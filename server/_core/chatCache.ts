import { createHash } from "node:crypto";

import type { ChatTurn } from "./chatGuard";

/**
 * Tiny LRU answer cache: identical questions (a common pattern with a single
 * owner re-opening the app) are answered instantly and cost no credits.
 * Only the last user turn counts, so a changing history still hits the cache
 * for repeated questions.
 */
export function createAnswerCache(options: { ttlMs?: number; max?: number } = {}) {
  const ttlMs = options.ttlMs ?? 2 * 60 * 60_000;
  const max = options.max ?? 200;
  const store = new Map<string, { content: string; at: number }>();

  const keyFor = (mode: string, turns: ChatTurn[]) => {
    const lastUser = [...turns].reverse().find((turn) => turn.role === "user");
    // Whitespace and case must not turn the same question into a miss.
    const normalized = String(lastUser?.content ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    const text = `${mode}\u0000${normalized}`;
    return createHash("sha256").update(text).digest("hex");
  };

  return {
    keyFor,
    get(key: string, now = Date.now()): string | null {
      const hit = store.get(key);
      if (!hit) return null;
      if (now - hit.at > ttlMs) {
        store.delete(key);
        return null;
      }
      // Refresh recency so the map behaves like an LRU.
      store.delete(key);
      store.set(key, hit);
      return hit.content;
    },
    set(key: string, content: string, now = Date.now()): void {
      if (!content.trim()) return;
      store.delete(key);
      store.set(key, { content, at: now });
      while (store.size > max) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    get size(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
  };
}
