import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { monitorSnapshot } from "./monitor";
import { createOrderStore, ownerOrderFile } from "./orderStore";
import { createImage } from "./documentTools";
import { buildApk, deleteFile, editFile, listDir, rebuildWeb, restartServer, runCommand } from "./agentWorkspace";
import { readWorkspaceFile, writeWorkspaceFile } from "../workspace-files";

/**
 * Fast, deterministic actions the owner runs from one button or one sentence.
 * No model call, no round trip through the agent: each tool finishes in
 * milliseconds to a few seconds and reports what it actually did.
 */

export type OwnerToolResult = {
  ok: boolean;
  tool: string;
  summary: string;
  ms: number;
  data?: unknown;
};

const ROOT = () => process.cwd();
const PROMO_SITE_URL = (process.env.EXPO_PUBLIC_SITE_URL || "https://site-46a89efcae814916890b8988f2f1d0dd.freebuff.page").replace(/\/$/, "");
function promoAdminPassword(): string {
  if (process.env.PROMO_ADMIN_PASSWORD) return process.env.PROMO_ADMIN_PASSWORD;
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    const file = join(process.cwd(), "artifacts", "promo-admin-password.txt");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  } catch {
    /* ignore */
  }
  return "";
}
async function promoLoginCookie(pw: string): Promise<string> {
  const res = await fetch(`${PROMO_SITE_URL}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
  if (!res.ok) throw new Error("كلمة مرور إدارة الموقع غير صحيحة.");
  return res.headers.get("set-cookie") || "";
}

function inside(input: string): string {
  const root = ROOT();
  const full = resolve(root, String(input || "."));
  if (full !== root && !full.startsWith(root + "/")) throw new Error("مسار خارج المشروع مرفوض");
  return full;
}

function sh(command: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(command, args, { cwd: ROOT(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      done({ code, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
    });
  });
}

const pnpm = (...args: string[]) => sh("npx", ["--yes", "pnpm@9.12.0", ...args], 300_000);

/** Every action the console can perform without spending a model call. */
export const OWNER_TOOLS = [
    { name: "replace_in_text_file",
    label: "استبدال نص في ملف",
    description: "يستبدل نصًا حرفيًا داخل ملف ويحفظ نسخة من السابق.",
    args: ["path", "find", "replace"],
  },
  { name: "run_command", label: "أمر Terminal", description: "ينفّذ أمر shell حقيقيًا داخل المشروع ويعيد المخرجات.", args: ["command"] },
  { name: "list_dir", label: "عرض مجلد", description: "يعرض ملفات مجلد داخل المشروع.", args: ["path"] },
  { name: "read_file", label: "قراءة ملف", description: "يقرأ محتوى ملف داخل المشروع.", args: ["path"] },
  { name: "write_file", label: "كتابة ملف", description: "ينشئ ملفًا أو يستبدله مع نسخة احتياطية.", args: ["path", "content"] },
  { name: "create_file", label: "إنشاء ملف", description: "ينشئ ملفًا جديدًا داخل المشروع.", args: ["path", "content"] },
  { name: "edit_file", label: "تعديل ملف", description: "يستبدل نصًا محددًا داخل ملف.", args: ["path", "find", "replace"] },
  { name: "delete_file", label: "حذف ملف", description: "يحذف ملفًا داخل المشروع بعد الحماية.", args: ["path"] },
  { name: "http_request", label: "طلب HTTP", description: "ينفّذ طلب HTTP خارجيًا ويعيد الحالة والرد.", args: ["url", "method", "body"] },
  { name: "generate_image", label: "توليد صورة", description: "يصمّم صورة من وصف ويحفظها في generated.", args: ["prompt", "name"] },
  { name: "restart_server", label: "إعادة تشغيل الخادم", description: "يعيد تشغيل خادم المنصة بعد التعديلات.", args: [] },
  { name: "site_build", label: "بناء الموقع", description: "يبني الخادم وواجهة الويب.", args: [] },
  { name: "site_restart", label: "إعادة تشغيل الموقع", description: "يعيد تشغيل خادم الموقع.", args: [] },
  { name: "build_apk", label: "بناء APK", description: "يبني حزمة أندرويد إن توفرت أدوات البناء.", args: [] },
  { name: "run_tests", label: "تشغيل الاختبارات", description: "يشغّل vitest ويلخّص النتيجة.", args: [] },
  { name: "typecheck", label: "فحص الأنواع", description: "يشغّل tsc ويعيد أول الأخطاء.", args: [] },
  { name: "backup_project", label: "نسخة احتياطية", description: "يضغط المشروع في .zenox-backups.", args: [] },
  { name: "list_uploads", label: "الملفات المرفوعة", description: "يعرض آخر الملفات في مجلد uploads.", args: [] },
  { name: "build_web", label: "بناء الويب", description: "يعيد بناء واجهة الويب.", args: [] },
  { name: "git_status", label: "حالة Git", description: "يعرض الملفات المعدّلة.", args: [] },
  { name: "disk_usage", label: "حجم المشروع", description: "يحسب حجم المجلدات الرئيسية.", args: [] },
  { name: "speed_report", label: "تقرير السرعة", description: "يعرض زمن الاستجابة وعدد الطلبات.", args: [] },
  { name: "orders_report", label: "سجل الأوامر", description: "يعرض آخر الأوامر المحفوظة على القرص وحالتها.", args: [] },
  { name: "promo_content_get", label: "جلب محتوى الموقع", description: "يجلب محتوى موقع ZANOX9.AI (نصوص، مزايا، FAQ، إعلانات).", args: [] },
  { name: "promo_content_set", label: "حفظ محتوى الموقع", description: "يحفظ محتوى موقع ZANOX9.AI من JSON.", args: ["json"] },
  { name: "promo_ad_add", label: "إضافة إعلان", description: "يضيف إعلانًا جديدًا للموقع.", args: ["title", "body", "ctaLabel", "ctaUrl", "tone"] },
  { name: "promo_ad_remove", label: "حذف إعلان", description: "يحذف إعلانًا حسب المعرّف.", args: ["id"] },
] as const;

export type OwnerToolName = (typeof OWNER_TOOLS)[number]["name"];

export function findTool(text: string): OwnerToolName | null {
  const rules: [OwnerToolName, RegExp][] = [
    ["run_tests", /(اختبار|اختبارات|tests?\b|vitest)/i],
    ["typecheck", /(فحص\s*(الأنواع|الانواع)|typecheck|tsc)/i],
    ["backup_project", /(نسخة\s*احتياطية|نسخ\s*احتياطي|backup)/i],
    ["list_uploads", /(الملفات\s*(المرفوعة|المرفوعه)|uploads|المرفوعات)/i],
    ["build_web", /(بناء\s*(الويب|الواجهة)|build:web|أعد\s*بناء\s*الواجهة)/i],
    ["git_status", /(git\s*status|حالة\s*git|الملفات\s*المعدلة)/i],
    ["disk_usage", /(حجم\s*(المشروع|المجلد)|disk|du\b)/i],
    ["promo_content_get", /(جلب\s*محتوى\s*الموقع|محتوى\s*الموقع|get\s*site\s*content)/i],
    ["promo_ad_add", /(إضافة\s*إعلان|اعلان\s*جديد|add\s*ad)/i],
    ["promo_ad_remove", /(حذف\s*إعلان|remove\s*ad)/i],
    ["speed_report", /(تقرير\s*السرعة|سرعة\s*الخادم|latency|الأداء)/i],
  ];
  for (const [name, pattern] of rules) if (pattern.test(text)) return name;
  return null;
}

async function speedReport(): Promise<OwnerToolResult> {
  // Real in-process counters, not a file that may not exist.
  const snapshot = monitorSnapshot();
  return {
    ok: true,
    tool: "speed_report",
    summary: `الطلبات: ${snapshot.requests} · الأخطاء: ${snapshot.errors} · متوسط ${snapshot.averageMs}ms · أبطأ ${snapshot.slowestMs}ms · ذاكرة ${snapshot.memoryMb}MB · تشغيل ${snapshot.uptimeSeconds}s`,
    ms: 0,
    data: snapshot,
  };
}

export async function runOwnerTool(name: string, args: Record<string, unknown> = {}): Promise<OwnerToolResult> {
  const started = Date.now();
  const finish = (ok: boolean, summary: string, data?: unknown): OwnerToolResult => ({
    ok,
    tool: name,
    summary,
    ms: Date.now() - started,
    data,
  });

  try {
    switch (name) {
      case "run_command": {
        const command = String(args.command ?? "").trim();
        if (!command) return finish(false, "الأمر فارغ.");
        const result = await runCommand({ command, timeoutMs: Number(args.timeoutMs) || 120_000 });
        return finish(result.code === 0 && !result.timedOut, result.output.slice(-8000) || `(exit ${result.code ?? "?"})`, result);
      }

      case "list_dir": {
        const result = listDir({ path: typeof args.path === "string" ? args.path : "." });
        return finish(true, result.files.length ? result.files.join("\n") : "المجلد فارغ.", result);
      }

      case "read_file": {
        const path = String(args.path ?? "").trim();
        if (!path) return finish(false, "لم يُحدَّد مسار الملف.");
        const file = readWorkspaceFile(path);
        const content = String((file as { content?: unknown }).content ?? "");
        return finish(true, content.length > 8000 ? `${content.slice(0, 8000)}\n…(مقتطع)` : content, file);
      }

      case "write_file":
      case "create_file": {
        const path = String(args.path ?? "").trim();
        const content = String(args.content ?? "");
        if (!path) return finish(false, "لم يُحدَّد مسار الملف.");
        const result = writeWorkspaceFile({ path, content });
        return finish(true, `حُفظ ${path} (${content.length} حرفًا).`, result);
      }

      case "edit_file": {
        const result = editFile({
          path: String(args.path ?? ""),
          find: String(args.find ?? ""),
          replace: String(args.replace ?? ""),
          all: Boolean(args.all),
        });
        return finish(true, `عُدّل ${result.path} (${result.replaced} موضعًا).`, result);
      }

      case "delete_file": {
        const result = deleteFile({ path: String(args.path ?? "") });
        return finish(true, `حُذف ${result.path}.`, result);
      }

      case "http_request": {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return finish(false, "الرابط يجب أن يبدأ بـ http:// أو https://");
        const method = String(args.method ?? "GET").toUpperCase();
        const body = args.body == null ? undefined : typeof args.body === "string" ? args.body : JSON.stringify(args.body);
        const res = await fetch(url, { method, body, headers: body ? { "content-type": "application/json" } : undefined });
        const text = await res.text();
        return finish(res.ok, `HTTP ${res.status}\n${text.length > 8000 ? `${text.slice(0, 8000)}\n…(مقتطع)` : text}`, { status: res.status, body: text.slice(0, 8000) });
      }

      case "generate_image": {
        const prompt = String(args.prompt ?? "").trim();
        if (!prompt) return finish(false, "لم يُحدَّد وصف الصورة.");
        const image = await createImage({ prompt, name: typeof args.name === "string" ? args.name : undefined });
        return finish(true, `صُمّمت الصورة: ${image.path}`, image);
      }

      case "restart_server":
      case "site_restart": {
        const result = restartServer();
        return finish(true, "سيُعاد تشغيل الخادم بعد ثانيتين.", result);
      }

      case "site_build": {
        const result = await rebuildWeb();
        return finish(result.code === 0, result.code === 0 ? "بُني الخادم والواجهة." : `فشل البناء (exit ${result.code ?? "?"}): ${result.output.slice(-500)}`, result);
      }

      case "build_apk": {
        const result = await buildApk();
        return finish(result.code === 0, result.code === 0 ? "بُنيت حزمة APK." : `فشل بناء APK (exit ${result.code ?? "?"}): ${result.output.slice(-500)}`, result);
      }

      case "replace_in_text_file": {
        const path = inside(String(args.path ?? ""));
        const find = String(args.find ?? "");
        const replace = String(args.replace ?? "");
        if (!find) return finish(false, "لم تُحدد الكلمة المطلوب استبدالها.");
        if (!existsSync(path) || !statSync(path).isFile()) return finish(false, "الملف غير موجود.");
        const before = readFileSync(path, "utf8");
        const hits = before.split(find).length - 1;
        if (hits === 0) return finish(false, "لم أجد النص في الملف.");
        const backup = join(ROOT(), ".zenox-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(path)}`);
        mkdirSync(join(ROOT(), ".zenox-backups"), { recursive: true });
        copyFileSync(path, backup);
        writeFileSync(path, before.split(find).join(replace), "utf8");
        return finish(true, `استبدلت ${hits} موضعًا في ${args.path}.`, { hits, backup });
      }

      case "run_tests": {
        const { code, out } = await pnpm("test");
        const summary = (out.match(/Tests\s+[^\n]+/) ?? out.match(/Test Files\s+[^\n]+/) ?? [""])[0];
        return finish(code === 0, code === 0 ? `الاختبارات نجحت: ${summary}` : `فشل في الاختبارات: ${out.slice(-300)}`, { code });
      }

      case "typecheck": {
        const { code, out } = await pnpm("check");
        const first = out.split("\n").find((line) => line.includes("error TS")) ?? "";
        return finish(code === 0, code === 0 ? "فحص الأنواع نظيف." : `أخطاء أنواع: ${first}`, { code });
      }

      case "backup_project": {
        const dir = join(ROOT(), ".zenox-backups");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `zenox-${new Date().toISOString().replace(/[:.]/g, "-")}.tgz`);
        const { code, out } = await sh("tar", [
          "--exclude=node_modules",
          "--exclude=.git",
          "--exclude=dist",
          "--exclude=dist-web",
          "--exclude=.zenox-backups",
          "-czf",
          file,
          ".",
        ]);
        if (code !== 0) return finish(false, `تعذر إنشاء النسخة: ${out.slice(0, 200)}`);
        const size = statSync(file).size;
        return finish(true, `نسخة احتياطية جاهزة: ${basename(file)} (${Math.round(size / 1024 / 1024)}MB).`, { file, size });
      }

      case "list_uploads": {
        const dir = join(ROOT(), "uploads");
        if (!existsSync(dir)) return finish(true, "لا توجد ملفات مرفوعة بعد.", []);
        const files = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => ({ name: entry.name, size: statSync(join(dir, entry.name)).size }))
          .sort((a, b) => b.size - a.size)
          .slice(0, 20);
        return finish(true, `${files.length} ملفًا في uploads.`, files);
      }

      case "build_web": {
        const { code, out } = await pnpm("build:web");
        return finish(code === 0, code === 0 ? "أُعيد بناء الواجهة." : `فشل البناء: ${out.slice(-300)}`, { code });
      }

      case "git_status": {
        const { out } = await sh("git", ["status", "--short"]);
        const lines = out.split("\n").filter(Boolean);
        return finish(true, `${lines.length} ملفًا معدّلًا.`, lines.slice(0, 40));
      }

      case "disk_usage": {
        const { out } = await sh("du", ["-sh", "uploads", "dist", "dist-web", "node_modules", "artifacts"]);
        return finish(true, out.replace(/\n/g, " · ").slice(0, 400), { raw: out });
      }

      case "orders_report": {
        const store = createOrderStore();
        const orders = store.list(10);
        if (!orders.length) return finish(true, "لا يوجد أمر محفوظ خلال آخر ١٠ دقائق.", { orders, count: 0 });
        const lines = orders.map((order) => `• ${order.summary}${order.action ? ` (${order.action})` : ""}`);
        return finish(true, `${orders.length} أمر محفوظ على القرص:\n${lines.join("\n")}`, {
          count: orders.length,
          orders,
          file: store.file,
        });
      }
      case "speed_report":
        return await speedReport();

      case "promo_content_get": {
        const res = await fetch(`${PROMO_SITE_URL}/api/content`);
        if (!res.ok) return finish(false, "تعذر جلب محتوى الموقع.");
        const data = (await res.json()) as { content?: unknown; updatedAt?: string | null };
        return finish(true, `تم جلب محتوى الموقع (تحديث: ${data.updatedAt ?? "—"}).`, data.content);
      }

      case "promo_content_set": {
        const pw = promoAdminPassword();
        if (!pw) return finish(false, "كلمة مرور إدارة الموقع غير مضبوطة.");
        let content: unknown;
        try {
          content = JSON.parse(String(args.json ?? "{}"));
        } catch {
          return finish(false, "JSON غير صالح.");
        }
        const cookie = await promoLoginCookie(pw);
        const res = await fetch(`${PROMO_SITE_URL}/api/content`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(content) });
        if (!res.ok) return finish(false, `تعذّر الحفظ: ${res.status}`);
        return finish(true, "تم حفظ محتوى موقع ZANOX9.AI.");
      }

      case "promo_ad_add": {
        const pw = promoAdminPassword();
        if (!pw) return finish(false, "كلمة مرور إدارة الموقع غير مضبوطة.");
        const getRes = await fetch(`${PROMO_SITE_URL}/api/content`);
        if (!getRes.ok) return finish(false, "تعذر جلب المحتوى.");
        const getData = (await getRes.json()) as { content?: { ads?: unknown[] } };
        const current = getData.content ?? {};
        const ads = Array.isArray(current.ads) ? [...current.ads] : [];
        if (ads.length >= 6) return finish(false, "الحد الأقصى 6 إعلانات.");
        ads.push({ id: `ad-${Date.now()}`, title: String(args.title ?? ""), body: String(args.body ?? ""), ctaLabel: String(args.ctaLabel ?? ""), ctaUrl: String(args.ctaUrl ?? ""), tone: String(args.tone ?? "info"), enabled: true });
        const cookie = await promoLoginCookie(pw);
        const putRes = await fetch(`${PROMO_SITE_URL}/api/content`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ ...current, ads }) });
        if (!putRes.ok) return finish(false, `تعذّر الحفظ: ${putRes.status}`);
        return finish(true, "تمت إضافة الإعلان.");
      }

      case "promo_ad_remove": {
        const pw = promoAdminPassword();
        if (!pw) return finish(false, "كلمة مرور إدارة الموقع غير مضبوطة.");
        const getRes = await fetch(`${PROMO_SITE_URL}/api/content`);
        if (!getRes.ok) return finish(false, "تعذر جلب المحتوى.");
        const getData = (await getRes.json()) as { content?: { ads?: { id?: string }[] } };
        const current = getData.content ?? {};
        const ads = (Array.isArray(current.ads) ? current.ads : []).filter((a) => a?.id !== String(args.id ?? ""));
        const cookie = await promoLoginCookie(pw);
        const putRes = await fetch(`${PROMO_SITE_URL}/api/content`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ ...current, ads }) });
        if (!putRes.ok) return finish(false, `تعذّر الحفظ: ${putRes.status}`);
        return finish(true, "تم حذف الإعلان.");
      }

      default:
        return finish(false, `أداة غير معروفة: ${name}`);
    }
  } catch (error) {
    return finish(false, error instanceof Error ? error.message : "فشل التنفيذ.");
  }
}
