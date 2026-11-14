#!/usr/bin/env node
/**
 * ZENOX preflight: everything that must be true BEFORE the server starts.
 * Usage: pnpm preflight
 * Exit 0 = safe to start. Exit 1 = at least one blocking problem.
 * Never prints secret values.
 */
import "dotenv/config";
import { existsSync, readdirSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import net from "node:net";
import mysql from "mysql2/promise";

const results = [];
const pass = (name, detail = "") => results.push({ level: "pass", name, detail });
const fail = (name, detail = "") => results.push({ level: "fail", name, detail });
const warn = (name, detail = "") => results.push({ level: "warn", name, detail });

const MIGRATION_DIR = join(process.cwd(), "drizzle");
const PORT = Number(process.env.PORT || 3000);
const WORKSPACE = resolve(process.env.ZENOX_WORKSPACE?.trim() || process.cwd());

function migrationFiles() {
  return existsSync(MIGRATION_DIR)
    ? readdirSync(MIGRATION_DIR).filter((n) => n.endsWith(".sql")).sort()
    : [];
}

async function checkDatabase() {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    fail("DATABASE_URL", "غير مضبوط — قاعدة البيانات لن تعمل ولن تُكتب أي جلسة أو طلب تعديل");
    return;
  }
  if (!/^mysql(2)?:\/\//.test(raw)) {
    fail("DATABASE_URL", "يجب أن يبدأ بـ mysql:// (Drizzle مثبّت على MySQL)");
    return;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("DATABASE_URL", "ليس رابطًا صالحًا");
    return;
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    fail("DATABASE_URL", "لا يحتوي اسم قاعدة البيانات في آخر المسار");
    return;
  }

  let connection;
  try {
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      connectTimeout: 8000,
    });
    await connection.query("SELECT 1");
    pass("اتصال قاعدة البيانات", `${database}@${url.hostname}:${url.port || 3306}`);
  } catch (error) {
    fail("اتصال قاعدة البيانات", error.message);
    return;
  }

  try {
    const [rows] = await connection.query("SELECT `name` FROM `__zenox_migrations`");
    const applied = new Set(rows.map((row) => String(row.name)));
    const files = migrationFiles();
    const missing = files.filter((name) => !applied.has(name));
    if (missing.length === 0) {
      pass("الهجرات", `${files.length}/${files.length} مطبَّقة`);
    } else {
      fail("الهجرات", `ناقصة: ${missing.join(", ")} — نفّذ pnpm db:init`);
    }
  } catch {
    fail("الهجرات", "جدول __zenox_migrations غير موجود — نفّذ pnpm db:init");
  }

  try {
    const [cols] = await connection.query("SHOW COLUMNS FROM `file_change_requests` LIKE 'status'");
    const type = String(cols[0]?.Type ?? "");
    const needed = ["applied", "failed", "awaiting_approval", "approved", "cancelled"];
    const missing = needed.filter((value) => !type.includes(`'${value}'`));
    if (type && missing.length === 0) {
      pass("حالة طلب التعديل", "applied/failed موجودة");
    } else {
      fail("حالة طلب التعديل", `العمود لا يقبل ${missing.join(", ")} — نفّذ pnpm db:init`);
    }
  } catch (error) {
    fail("حالة طلب التعديل", error.message);
  }

  try {
    const [tables] = await connection.query(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?",
      [database],
    );
    const count = Number(tables[0]?.n ?? 0);
    if (count >= 10) pass("الجداول", `${count} جدولًا`);
    else fail("الجداول", `${count} فقط — الهجرة لم تكتمل`);
  } catch (error) {
    fail("الجداول", error.message);
  }

  await connection.end().catch(() => undefined);
}

function checkSecrets() {
  const sessionSecret = process.env.OWNER_SESSION_SECRET || process.env.JWT_SECRET || process.env.MANUS_JWT_SECRET;
  if (sessionSecret && sessionSecret.length >= 16) pass("مفتاح توقيع الجلسة", "مضبوط");
  else fail("مفتاح توقيع الجلسة", "اضبط OWNER_SESSION_SECRET أو JWT_SECRET (16 حرفًا على الأقل)");

  const hash = process.env.OWNER_PASSWORD_HASH?.trim();
  const file = resolve(process.env.OWNER_PASSWORD_FILE?.trim() || join(process.cwd(), ".zenox-owner.json"));
  if (hash) pass("كلمة مرور المالك", "من متغيّر البيئة");
  else if (existsSync(file)) pass("كلمة مرور المالك", `من ${file}`);
  else warn("كلمة مرور المالك", "غير مضبوطة — ستعرض شاشة أول تشغيل إنشاءها (وهذا مقبول)");
}

function checkRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) pass("إصدار Node", process.versions.node);
  else fail("إصدار Node", `${process.versions.node} — يحتاج 20 أو أحدث`);

  try {
    accessSync(WORKSPACE, constants.W_OK);
    pass("مساحة العمل", `${WORKSPACE} قابلة للكتابة`);
  } catch {
    fail("مساحة العمل", `${WORKSPACE} غير قابلة للكتابة — Terminal وapplyPatch سيفشلان`);
  }

  try {
    const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    pass("git", version);
  } catch {
    fail("git", "غير مثبت — تطبيق Patch يحتاج git apply");
  }

  if (existsSync(join(process.cwd(), "dist", "index.js"))) pass("حزمة الخادم", "dist/index.js موجود");
  else warn("حزمة الخادم", "dist/index.js غير موجود — نفّذ pnpm build قبل pnpm start");
}

async function checkPort() {
  await new Promise((done) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") warn("المنفذ", `${PORT} مشغول — إن كان خادمًا يعمل فهذا طبيعي`);
      else warn("المنفذ", error.message);
      done();
    });
    server.listen(PORT, "127.0.0.1", () => server.close(() => {
      pass("المنفذ", `${PORT} متاح`);
      done();
    }));
  });
}

checkRuntime();
checkSecrets();
await checkDatabase();
await checkPort();

const icon = { pass: "[✓]", warn: "[!]", fail: "[✗]" };
console.log("");
for (const item of results) {
  console.log(`${icon[item.level]} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
const failures = results.filter((item) => item.level === "fail");
const warnings = results.filter((item) => item.level === "warn");
console.log("");
console.log(`${results.filter((r) => r.level === "pass").length} ناجح · ${warnings.length} تنبيه · ${failures.length} فاشل`);

if (failures.length > 0) {
  console.log("\nلا تشغّل الخادم قبل إصلاح الأخطاء أعلاه.");
  process.exit(1);
}
console.log("\nجاهز للتشغيل: pnpm build ثم pnpm start");
