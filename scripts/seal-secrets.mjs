#!/usr/bin/env node
/**
 * Seals the project's .env into an AES-256-GCM blob that only the owner can open.
 * The 32-byte key lives outside the project (ZENOX_OWNER_DIR/secrets.key, 0600),
 * so a delivered ZIP cannot reveal a single value. The owner panel decrypts it
 * after the owner password, and never prints it to logs.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ownerDir = process.env.ZENOX_OWNER_DIR?.trim() || join(homedir(), ".zenox-owner");
const keyPath = join(ownerDir, "secrets.key");
const envPath = join(process.cwd(), ".env");
const outPath = join(process.cwd(), "secrets", ".env.enc.json");

if (!existsSync(envPath)) {
  console.error("No .env to seal.");
  process.exit(1);
}

mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
let key;
if (existsSync(keyPath)) {
  key = readFileSync(keyPath);
} else {
  key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
}
if (key.length !== 32) {
  console.error("secrets.key must be exactly 32 bytes.");
  process.exit(1);
}

const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const data = Buffer.concat([cipher.update(readFileSync(envPath)), cipher.final()]);
const tag = cipher.getAuthTag();

mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
writeFileSync(
  outPath,
  JSON.stringify(
    { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: tag.toString("base64"), data: data.toString("base64") },
    null,
    2,
  ),
  { mode: 0o600 },
);

const names = readFileSync(envPath, "utf8")
  .split("\n")
  .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
  .filter(Boolean);
console.log(`Sealed ${names.length} variables into ${outPath}`);
console.log(`Key stays outside the project: ${keyPath}`);
