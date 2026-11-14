import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { llmEndpoint, llmStatus, rotateDaily } from "../server/_core/llm";

const KEYS = [
  "ZENOX_LLM_PROVIDER",
  "ZENOX_LLM_API_URL",
  "ZENOX_LLM_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "ZENOX_LLM_MODEL",
  "MANUS_API_URL",
  "MANUS_API_KEY",
  "BUILT_IN_FORGE_API_URL",
  "BUILT_IN_FORGE_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ZENOX_LLM_API_KEY = "test-key-not-real";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("llm endpoint resolution", () => {
  it("maps the groq preset to its OpenAI-compatible route", async () => {
    process.env.ZENOX_LLM_PROVIDER = "groq";
    expect(llmEndpoint()).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((await llmStatus()).model).toBe("openai/gpt-oss-120b");
  });

  it("keeps a versioned base for Z.ai", async () => {
    process.env.ZENOX_LLM_PROVIDER = "zai";
    expect(llmEndpoint()).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect((await llmStatus()).model).toBe("glm-4.6");
  });

  it("uses Gemini's OpenAI-compatible endpoint as-is", async () => {
    process.env.ZENOX_LLM_PROVIDER = "gemini";
    expect(llmEndpoint()).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    // The lite flash is the default because 3.8 is often rate-limited and 2.5 is retired.
    expect((await llmStatus()).model).toBe("gemini-3.5-flash-lite");
  });

  it("accepts openrouter's /api/v1 base without duplicating the version", () => {
    process.env.ZENOX_LLM_API_URL = "https://openrouter.ai/api/v1";
    expect(llmEndpoint()).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("accepts a full endpoint unchanged", () => {
    process.env.ZENOX_LLM_API_URL = "https://example.com/custom/chat/completions";
    expect(llmEndpoint()).toBe("https://example.com/custom/chat/completions");
  });

  it("falls back to the bare OpenAI host rule", () => {
    process.env.ZENOX_LLM_API_URL = "https://api.openai.com";
    expect(llmEndpoint()).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("prefers an explicit URL over the provider preset", () => {
    process.env.ZENOX_LLM_PROVIDER = "groq";
    process.env.ZENOX_LLM_API_URL = "https://api.openai.com";
    expect(llmEndpoint()).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("reports configured status without leaking a key", async () => {
    const status = await llmStatus();
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("test-key-not-real");
  });
});

describe("daily rotation", () => {
  const keys = ["a", "b", "c"];

  it("picks a different starting key each day", () => {
    const day = 86_400_000;
    expect(rotateDaily(keys, day * 9)).toEqual(["a", "b", "c"]);
    expect(rotateDaily(keys, day * 10)).toEqual(["b", "c", "a"]);
    expect(rotateDaily(keys, day * 11)).toEqual(["c", "a", "b"]);
  });

  it("keeps single-key pools untouched", () => {
    expect(rotateDaily(["only"])).toEqual(["only"]);
    expect(rotateDaily([])).toEqual([]);
  });
});
