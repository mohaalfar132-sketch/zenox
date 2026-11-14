import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseCookieHeader } from "cookie";
import type { CookieOptions, Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { getSessionCookieOptions } from "./cookies";
import { getOwnerCredentialHash, saveOwnerCredentialHash } from "../db";
import { ownerSigningSecret } from "./ownerSigningSecret";

export const OWNER_COOKIE = "zx_owner";
const OWNER_ID = "primary";
// The owner is never time-boxed: 30 days by default, configurable.
const SESSION_TTL_MS = Number(process.env.OWNER_SESSION_HOURS ?? 720) * 60 * 60 * 1000;

/**
 * The owner credential lives in the owner's home directory, never inside the
 * project: the code can be shared, zipped or handed to another AI, and the hash
 * is not part of it. Mode 0700/0600 keeps it readable by the owner alone.
 */
export function ownerCredentialDir() {
  const configured = process.env.ZENOX_OWNER_DIR?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".zenox-owner");
}

export function ownerPasswordFile() {
  const configured = process.env.OWNER_PASSWORD_FILE?.trim();
  return configured && configured.length > 0 ? configured : join(ownerCredentialDir(), "credential.json");
}

/**
 * A delivered archive carries the owner's credential hash beside the sealed
 * secrets. On a fresh machine it is installed into the owner's home directory
 * (outside the project, 0600) so the same password keeps working — the project
 * folder itself never stores the hash.
 */
export function bootstrapOwnerCredential() {
  if (process.env.OWNER_PASSWORD_FILE?.trim()) return false;
  const target = ownerPasswordFile();
  if (existsSync(target)) return false;
  const bundled = join(process.cwd(), "secrets", "owner-credential.json");
  if (!existsSync(bundled)) return false;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, readFileSync(bundled), { mode: 0o600 });
    chmodSync(target, 0o600);
    console.log("[owner] installed the bundled owner credential outside the project");
    return true;
  } catch {
    return false;
  }
}

function passwordFile() {
  return ownerPasswordFile();
}

/** Older builds kept the hash inside the project; move it out on first read. */
function migrateLegacyFile() {
  if (process.env.OWNER_PASSWORD_FILE?.trim()) return;
  const legacy = join(process.cwd(), ".zenox-owner.json");
  const target = ownerPasswordFile();
  if (!existsSync(legacy) || existsSync(target)) return;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(legacy, target);
    chmodSync(target, 0o600);
    console.log("[owner] moved the owner credential out of the project directory");
  } catch {
    // Keep serving: the legacy file still answers reads.
  }
}

/** Env hash wins; otherwise the hash created from the app's first-run screen. */
export function storedOwnerHash(): string | null {
  migrateLegacyFile();
  const fromEnv = process.env.OWNER_PASSWORD_HASH?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = passwordFile();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { hash?: unknown };
    return typeof parsed.hash === "string" && parsed.hash.length > 0 ? parsed.hash : null;
  } catch {
    return null;
  }
}

export function isOwnerConfigured() {
  return Boolean(storedOwnerHash());
}

export type OwnerHashSource = "database" | "env" | "file";

/**
 * Resolves the owner credential. The database is the source of truth, then the
 * environment hash, then the first-run file. The source is returned so the
 * client and smoke checks can prove where the password actually lives.
 */
export async function resolveOwnerHash(): Promise<{ hash: string; source: OwnerHashSource } | null> {
  const fromDb = await getOwnerCredentialHash().catch(() => null);
  if (fromDb?.hash) return { hash: fromDb.hash, source: "database" };
  const fromEnv = process.env.OWNER_PASSWORD_HASH?.trim();
  if (fromEnv) return { hash: fromEnv, source: "env" };
  const fromFile = storedOwnerHash();
  return fromFile ? { hash: fromFile, source: "file" } : null;
}

/** Writes to the database when it is reachable; otherwise falls back to the 0600 file. */
export async function persistOwnerHash(hash: string): Promise<OwnerHashSource> {
  if (process.env.DATABASE_URL) {
    try {
      await saveOwnerCredentialHash(hash);
      return "database";
    } catch {
      console.warn("[owner] database write failed; falling back to local file storage");
    }
  }
  saveOwnerHash(hash);
  return "file";
}

/** Removes the stored hash so the owner can set a new password once. */
export function clearOwnerPassword() {
  const file = passwordFile();
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // Nothing to clear.
  }
  return { cleared: !existsSync(file), file };
}

export function hashOwnerPassword(password: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Persists only the scrypt hash, never the password. File mode is 0600. */
export function saveOwnerHash(hash: string) {
  const file = passwordFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ hash, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function verifyOwnerPassword(password: string, stored: string | undefined | null) {
  if (!stored) return false;
  const parts = stored.trim().split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function secretKey(): Uint8Array | null {
  return ownerSigningSecret();
}

export function ownerCookieOptions(req: Request): CookieOptions {
  return {
    ...getSessionCookieOptions(req),
    maxAge: SESSION_TTL_MS,
    httpOnly: true,
  };
}

export async function createOwnerSession(): Promise<string | null> {
  const key = secretKey();
  if (!key) return null;
  return new SignJWT({ kind: "owner", ownerId: OWNER_ID })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + SESSION_TTL_MS) / 1000))
    .sign(key);
}

export async function readOwnerSession(req: Request): Promise<{ ownerId: string } | null> {
  const key = secretKey();
  if (!key) return null;
  const token = req.headers.cookie ? parseCookieHeader(req.headers.cookie)[OWNER_COOKIE] : undefined;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (payload.kind !== "owner") return null;
    return { ownerId: String(payload.ownerId ?? OWNER_ID) };
  } catch {
    return null;
  }
}

/** Kept for compatibility; the owner is not throttled any more. */
export function allowOwnerAttempt(_ip: string) {
  void _ip;
  return true;
}

export function resetOwnerAttempts(_ip: string) {
  void _ip;
}
