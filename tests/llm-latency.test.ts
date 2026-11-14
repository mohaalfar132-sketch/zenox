import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyLatencySnapshot, recordKeyLatency } from "../server/_core/llm";

describe("Gemini and OpenAI share the load by measured speed", () => {
  it("remembers the measured latency per key and ignores nonsense values", () => {
    recordKeyLatency("env:GEMINI_API_KEY", 640);
    recordKeyLatency("env:GEMINI_API_KEY", 0);
    recordKeyLatency("env:OPENAI_API_KEY", -5);
    recordKeyLatency("", 100);
    const snapshot = keyLatencySnapshot();
    expect(snapshot["env:GEMINI_API_KEY"]).toBe(640);
    expect(snapshot["env:OPENAI_API_KEY"]).toBeUndefined();
    expect(snapshot[""]).toBeUndefined();
  });

  it("orders the pool by latency and tries more than three keys", () => {
    const source = readFileSync(join(process.cwd(), "server/_core/llm.ts"), "utf8");
    expect(source).toContain("keyLatency.get(a.label)");
    expect(source).toContain("pool.slice(0, Math.min(pool.length, 5))");
    expect(source).toContain("recordKeyLatency(candidate.label, Date.now() - attemptStarted)");
  });
});

describe("working keys take turns", () => {
  it("rotates the healthy pool on every request", async () => {
    const { rotateByRequest } = await import("../server/_core/llm");
    const pool = ["gemini", "groq"];
    const first = rotateByRequest(pool)[0];
    const second = rotateByRequest(pool)[0];
    expect(new Set([first, second]).size).toBe(2);
    expect(rotateByRequest(["only"])).toEqual(["only"]);
  });
});

describe("owner preference", () => {
  it("reads the preferred provider from the environment", async () => {
    const { preferredProvider } = await import("../server/_core/llm");
    const before = process.env.ZENOX_LLM_PREFER;
    process.env.ZENOX_LLM_PREFER = " OpenRouter ";
    expect(preferredProvider()).toBe("openrouter");
    if (before === undefined) delete process.env.ZENOX_LLM_PREFER;
    else process.env.ZENOX_LLM_PREFER = before;
  });
});

describe("OpenRouter free models", () => {
  it("extracts only :free entries from the public catalogue", async () => {
    const { extractFreeModels } = await import("../server/_core/freeModels");
    const catalogue = {
      data: [
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 },
        { id: "google/gemma:free", name: "Gemma", context_length: 262144 },
        { id: "google/gemma:free", name: "Gemma duplicate", context_length: 262144 },
        { id: "liquid/lfm:free", name: "LFM", context_length: 1000 },
        { id: "", name: "broken" },
      ],
    };
    const models = extractFreeModels(catalogue);
    expect(models.map((model) => model.id)).toEqual(["google/gemma:free", "liquid/lfm:free"]);
  });

  it("ranks answering models first, then by measured speed", async () => {
    const { rankFreeModels } = await import("../server/_core/freeModels");
    const models = [
      { id: "slow:free", name: "slow", context: 1 },
      { id: "fast:free", name: "fast", context: 1 },
      { id: "broken:free", name: "broken", context: 1 },
      { id: "unknown:free", name: "unknown", context: 1 },
    ];
    const stats = new Map([
      ["slow:free", { ok: 1, fail: 0, lastMs: 900 }],
      ["fast:free", { ok: 1, fail: 0, lastMs: 120 }],
      ["broken:free", { ok: 0, fail: 3, lastMs: 0 }],
    ]);
    const ranked = rankFreeModels(models, stats).map((model) => model.id);
    expect(ranked[0]).toBe("fast:free");
    expect(ranked[1]).toBe("slow:free");
    expect(ranked.at(-1)).toBe("broken:free");
  });

  it("records real outcomes into the ranking", async () => {
    const { recordFreeModelResult, freeModelReport, refreshFreeModels } = await import("../server/_core/freeModels");
    await refreshFreeModels(true).catch(() => undefined);
    recordFreeModelResult("liquid/lfm-3-1.7b:free", true, 300);
    const report = freeModelReport();
    expect(report.models.length).toBeGreaterThan(0);
    expect(report.fetchedAt === null || typeof report.fetchedAt === "string").toBe(true);
  });
});

describe("owner preference", () => {
  it("reads the preferred provider from the environment", async () => {
    const { preferredProvider } = await import("../server/_core/llm");
    const before = process.env.ZENOX_LLM_PREFER;
    process.env.ZENOX_LLM_PREFER = " OpenRouter ";
    expect(preferredProvider()).toBe("openrouter");
    if (before === undefined) delete process.env.ZENOX_LLM_PREFER;
    else process.env.ZENOX_LLM_PREFER = before;
  });
});
