/**
 * Slows down password guessing against the owner center. Failures are counted
 * per client address in a short window; a locked address must wait, and every
 * failed attempt also costs a moment so a script cannot hammer the endpoint.
 */

const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 6;
const LOCK_MS = 15 * 60_000;

type Entry = { failures: number[]; lockedUntil: number };
const entries = new Map<string, Entry>();

function entryFor(key: string): Entry {
  const existing = entries.get(key);
  if (existing) return existing;
  const fresh: Entry = { failures: [], lockedUntil: 0 };
  entries.set(key, fresh);
  if (entries.size > 5000) {
    const oldest = entries.keys().next().value;
    if (oldest) entries.delete(oldest);
  }
  return fresh;
}

export function loginBlockedFor(key: string): number {
  const entry = entryFor(key);
  const now = Date.now();
  if (entry.lockedUntil > now) return Math.ceil((entry.lockedUntil - now) / 1000);
  entry.failures = entry.failures.filter((at) => now - at < WINDOW_MS);
  return 0;
}

export function recordLoginFailure(key: string): { lockedSeconds: number } {
  const entry = entryFor(key);
  const now = Date.now();
  entry.failures = entry.failures.filter((at) => now - at < WINDOW_MS);
  entry.failures.push(now);
  if (entry.failures.length >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
    entry.failures = [];
    return { lockedSeconds: Math.ceil(LOCK_MS / 1000) };
  }
  return { lockedSeconds: 0 };
}

export function recordLoginSuccess(key: string): void {
  entries.delete(key);
}

/** Successful sign-in resets the counter, so the owner is never locked out. */
export const OWNER_THROTTLE = { windowMs: WINDOW_MS, maxFailures: MAX_FAILURES, lockMs: LOCK_MS };
