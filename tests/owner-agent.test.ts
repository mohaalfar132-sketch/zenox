import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replies: any[] = [];

vi.mock("../server/_core/llm", () => ({
  invokeLLM: vi.fn(async () => replies.shift() ?? { choices: [{ message: { role: "assistant", content: "تم." } }] }),
}));

const { OWNER_AGENT_TOOLS, maskKey, runOwnerAgent } = await import("../server/_core/ownerAgent");

const toolCall = (name: string, args: Record<string, unknown>, id = `call_${name}`) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
});

const finalText = (content: string) => ({ choices: [{ message: { role: "assistant", content } }] });

beforeEach(() => {
  replies.length = 0;
  process.env.ZENOX_ENV_FILE = join(mkdtempSync(join(tmpdir(), "zenox-agent-")), ".env");
});

describe("owner assistant executes instead of instructing", () => {
  it("offers reading, platform controls and keys — never shell or code writes", () => {
    expect(OWNER_AGENT_TOOLS).toEqual(
      expect.arrayContaining(["search_code", "read_file", "site_banner", "security_audit", "add_ai_key", "remember", "recall"]),
    );
    for (const forbidden of ["edit_file", "write_file", "delete_file", "run_command", "build_apk", "rebuild_web", "restart_server"]) {
      expect(OWNER_AGENT_TOOLS).not.toContain(forbidden);
    }
  });

  it("refuses a file write even when the model asks for one", async () => {
    const path = `tests/tmp-agent-${Date.now()}.txt`;
    replies.push(toolCall("write_file", { path, content: "سطر جديد\n" }), finalText("لا أملك تعديل الملفات."));
    const result = await runOwnerAgent({ messages: [{ role: "user", content: `اكتب في ${path} سطرًا` }] });
    expect(result.steps[0]).toMatchObject({ tool: "write_file", ok: false });
    expect(result.steps[0].summary).toContain("مساحة ZENOX");
    expect(existsSync(path)).toBe(false);
  });

  it("saves a new AI key without echoing it", async () => {
    const key = "gsk_test_key_1234567890abcdef";
    replies.push(toolCall("add_ai_key", { provider: "groq", key }), finalText("أضفت المفتاح وشغّلته."));
    const result = await runOwnerAgent({ messages: [{ role: "user", content: "ضيف مفتاح groq" }] });
    expect(result.steps[0].summary).toContain("groq");
    const env = readFileSync(process.env.ZENOX_ENV_FILE!, "utf8");
    expect(env).toContain("GROQ_API_KEY=");
    expect(result.content).not.toContain(key);
    expect(JSON.stringify(result.steps)).not.toContain(key);
  });

  it("reports a failed tool instead of claiming success", async () => {
    replies.push(toolCall("read_file", { path: "no/such/file.ts" }), finalText("لم أجد الملف."));
    const result = await runOwnerAgent({ messages: [{ role: "user", content: "اقرأ ملفًا غير موجود" }] });
    expect(result.steps[0].ok).toBe(false);
  });

  it("always asks for a preview-only key mask", () => {
    expect(maskKey("gsk_1234567890abcdef")).toBe("gsk_…");
    expect(maskKey("short")).toBe("«محجوب»");
  });
});
