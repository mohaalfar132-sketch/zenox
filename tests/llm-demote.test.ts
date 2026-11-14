import { describe, expect, it } from "vitest";
import { isKeyRejected, markKeyRejected, resetKeyHealth } from "../server/_core/llm";

describe("a rejected key steps aside instead of slowing every reply", () => {
  it("demotes a rejected key for half an hour", () => {
    resetKeyHealth();
    const start = 1_000_000;
    markKeyRejected("env:OPENAI_API_KEY", start);
    expect(isKeyRejected("env:OPENAI_API_KEY", start + 60_000)).toBe(true);
    expect(isKeyRejected("env:OPENAI_API_KEY", start + 31 * 60_000)).toBe(false);
    expect(isKeyRejected("env:GEMINI_API_KEY", start)).toBe(false);
  });

  it("ignores empty labels", () => {
    resetKeyHealth();
    markKeyRejected("");
    expect(isKeyRejected("")).toBe(false);
  });
});
