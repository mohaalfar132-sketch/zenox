/**
 * ZANOX9.AI — promo Worker.
 *
 * Static landing page + a small JSON content store in D1 so the owner can edit
 * texts, links and FAQ items from /admin without touching code. Every response
 * carries a strict CSP; writes need a signed owner cookie and are validated
 * server-side (length caps, https-only links, tag whitelist).
 */

const COOKIE = "zx_site";
const SESSION_MS = 12 * 60 * 60_000;
const OWNER_LINK_TTL_MS = 5 * 60_000;
const OWNER_LINK_SCOPE = "zanox9-site-admin";
const MAX_BODY = 24 * 1024;

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
};

const withHeaders = (response) => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
};

const json = (data, status = 200, extra = {}) =>
  withHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
    }),
  );

/* ------------------------------ text helpers ------------------------------ */

const clean = (value, max) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);

/** Plain fields never carry markup: strip any tag and the angle brackets. */
const plain = (value, max) =>
  clean(value, max)
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim();

/** The hero title is the only rich field: keep <em> and drop every other tag. */
const richText = (value, max) =>
  clean(value, max)
    .replace(/<(?!\/?em>)[^>]*>/gi, "")
    .replace(/em>/gi, "em>");

const safeUrl = (value) => {
  const raw = clean(value, 500);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
};

const sanitizeContent = (input) => {
  const source = input && typeof input === "object" ? input : {};
  const hero = source.hero && typeof source.hero === "object" ? source.hero : {};
  const download = source.download && typeof source.download === "object" ? source.download : {};
  const features = Array.isArray(source.features) ? source.features.slice(0, 9) : [];
  const faq = Array.isArray(source.faq) ? source.faq.slice(0, 10) : [];
  const ads = Array.isArray(source.ads) ? source.ads.slice(0, 6) : [];
  return {
    brand: plain(source.brand, 40) || "ZANOX9.AI",
    hero: {
      badge: plain(hero.badge, 80),
      title: richText(hero.title, 140),
      subtitle: plain(hero.subtitle, 320),
      hint: plain(hero.hint, 160),
    },
    features: features.map((item) => ({
      icon: ["chat", "modes", "files", "image", "speed", "lock"].includes(item?.icon) ? item.icon : "chat",
      title: plain(item?.title, 60),
      text: plain(item?.text, 220),
    })),
    download: {
      title: plain(download.title, 60),
      subtitle: plain(download.subtitle, 240),
      webNote: plain(download.webNote, 200),
      apkNote: plain(download.apkNote, 200),
      webUrl: safeUrl(download.webUrl),
      apkUrl: safeUrl(download.apkUrl),
    },
    faq: faq.map((item) => ({ q: plain(item?.q, 120), a: plain(item?.a, 400) })),
    footer: plain(source.footer, 140),
    ads: ads.map((item) => ({
      id: plain(item?.id, 40) || `ad-${Math.random().toString(36).slice(2, 8)}`,
      title: plain(item?.title, 80),
      body: plain(item?.body, 280),
      ctaLabel: plain(item?.ctaLabel, 40),
      ctaUrl: safeUrl(item?.ctaUrl),
      tone: ["info", "warning", "success"].includes(item?.tone) ? item.tone : "info",
      enabled: item?.enabled !== false,
    })),
  };
};

/* ------------------------------- auth token ------------------------------- */

const encoder = new TextEncoder();

const hmac = async (secret, data) => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=+$/, "");
};

const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const cookieValue = (request) => {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return "";
};

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64url = (value) => {
  const raw = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  return atob(padded);
};

const hmacUrl = async (secret, data) => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
};

/**
 * The owner console signs a five-minute link with the same site password the
 * Worker already holds. The link only proves "the owner sent this"; it is not a
 * password and is exchanged once for the ordinary HttpOnly site session.
 */
const ownerLinkValid = async (token, secret) => {
  if (!secret || typeof token !== "string" || token.length < 20 || token.length > 4096) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (!equal(signature, await hmacUrl(secret, `owner-link.${payload}`))) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(fromB64url(payload), (char) => char.charCodeAt(0))));
    if (data?.v !== 1 || data?.scope !== OWNER_LINK_SCOPE || data?.aud !== "zanox9-site") return false;
    const expires = Number(data?.exp);
    const now = Date.now();
    return Number.isFinite(expires) && expires > now && expires - now <= OWNER_LINK_TTL_MS + 60_000;
  } catch {
    return false;
  }
};

const issueToken = async (secret) => {
  const expires = Date.now() + SESSION_MS;
  return `${expires}.${await hmac(secret, `admin:${expires}`)}`;
};

const verified = async (request, secret) => {
  const token = cookieValue(request);
  const [rawExpires, signature] = token.split(".");
  const expires = Number(rawExpires);
  if (!expires || !signature || expires < Date.now()) return false;
  return equal(signature, await hmac(secret, `admin:${expires}`));
};

/** Five wrong passwords per ten minutes per address, kept per isolate. */
const attempts = new Map();
/** Waitlist signups per address: five per ten minutes. */
const signups = new Map();
const blocked = (ip) => {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.at > 10 * 60_000) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= 5;
};
const noteFailure = (ip) => {
  const entry = attempts.get(ip) || { count: 0, at: Date.now() };
  attempts.set(ip, { count: entry.count + 1, at: Date.now() });
};

/* --------------------------------- store --------------------------------- */

const DEFAULTS = {
  brand: "ZANOX9.AI",
  hero: {
    badge: "نسخة الويب وتطبيق أندرويد",
    title: "مساعدك الذكي <em>بالعربية</em> — بلا تعقيد",
    subtitle:
      "محادثة تفهم العربية والمصرية، سبعة أوضاع متخصصة، وقراءة ملفاتك وتوليد المستندات والصور من نفس المكان.",
    hint: "يعمل على الهاتف والكمبيوتر · لا يحتاج تثبيت لنسخة الويب",
  },
  features: [
    { icon: "chat", title: "محادثة عربية طبيعية", text: "تفهم الفصحى والمصرية، وتجيب باختصار أو بتفصيل حسب طلبك." },
    { icon: "modes", title: "سبعة أوضاع متخصصة", text: "مجادلة تبني الحجة، طبي يوضّح بحدود آمنة، برمجي يكتب كودًا جاهزًا." },
    { icon: "files", title: "ملفاتك بكل الأنواع", text: "PDF وWord وExcel والصور، وفكّ ضغط ZIP وRAR داخل التطبيق." },
    { icon: "image", title: "توليد وتعديل الصور", text: "أنشئ صورة من وصف نصي، أو عدّل ملفًا موجودًا وتحمّله فورًا." },
    { icon: "speed", title: "سرعة وتبديل ذكي", text: "يرتّب المزوّدين حسب سرعتهم الفعلية، وينتقل لغيره عند أي عطل." },
    { icon: "lock", title: "أسرار محفوظة", text: "مفاتيحك تبقى على الخادم مشفّرة، ولا تُعرض في الواجهة ولا في السجلات." },
  ],
  download: {
    title: "احصل على التطبيق",
    subtitle: "نسخة الويب تعمل فورًا من المتصفح. نسخة أندرويد تُثبّت كتطبيق عادي على الهاتف.",
    webNote: "افتحها من أي متصفح — هاتف أو كمبيوتر، بلا تثبيت وبلا متجر.",
    apkNote: "التنزيل المباشر من الرابط الرسمي، بلا حاجة لمتجر Play.",
    webUrl: "",
    apkUrl: "/zenox.apk",
  },
  faq: [
    { q: "هل أحتاج حسابًا لاستخدامه؟", a: "لا. تفتح الموقع وتبدأ المحادثة مباشرة." },
    { q: "ما الفرق بين نسخة الويب وAPK؟", a: "نفس التطبيق. الويب يعمل بلا تثبيت، وAPK يثبّت أيقونة على الهاتف." },
    { q: "هل مفاتيحي ظاهرة لأحد؟", a: "لا. تُخزَّن مشفّرة على الخادم ولا تُطبع في أي سجل." },
    { q: "هل يعمل بلا إنترنت؟", a: "لا، الردود تأتي من مزوّدي الذكاء الاصطناعي وتحتاج اتصالًا." },
  ],
  footer: "© ZANOX9.AI — جميع الحقوق محفوظة.",
  ads: [],
};

async function ensureTable(db) {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS site_content (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL)")
    .run();
}

async function ensureWaitlistTable(db) {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE NOT NULL, note TEXT, created_at TEXT NOT NULL)")
    .run();
}

async function readContent(db) {
  try {
    await ensureTable(db);
    const row = await db.prepare("SELECT json, updated_at FROM site_content WHERE id = 1").first();
    if (!row) return { content: DEFAULTS, updatedAt: null };
    const content = { ...DEFAULTS, ...JSON.parse(row.json) };
    // The APK is shipped with this site; keep the download link pointing at it
    // even when older saved content still carries an empty value.
    content.download = { ...DEFAULTS.download, ...(content.download || {}), apkUrl: "/zenox.apk" };
    return { content, updatedAt: row.updated_at };
  } catch {
    return { content: DEFAULTS, updatedAt: null };
  }
}

/* --------------------------------- routes -------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/api/content") {
      if (method === "GET") {
        const stored = await readContent(env.DB);
        return json({ ...stored, owner: await verified(request, env.ADMIN_PASSWORD) });
      }
      if (method === "PUT" || method === "POST") {
        if (!env.ADMIN_PASSWORD) return json({ error: "unconfigured" }, 503);
        if (!(await verified(request, env.ADMIN_PASSWORD))) return json({ error: "unauthorized" }, 401);
        const length = Number(request.headers.get("content-length") || 0);
        if (length > MAX_BODY) return json({ error: "too_large" }, 413);
        const text = await request.text();
        if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const content = sanitizeContent(parsed);
        await ensureTable(env.DB);
        await env.DB.prepare(
          "INSERT INTO site_content (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        )
          .bind(JSON.stringify(content), new Date().toISOString())
          .run();
        return json({ ok: true, content });
      }
      return json({ error: "method_not_allowed" }, 405, { allow: "GET, PUT" });
    }

    if (path === "/api/admin/exchange") {
      if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
      if (!env.ADMIN_PASSWORD) return json({ error: "unconfigured" }, 503);
      const length = Number(request.headers.get("content-length") || 0);
      if (length > 4096) return json({ error: "too_large" }, 413);
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!(await ownerLinkValid(body?.token, env.ADMIN_PASSWORD))) {
        return json({ error: "unauthorized" }, 401);
      }
      const token = await issueToken(env.ADMIN_PASSWORD);
      return json(
        { ok: true },
        200,
        {
          "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
        },
      );
    }

    if (path === "/api/login") {
      if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      if (blocked(ip)) return json({ error: "too_many_attempts" }, 429);
      if (!env.ADMIN_PASSWORD) return json({ error: "unconfigured" }, 503);
      const length = Number(request.headers.get("content-length") || 0);
      if (length > 2048) return json({ error: "too_large" }, 413);
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const password = typeof body?.password === "string" ? body.password : "";
      if (!equal(password, env.ADMIN_PASSWORD)) {
        noteFailure(ip);
        return json({ error: "unauthorized" }, 401);
      }
      attempts.delete(ip);
      const token = await issueToken(env.ADMIN_PASSWORD);
      return json(
        { ok: true },
        200,
        {
          "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
        },
      );
    }

    if (path === "/api/logout") {
      return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }

    if (path === "/api/waitlist") {
      if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const entry = signups.get(ip);
      if (entry && Date.now() - entry.at < 10 * 60_000 && entry.count >= 5) {
        return json({ error: "too_many" }, 429);
      }
      const length = Number(request.headers.get("content-length") || 0);
      if (length > 4096) return json({ error: "too_large" }, 413);
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const name = plain(body?.name, 80);
      const email = clean(body?.email, 200);
      const note = plain(body?.note, 500);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);
      const cur = signups.get(ip) || { count: 0, at: Date.now() };
      if (Date.now() - cur.at > 10 * 60_000) {
        cur.count = 0;
        cur.at = Date.now();
      }
      cur.count += 1;
      signups.set(ip, cur);
      await ensureWaitlistTable(env.DB);
      await env.DB.prepare(
        "INSERT INTO waitlist (name, email, note, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, note = excluded.note",
      )
        .bind(name, email, note, new Date().toISOString())
        .run();
      return json({ ok: true });
    }

    if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
    const asset = withHeaders(await env.ASSETS.fetch(request));
    if (path === "/admin" || path === "/admin/" || path === "/admin.html") {
      asset.headers.set("cache-control", "no-store");
      asset.headers.set("referrer-policy", "no-referrer");
    }
    return asset;
  },
};
