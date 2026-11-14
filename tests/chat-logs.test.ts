import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { clearChatLogs, conversationId, listChatSessions, logChatTurn, readChatConversation } from "../server/_core/chatLogs";

beforeEach(() => {
  process.env.ZENOX_CHAT_LOG_DIR = join(mkdtempSync(join(tmpdir(), "zenox-chats-")), "logs");
});

const turn = (text: string, answer: string, extra: Partial<Parameters<typeof logChatTurn>[0]> = {}) =>
  logChatTurn({ messages: [{ role: "user", content: text }], answer, mode: "general", ...extra });

describe("owner chat monitoring", () => {
  it("records a conversation the owner can read back", () => {
    turn("ما هو ZENOX؟", "منصة إدارة.");
    // A real client resends the history with every turn.
    logChatTurn({
      messages: [
        { role: "user", content: "ما هو ZENOX؟" },
        { role: "assistant", content: "منصة إدارة." },
        { role: "user", content: "وكم سعره؟" },
      ],
      answer: "مجاني.",
      mode: "general",
    });
    const sessions = listChatSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].preview).toBe("ما هو ZENOX؟");
    expect(sessions[0].turns).toBe(4);
    const thread = readChatConversation(sessions[0].conversation);
    expect(thread.map((item) => item.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(thread[1].text).toBe("منصة إدارة.");
  });

  it("does not duplicate a turn that is sent again", () => {
    turn("سؤال", "جواب");
    turn("سؤال", "جواب");
    expect(readChatConversation(conversationId("سؤال"))).toHaveLength(2);
  });

  it("groups history by the first message and masks the client address", () => {
    logChatTurn({
      messages: [
        { role: "user", content: "البداية" },
        { role: "assistant", content: "أهلًا" },
        { role: "user", content: "تكملة" },
      ],
      answer: "رد",
      client: "203.0.113.7",
    });
    const [session] = listChatSessions();
    expect(session.conversation).toBe(conversationId("البداية"));
    expect(session.client).toBe("203.0.113.x");
    // Only the newest user line and the answer of each request are stored.
    expect(session.turns).toBe(2);
    expect(session.preview).toBe("تكملة");
  });

  it("marks cached answers and the owner", () => {
    turn("س", "ج", { cached: true, owner: true });
    const [item] = readChatConversation(conversationId("س")).slice(-1);
    expect(item.cached).toBe(true);
    expect(item.owner).toBe(true);
  });

  it("rejects a forged conversation id", () => {
    expect(() => readChatConversation("../../etc/passwd")).toThrow();
  });

  it("clears the log on demand", () => {
    turn("سؤال للمسح", "جواب للمسح");
    const dir = process.env.ZENOX_CHAT_LOG_DIR!;
    expect(clearChatLogs().removedFiles).toBe(1);
    expect(listChatSessions()).toHaveLength(0);
    expect(() => readFileSync(join(dir, "chat-missing.jsonl"))).toThrow();
  });
});
