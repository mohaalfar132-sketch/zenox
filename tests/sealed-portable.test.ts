import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSealedSecretsIntoEnv, sealedSecretPairs } from "../server/_core/ownerSecrets";

describe("sealed secrets travel with the archive", () => {
  it("keeps ciphertext only — no key value appears in the sealed file", () => {
    const file = join(process.cwd(), "secrets", ".env.enc.json");
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("aes-256-gcm");
    expect(/sk-|gsk_|AIza/.test(raw)).toBe(false);
  });

  it("opens with the bundled key and fills missing variables only", () => {
    const pairs = sealedSecretPairs();
    expect(pairs && pairs.length > 0).toBe(true);
    const name = pairs![0].name;
    const saved = process.env[name];
    delete process.env[name];
    const applied = loadSealedSecretsIntoEnv();
    expect(applied).toBeGreaterThan(0);
    expect(process.env[name]).toBeTruthy();
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
});
