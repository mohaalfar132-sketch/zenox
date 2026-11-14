#!/usr/bin/env node
/**
 * ZENOX smoke test against a RUNNING server.
 * Usage: SMOKE_BASE_URL=https://host pnpm smoke
 *        SMOKE_OWNER_PASSWORD=... pnpm smoke   (adds the authenticated checks)
 * Exit 0 = all checks passed. Exit 1 = a check failed.
 * The password is read from the environment only; it is never printed.
 */
import "dotenv/config";

const BASE = (process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
const PASSWORD = process.env.SMOKE_OWNER_PASSWORD;
const results = [];
// Real cookie jar: the server sets several cookies (owner + OAuth session),
// so the jar must merge by name instead of keeping only the last response.
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function absorbCookies(setCookieLines) {
  for (const line of setCookieLines) {
    const pair = line.split(";")[0];
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === "" || /^expires=thu, 01 jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
}

async function call(procedure, { method = "GET", input, useCookie = false } = {}) {
  const headers = { "content-type": "application/json" };
  const currentCookie = cookieHeader();
  if (useCookie && currentCookie) headers.cookie = currentCookie;
  const payload = input === undefined ? {} : input;
  const url =
    method === "GET"
      ? `${BASE}/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: payload } }))}`
      : `${BASE}/api/trpc/${procedure}?batch=1`;
  const response = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify({ "0": { json: payload } }) : undefined,
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const setCookieHeader = response.headers.get("set-cookie");
  if (setCookie.length > 0) absorbCookies(setCookie);
  else if (setCookieHeader) absorbCookies([setCookieHeader]);

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const result = Array.isArray(json) ? json[0]?.result?.data?.json : undefined;
  return { status: response.status, json, result, text };
}

console.log(`ZENOX smoke test → ${BASE}\n`);

try {
  const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10000) });
  const body = await health.text();
  record("health", health.status === 200 && body.includes('"ok":true'), `HTTP ${health.status}`);
} catch (error) {
  record("health", false, error.message);
  console.log("[✗] health — لا يمكن الوصول للخادم");
  process.exit(1);
}

for (const page of ["/", "/console"]) {
  try {
    const response = await fetch(`${BASE}${page}`, { signal: AbortSignal.timeout(15000) });
    const html = await response.text();
    record(`صفحة ${page}`, response.status === 200 && /<html/i.test(html), `HTTP ${response.status}`);
  } catch (error) {
    record(`صفحة ${page}`, false, error.message);
  }
}

try {
  const missing = await fetch(`${BASE}/api/procedure-does-not-exist`, { signal: AbortSignal.timeout(10000) });
  const body = await missing.text();
  record("API 404 يرجع JSON", missing.status === 404 && body.includes("not_found"), `HTTP ${missing.status}`);
} catch (error) {
  record("API 404 يرجع JSON", false, error.message);
}

const anonExec = await call("owner.terminal.exec", { method: "POST", input: { command: "id" } });
record("Anonymous shell is blocked", anonExec.status === 403, `HTTP ${anonExec.status}`);

const status = await call("owner.auth.status", { method: "GET" });
const statusJson = status.result;
record("owner.auth.status", status.status === 200 && statusJson != null, `HTTP ${status.status} mode=${statusJson?.mode ?? "?"}`);

if (PASSWORD) {
  // Branch on whether a password EXISTS, not on the current session. Otherwise a
  // second run would try to create an already-created password and get 409.
  const configured = statusJson?.passwordConfigured === true;
  const auth = configured
    ? await call("owner.auth.login", { method: "POST", input: { password: PASSWORD } })
    : await call("owner.auth.setup", { method: "POST", input: { password: PASSWORD } });
  record(configured ? "تسجيل الدخول" : "إنشاء كلمة المرور", auth.status === 200, `HTTP ${auth.status}${configured ? "" : " (أول تشغيل)"}`);

  const exec = await call("owner.terminal.exec", { method: "POST", input: { command: "echo zenox-smoke" }, useCookie: true });
  record("Owner shell", exec.status === 200 && exec.result?.stdout?.includes("zenox-smoke"), `code=${exec.result?.code}`);

  const refreshStatus = await call("owner.auth.status", { method: "GET", useCookie: true });
  record("كلمة المرور محفوظة في قاعدة البيانات", refreshStatus.result?.passwordStorage === "database", `storage=${refreshStatus.result?.passwordStorage ?? "?"}`);

  const tree = await call("owner.code.tree", { method: "GET", input: { depth: 1 }, useCookie: true });
  record("كود البنية", tree.status === 200 && Array.isArray(tree.result?.entries) && tree.result.entries.length > 0, `HTTP ${tree.status}`);

  const readFile = await call("owner.code.read", { method: "GET", input: { path: "package.json" }, useCookie: true });
  record("قراءة ملف من البنية", readFile.status === 200 && String(readFile.result?.content ?? "").includes("\"name\""), `HTTP ${readFile.status}`);

  const policies = await call("policies.list", { method: "GET", useCookie: true });
  record("قراءة من قاعدة البيانات", policies.status === 200 && Array.isArray(policies.result), `HTTP ${policies.status}`);

  const logout = await call("owner.auth.logout", { method: "POST", input: {}, useCookie: true });
  record("تسجيل الخروج", logout.status === 200, `HTTP ${logout.status}`);
} else {
  console.log("[i] SMOKE_OWNER_PASSWORD غير مضبوط — تخطّي الفحوص المصادَقة (الخادم لم يُختبر بعمق).\n");
}

for (const item of results) {
  console.log(`${item.ok ? "[✓]" : "[✗]"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} ناجح`);
if (failed.length > 0) {
  console.log("\nفشل واحد أو أكثر. لا تعلن النشر ناجحًا قبل إصلاحه.");
  process.exit(1);
}
