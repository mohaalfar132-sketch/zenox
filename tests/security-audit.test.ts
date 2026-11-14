import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSecurityAudit, scanTextForPatterns, scanTextForSecrets } from "../server/_core/securityAudit";

describe("security audit — secret scanning", () => {
  it("finds the key kinds but never returns the value", () => {
    const text = [
      'const a = "AIzaSyA1234567890abcdefghijklmnopqrstu";',
      'const b = "sk-abcdefghijklmnopqrstuvwxyz012345";',
      'const c = "-----BEGIN RSA PRIVATE KEY-----";',
      "const d = 'normal text without secrets';",
    ].join("\n");
    const hits = scanTextForSecrets(text);
    const kinds = hits.map((hit) => hit.kind).join(" ");
    expect(kinds).toContain("Google");
    expect(kinds).toContain("OpenAI");
    expect(kinds).toContain("خاص");
    expect(hits.every((hit) => !JSON.stringify(hit).includes("AIzaSy"))).toBe(true);
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  it("does not flag ordinary code", () => {
    expect(scanTextForSecrets("const token = process.env.GEMINI_API_KEY;")).toEqual([]);
  });
});

describe("security audit — risky patterns", () => {
  it("flags disabled TLS, wildcard CORS and dynamic eval", () => {
    const ids = scanTextForPatterns(
      [
        "agent({ rejectUnauthorized: false })",
        'cors({ origin: "*" })',
        "const value = eval(userInput);",
        "const ok = 1;",
      ].join("\n"),
    ).map((hit) => hit.rule.id);
    expect(ids).toContain("tls-disabled");
    expect(ids).toContain("cors-wildcard");
    expect(ids).toContain("dynamic-eval");
    expect(ids).not.toContain("html-injection");
  });
});

describe("security audit — project report", () => {
  it("penalises a world-readable .env and a secret in source", async () => {
    const root = mkdtempSync(join(tmpdir(), "zenox-audit-"));
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "leak.ts"), 'export const k = "AIzaSyA1234567890abcdefghijklmnopqrstu";\n');
    writeFileSync(join(root, ".env"), "JWT_SECRET=abcdef1234567890\n");
    chmodSync(join(root, ".env"), 0o644);

    const report = await runSecurityAudit(root);
    const ids = report.findings.map((finding) => finding.id);
    expect(ids).toContain("secret-in-source");
    expect(ids).toContain("secret-permissions");
    expect(report.score).toBeLessThan(100);
    expect(report.scannedFiles).toBeGreaterThan(0);
    expect(report.generatedAt).toBeTruthy();
  });

  it("keeps a clean project at a high score", async () => {
    const root = mkdtempSync(join(tmpdir(), "zenox-audit-clean-"));
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "safe.ts"), "export const add = (a: number, b: number) => a + b;\n");
    const report = await runSecurityAudit(root);
    expect(report.findings.some((finding) => finding.severity === "critical")).toBe(false);
    expect(report.score).toBeGreaterThanOrEqual(90);
  });
});
