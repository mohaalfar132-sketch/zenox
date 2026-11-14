#!/usr/bin/env node
/**
 * Attack + behaviour checks for the deployed ZANOX9.AI worker.
 *
 *   node scripts/promo-security-test.mjs [baseUrl]
 *
 * Reads the editor password from artifacts/promo-admin-password.txt (local
 * only) and never prints it. Each probe prints PASS/FAIL, and the process exits
 * non-zero when any check fails.
 */
import { readFileSync } from "node:fs";

const base = (process.argv[2] || "https://site-46a89efcae814916890b8988f2f1d0dd.freebuff.page").replace(/\/$/, "");
const password = readFileSync("artifacts/promo-admin-password.txt", "utf8").trim();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const request = (path, init = {}) =>
  fetch(`${base}${path}`, { redirect: "manual", ...init, headers: { accept: "*/*", ...(init.headers || {}) } });

/* ------------------------------- baseline -------------------------------- */
const home = await request("/");
const homeText = await home.text();
const csp = home.headers.get("content-security-policy") || "";
check("home loads", home.status === 200, `status ${home.status}`);
check("home is html", (home.headers.get("content-type") || "").includes("text/html"));
check("home has CSP", csp.includes("default-src 'self'"), csp.slice(0, 60));
check("CSP blocks framing", csp.includes("frame-ancestors 'none'"));
check("nosniff", home.headers.get("x-content-type-options") === "nosniff");
check("HSTS", (home.headers.get("strict-transport-security") || "").includes("max-age"));
check("no app server banner", ["cloudflare", "", null].includes(home.headers.get("server")), home.headers.get("server") || "none");
check("brand renders", homeText.includes("ZANOX9.AI"));

const admin = await request("/admin");
check("admin page loads", admin.status === 200);
check("admin is noindex", (await admin.text()).includes("noindex"));

/* ----------------------------- content store ----------------------------- */
const content = await request("/api/content");
const payload = await content.json();
check("content endpoint", content.status === 200 && typeof payload.content === "object");
check("content is no-store", (content.headers.get("cache-control") || "").includes("no-store"));

const anonymousWrite = await request("/api/content", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ brand: "hacked" }),
});
check("anonymous write rejected", anonymousWrite.status === 401, `status ${anonymousWrite.status}`);

const forgedCookie = await request("/api/content", {
  method: "PUT",
  headers: { "content-type": "application/json", cookie: "zx_site=9999999999999.forged" },
  body: JSON.stringify({ brand: "hacked" }),
});
check("forged cookie rejected", forgedCookie.status === 401, `status ${forgedCookie.status}`);

const badMethod = await request("/", { method: "PUT", body: "x" });
check("static PUT rejected", badMethod.status === 405, `status ${badMethod.status}`);

/* -------------------------------- login ---------------------------------- */
const wrong = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: `${password}x` }),
});
check("wrong password rejected", wrong.status === 401, `status ${wrong.status}`);

const login = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password }),
});
const setCookie = login.headers.get("set-cookie") || "";
const cookie = setCookie.split(";")[0];
check("owner login works", login.status === 200, `status ${login.status}`);
check("session cookie is HttpOnly+Secure+Strict", /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie));

/* ---------------------------- input hardening ---------------------------- */
const xss = await fetch(`${base}/api/content`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({
    brand: "<script>alert(1)</script>ZANOX",
    hero: { title: "<img src=x onerror=alert(1)><em>آمن</em>", subtitle: "<svg onload=alert(1)>", badge: "b", hint: "h" },
    download: { title: "t", subtitle: "s", webNote: "w", apkNote: "a", webUrl: "javascript:alert(1)", apkUrl: "data:text/html,<script>alert(1)</script>" },
    features: [{ icon: "chat", title: "<b>x</b>", text: "y" }],
    faq: [{ q: "<script>q</script>", a: "<iframe src=//evil>" }],
    footer: "f",
  }),
});
const saved = xss.status === 200 ? await xss.json() : { content: {} };
const serialized = JSON.stringify(saved.content || {});
check("owner save accepted", xss.status === 200, `status ${xss.status}`);
check("script tag stripped", !/<script/i.test(serialized));
check("onerror stripped", !/onerror/i.test(serialized));
check("iframe stripped", !/<iframe/i.test(serialized));
check("javascript: link rejected", (saved.content?.download?.webUrl || "") === "");
check("data: link rejected", (saved.content?.download?.apkUrl || "") === "");
check("safe <em> survives", serialized.includes("<em>"));

const invalidJson = await fetch(`${base}/api/content`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: "{not json",
});
check("invalid JSON rejected", invalidJson.status === 400, `status ${invalidJson.status}`);

const huge = await fetch(`${base}/api/content`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ brand: "a".repeat(40 * 1024) }),
});
check("oversized body rejected", huge.status === 413, `status ${huge.status}`);

const protoPollution = await fetch(`${base}/api/content`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ __proto__: { polluted: true }, brand: "ok" }),
});
const pollutionBody = await protoPollution.json().catch(() => ({}));
check("prototype pollution ignored", !("polluted" in (pollutionBody.content || {})), `status ${protoPollution.status}`);

/* ------------------------------ path tricks ------------------------------ */
for (const path of ["/../etc/passwd", "/..%2f..%2fetc%2fpasswd", "/%2e%2e/WRANGLER.toml", "/admin.html/../.."]) {
  const probe = await request(path);
  const body = await probe.text();
  check(`traversal blocked ${path}`, !body.includes("root:x:") && !body.includes("[vars]"), `status ${probe.status}`);
}

const reflected = await request("/?q=%3Cscript%3Ealert(1)%3C/script%3E");
const reflectedBody = await reflected.text();
check("query not reflected", !reflectedBody.includes("<script>alert(1)</script>"));

/* ------------------------------- default doc ----------------------------- */
const restored = await fetch(`${base}/api/content`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({
    brand: "ZANOX9.AI",
    hero: {
      badge: "نسخة الويب وتطبيق أندرويد",
      title: "مساعدك الذكي <em>بالعربية</em> — بلا تعقيد",
      subtitle: "محادثة تفهم العربية والمصرية، سبعة أوضاع متخصصة، وقراءة ملفاتك وتوليد المستندات والصور من نفس المكان.",
      hint: "يعمل على الهاتف والكمبيوتر · لا يحتاج تثبيت لنسخة الويب",
    },
    download: {
      title: "احصل على التطبيق",
      subtitle: "نسخة الويب تعمل فورًا من المتصفح. نسخة أندرويد تُثبّت كتطبيق عادي على الهاتف.",
      webNote: "افتحها من أي متصفح — هاتف أو كمبيوتر، بلا تثبيت وبلا متجر.",
      apkNote: "التنزيل المباشر من الرابط الرسمي، بلا حاجة لمتجر Play.",
      webUrl: "",
      apkUrl: "",
    },
    features: [
      { icon: "chat", title: "محادثة عربية طبيعية", text: "تفهم الفصحى والمصرية، وتجيب باختصار أو بتفصيل حسب طلبك." },
      { icon: "modes", title: "سبعة أوضاع متخصصة", text: "مجادلة تبني الحجة، طبي يوضّح بحدود آمنة، برمجي يكتب كودًا جاهزًا." },
      { icon: "files", title: "ملفاتك بكل الأنواع", text: "PDF وWord وExcel والصور، وفكّ ضغط ZIP وRAR داخل التطبيق." },
      { icon: "image", title: "توليد وتعديل الصور", text: "أنشئ صورة من وصف نصي، أو عدّل ملفًا موجودًا وتحمّله فورًا." },
      { icon: "speed", title: "سرعة وتبديل ذكي", text: "يرتّب المزوّدين حسب سرعتهم الفعلية، وينتقل لغيره عند أي عطل." },
      { icon: "lock", title: "أسرار محفوظة", text: "مفاتيحك تبقى على الخادم مشفّرة، ولا تُعرض في الواجهة ولا في السجلات." },
    ],
    faq: [
      { q: "هل أحتاج حسابًا لاستخدامه؟", a: "لا. تفتح الموقع وتبدأ المحادثة مباشرة." },
      { q: "ما الفرق بين نسخة الويب وAPK؟", a: "نفس التطبيق. الويب يعمل بلا تثبيت، وAPK يثبّت أيقونة على الهاتف." },
      { q: "هل مفاتيحي ظاهرة لأحد؟", a: "لا. تُخزَّن مشفّرة على الخادم ولا تُطبع في أي سجل." },
      { q: "هل يعمل بلا إنترنت؟", a: "لا، الردود تأتي من مزوّدي الذكاء الاصطناعي وتحتاج اتصالًا." },
    ],
    footer: "© ZANOX9.AI — جميع الحقوق محفوظة.",
  }),
});
check("default content restored", restored.status === 200);

/* ------------------------- brute force (last) ---------------------------- */
let blockedStatus = 0;
for (let i = 0; i < 8; i += 1) {
  const attempt = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: `wrong-${i}` }),
  });
  blockedStatus = attempt.status;
  if (attempt.status === 429) break;
}
check("rate limit after repeated failures", blockedStatus === 429, `last status ${blockedStatus}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
