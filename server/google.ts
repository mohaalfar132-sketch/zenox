import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import { getDb } from "./db";
import { ownerSessionDir, ownerSigningSecret } from "./_core/ownerSigningSecret";
import { ensureGoogleCredentials, googleCredentialSource } from "./googleCredentials";
import { googleAccounts, type GoogleAccount } from "../drizzle/schema";

export const GOOGLE_COOKIE = "zx_google";
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive",
] as const;

/** Existing sessions created before the full-control upgrade must reconnect once. */
const REQUIRED_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive",
] as const;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type GoogleProfile = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

/**
 * A single-owner deployment may run without MySQL. The OAuth link then lives in
 * a 0600 file outside the project, encrypted with the same owner session key as
 * the database columns, so Gmail/Drive keep working after a restart.
 */
type FileAccount = {
  id: number;
  googleSub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  refreshToken: string;
  accessToken: string | null;
  accessExpiresAt: string | null;
  scopes: string | null;
  createdAt: string;
  updatedAt: string;
};

function googleAccountFile() {
  const configured = process.env.ZENOX_GOOGLE_ACCOUNT_FILE?.trim();
  return configured && configured.length > 0
    ? configured
    : join(ownerSessionDir(), "google-account.json");
}

function readFileAccount(sub?: string): GoogleAccount | null {
  const file = googleAccountFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as FileAccount;
    if (!parsed?.googleSub || (sub && parsed.googleSub !== sub)) return null;
    return {
      id: Number(parsed.id) || 1,
      googleSub: parsed.googleSub,
      email: parsed.email ?? null,
      name: parsed.name ?? null,
      picture: parsed.picture ?? null,
      refreshToken: parsed.refreshToken,
      accessToken: parsed.accessToken ?? null,
      accessExpiresAt: parsed.accessExpiresAt ? new Date(parsed.accessExpiresAt) : null,
      scopes: parsed.scopes ?? null,
      createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(0),
      updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : new Date(0),
    };
  } catch {
    return null;
  }
}

function writeFileAccount(account: Omit<FileAccount, "updatedAt">) {
  const dir = ownerSessionDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = googleAccountFile();
  const temp = `${file}.${process.pid}.tmp`;
  const payload: FileAccount = { ...account, updatedAt: new Date().toISOString() };
  writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function configError(message: string) {
  return new TRPCError({ code: "PRECONDITION_FAILED", message });
}

function authError(message: string) {
  return new TRPCError({ code: "UNAUTHORIZED", message });
}

export function googleConfigured() {
  ensureGoogleCredentials();
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

function googleSecret(name: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET") {
  ensureGoogleCredentials();
  const value = process.env[name]?.trim();
  if (!value) throw configError(`لم يُضبط ${name} على الخادم بعد.`);
  return value;
}

/** Same-origin path only: no open redirects after the Google callback. */
export function safeReturnTo(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw.slice(0, 500);
}

function requestOrigin(req: Request) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

export function googleRedirectUri(req: Request) {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (configured) return configured;
  return `${requestOrigin(req)}/api/google/callback`;
}

function googleSecretBytes() {
  const configured =
    process.env.GOOGLE_TOKEN_SECRET?.trim() ||
    process.env.OWNER_SESSION_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    process.env.MANUS_JWT_SECRET?.trim();
  if (configured) return new TextEncoder().encode(configured);
  const generated = ownerSigningSecret();
  if (!generated) throw configError("مفتاح تشفير جلسات Google غير مضبوط على الخادم.");
  return generated;
}

function tokenKey() {
  return createHash("sha256")
    .update(Buffer.from("zenox-google:"))
    .update(googleSecretBytes())
    .digest();
}

function encryptToken(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptToken(value: string | null | undefined) {
  if (!value) return "";
  const [version, ivB64, tagB64, dataB64] = value.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw authError("بيانات ربط Google غير صالحة. أعد الربط.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw authError("تعذر فك تشفير جلسة Google. أعد الربط.");
  }
}

function sessionKey() {
  return googleSecretBytes();
}

export async function createGoogleSession(profile: GoogleProfile) {
  return new SignJWT({ kind: "google", sub: profile.sub, email: profile.email ?? "" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(sessionKey());
}

export async function readGoogleSession(req: Request): Promise<{ sub: string; email: string } | null> {
  const token = req.headers.cookie ? parseCookieHeader(req.headers.cookie)[GOOGLE_COOKIE] : undefined;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ["HS256"] });
    if (payload.kind !== "google" || typeof payload.sub !== "string" || !payload.sub) return null;
    return { sub: payload.sub, email: String(payload.email ?? "") };
  } catch {
    return null;
  }
}

export function clearGoogleCookie(res: Response) {
  const secure = process.env.NODE_ENV === "production";
  res.clearCookie(GOOGLE_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: secure ? "none" : "lax",
    secure,
  });
}

export function setGoogleCookie(res: Response, token: string) {
  const secure = process.env.NODE_ENV === "production";
  res.cookie(GOOGLE_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: secure ? "none" : "lax",
    secure,
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export async function createGoogleState(returnTo: string) {
  return new SignJWT({ kind: "google_state", returnTo: safeReturnTo(returnTo), nonce: randomBytes(12).toString("base64url") })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(sessionKey());
}

export async function readGoogleState(state: string) {
  try {
    const { payload } = await jwtVerify(state, sessionKey(), { algorithms: ["HS256"] });
    if (payload.kind !== "google_state") return null;
    return { returnTo: safeReturnTo(payload.returnTo) };
  } catch {
    return null;
  }
}

export function googleAuthUrl(input: { redirectUri: string; state: string }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", googleSecret("GOOGLE_CLIENT_ID"));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function exchangeCode(code: string, redirectUri: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: googleSecret("GOOGLE_CLIENT_ID"),
    client_secret: googleSecret("GOOGLE_CLIENT_SECRET"),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok || data.error || !data.access_token) {
    throw authError(data.error_description || data.error || `رفض Google طلب الربط (${response.status}).`);
  }
  return data;
}

async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: googleSecret("GOOGLE_CLIENT_ID"),
    client_secret: googleSecret("GOOGLE_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok || data.error || !data.access_token) {
    throw authError("انتهت صلاحية ربط Google. اضغط «إعادة الربط».");
  }
  return data;
}

async function googleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = (await response.json().catch(() => ({}))) as Partial<GoogleProfile>;
  if (!response.ok || !data.sub) throw authError("تعذر قراءة حساب Google.");
  return {
    sub: data.sub,
    email: typeof data.email === "string" ? data.email : undefined,
    name: typeof data.name === "string" ? data.name : undefined,
    picture: typeof data.picture === "string" ? data.picture : undefined,
  };
}

export async function connectGoogleAccount(code: string, redirectUri: string) {
  const token = await exchangeCode(code, redirectUri);
  const profile = await googleProfile(token.access_token!);
  const db = await getDb();
  const existing = db
    ? await db.select().from(googleAccounts).where(eq(googleAccounts.googleSub, profile.sub)).limit(1)
    : [readFileAccount(profile.sub)].filter((row): row is GoogleAccount => Boolean(row));

  const refreshToken = token.refresh_token?.trim() || existing[0]?.refreshToken || "";
  if (!refreshToken) {
    throw authError("لم يمنح Google refresh token. أعد الربط ووافق على الوصول الدائم.");
  }

  const values = {
    googleSub: profile.sub,
    email: profile.email ?? null,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
    refreshToken: encryptToken(refreshToken),
    accessToken: encryptToken(token.access_token!),
    accessExpiresAt: new Date(Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000),
    scopes: token.scope ?? GOOGLE_SCOPES.join(" "),
  };

  if (db) {
    if (existing[0]) {
      await db.update(googleAccounts).set(values).where(eq(googleAccounts.googleSub, profile.sub));
    } else {
      await db.insert(googleAccounts).values(values);
    }
  } else {
    writeFileAccount({
      id: existing[0]?.id ?? 1,
      googleSub: profile.sub,
      email: values.email,
      name: values.name,
      picture: values.picture,
      refreshToken: values.refreshToken,
      accessToken: values.accessToken,
      accessExpiresAt: values.accessExpiresAt.toISOString(),
      scopes: values.scopes,
      createdAt: existing[0]?.createdAt?.toISOString() ?? new Date().toISOString(),
    });
  }

  return profile;
}

async function accountFor(sub: string): Promise<GoogleAccount | null> {
  const db = await getDb();
  if (!db) return readFileAccount(sub);
  const rows = await db.select().from(googleAccounts).where(eq(googleAccounts.googleSub, sub)).limit(1);
  return rows[0] ?? null;
}

async function accessTokenFor(account: GoogleAccount) {
  const expiresAt = account.accessExpiresAt ? new Date(account.accessExpiresAt).getTime() : 0;
  if (account.accessToken && expiresAt > Date.now() + 90_000) {
    return decryptToken(account.accessToken);
  }
  const refreshToken = decryptToken(account.refreshToken);
  if (!refreshToken) throw authError("انتهت صلاحية ربط Google. أعد الربط.");
  const refreshed = await refreshAccessToken(refreshToken);
  const db = await getDb();
  const accessExpiresAt = new Date(Date.now() + Math.max(60, refreshed.expires_in ?? 3600) * 1000);
  if (db) {
    await db
      .update(googleAccounts)
      .set({ accessToken: encryptToken(refreshed.access_token!), accessExpiresAt })
      .where(and(eq(googleAccounts.googleSub, account.googleSub), eq(googleAccounts.id, account.id)));
  } else {
    writeFileAccount({
      id: account.id,
      googleSub: account.googleSub,
      email: account.email ?? null,
      name: account.name ?? null,
      picture: account.picture ?? null,
      refreshToken: account.refreshToken,
      accessToken: encryptToken(refreshed.access_token!),
      accessExpiresAt: accessExpiresAt.toISOString(),
      scopes: account.scopes ?? null,
      createdAt: account.createdAt.toISOString(),
    });
  }
  return refreshed.access_token!;
}

async function googleFetch<T>(sub: string, url: string, init?: RequestInit): Promise<T> {
  const account = await accountFor(sub);
  if (!account) throw authError("اربط حساب Google أولًا.");
  const token = await accessTokenFor(account);
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) {
    const message = data.error?.message || `رفض Google الطلب (${response.status}).`;
    throw configError(message);
  }
  return data;
}

export async function googleAccountEmail(sub: string): Promise<string | null> {
  const account = await accountFor(sub).catch(() => null);
  return account?.email ?? null;
}

export async function googleStatus(req: Request, sub: string | null) {
  const configured = googleConfigured();
  const account = configured && sub ? await accountFor(sub).catch(() => null) : null;
  const scopes = account?.scopes ? account.scopes.split(/\s+/).filter(Boolean) : [];
  let tokenReadable = false;
  if (account) {
    try {
      tokenReadable = Boolean(decryptToken(account.refreshToken) || decryptToken(account.accessToken));
    } catch {
      tokenReadable = false;
    }
  }
  const permissionsComplete = scopes.length > 0 && REQUIRED_GOOGLE_SCOPES.every((scope) => scopes.includes(scope));
  return {
    configured,
    connected: Boolean(account),
    needsReconnect: Boolean(account && (!tokenReadable || !permissionsComplete)),
    permissionsComplete,
    email: account?.email ?? null,
    name: account?.name ?? null,
    picture: account?.picture ?? null,
    scopes,
    redirectUri: googleRedirectUri(req),
    credentialSource: googleCredentialSource(),
    connectPath: "/api/google/start",
  };
}

export async function disconnectGoogle(sub: string) {
  const db = await getDb();
  if (db) await db.delete(googleAccounts).where(eq(googleAccounts.googleSub, sub));
  else if (readFileAccount(sub) && existsSync(googleAccountFile())) unlinkSync(googleAccountFile());
  return { disconnected: true };
}

type GmailListResponse = { messages?: Array<{ id: string; threadId?: string }> }; 
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name?: string; value?: string }> };
};

function header(message: GmailMessage, name: string) {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeGmailBody(data?: string) {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectGmailBodies(part: GmailPart | undefined, output: { text: string[]; html: string[] }) {
  if (!part) return;
  if (part.mimeType === "text/plain" && part.body?.data) output.text.push(decodeGmailBody(part.body.data));
  if (part.mimeType === "text/html" && part.body?.data) output.html.push(decodeGmailBody(part.body.data));
  for (const child of part.parts ?? []) collectGmailBodies(child, output);
}

export async function getGmailMessage(sub: string, id: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw configError("معرّف الرسالة غير صالح.");
  const params = new URLSearchParams({ format: "full" });
  const message = await googleFetch<GmailMessage & { payload?: GmailPart }>(
    sub,
    `${GMAIL_API}/messages/${encodeURIComponent(id)}?${params.toString()}`,
  );
  const bodies = { text: [] as string[], html: [] as string[] };
  collectGmailBodies(message.payload, bodies);
  const text = bodies.text.join("\n").trim().slice(0, 60_000);
  const html = bodies.html.join("\n").trim().slice(0, 120_000);
  return {
    id: message.id,
    threadId: message.threadId ?? "",
    from: header(message, "From"),
    to: header(message, "To"),
    cc: header(message, "Cc"),
    subject: header(message, "Subject") || "(بدون موضوع)",
    date: header(message, "Date"),
    snippet: message.snippet ?? "",
    labelIds: message.labelIds ?? [],
    unread: Boolean(message.labelIds?.includes("UNREAD")),
    text,
    html,
    url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
  };
}

export type GmailAction = "read" | "unread" | "archive" | "unarchive" | "trash" | "untrash" | "delete";

export async function modifyGmail(sub: string, id: string, action: GmailAction) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw configError("معرّف الرسالة غير صالح.");
  const base = `${GMAIL_API}/messages/${encodeURIComponent(id)}`;
  if (action === "delete") {
    await googleFetch<Record<string, never>>(sub, base, { method: "DELETE" });
    return { ok: true, action };
  }
  if (action === "trash" || action === "untrash") {
    await googleFetch<Record<string, never>>(sub, `${base}/${action}`, { method: "POST" });
    return { ok: true, action };
  }
  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];
  if (action === "read") removeLabelIds.push("UNREAD");
  if (action === "unread") addLabelIds.push("UNREAD");
  if (action === "archive") removeLabelIds.push("INBOX");
  if (action === "unarchive") addLabelIds.push("INBOX");
  await googleFetch<Record<string, never>>(sub, `${base}/modify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
  return { ok: true, action };
}

export async function listGmail(sub: string, input: { q?: string; max?: number }) {
  const max = Math.min(Math.max(Math.trunc(input.max ?? 12), 1), 25);
  const params = new URLSearchParams({ maxResults: String(max) });
  if (input.q?.trim()) params.set("q", input.q.trim().slice(0, 300));
  const list = await googleFetch<GmailListResponse>(sub, `${GMAIL_API}/messages?${params.toString()}`);
  const ids = (list.messages ?? []).map((message) => message.id);
  const messages = await Promise.all(
    ids.map(async (id) => {
      const params = new URLSearchParams({ format: "metadata" });
      params.append("metadataHeaders", "From");
      params.append("metadataHeaders", "Subject");
      params.append("metadataHeaders", "Date");
      const message = await googleFetch<GmailMessage>(sub, `${GMAIL_API}/messages/${encodeURIComponent(id)}?${params.toString()}`);
      return {
        id: message.id,
        threadId: message.threadId ?? "",
        from: header(message, "From"),
        subject: header(message, "Subject") || "(بدون موضوع)",
        date: header(message, "Date"),
        snippet: message.snippet ?? "",
        unread: Boolean(message.labelIds?.includes("UNREAD")),
        url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
      };
    }),
  );
  return messages;
}

function encodeHeader(value: string) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function wrapBase64(value: string) {
  return value.replace(/(.{76})/g, "$1\r\n");
}

export async function sendGmail(sub: string, input: { to: string; subject: string; body: string }) {
  const body = Buffer.from(input.body, "utf8").toString("base64");
  const mime = [
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(body),
  ].join("\r\n");
  const raw = Buffer.from(mime, "utf8").toString("base64url");
  const result = await googleFetch<{ id?: string; threadId?: string }>(sub, `${GMAIL_API}/messages/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  return { sent: true, id: result.id ?? "", threadId: result.threadId ?? "" };
}

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  iconLink?: string;
  trashed?: boolean;
};

type DriveListResponse = { files?: DriveFile[] };

function mapDriveFile(file: DriveFile) {
  return {
    id: file.id,
    name: file.name || "(بدون اسم)",
    mimeType: file.mimeType || "application/octet-stream",
    size: Number(file.size ?? 0),
    modifiedTime: file.modifiedTime ?? "",
    trashed: Boolean(file.trashed),
    url: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`,
  };
}

export async function listDrive(sub: string, input: { q?: string; max?: number }) {
  const max = Math.min(Math.max(Math.trunc(input.max ?? 15), 1), 30);
  const params = new URLSearchParams({
    pageSize: String(max),
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink)",
  });
  const query = input.q?.trim();
  if (query) {
    const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'").slice(0, 200);
    params.set("q", `name contains '${escaped}' and trashed = false`);
  }
  const result = await googleFetch<DriveListResponse>(sub, `${DRIVE_API}?${params.toString()}`);
  return (result.files ?? []).map(mapDriveFile);
}

export async function createDriveFolder(sub: string, input: { name: string; parentId?: string }) {
  const metadata: Record<string, unknown> = {
    name: input.name.slice(0, 200),
    mimeType: "application/vnd.google-apps.folder",
  };
  if (input.parentId?.trim()) metadata.parents = [input.parentId.trim()];
  const file = await googleFetch<DriveFile>(sub, `${DRIVE_API}?fields=id,name,mimeType,modifiedTime,webViewLink`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
  return mapDriveFile(file);
}

export async function updateDriveFile(
  sub: string,
  input: { id: string; name?: string; trashed?: boolean },
) {
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(input.id)) throw configError("معرّف ملف Drive غير صالح.");
  const patch: Record<string, unknown> = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 200);
  if (typeof input.trashed === "boolean") patch.trashed = input.trashed;
  if (!Object.keys(patch).length) throw configError("لا يوجد تغيير مطلوب.");
  const file = await googleFetch<DriveFile>(
    sub,
    `${DRIVE_API}/${encodeURIComponent(input.id)}?fields=id,name,mimeType,size,modifiedTime,webViewLink,trashed`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  return mapDriveFile(file);
}

export async function deleteDriveFile(sub: string, id: string) {
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(id)) throw configError("معرّف ملف Drive غير صالح.");
  await googleFetch<Record<string, never>>(sub, `${DRIVE_API}/${encodeURIComponent(id)}`, { method: "DELETE" });
  return { ok: true };
}

export async function shareDriveFile(
  sub: string,
  input: { id: string; role: "reader" | "commenter" | "writer"; type: "user" | "group" | "domain" | "anyone"; emailAddress?: string },
) {
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(input.id)) throw configError("معرّف ملف Drive غير صالح.");
  if (input.type !== "anyone" && !input.emailAddress?.trim()) {
    throw configError("أدخل بريد المستخدم أو النطاق للمشاركة.");
  }
  const body: Record<string, unknown> = { role: input.role, type: input.type };
  if (input.emailAddress?.trim()) body.emailAddress = input.emailAddress.trim();
  const permission = await googleFetch<{ id?: string }>(
    sub,
    `${DRIVE_API}/${encodeURIComponent(input.id)}/permissions?sendNotificationEmail=false&fields=id`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { ok: true, permissionId: permission.id ?? "" };
}

function escapeMultipart(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

export async function uploadTextToDrive(sub: string, input: { name: string; text: string; mimeType?: string }) {
  const boundary = `zenox_${randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: input.name.slice(0, 200),
    mimeType: input.mimeType || "text/plain",
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, "utf8"),
    Buffer.from(
      `--${boundary}\r\nContent-Type: ${escapeMultipart(input.mimeType || "text/plain")}\r\n\r\n${input.text}\r\n`,
      "utf8",
    ),
    Buffer.from(`--${boundary}--`, "utf8"),
  ]);
  const result = await googleFetch<{ id?: string; name?: string; webViewLink?: string }>(
    sub,
    `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name,webViewLink`,
    {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  return {
    id: result.id ?? "",
    name: result.name ?? input.name,
    url: result.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(result.id ?? "")}/view`,
  };
}
