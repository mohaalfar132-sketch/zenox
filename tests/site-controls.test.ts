import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { bannerFromSentence, publicControls, readControls, updateControls } from "../server/_core/siteControls";
import { directSiteIntent, parseCommandPlan, parseMinutes } from "../server/_core/execIntent";

beforeEach(() => {
  process.env.ZENOX_DATA_DIR = mkdtempSync(join(tmpdir(), "zenox-controls-"));
});

describe("live site controls", () => {
  it("starts empty and persists a banner", () => {
    expect(readControls().banner.enabled).toBe(false);
    const next = updateControls({ banner: { enabled: true, text: "تحذير: صيانة مساءً", tone: "warning" } });
    expect(next.banner.enabled).toBe(true);
    expect(readControls().banner.text).toBe("تحذير: صيانة مساءً");
    expect(publicControls().banner.tone).toBe("warning");
  });

  it("turns the banner off when the text is cleared", () => {
    updateControls({ banner: { enabled: true, text: "خبر" } });
    updateControls({ banner: { text: "" } });
    expect(readControls().banner.enabled).toBe(false);
  });

  it("keeps announcement and maintenance independent", () => {
    updateControls({ announcement: { enabled: true, title: "جديد", body: "نسخة ٢" } });
    updateControls({ maintenance: { enabled: true, message: "دقيقة" } });
    const state = readControls();
    expect(state.announcement.enabled).toBe(true);
    expect(state.maintenance.message).toBe("دقيقة");
    updateControls({ maintenance: { enabled: false } });
    expect(readControls().announcement.enabled).toBe(true);
  });

  it("extracts the banner text and tone from one sentence", () => {
    expect(bannerFromSentence("أظهر إعلان تحذير على المنصة: صيانة الليلة")).toEqual({
      text: "صيانة الليلة",
      tone: "warning",
    });
    expect(bannerFromSentence("أظهر بانر: عرض جديد").tone).toBe("info");
    expect(bannerFromSentence("تحذير خطر: محاولة اختراق").tone).toBe("danger");
  });
});

describe("chat → command console", () => {
  it("applies a banner order with no model call", () => {
    const plan = directSiteIntent("أظهر إعلان تحذير على المنصة: صيانة الليلة");
    expect(plan?.kind).toBe("site");
    expect(readControls().banner.enabled).toBe(true);
    expect(readControls().banner.text).toContain("صيانة الليلة");
  });

  it("hides the banner on a hide order", () => {
    directSiteIntent("أظهر إعلان تحذير على المنصة: تنبيه");
    const plan = directSiteIntent("أخف إعلان المنصة");
    expect(plan?.kind).toBe("site");
    expect(readControls().banner.enabled).toBe(false);
  });

  it("switches maintenance on and off", () => {
    expect(directSiteIntent("شغّل وضع صيانة للموقع")?.kind).toBe("site");
    expect(readControls().maintenance.enabled).toBe(true);
    directSiteIntent("أوقف وضع الصيانة");
    expect(readControls().maintenance.enabled).toBe(false);
  });

  it("reads a command from json, a fence or a plain line", () => {
    expect(parseCommandPlan('{"command":"ls -la"}')).toBe("ls -la");
    expect(parseCommandPlan("```bash\npnpm test\n```")).toBe("pnpm test");
    expect(parseCommandPlan("$ pwd")).toBe("pwd");
    expect(parseCommandPlan("الأمر: du -sh uploads")).toBe("du -sh uploads");
    expect(parseCommandPlan("   ")).toBeNull();
  });
});

describe("alarm with the announcement", () => {
  it("stores the alarm flag and exposes it publicly", () => {
    updateControls({ banner: { enabled: true, text: "تحذير", tone: "warning", alarm: true } });
    expect(publicControls().banner.alarm).toBe(true);
    updateControls({ banner: { alarm: false } });
    expect(readControls().banner.alarm).toBe(false);
  });

  it("turns the sound on when the order mentions إنذار", () => {
    const plan = directSiteIntent("أظهر إعلان تحذير مع صوت إنذار على المنصة: صيانة الليلة");
    expect(plan?.kind).toBe("site");
    expect(readControls().banner.alarm).toBe(true);
    expect(readControls().banner.tone).toBe("warning");
  });
});

describe("duration and instant chat path", () => {
  it("reads Arabic and Latin minutes", () => {
    expect(parseMinutes("يبقى ٣ دقائق")).toBe(3);
    expect(parseMinutes("لمدة 10 دقايق")).toBe(10);
    expect(parseMinutes("for 5 minutes")).toBe(5);
    expect(parseMinutes("بدون مدة")).toBeNull();
  });

  it("sets an expiry ~3 minutes ahead and hides the banner after it", () => {
    const plan = directSiteIntent("أظهر إعلان تحذير على واجهة المستخدم: صيانة الليلة لمدة ٣ دقائق");
    expect(plan?.kind).toBe("site");
    const state = readControls();
    expect(state.banner.enabled).toBe(true);
    const diff = Date.parse(String(state.banner.expiresAt)) - Date.now();
    expect(diff).toBeGreaterThan(2 * 60_000);
    expect(diff).toBeLessThanOrEqual(3 * 60_000 + 2000);
    expect(state.banner.text).toBe("صيانة الليلة");
  });
});
