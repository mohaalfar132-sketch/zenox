import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";

/**
 * Owner-visible conversation log. The guest assistant is stateless: every turn
 * arrives with the whole history, so a conversation is identified by a hash of
 * its first message and each turn is stored once (repeat sends are de-duped).
 * Lines are appended as JSONL in the project folder so they survive a restart
 * even without a database, and they never contain keys or session cookies.
 */
const MAX_TEXT = 4000;
const MAX_FILES = 30;
const KEEP_TURNS = 400;

export type ChatTurn = {
  at: number;
  conversation: string;
  role: "user" | "assistant";
  text: string;
  mode: string;
  owner: boolean;
  cached: boolean;
  client: string;
};

export type ChatSession = {
  conversation: string;
  client: string;
  mode: string;
  owner: boolean;
  turns: number;
  startedAt: number;
  lastAt: number;
  preview: string;
};

const logDir = () => (process.env.ZENOX_CHAT_LOG_DIR || "").trim() || join(process.cwd(), ".zenox-chats");

function ensureDir() {
  const dir = logDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stable per-conversation id; the message text itself is never hashed out of reach. */
export function conversationId(firstUserMessage: string) {
  return createHash("sha256").update(firstUserMessage.trim().slice(0, 2000)).digest("hex").slice(0, 12);
}

// A retried request must not double-log a turn, but the same question asked
// again tomorrow is a new conversation turn, so de-duplication is time-boxed.
const DEDUPE_MS = 10 * 60 * 1000;
const seen = new Map<string, number>();

function alreadyLogged(conversation: string, role: string, text: string) {
  const key = `${conversation}|${createHash("sha256").update(`${role}\n${text}`).digest("hex")}`;
  const now = Date.now();
  const previous = seen.get(key);
  if (previous && now - previous < DEDUPE_MS) return true;
  seen.set(key, now);
  if (seen.size > 2000) {
    for (const [item, at] of seen) {
      if (now - at > DEDUPE_MS) seen.delete(item);
    }
    if (seen.size > 2000) seen.delete(seen.keys().next().value as string);
  }
  return false;
}

/** A client address is masked before it is written: the owner reads chats, not raw IPs. */
function maskClient(value: string) {
  const clean = value.replace(/^::ffff:/, "");
  const parts = clean.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  return clean.slice(0, 8) + "…";
}

function prune() {
  let dir: string;
  try {
    dir = logDir();
    const files = readdirSync(dir).filter((name) => /^chat-.*\.jsonl$/.test(name)).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_FILES))) {
      try {
        unlinkSync(join(dir, stale));
      } catch {
        // A file we cannot prune is harmless.
      }
    }
  } catch {
    // Nothing to prune yet.
  }
}

function logChatTurnRaw(input: {
  messages: { role: string; content: string }[];
  answer: string;
  mode?: string;
  owner?: boolean;
  cached?: boolean;
  client?: string;
}): void {
  try {
    const users = input.messages.filter((item) => item.role === "user" && item.content.trim());
    const first = users[0];
    const last = users[users.length - 1];
    if (!first || !last) return;
    const conversation = conversationId(first.content);
    const client = maskClient(input.client || "unknown");
    const mode = (input.mode || "general").slice(0, 60);
    const dir = ensureDir();
    const file = join(dir, `chat-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines: string[] = [];
    const push = (role: "user" | "assistant", text: string, cached: boolean) => {
      const clean = text.trim().slice(0, MAX_TEXT);
      if (!clean || alreadyLogged(conversation, role, clean)) return;
      const turn: ChatTurn = {
        at: Date.now(),
        conversation,
        role,
        text: clean,
        mode,
        owner: Boolean(input.owner),
        cached,
        client,
      };
      lines.push(JSON.stringify(turn));
    };
    push("user", last.content, false);
    push("assistant", input.answer, Boolean(input.cached));
    if (lines.length) appendFileSync(file, lines.join("\n") + "\n", "utf8");
    prune();
  } catch (error) {
    // Logging must never break a reply.
    console.warn("[chats] could not record a turn:", (error as Error).message);
  }
}

function readTurns(): ChatTurn[] {
  let dir: string;
  try {
    dir = logDir();
  } catch {
    return [];
  }
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => /^chat-.*\.jsonl$/.test(name)).sort();
  const turns: ChatTurn[] = [];
  for (const name of files) {
    const full = join(dir, name);
    try {
      if (statSync(full).size > 20_000_000) continue;
      for (const line of readFileSync(full, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as ChatTurn;
          if (typeof parsed.text === "string" && typeof parsed.conversation === "string") turns.push(parsed);
        } catch {
          // A torn last line is normal after a crash.
        }
      }
    } catch {
      // Unreadable file: skip it.
    }
  }
  return turns.sort((a, b) => a.at - b.at);
}

/** Newest conversations first, with the first line of each as a preview. */
export function listChatSessions(limit = 30): ChatSession[] {
  const map = new Map<string, ChatSession>();
  for (const turn of readTurns()) {
    const current = map.get(turn.conversation);
    if (!current) {
      map.set(turn.conversation, {
        conversation: turn.conversation,
        client: turn.client,
        mode: turn.mode,
        owner: turn.owner,
        turns: 1,
        startedAt: turn.at,
        lastAt: turn.at,
        preview: turn.role === "user" ? turn.text.slice(0, 140) : "",
      });
      continue;
    }
    current.turns += 1;
    current.lastAt = Math.max(current.lastAt, turn.at);
    if (!current.preview && turn.role === "user") current.preview = turn.text.slice(0, 140);
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, Math.min(Math.max(limit, 1), 100));
}

/** Every stored turn of one conversation, oldest first. */
export function readChatConversation(conversation: string, limit = 300): ChatTurn[] {
  if (!/^[a-f0-9]{6,64}$/.test(conversation)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف محادثة غير صالح." });
  }
  const turns = readTurns().filter((turn) => turn.conversation === conversation);
  return turns.slice(-Math.min(Math.max(limit, 1), 1000));
}

export function memoryZChatTotals() {
  const turns = readTurns();
  return {
    messages: turns.length,
    conversations: new Set(turns.map((turn) => turn.conversation)).size,
  };
}

export function clearChatLogs(): { removedFiles: number } {
  let dir: string;
  try {
    dir = logDir();
    if (!existsSync(dir)) return { removedFiles: 0 };
    let removedFiles = 0;
    for (const name of readdirSync(dir)) {
      if (!/^chat-.*\.jsonl$/.test(name)) continue;
      try {
        unlinkSync(join(dir, name));
        removedFiles += 1;
      } catch {
        // Best effort.
      }
    }
    seen.clear();
    return { removedFiles };
  } catch {
    return { removedFiles: 0 };
  }
}

/**
 * Keys pasted into a chat must never reach the log on disk: the owner still gets
 * a readable conversation, but a credential is replaced by a marker.
 */
export function redactSecrets(text: string): string {
  return String(text)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{20,}|xai-[A-Za-z0-9]{12,})\b/g, "«مفتاح محجوب»")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S{8,}/gi, "$1«محجوب»");
}

/** The only entry point callers use: it redacts, then stores. */
export function logChatTurn(input: Parameters<typeof logChatTurnRaw>[0]) {
  return logChatTurnRaw({
    ...input,
    messages: input.messages.map((message) => ({
      ...message,
      content: typeof message.content === "string" ? redactSecrets(message.content) : message.content,
    })),
    answer: redactSecrets(input.answer),
  });
}
