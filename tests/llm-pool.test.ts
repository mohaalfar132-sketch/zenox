import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: number;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: number;
  status: string;
};

let rows: Row[] = [];

vi.mock("../server/db", () => ({
  listLlmKeys: vi.fn(async () => rows),
  setLlmKeyHealth: vi.fn(async () => undefined),
  touchLlmKey: vi.fn(async () => undefined),
}));

const ENV_KEYS = ["ZENOX_LLM_API_KEY", "ZENOX_LLM_PROVIDER", "GROQ_API_KEY", "GEMINI_API_KEY", "ZENOX_LLM_FREE"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  rows = [];
  const db = await import("../server/db");
  vi.mocked(db.listLlmKeys).mockClear();
  // The pool keeps a short-lived snapshot; clear it so each test sees its rows.
  const { invalidateLlmKeyCache } = await import("../server/_core/llm");
  invalidateLlmKeyCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const row = (id: number, provider: string, status: string): Row => ({
  id,
  label: `key-${id}`,
  provider,
  baseUrl: provider === "groq" ? "https://api.groq.com/openai" : "https://api.openai.com",
  model: provider === "groq" ? "openai/gpt-oss-120b" : "gpt-4o-mini",
  apiKey: `secret-${id}`,
  enabled: 1,
  status,
});

describe("key pool ordering", () => {
  it("puts a failing key after healthy ones", async () => {
    rows = [row(1, "openai", "failing"), row(2, "groq", "ok")];
    const { orderedPool } = await import("../server/_core/llm");
    const labels = (await orderedPool()).map((entry) => entry.label);
    expect(labels[0]).toBe("key-2");
    expect(labels[1]).toBe("key-1");
  });

  it("keeps the keyless fallback last so a real key always wins", async () => {
    rows = [row(1, "groq", "ok")];
    const { orderedPool } = await import("../server/_core/llm");
    const pool = await orderedPool();
    expect(pool.at(-1)?.provider).toBe("pollinations");
    expect(pool[0]?.provider).toBe("groq");
  });

  it("ignores disabled keys", async () => {
    rows = [{ ...row(1, "groq", "ok"), enabled: 0 }, row(2, "openai", "ok")];
    const { orderedPool } = await import("../server/_core/llm");
    const labels = (await orderedPool()).map((entry) => entry.label);
    expect(labels).not.toContain("key-1");
    expect(labels).toContain("key-2");
  });

  it("uses the free fallback alone when nothing is configured", async () => {
    rows = [];
    const { orderedPool } = await import("../server/_core/llm");
    const pool = await orderedPool();
    expect(pool).toHaveLength(1);
    expect(pool[0]?.provider).toBe("pollinations");
  });
});
