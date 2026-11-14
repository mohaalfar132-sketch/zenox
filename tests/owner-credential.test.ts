import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashOwnerPassword, ownerPasswordFile, saveOwnerHash, storedOwnerHash, verifyOwnerPassword } from "../server/_core/ownerAuth";

let dir = "";
const previous = { dir: process.env.ZENOX_OWNER_DIR, file: process.env.OWNER_PASSWORD_FILE, hash: process.env.OWNER_PASSWORD_HASH };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenox-owner-"));
  process.env.ZENOX_OWNER_DIR = dir;
  delete process.env.OWNER_PASSWORD_FILE;
  delete process.env.OWNER_PASSWORD_HASH;
});

afterEach(() => {
  if (previous.dir === undefined) delete process.env.ZENOX_OWNER_DIR; else process.env.ZENOX_OWNER_DIR = previous.dir;
  if (previous.file === undefined) delete process.env.OWNER_PASSWORD_FILE; else process.env.OWNER_PASSWORD_FILE = previous.file;
  if (previous.hash === undefined) delete process.env.OWNER_PASSWORD_HASH; else process.env.OWNER_PASSWORD_HASH = previous.hash;
  rmSync(dir, { recursive: true, force: true });
});

describe("the owner credential stays out of the project", () => {
  it("never stores the hash inside the project directory by default", () => {
    delete process.env.ZENOX_OWNER_DIR;
    const file = ownerPasswordFile();
    expect(file.includes(`.zenox-owner${sep}credential.json`)).toBe(true);
    expect(file.startsWith(process.cwd() + sep)).toBe(false);
  });

  it("saves a hash file readable by the owner only", () => {
    const hash = hashOwnerPassword("a-long-owner-password");
    saveOwnerHash(hash);
    const file = ownerPasswordFile();
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(storedOwnerHash()).toBe(hash);
    expect(verifyOwnerPassword("a-long-owner-password", hash)).toBe(true);
    expect(verifyOwnerPassword("wrong", hash)).toBe(false);
    // The password itself is never written.
    expect(readFileSync(file, "utf8")).not.toContain("a-long-owner-password");
  });
});
