import { bannerFromSentence, updateControls, type BannerTone } from "./siteControls";
import { findTool, runOwnerTool } from "./ownerTools";

/**
 * One owner sentence → either an instant site change (banner, maintenance,
 * announcement) or one shell command that runs immediately. No plans, no steps:
 * the console shows `$ command` and its live output while it runs.
 */

export type IntentPlan =
  | { kind: "site"; action: string; summary: string }
  | { kind: "tool"; action: string; summary: string; data?: unknown }
  | { kind: "command"; command: string; summary: string }
  | { kind: "message"; summary: string };

const SHOW = /(أظهر|اظهر|اعرض|أعرض|عرض|ضع|انشر|أضف|اضف|شغّل|فعل|show|add|display|enable)/i;
const HIDE = /(أخف|اخف|اخفي|أخفِ|شيل|أزل|ازل|امسح|احذف|أوقف|اوقف|عطّل|عطل|disable|hide|remove|clear|stop)/i;

/** "٣ دقائق" / "3 minutes" → 3; anything absurd is clamped to one day. */
export function parseMinutes(sentence: string): number | null {
  const arabic = sentence.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  const match = /(\d{1,4})\s*(دقيقة|دقائق|دقايق|دق|minutes?|mins?)/i.exec(arabic);
  if (!match) return null;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(minutes, 1440);
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Fast path: common orders are applied without spending a model call. */
export function directSiteIntent(sentence: string): IntentPlan | null {
  const text = clean(sentence);
  const isBanner = /(بانر|banner|شريط|إعلان|اعلان|إشعار|اشعار|تحذير|تنبيه)/i.test(text);
  const onSite = /(المنصة|الموقع|الصفحة|الرئيسية|للمستخدمين|للزوار|site|page)/i.test(text);
  // "أظهر إعلان تحذير: صيانة الليلة" is a banner, not a maintenance switch.
  const isMaintenance =
    /(صيانة|maintenance)/i.test(text) &&
    (SHOW.test(text) || HIDE.test(text)) &&
    !/(إعلان|اعلان|بانر|banner|شريط)/i.test(text);
  const isAnnouncement = /(إعلان منبثق|اعلان منبثق|نافذة إعلان|نافذة اعلان|announcement|modal)/i.test(text);

  if (isMaintenance) {
    if (HIDE.test(text)) {
      updateControls({ maintenance: { enabled: false } });
      return { kind: "site", action: "maintenance-off", summary: "أُوقف وضع الصيانة؛ الموقع عاد للجميع" };
    }
    if (SHOW.test(text) || /صيانة/.test(text)) {
      const message = clean(
        text
          .replace(/^(أعلن|اعلن|شغّل|شغل|فعّل|فعل|أوقف|اوقف|أغلق|اغلق)?\s*/i, "")
          .replace(/(وضع\s+)?صيانة/gi, "")
          .replace(/^(الموقع|المنصة)/i, ""),
      );
      updateControls({ maintenance: { enabled: true, message: message || "الموقع في صيانة قصيرة، نعود بعد قليل." } });
      return { kind: "site", action: "maintenance-on", summary: "فُعّل وضع الصيانة للمستخدمين" };
    }
  }

  if (isAnnouncement && SHOW.test(text)) {
    const body = clean(text.replace(/^(أضف|اضف|اعرض|أظهر|اظهر|انشر)\s*/i, "").replace(/(إعلان منبثق|اعلان منبثق|نافذة إعلان|نافذة اعلان|announcement|modal)/gi, ""));
    updateControls({ announcement: { enabled: true, title: "إعلان", body: body || "لدينا جديد." } });
    return { kind: "site", action: "announcement-on", summary: "ظهر إعلان منبثق لكل مستخدم" };
  }

  if (isBanner && (onSite || SHOW.test(text) || HIDE.test(text))) {
    if (HIDE.test(text) && !/(تحذير|تنبيه)/.test(text.replace(/.*(أخف|اخف|شيل|أزل|ازل).*/, ""))) {
      updateControls({ banner: { enabled: false } });
      return { kind: "site", action: "banner-off", summary: "أُخفي شريط الإعلان من المنصة" };
    }
    if (SHOW.test(text)) {
      const { text: bannerText, tone } = bannerFromSentence(text);
      const alarm = /(صوت|إنذار|انذار|سارينة|صفير|رنين|siren|alarm|sound)/i.test(text);
      const minutes = parseMinutes(text);
      updateControls({
        banner: {
          enabled: true,
          text: bannerText,
          tone,
          alarm,
          expiresAt: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
        },
      });
      return {
        kind: "site",
        action: "banner-on",
        summary: `ظهر شريط${alarm ? " مع صوت إنذار" : ""} على المنصة: «${bannerText}»`,
      };
    }
  }

  return null;
}

/** Accepts json, a fenced block, or one plain line; returns a single command. */
export function parseCommandPlan(raw: string): string | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { command?: unknown };
      if (typeof parsed.command === "string" && parsed.command.trim()) return parsed.command.trim().slice(0, 2000);
    } catch {
      // Not JSON: fall through to the text forms.
    }
  }
  const fenced = text.match(/```(?:bash|sh|shell)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const line = body
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row && !row.startsWith("#"))
    .map((row) => row.replace(/^\$\s*/, "").replace(/^(الأمر|command)\s*[:：]\s*/i, ""))
    .join(" && ")
    .trim();
  return line ? line.slice(0, 2000) : null;
}

export async function planFromText(sentence: string): Promise<IntentPlan> {
  const direct = directSiteIntent(sentence);
  if (direct) return direct;

  // A named tool ("شغّل الاختبارات"، "خذ نسخة احتياطية") runs directly.
  const tool = findTool(sentence);
  if (tool === "replace_in_text_file") {
    return {
      kind: "message",
      summary: "تعديل ملفات الكود يتم من مساحة ZENOX (قسم الملفات أو كود البنية) وليس من أمر نصي.",
    };
  }
  if (tool) {
    const result = await runOwnerTool(tool);
    return { kind: "tool", action: tool, summary: result.summary, data: result.data };
  }

  const text = sentence.trim();
  // A command the owner typed himself runs as-is.
  if (/^\$|^(sudo\s+)?(ls|cd|cat|pwd|git|npm|npx|pnpm|node|python3?|bash|sh|curl|du|df|ps|top|grep|rg|find|chmod|chown|mkdir|cp|mv|rm|systemctl|docker)\b/.test(text)) {
    return { kind: "command", command: text.replace(/^\$\s*/, ""), summary: "نفّذت الأمر المكتوب" };
  }

  // No model-written shell: an order it cannot map to a known action becomes a
  // message that points the owner at his own panel.
  return {
    kind: "message",
    summary: "لا أنفّذ أوامر shell تلقائيًا. اكتب الأمر في Terminal داخل مساحة ZENOX، أو اطلب إجراءً معروفًا (إعلان، صيانة، أداة).",
  };
}
