import { createHash } from "node:crypto";
import { createPool, type Pool as MySqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import type { ExternalConnection } from "../drizzle/schema";

type ConnectionKind = ExternalConnection["kind"];

type ConnectionTestResult = {
  connectionId: number;
  kind: ConnectionKind;
  reachable: boolean;
  latencyMs: number;
  status: number;
  message: string;
};

const CONNECT_TIMEOUT_MS = 8_000;
const MAX_POOL_SIZE = 2;
const mysqlPools = new Map<number, { fingerprint: string; pool: MySqlPool }>();
const postgresPools = new Map<number, { fingerprint: string; pool: PgPool }>();

function requireSecret(secretRef: string) {
  const value = process.env[secretRef]?.trim();
  if (!value) throw new Error(`السر ${secretRef} غير مهيأ على الخادم`);
  return value;
}

function secretFingerprint(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function assertSafeHost(host: string) {
  const value = host.trim();
  if (!value || value.length > 255 || /[\r\n]/.test(value) || /@/.test(value)) {
    throw new Error("عنوان الاتصال غير صالح");
  }
  return value;
}

function isDsn(value: string, protocol: "mysql" | "postgres") {
  return value.toLowerCase().startsWith(`${protocol}://`) || (protocol === "postgres" && value.toLowerCase().startsWith("postgresql://"));
}

function buildDatabaseDsn(connection: ExternalConnection, secret: string, protocol: "mysql" | "postgres") {
  if (isDsn(secret, protocol)) return secret;
  const host = assertSafeHost(connection.host).replace(/^https?:\/\//i, "");
  const username = encodeURIComponent(connection.username ?? "");
  const password = encodeURIComponent(secret);
  const database = encodeURIComponent(connection.databaseName ?? "");
  if (!username || !database) throw new Error("يلزم اسم المستخدم واسم قاعدة البيانات عند استخدام السر ككلمة مرور");
  return `${protocol}://${username}:${password}@${host}/${database}`;
}

function mysqlOptions(connection: ExternalConnection, secret: string) {
  return {
    uri: buildDatabaseDsn(connection, secret, "mysql"),
    ssl: connection.sslRequired ? { rejectUnauthorized: true } : undefined,
    connectionLimit: MAX_POOL_SIZE,
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableKeepAlive: true,
  };
}

function postgresOptions(connection: ExternalConnection, secret: string) {
  return {
    connectionString: buildDatabaseDsn(connection, secret, "postgres"),
    ssl: connection.sslRequired ? { rejectUnauthorized: true } : false,
    max: MAX_POOL_SIZE,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
  };
}

async function testMysql(connection: ExternalConnection, secret: string) {
  const fingerprint = secretFingerprint(secret);
  const current = mysqlPools.get(connection.id);
  if (current && current.fingerprint !== fingerprint) {
    await current.pool.end();
    mysqlPools.delete(connection.id);
  }
  const pool = mysqlPools.get(connection.id)?.pool ?? createPool(mysqlOptions(connection, secret));
  mysqlPools.set(connection.id, { fingerprint, pool });
  try {
    await pool.query("SELECT 1 AS zanox_health");
  } catch (error) {
    mysqlPools.delete(connection.id);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

async function testPostgres(connection: ExternalConnection, secret: string) {
  const fingerprint = secretFingerprint(secret);
  const current = postgresPools.get(connection.id);
  if (current && current.fingerprint !== fingerprint) {
    await current.pool.end();
    postgresPools.delete(connection.id);
  }
  const pool = postgresPools.get(connection.id)?.pool ?? new PgPool(postgresOptions(connection, secret));
  postgresPools.set(connection.id, { fingerprint, pool });
  try {
    await pool.query("SELECT 1 AS zanox_health");
  } catch (error) {
    postgresPools.delete(connection.id);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function requireHttps(url: URL) {
  if (url.protocol !== "https:") throw new Error("الاتصال الخارجي يجب أن يستخدم HTTPS");
}

async function testHttpConnection(connection: ExternalConnection, secret: string, supabase: boolean) {
  let url: URL;
  try {
    url = new URL(connection.host);
  } catch {
    throw new Error("عنوان HTTP الخارجي غير صالح");
  }
  requireHttps(url);
  const target = supabase ? new URL("rest/v1/", `${url.origin}/`) : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (secret) {
      headers.authorization = `Bearer ${secret}`;
      headers["x-api-key"] = secret;
    }
    const response = await fetch(target, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    if (response.status >= 400) throw new Error(`الخدمة أعادت الحالة ${response.status}`);
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

function redactError(error: unknown, secret: string) {
  const message = error instanceof Error ? error.message : "تعذر اختبار الاتصال";
  return message
    .replaceAll(secret, "[محجوب]")
    .replace(/(password|passwd|token|secret|key)=?[^\s&]+/gi, "$1=[محجوب]")
    .replace(/(mysql|postgres(?:ql)?:\/\/)[^\s]+/gi, "$1[محجوب]");
}

export async function testExternalConnection(connection: ExternalConnection): Promise<ConnectionTestResult> {
  if (!connection.enabled) throw new Error("الاتصال معطل في إعدادات ZENOX");
  const secret = requireSecret(connection.secretRef);
  const startedAt = Date.now();

  try {
    let status = 200;
    if (connection.kind === "mysql") await testMysql(connection, secret);
    else if (connection.kind === "postgres") await testPostgres(connection, secret);
    else if (connection.kind === "supabase") status = await testHttpConnection(connection, secret, true);
    else status = await testHttpConnection(connection, secret, false);

    return {
      connectionId: connection.id,
      kind: connection.kind,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      status,
      message: "تم اختبار الاتصال بنجاح دون حفظ السر أو إظهاره.",
    };
  } catch (error) {
    return {
      connectionId: connection.id,
      kind: connection.kind,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      status: 0,
      message: redactError(error, secret),
    };
  }
}
