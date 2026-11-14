import { describe, expect, it } from "vitest";
import { CHAT_LIMITS, normalizeChatMessages } from "../server/_core/chatGuard";

const turn = (role: "user" | "assistant", content: string) => ({ role, content });

describe("long conversations", () => {
  it("keeps the newest question and drops old context", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      turn(index % 2 === 0 ? "user" : "assistant", `رسالة ${index} ` + "طويل ".repeat(400)),
    );
    const result = normalizeChatMessages({ messages });
    const last = result[result.length - 1];
    expect(last.content).toContain("رسالة 29");
    expect(result.some((item) => item.content.includes("رسالة 0 "))).toBe(false);
  });

  it("stays inside the model budget however long the payload is", () => {
    const messages = Array.from({ length: 200 }, (_, index) => turn("user", `س${index} ` + "ن".repeat(3900)));
    const result = normalizeChatMessages({ messages });
    const total = result.reduce((sum, item) => sum + item.content.length, 0);
    expect(total).toBeLessThanOrEqual(CHAT_LIMITS.maxTotalChars + 300);
    expect(result.length).toBeGreaterThan(0);
    expect(result[result.length - 1].content).toContain("س199");
  });

  it("keeps a very long single message inside the per-message cap", () => {
    const result = normalizeChatMessages({ messages: [turn("user", "ا".repeat(20000))] });
    expect(result[0].content.length).toBeLessThanOrEqual(CHAT_LIMITS.maxCharsPerMessage);
  });
});
