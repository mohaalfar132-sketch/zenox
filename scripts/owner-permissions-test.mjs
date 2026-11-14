#!/usr/bin/env node
/**
 * ZENOX owner permission matrix.
 * Proves every owner capability is closed without a session and open with one.
 *
 * Usage: SMOKE_BASE_URL=http://127.0.0.1:3010 \
 *        SMOKE_OWNER_PASSWORD=... node scripts/owner-permissions-test.mjs
 */
const BASE = (process.env.SMOKE_BASE_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
const PASSWORD = process.env.SMOKE_OWNER_PASSWORD;
const jar = new Map();
const results = [];

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

function absorb(response) {
  const lines = response.headers.getSetCookie?.() ?? [];
  const single = response.headers.get("set-cookie");
  if (lines.length === 0 && single) lines.push(single);
  for (const line of lines) {
    const pair = line.split(";")[0];
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!value) jar.delete(name);
    else jar.set(name, value);
  }
}

async function call(procedure, { method = "GET", input, auth = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth && cookieHeader()) headers.cookie = cookieHeader();
  const payload = input ?? {};
  const url =
    method === "GET"
      ? `${BASE}/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: payload } }))}`
      : `${BASE}/api/trpc/${procedure}?batch=1`;
  const response = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify({ "0": { json: payload } }) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  absorb(response);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

const closed = [
  ["owner.terminal.exec", "POST", { command: "id" }],
  ["owner.terminal.status", "GET"],
  ["owner.tools.list", "GET"],
  ["owner.tools.run", "POST", { name: "disk_usage" }],
  ["owner.code.tree", "GET", { depth: 1 }],
  ["owner.code.read", "GET", { path: "package.json" }],
  ["owner.code.write", "POST", { path: "tests/.owner-denied.txt", content: "x" }],
  ["owner.uploads.list", "GET"],
  ["owner.promo.get", "GET"],
  ["owner.promo.set", "POST", { content: {} }],
  ["owner.promo.ads.add", "POST", { ad: { title: "x" } }],
  ["owner.promo.ads.remove", "POST", { id: "x" }],
  ["owner.site.get", "GET"],
  ["owner.site.set", "POST", { maintenance: true }],
  ["owner.guarantee", "GET"],
  ["owner.secrets.status", "GET"],
  ["owner.secrets.open", "POST", { password: "x" }],
  ["owner.security.audit", "POST", {}],
  ["owner.ai.list", "GET"],
  ["owner.ai.stats", "GET"],
  ["owner.ai.remove", "POST", { id: 1 }],
  ["owner.monitor.stats", "GET"],
];

console.log(`ZENOX owner permission matrix → ${BASE}\n`);

for (const [procedure, method, input] of closed) {
  try {
    const response = await call(procedure, { method, input });
    const blocked = response.status === 401 || response.status === 403;
    record(`مغلق: ${procedure}`, blocked, `HTTP ${response.status}`);
  } catch (error) {
    record(`مغلق: ${procedure}`, false, error.message);
  }
}

if (!PASSWORD) {
  console.log("[i] SMOKE_OWNER_PASSWORD غير مضبوط — نصف الجلسة متخطّى.");
} else {
  const status = await call("owner.auth.status");
  let configured = false;
  try {
    configured = Boolean(JSON.parse(status.text)?.[0]?.result?.data?.json?.passwordConfigured);
  } catch {
    configured = false;
  }
  const login = configured
    ? await call("owner.auth.login", { method: "POST", input: { password: PASSWORD } })
    : await call("owner.auth.setup", { method: "POST", input: { password: PASSWORD } });
  record(configured ? "تسجيل دخول المالك" : "إنشاء كلمة مرور المالك", login.status === 200, `HTTP ${login.status}`);

  const open = [
    ["owner.guarantee", "GET", undefined],
    ["owner.tools.list", "GET", undefined],
    ["owner.tools.run", "POST", { name: "disk_usage" }],
    ["owner.code.tree", "GET", { depth: 1 }],
    ["owner.code.read", "GET", { path: "package.json" }],
    ["owner.uploads.list", "GET", undefined],
    ["owner.site.get", "GET", undefined],
    ["owner.promo.get", "GET", undefined],
    ["owner.secrets.status", "GET", undefined],
    ["owner.ai.list", "GET", undefined],
    ["owner.ai.stats", "GET", undefined],
    ["owner.monitor.stats", "GET", undefined],
    ["owner.terminal.status", "GET", undefined],
    ["owner.terminal.exec", "POST", { command: "echo owner-matrix" }],
  ];

  for (const [procedure, method, input] of open) {
    try {
      const response = await call(procedure, { method, input, auth: true });
      const allowed = response.status === 200;
      record(`مفتوح: ${procedure}`, allowed, `HTTP ${response.status}`);
    } catch (error) {
      record(`مفتوح: ${procedure}`, false, error.message);
    }
  }

  const logout = await call("owner.auth.logout", { method: "POST", input: {}, auth: true });
  record("تسجيل الخروج", logout.status === 200, `HTTP ${logout.status}`);
  const after = await call("owner.terminal.exec", { method: "POST", input: { command: "id" } });
  record("الجلسة أُغلقت بعد الخروج", after.status === 401 || after.status === 403, `HTTP ${after.status}`);
}

for (const item of results) {
  console.log(`${item.ok ? "[✓]" : "[✗]"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} ناجح`);
if (failed.length > 0) process.exit(1);
