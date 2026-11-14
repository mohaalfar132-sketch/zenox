import { describe, expect, it } from "vitest";
import { shouldAnswerDirectly } from "../server/_core/ownerAgent";
import { createAnswerCache } from "../server/_core/chatCache";

const user = (content: string) => [{ role: "user" as const, content }];

describe("fast reply path", () => {
  it("answers pure conversation without the executor", () => {
    for (const text of ["السلام عليكم", "شكرا", "إيه رأيك في الاسم؟", "تمام"]) {
      expect(shouldAnswerDirectly(user(text))).toBe(true);
    }
  });

  it("always routes an action through the executor", () => {
    for (const text of [
      "عدل ملف الواجهة",
      "أضف زر جديد",
      "شغل الاختبارات",
      "ابن الـAPK",
      "احذف الملف",
      "ارفع التعديلات",
      "fix the login bug",
    ]) {
      expect(shouldAnswerDirectly(user(text))).toBe(false);
    }
  });
});

describe("answer cache", () => {
  it("hits across spacing and case", () => {
    const cache = createAnswerCache();
    const key = cache.keyFor("fast", user("  مرحبا   يا ZENOX "));
    cache.set(key, "أهلاً");
    expect(cache.get(cache.keyFor("fast", user("مرحبا يا zenox")))).toBe("أهلاً");
  });
});
