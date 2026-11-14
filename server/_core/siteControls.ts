import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Live site controls the owner changes in one sentence — no code edit, no
 * rebuild, no deploy. The value is read by the web app on load, so a warning
 * banner appears for every visitor within one page refresh.
 */

export type BannerTone = "info" | "warning" | "danger";

export type SiteControls = {
  banner: { enabled: boolean; text: string; tone: BannerTone; alarm: boolean; expiresAt: string | null; updatedAt: string | null };
  maintenance: { enabled: boolean; message: string; updatedAt: string | null };
  announcement: { enabled: boolean; title: string; body: string; updatedAt: string | null };
};

export const DEFAULT_CONTROLS: SiteControls = {
  banner: { enabled: false, text: "", tone: "info", alarm: false, expiresAt: null, updatedAt: null },
  maintenance: { enabled: false, message: "", updatedAt: null },
  announcement: { enabled: false, title: "", body: "", updatedAt: null },
};

function dataRoot() {
  return (process.env.ZENOX_DATA_DIR || "").trim() || process.cwd();
}

function file() {
  return join(dataRoot(), "site-controls.json");
}

function clampText(value: unknown, max = 400): string {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

function tone(value: unknown): BannerTone {
  return value === "warning" || value === "danger" ? value : "info";
}

export function readControls(): SiteControls {
  try {
    if (!existsSync(file())) return { ...DEFAULT_CONTROLS };
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as Partial<SiteControls>;
    const expired = Boolean(parsed.banner?.expiresAt && Date.parse(String(parsed.banner.expiresAt)) <= Date.now());
    return {
      banner: {
        enabled: Boolean(parsed.banner?.enabled) && !expired,
        text: clampText(parsed.banner?.text),
        tone: tone(parsed.banner?.tone),
        alarm: Boolean(parsed.banner?.alarm),
        expiresAt: parsed.banner?.expiresAt ?? null,
        updatedAt: parsed.banner?.updatedAt ?? null,
      },
      maintenance: {
        enabled: Boolean(parsed.maintenance?.enabled),
        message: clampText(parsed.maintenance?.message, 1000),
        updatedAt: parsed.maintenance?.updatedAt ?? null,
      },
      announcement: {
        enabled: Boolean(parsed.announcement?.enabled),
        title: clampText(parsed.announcement?.title, 160),
        body: clampText(parsed.announcement?.body, 1500),
        updatedAt: parsed.announcement?.updatedAt ?? null,
      },
    };
  } catch {
    return { ...DEFAULT_CONTROLS };
  }
}

function write(next: SiteControls): SiteControls {
  mkdirSync(dataRoot(), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Only the fields provided are touched, so one order cannot erase another. */
export function updateControls(patch: {
  banner?: Partial<SiteControls["banner"]>;
  maintenance?: Partial<SiteControls["maintenance"]>;
  announcement?: Partial<SiteControls["announcement"]>;
}): SiteControls {
  const current = readControls();
  const now = new Date().toISOString();
  const next: SiteControls = {
    banner: { ...current.banner },
    maintenance: { ...current.maintenance },
    announcement: { ...current.announcement },
  };

  if (patch.banner) {
    if (typeof patch.banner.enabled === "boolean") next.banner.enabled = patch.banner.enabled;
    if (patch.banner.text !== undefined) next.banner.text = clampText(patch.banner.text);
    if (patch.banner.tone !== undefined) next.banner.tone = tone(patch.banner.tone);
    if (typeof patch.banner.alarm === "boolean") next.banner.alarm = patch.banner.alarm;
    if (patch.banner.expiresAt !== undefined) {
      next.banner.expiresAt = patch.banner.expiresAt ? String(patch.banner.expiresAt) : null;
    }
    if (next.banner.text === "") next.banner.enabled = false;
    next.banner.updatedAt = now;
  }
  if (patch.maintenance) {
    if (typeof patch.maintenance.enabled === "boolean") next.maintenance.enabled = patch.maintenance.enabled;
    if (patch.maintenance.message !== undefined) next.maintenance.message = clampText(patch.maintenance.message, 1000);
    next.maintenance.updatedAt = now;
  }
  if (patch.announcement) {
    if (typeof patch.announcement.enabled === "boolean") next.announcement.enabled = patch.announcement.enabled;
    if (patch.announcement.title !== undefined) next.announcement.title = clampText(patch.announcement.title, 160);
    if (patch.announcement.body !== undefined) next.announcement.body = clampText(patch.announcement.body, 1500);
    next.announcement.updatedAt = now;
  }

  return write(next);
}

/** What the browser is allowed to see: text only, never any internal path. */
export function publicControls() {
  const controls = readControls();
  return {
    banner: controls.banner,
    maintenance: controls.maintenance,
    announcement: controls.announcement,
    updatedAt: controls.banner.updatedAt ?? controls.maintenance.updatedAt ?? controls.announcement.updatedAt,
  };
}

/**
 * Turns one owner sentence into a ready banner without asking anything else.
 * "أظهر إعلان تحذير: صيانة مساءً" → warning banner with that text.
 */
export function bannerFromSentence(sentence: string): { text: string; tone: BannerTone } {
  const raw = String(sentence || "").replace(/\s+/g, " ").trim();
  const danger = /(خطر|تحذير شديد|حرج|danger|critical|اختراق)/i.test(raw);
  const warning = danger || /(تحذير|تنبيه|انتباه|warning|هام)/i.test(raw);
  let text = raw
    // "مع صوت إنذار" is a delivery option, not part of the message.
    .replace(/(مع|و|ب)?\s*(صوت\s*(ال)?(إنذار|انذار)|سارينة|صفير\s*إنذار|siren|alarm\s*sound)/gi, " ")
    .replace(/^(من فضلك\s+)?(أظهر|اظهر|اعرض|أضف|اضف|ضع|انشر|show|add|display|post)\s+/i, "")
    .replace(/^(إعلان|اعلان|بانر|banner|إشعار|اشعار|تنبيه)\s*/i, "")
    .replace(/^(تحذير|تنبيه|هام)\s*[:：]?\s*/i, "")
    .replace(/(على|في|لكل)\s+(المنصة|الموقع|الصفحة|الرئيسية|واجهة\s*المستخدم|المستخدمين|الزوار)/gi, " ")
    // "يبقى ٣ دقائق" is a duration, not part of the message.
    .replace(/(لمدة|مدة|يظل|يبقى|تظل|تبقى|يبقي|مدة\s*ظهور)?\s*(\d+|[٠-٩]+)\s*(دقيقة|دقائق|دقايق|دق|minutes?|mins?)/gi, " ")
    .replace(/^[\s:：\-–]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) text = raw;
  return { text: text.slice(0, 400), tone: danger ? "danger" : warning ? "warning" : "info" };
}
