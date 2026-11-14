import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ownerSessionDir, ownerSigningSecret } from "./_core/ownerSigningSecret";

/**
 * Google OAuth client credentials entered from the owner panel. They are kept
 * encrypted with the owner's persistent signing key, outside the project, so a
 * copied archive never carries the client secret. The values are never
 * returned to the client or written to logs.
 */
type StoredCredentials = {
  v: 1;
  iv: string;
  tag: string;
  data: string;
};

type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  source: "env" | "file";
};

let cached: GoogleCredentials | null = null;
let loaded = false;

export function googleCredentialFile() {
  const configured = process.env.ZENOX_GOOGLE_CREDENTIAL_FILE?.trim();
  return configured && configured.length > 0
    ? configured
    : join(ownerSessionDir(), "google-oauth.json");
}

function credentialKey() {
  const secret = ownerSigningSecret();
  if (!secret) return null;
  return createHash("sha256")
    .update("zenox-google-oauth-client:")
    .update(Buffer.from(secret))
    .digest();
}

function normalizeClientId(raw: string) {
  return raw.replace(/^\uFEFF/, "").replace(/\s+/g, "").trim();
}

function normalizeClientSecret(raw: string) {
  return raw.replace(/^\uFEFF/, "").replace(/\s+/g, "").trim();
}

function validClientId(value: string) {
  return /^[A-Za-z0-9._-]{20,300}$/.test(value) && value.endsWith(".apps.googleusercontent.com");
}

function validClientSecret(value: string) {
  return /^[A-Za-z0-9_-]{10,300}$/.test(value);
}

function encrypt(value: string, key: Buffer): StoredCredentials {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url"),
  };
}

function decrypt(stored: StoredCredentials, key: Buffer) {
  if (stored.v !== 1) throw new Error("unsupported credential version");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(stored.data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function readStored(): GoogleCredentials | null {
  const file = googleCredentialFile();
  if (!existsSync(file)) return null;
  const key = credentialKey();
  if (!key) return null;
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as StoredCredentials;
    const parsed = JSON.parse(decrypt(stored, key)) as { clientId?: unknown; clientSecret?: unknown };
    const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
    const clientSecret = typeof parsed.clientSecret === "string" ? parsed.clientSecret : "";
    if (!validClientId(clientId) || !validClientSecret(clientSecret)) return null;
    return { clientId, clientSecret, source: "file" };
  } catch {
    return null;
  }
}

function apply(credentials: GoogleCredentials) {
  process.env.GOOGLE_CLIENT_ID = credentials.clientId;
  process.env.GOOGLE_CLIENT_SECRET = credentials.clientSecret;
  cached = credentials;
  loaded = true;
}

/** Environment credentials win; otherwise the encrypted owner file is loaded. */
export function ensureGoogleCredentials() {
  // A value saved from the owner panel stays authoritative for this process,
  // even though it is also copied into process.env for the OAuth helpers.
  if (cached) return;
  const envId = normalizeClientId(process.env.GOOGLE_CLIENT_ID ?? "");
  const envSecret = normalizeClientSecret(process.env.GOOGLE_CLIENT_SECRET ?? "");
  if (validClientId(envId) && validClientSecret(envSecret)) {
    apply({ clientId: envId, clientSecret: envSecret, source: "env" });
    return;
  }
  if (loaded) return;
  const stored = readStored();
  if (stored) apply(stored);
  loaded = true;
}

export function googleCredentialSource(): "env" | "file" | "none" {
  ensureGoogleCredentials();
  return cached?.source ?? "none";
}

export function saveGoogleCredentials(input: { clientId: string; clientSecret: string }) {
  const clientId = normalizeClientId(input.clientId);
  const clientSecret = normalizeClientSecret(input.clientSecret);
  if (!validClientId(clientId)) {
    throw new Error("Google Client ID غير صالح. انسخه كاملًا وينتهي بـ .apps.googleusercontent.com");
  }
  if (!validClientSecret(clientSecret)) {
    throw new Error("Google Client Secret غير صالح. انسخه كاملًا بلا مسافات أو علامات اقتباس.");
  }

  const key = credentialKey();
  if (!key) throw new Error("مفتاح تشفير ZENOX غير جاهز؛ أعد فتح جلسة ZENOX.");

  const file = googleCredentialFile();
  mkdirSync(ownerSessionDir(), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify(encrypt(JSON.stringify({ clientId, clientSecret }), key));
  writeFileSync(temp, payload, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);

  apply({ clientId, clientSecret, source: "file" });
  return { saved: true as const, source: "file" as const };
}

/** Test seam: forget the in-process copy so the encrypted file is read again. */
export function resetGoogleCredentialsCache() {
  cached = null;
  loaded = false;
}
