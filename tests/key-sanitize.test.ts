import { describe, expect, it } from "vitest";
import { sanitizeApiKey } from "../server/_core/keyVault";

describe("pasted API keys", () => {
  it("strips quotes, BOM, spaces and invisible non-ASCII characters", () => {
    expect(sanitizeApiKey('  "sk-proj-abc123"  ')).toBe("sk-proj-abc123");
    expect(sanitizeApiKey("\uFEFFgsk_abc\u00A0def")).toBe("gsk_abcdef");
    expect(sanitizeApiKey("Bearer sk-xyz")).toBe("sk-xyz");
    expect(sanitizeApiKey("sk-\u201Cabc\u201D")).toBe("sk-abc");
    expect(sanitizeApiKey(undefined)).toBe("");
  });
});
