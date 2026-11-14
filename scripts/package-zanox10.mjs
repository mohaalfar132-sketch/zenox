#!/usr/bin/env node
/**
 * Builds the single deliverable archive: ZANOX10.zip
 *
 *   node scripts/package-zanox10.mjs
 *
 * It copies the whole project (source, tests, scripts, docs) plus the sealed
 * secrets folder, and leaves behind anything that must be rebuilt or must never
 * travel: node_modules, build output, logs, the plaintext `.env`, and the local
 * working folders.
 */
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const requested = process.argv.find((arg) => arg.startsWith("--version="));
const existing = existsSync(join(root, "artifacts"))
  ? readdirSync(join(root, "artifacts"))
      .map((name) => /^ZANOX10-v(\d+)\.zip$/.exec(name))
      .filter((match) => Boolean(match))
      .map((match) => Number(match[1]))
  : [];
const version = requested
  ? requested.slice("--version=".length).replace(/^v/i, "")
  : String((existing.length ? Math.max(...existing) : 10) + 1);
if (!/^\d+$/.test(version)) {
  console.error("Use --version=N, for example --version=12.");
  process.exit(1);
}
const bundleName = `ZANOX10-v${version}`;
const stage = join(root, "artifacts", bundleName);
const zip = join(root, "artifacts", `${bundleName}.zip`);

const SKIP = new Set([
  "node_modules",
  "dist",
  "dist-web",
  ".git",
  ".expo",
  "artifacts",
  "generated",
  ".zenox-backups",
  "secrets/.env",
  ".env",
  "pnpm-lock.yaml.bak",
]);

// Only the target version is replaced. Older ZANOX10-vN.zip files stay intact.
rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(stage, { recursive: true });

const tarball = join(root, "artifacts", "zanox10.tar");
execFileSync("tar", [
  "-C", root,
  "--exclude=./node_modules",
  "--exclude=./dist",
  "--exclude=./dist-web",
  "--exclude=./.git",
  "--exclude=./.expo",
  "--exclude=./artifacts",
  "--exclude=./generated",
  "--exclude=./.env",
  "--exclude=./.zenox-backups",
  "--exclude=./bin/cloudflared",
  "--exclude=./deploy/*.tgz",
  "--exclude=*.log",
  "-cf", tarball,
  ".",
]);
execFileSync("tar", ["-C", stage, "-xf", tarball]);
rmSync(tarball, { force: true });

writeFileSync(
  join(stage, "README-ZANOX10.md"),
  `# ${bundleName} — حزمة التشغيل الكاملة

هذه حزمة واحدة تحتوي المشروع كاملًا **ومعه مفاتيحه مشفّرة**، جاهزة للعمل على جهاز آخر.

> استُثني فقط ملف \`bin/cloudflared\` الثنائي الكبير وأرشيف الإصدار القديم \`deploy/*.tgz\` لأنهما قابلان لإعادة التوليد/التحميل؛ كل الكود والتصاميم والأصول والاختبارات والأسرار المشفّرة موجودة.

## التشغيل
\`\`\`bash
npm install          # أو pnpm install
npm run build        # بناء الخادم
npm run build:web    # بناء الواجهة
node dist/index.js   # PORT=3000 افتراضيًا
\`\`\`

## المفاتيح
- كل المفاتيح داخل \`secrets/.env.enc.json\` **مشفّرة AES-256-GCM**؛ لا يوجد أي مفتاح بنص صريح في الحزمة.
- عند الإقلاع يقرأ الخادم الملف ويفكّه في الذاكرة فقط ويضع كل مفتاح في خانته (Groq / Gemini / OpenAI / OpenRouter / Z.AI) — لا يُكتب إلى قرص ولا يُطبع في أي سجل.
- مفتاح فك التشفير في \`secrets/secrets.key\` بصلاحية 0600، وبيانات دخول المالك في \`secrets/owner-credential.json\`، فتعمل **نفس كلمة مرور المالك** على الجهاز الجديد.
- لتغيير أي مفتاح: افتح \`/keys\` → «دخول محمي» → الصق المفتاح → «حفظ وفحص».

## الأمان
- واجهة المالك وشاشتها لا تظهران للمستخدمين، وأوامر shell للمالك فقط، ولا مسار يحذف كلمة المرور.
- الأسرار لا تُعرَض في الواجهة: قسم «الأسرار» يعرض الأسماء فقط لا القيم.
- ⚠️ لأن المفتاح يُشحن مع الحزمة لتعمل المفاتيح تلقائيًا، من يملك الحزمة يملك فكّها. احفظ الـZIP في مكان خاص، أو احذف \`secrets/secrets.key\` بعد أول تشغيل وأعد توليده بـ\`node scripts/seal-secrets.mjs\`.
`,
);

const before = execFileSync("du", ["-sh", stage]).toString().trim();
execFileSync("zip", ["-q", "-r", "-X", zip, bundleName], { cwd: join(root, "artifacts") });
const size = (statSync(zip).size / 1024 / 1024).toFixed(2);
const files = execFileSync("bash", ["-lc", `cd "${stage}" && find . -type f | wc -l`]).toString().trim();
const hasSecrets = existsSync(join(stage, "secrets", ".env.enc.json"));
const hasEnv = existsSync(join(stage, ".env"));
console.log(`${bundleName}.zip → ${size} MB · ${files} files · ${before}`);
console.log(`sealed secrets included: ${hasSecrets} · plaintext .env included: ${hasEnv}`);
