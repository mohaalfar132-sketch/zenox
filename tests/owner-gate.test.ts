import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashOwnerPassword } from "../server/_core/ownerAuth";
import { ownerGateFile, ownerGateStatus, verifyOwnerGatePassword } from "../server/_core/ownerGate";
import { ownerSigningSecret, ownerSigningSecretSource } from "../server/_core/ownerSigningSecret";

const ENV_KEYS = [
  "ZENOX_OWNER_DIR",
  "ZENOX_OWNER_GATE_FILE",
  "OWNER_GATE_PASSWORD_HASH",
  "OWNER_PASSWORD_HASH",
  "OWNER_GATE_SECRET",
  "OWNER_SESSION_SECRET",
  "JWT_SECRET",
  "MANUS_JWT_SECRET",
  "DATABASE_URL",
] as const;

const saved = new Map<string, string | undefined>();
let dir = "";

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  dir = mkdtempSync(join(tmpdir(), "zenox-owner-gate-"));
  process.env.ZENOX_OWNER_DIR = dir;
  delete process.env.ZENOX_OWNER_GATE_FILE;
  delete process.env.OWNER_GATE_PASSWORD_HASH;
  delete process.env.OWNER_PASSWORD_HASH;
  delete process.env.OWNER_GATE_SECRET;
  delete process.env.OWNER_SESSION_SECRET;
  delete process.env.JWT_SECRET;
  delete process.env.MANUS_JWT_SECRET;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("owner gate", () => {
  it("creates a persistent signing key when the environment has none", () => {
    const first = ownerSigningSecret();
    const second = ownerSigningSecret();
    expect(first).not.toBeNull();
    expect(Buffer.from(first!).toString()).toBe(Buffer.from(second!).toString());
    expect(existsSync(join(dir, "owner-gate.key"))).toBe(true);
  });

  it("falls back to an in-memory key when the owner directory is unwritable", () => {
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    process.env.ZENOX_OWNER_DIR = blocker;
    expect(ownerSigningSecret()).not.toBeNull();
    expect(ownerSigningSecretSource()).toBe("memory");
  });

  it("verifies a credential and keeps a local copy after the first success", async () => {
    const password = "owner-gate-test-password";
    process.env.OWNER_GATE_PASSWORD_HASH = hashOwnerPassword(password);

    const accepted = await verifyOwnerGatePassword(password);
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.source).toBe("gate_env");
    expect(existsSync(ownerGateFile())).toBe(true);
    expect(readFileSync(ownerGateFile(), "utf8")).toContain("scrypt$");

    delete process.env.OWNER_GATE_PASSWORD_HASH;
    const fromFile = await verifyOwnerGatePassword(password);
    expect(fromFile.ok).toBe(true);
    expect(fromFile.ok && fromFile.source).toBe("gate_file");

    const rejected = await verifyOwnerGatePassword("wrong-password");
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.reason).toBe("wrong_password");
  });

  it("reports health without exposing a hash", async () => {
    process.env.OWNER_GATE_PASSWORD_HASH = hashOwnerPassword("owner-gate-health-password");
    const status = await ownerGateStatus();
    expect(status.configured).toBe(true);
    expect(status.sessionReady).toBe(true);
    expect(JSON.stringify(status)).not.toContain("scrypt$");
  });
});
