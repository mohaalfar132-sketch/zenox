import { describe, expect, it } from "vitest";

import { createAnswerCache } from "../server/_core/chatCache";
import { createChatLimiter } from "../server/_core/chatGuard";

const turns = (content: string) => [{ role: "user" as const, content }];

describe("answer cache", () => {
  it("keys on the last user turn, not the whole history", () => {
    const cache = createAnswerCache();
    const a = cache.keyFor("general", turns("ما هي القهوة؟"));
    const b = cache.keyFor("general", [
      { role: "assistant", content: "قديم" },
      { role: "user", content: "ما هي القهوة؟" },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(cache.keyFor("emotional", turns("ما هي القهوة؟")));
  });

  it("returns a stored answer and expires it after the TTL", () => {
    const cache = createAnswerCache({ ttlMs: 1_000 });
    const key = cache.keyFor("general", turns("سؤال"));
    cache.set(key, "جواب", 0);
    expect(cache.get(key, 500)).toBe("جواب");
    expect(cache.get(key, 1_500)).toBeNull();
  });

  it("ignores empty answers", () => {
    const cache = createAnswerCache();
    const key = cache.keyFor("general", turns("سؤال"));
    cache.set(key, "   ");
    expect(cache.get(key)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry past the size limit", () => {
    const cache = createAnswerCache({ max: 2 });
    const k1 = cache.keyFor("general", turns("١"));
    const k2 = cache.keyFor("general", turns("٢"));
    const k3 = cache.keyFor("general", turns("٣"));
    cache.set(k1, "أ");
    cache.set(k2, "ب");
    cache.get(k1); // k1 is now the most recently used
    cache.set(k3, "ج");
    expect(cache.size).toBe(2);
    expect(cache.get(k2)).toBeNull();
    expect(cache.get(k1)).toBe("أ");
  });
});

describe("daily budget", () => {
  it("blocks a client that keeps asking across windows", () => {
    const limiter = createChatLimiter({ windowMs: 1_000, max: 100, maxConcurrent: 10, maxPerDay: 3 });
    const day = 1_700_000_000_000;
    expect(limiter.check("big", day).allowed).toBe(true);
    expect(limiter.check("big", day + 2_000).allowed).toBe(true);
    expect(limiter.check("big", day + 4_000).allowed).toBe(true);
    const blocked = limiter.check("big", day + 6_000);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThan(60);
  });

  it("resets the daily counter on a new day", () => {
    const limiter = createChatLimiter({ windowMs: 1_000, max: 100, maxConcurrent: 10, maxPerDay: 1 });
    const day = 1_700_000_000_000;
    expect(limiter.check("x", day).allowed).toBe(true);
    expect(limiter.check("x", day + 500).allowed).toBe(false);
    expect(limiter.check("x", day + 86_400_000).allowed).toBe(true);
  });

  it("keeps days separate per client", () => {
    const limiter = createChatLimiter({ windowMs: 1_000, max: 100, maxConcurrent: 10, maxPerDay: 1 });
    const day = 1_700_000_000_000;
    expect(limiter.check("a", day).allowed).toBe(true);
    expect(limiter.check("b", day).allowed).toBe(true);
    expect(limiter.check("a", day + 10).allowed).toBe(false);
  });
});
