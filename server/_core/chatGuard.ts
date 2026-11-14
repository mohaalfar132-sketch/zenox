/**
 * Guards for the public chat endpoint: it spends the owner's model credits, so
 * it must be cheap to verify, bounded in size and rate limited per client.
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };

export const CHAT_LIMITS = {
  maxMessages: 20,
  maxCharsPerMessage: 4_000,
  maxTotalChars: 12_000,
} as const;

/**
 * Removes control characters that break SSE framing, plus bidirectional
 * overrides that can visually disguise text (a classic spoofing trick).
 */
const stripControl = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "");

/**
 * Accepts an untrusted request body and returns only well-formed chat turns,
 * trimmed to a size that cannot be used to drain credits or memory.
 */
export function normalizeChatMessages(body: unknown): ChatTurn[] {
  const raw = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw)) return [];

  // Walk backwards: a long chat must keep the newest question, not the first
  // few lines of old context, or the model answers something already finished.
  const kept: ChatTurn[] = [];
  let total = 0;
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    const item = raw[index];
    if (!item || typeof item !== "object") continue;
    const entry = item as { role?: unknown; content?: unknown };
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    if (typeof entry.content !== "string") continue;

    const content = stripControl(entry.content).trim().slice(0, CHAT_LIMITS.maxCharsPerMessage);
    if (!content) continue;
    if (kept.length > 0 && total + content.length > CHAT_LIMITS.maxTotalChars) break;
    kept.push({ role: entry.role, content });
    total += content.length;
    if (kept.length >= CHAT_LIMITS.maxMessages) break;
  }

  // Old context is dropped silently: the newest turns are what the model needs,
  // and an extra system note would spend budget that belongs to the question.
  return kept.reverse();
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Sliding-window limiter plus a global concurrency cap. In-memory on purpose:
 * one node process serves this app, and the goal is stopping accidental or
 * hostile floods, not distributed accounting.
 */
export function createChatLimiter(
  options: { windowMs?: number; max?: number; maxConcurrent?: number; maxPerDay?: number } = {},
) {
  const windowMs = options.windowMs ?? 5 * 60_000;
  const max = options.max ?? 30;
  const maxConcurrent = options.maxConcurrent ?? 3;
  const maxPerDay = options.maxPerDay ?? 150;

  const hits = new Map<string, number[]>();
  // A slow trickle under the short window can still drain credits overnight,
  // so each client also gets a daily budget.
  const daily = new Map<string, { day: number; count: number }>();
  let inFlight = 0;

  const prune = (key: string, now: number) => {
    const stamps = hits.get(key);
    if (!stamps) return [];
    const fresh = stamps.filter((stamp) => now - stamp < windowMs);
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
    return fresh;
  };

  return {
    /** Checks one client; a rejected call does not consume budget. */
    check(key: string, now = Date.now()): RateDecision {
      if (inFlight >= maxConcurrent) return { allowed: false, retryAfterSeconds: 2 };
      const stamps = prune(key, now);
      if (stamps.length >= max) {
        const oldest = stamps[0] ?? now;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
      }
      const day = Math.floor(now / 86_400_000);
      const today = daily.get(key);
      const count = today && today.day === day ? today.count : 0;
      if (count >= maxPerDay) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((day + 1) * 86_400_000 - now) / 1000)) };
      }
      stamps.push(now);
      hits.set(key, stamps);
      daily.set(key, { day, count: count + 1 });
      return { allowed: true };
    },
    acquire(): boolean {
      if (inFlight >= maxConcurrent) return false;
      inFlight += 1;
      return true;
    },
    release(): void {
      inFlight = Math.max(0, inFlight - 1);
    },
    get inFlightCount(): number {
      return inFlight;
    },
    reset(): void {
      hits.clear();
      daily.clear();
      inFlight = 0;
    },
  };
}
