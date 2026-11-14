import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerCredentialDir } from "./ownerAuth";

/**
 * The project's secrets, sealed with a key that never leaves the owner's home
 * directory. A ZIP of the project carries only ciphertext, so any model that
 * receives it sees no key and no value; the owner panel can open it after the
 * owner password.
 */
export type SealedBlob = { v: 1; alg: "aes-256-gcm"; iv: string; tag: string; data: string };

export function sealedSecretsPath() {
  return join(process.cwd(), "secrets", ".env.enc.json");
}

export function ownerSecretsKeyPath() {
  // The archive ships its key beside the ciphertext (0600), so the keys land in
  // their slots on the new machine without the owner typing them again.
  const bundled = join(process.cwd(), "secrets", "secrets.key");
  if (existsSync(bundled)) return bundled;
  return join(ownerCredentialDir(), "secrets.key");
}

export function sealSecrets(envText: string, key: Buffer): SealedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(envText, "utf8"), cipher.final()]);
  return { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function openSealedBlob(blob: SealedBlob, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]).toString("utf8");
}

export function readSealedSecrets(): { text: string; keys: string[] } | null {
  const file = sealedSecretsPath();
  const keyFile = ownerSecretsKeyPath();
  if (!existsSync(file) || !existsSync(keyFile)) return null;
  try {
    const blob = JSON.parse(readFileSync(file, "utf8")) as SealedBlob;
    const text = openSealedBlob(blob, readFileSync(keyFile));
    const keys = text
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter((name): name is string => Boolean(name));
    return { text, keys };
  } catch {
    return null;
  }
}

/**
 * Startup: decrypt the sealed `.env` and fill only the variables the new host
 * does not define yet. Nothing is written to disk and nothing is logged — just
 * the number of names that were provided.
 */
export function loadSealedSecretsIntoEnv(): number {
  const sealed = sealedSecretPairs();
  if (!sealed) return 0;
  let applied = 0;
  for (const { name, value } of sealed) {
    if (!value || process.env[name]) continue;
    process.env[name] = value;
    applied += 1;
  }
  return applied;
}

export function sealedSecretsSummary() {
  const sealed = readSealedSecrets();
  return {
    available: Boolean(sealed),
    keys: sealed?.keys ?? [],
    file: "secrets/.env.enc.json",
    keyLocation: "خارج المشروع: ~/.zenox-owner/secrets.key",
  };
}

export function sealedSecretPairs(): { name: string; value: string }[] | null {
  const sealed = readSealedSecrets();
  if (!sealed) return null;
  return sealed.keys.map((name) => ({
    name,
    value: sealed.text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "",
  }));
}
