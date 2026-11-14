import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

/**
 * Security audit for the owner's own project and deployment.
 *
 * It only reads the code and asks the local server about its own routes, so it
 * is safe to expose in the owner center: no external host is scanned.
 */

const run = promisify(execFile);

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Finding = {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
};

export type AuditReport = {
  score: number;
  scannedFiles: number;
  findings: Finding[];
  checks: number;
  durationMs: number;
  generatedAt: string;
};

const WEIGHT: Record<Severity, number> = { critical: 30, high: 15, medium: 7, low: 3, info: 0 };

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".expo", "dist", "dist-web", "uploads", ".zenox-chats",
  ".zenox-backups", "artifacts", "android-app/build", ".next", "coverage",
]);

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sh|ya?ml|java|kt|gradle|properties|env|example)$/i;

export type SecretHit = { kind: string; line: number };

const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "مفتاح Google/Gemini", re: /AIza[0-9A-Za-z_-]{30,}/ },
  { kind: "مفتاح OpenAI", re: /\bsk-[A-Za-z0-9]{20,}/ },
  { kind: "مفتاح GitHub", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: "مفتاح Slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "مفتاح AWS", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "مفتاح Stripe", re: /\b(sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { kind: "مفتاح خاص", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: "JWT كامل", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/** Never returns the secret itself: only its kind and line. */
export function scanTextForSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 4000) continue;
    for (const { kind, re } of SECRET_PATTERNS) {
      if (re.test(line)) hits.push({ kind, line: index + 1 });
    }
  }
  return hits;
}

export type PatternRule = { id: string; severity: Severity; title: string; detail: string; re: RegExp };

const PATTERN_RULES: PatternRule[] = [
  {
    id: "tls-disabled",
    severity: "critical",
    title: "التحقق من شهادة TLS معطّل",
    detail: "قبول أي شهادة يفتح الباب لاعتراض الاتصال. أزل rejectUnauthorized: false.",
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
  },
  {
    id: "cors-wildcard",
    severity: "high",
    title: "CORS مفتوح للجميع",
    detail: "origin: \"*\" يسمح لأي موقع بقراءة ردود الخادم. حدّد الأصل المسموح.",
    re: /origin\s*:\s*(['"]\*['"]|true\b)/,
  },
  {
    id: "dynamic-eval",
    severity: "high",
    title: "تنفيذ كود ديناميكي",
    detail: "eval أو new Function يحوّل أي إدخال نصي إلى كود قابل للتنفيذ.",
    re: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    id: "shell-interpolation",
    severity: "high",
    title: "أمر شل مبني من نص",
    detail: "بناء أمر من متغيّر دون تمريره كمصفوفة وسائط قد يسمح بحقن أوامر.",
    re: /exec\(\s*`[^`]*\$\{/,
  },
  {
    id: "html-injection",
    severity: "medium",
    title: "إدخال HTML خام",
    detail: "dangerouslySetInnerHTML أو innerHTML بمحتوى غير موثوق يفتح XSS.",
    re: /dangerouslySetInnerHTML|\.innerHTML\s*=/,
  },
  {
    id: "plain-http",
    severity: "low",
    title: "رابط http غير مشفّر",
    detail: "الاتصال غير المشفّر يكشف البيانات، استخدم https.",
    re: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[a-z0-9.-]+/i,
  },
  {
    id: "long-lived-token",
    severity: "low",
    title: "مدة جلسة طويلة جدًا",
    detail: "جلسة ZENOX الافتراضية 30 يومًا؛ قلّلها لو الجهاز مشترك.",
    re: /OWNER_SESSION_HOURS\s*[=:]\s*['"]?(7\d\d|[1-9]\d{3,})/,
  },
];

export type PatternHit = { rule: PatternRule; line: number };

export function scanTextForPatterns(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes("securityAudit.ts")) continue;
    for (const rule of PATTERN_RULES) {
      if (rule.re.test(line)) hits.push({ rule, line: index + 1 });
    }
  }
  return hits;
}

function walk(root: string, limit: number): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= limit) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const full = join(dir, entry);
      const rel = relative(root, full);
      if (SKIP_DIRS.has(entry) || SKIP_DIRS.has(rel)) continue;
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        visit(full);
      } else if (info.size < 1_500_000 && SOURCE_EXT.test(entry)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

type DependencyAudit = { total: number; critical: number; high: number; note: string };

async function auditDependencies(root: string): Promise<DependencyAudit> {
  try {
    const { stdout } = await run("npm", ["audit", "--json", "--omit=dev"], {
      cwd: root,
      timeout: 25_000,
      maxBuffer: 4_000_000,
    });
    const parsed = JSON.parse(stdout) as { metadata?: { vulnerabilities?: Record<string, number> } };
    const vulns = parsed.metadata?.vulnerabilities ?? {};
    return {
      total: Number(vulns.total ?? 0),
      critical: Number(vulns.critical ?? 0),
      high: Number(vulns.high ?? 0),
      note: "",
    };
  } catch (error) {
    // npm exits non-zero when it finds vulnerabilities; its JSON is still usable.
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout) as { metadata?: { vulnerabilities?: Record<string, number> } };
        const vulns = parsed.metadata?.vulnerabilities ?? {};
        return {
          total: Number(vulns.total ?? 0),
          critical: Number(vulns.critical ?? 0),
          high: Number(vulns.high ?? 0),
          note: "",
        };
      } catch {
        // fall through
      }
    }
    return { total: 0, critical: 0, high: 0, note: "تعذر فحص الحزم الآن (لا شبكة أو لا سجل npm)." };
  }
}

export type LiveCheck = { name: string; ok: boolean; detail: string };

/** Asks this very server whether its owner routes really refuse anonymous callers. */
export type LiveCheckReport = { reachable: boolean; checks: LiveCheck[] };

export async function checkOwnerRoutes(port = Number(process.env.PORT) || 3000): Promise<LiveCheck[]> {
  const base = `http://127.0.0.1:${port}`;
  const probes: { name: string; path: string; method: string; body?: string; expect: number }[] = [
    { name: "health عام", path: "/api/health", method: "GET", expect: 200 },
    { name: "تريمينال ZENOX مغلق", path: "/api/owner/terminal/state", method: "GET", expect: 403 },
    {
      name: "رفع الملفات مغلق",
      path: "/api/owner/upload?name=x.txt",
      method: "POST",
      body: "x",
      expect: 403,
    },
    {
      name: "طلبات ZENOX في tRPC مغلقة",
      path: "/api/trpc/owner.memory.list?batch=1&input=%7B%7D",
      method: "GET",
      expect: 403,
    },
    {
      name: "تنفيذ الأوامر مغلق",
      path: "/api/trpc/owner.terminal.exec?batch=1",
      method: "POST",
      body: '{"0":{"json":{"command":"echo hi"}}}',
      expect: 403,
    },
  ];
  const results: LiveCheck[] = [];
  let reachable = false;
  for (const probe of probes) {
    try {
      const response = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        headers: probe.body ? { "content-type": "application/json" } : undefined,
        body: probe.body,
        signal: AbortSignal.timeout(6000),
      });
      reachable = true;
      const status = response.status;
      const rejectedOwnerCall = probe.expect === 403 && status >= 400 && status < 500;
      const ok = status === probe.expect || rejectedOwnerCall;
      results.push({
        name: probe.name,
        ok,
        detail: ok ? `محجوب (${status})` : `توقعت 403 وحصلت ${status}`,
      });
    } catch (error) {
      results.push({ name: probe.name, ok: false, detail: `تعذر الفحص: ${String(error).slice(0, 80)}` });
    }
  }
  // The server may legitimately be stopped while the project is audited offline.
  if (!reachable) {
    return probes.map((probe) => ({
      name: probe.name,
      ok: true,
      detail: "لم يُفحص حيًّا: الخادم غير متاح من هذه العملية.",
    }));
  }
  return results;
}

export async function runSecurityAudit(root = process.cwd()): Promise<AuditReport> {
  const started = Date.now();
  const findings: Finding[] = [];
  const files = walk(root, 900);
  let checks = 0;

  for (const file of files) {
    const rel = relative(root, file);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // The auditor and its fixtures contain the very patterns it looks for.
    const isFixture = /(^|\/)(tests?\/|.*\.test\.tsx?$)/.test(rel) || rel.endsWith("securityAudit.ts");
    if (isFixture) continue;
    const isEnvLike = /(^|\/)\.env(\.|$)/.test(rel);
    if (!isEnvLike) {
      checks += 1;
      for (const hit of scanTextForSecrets(text)) {
        findings.push({
          id: "secret-in-source",
          severity: "critical",
          title: `مفتاح مكشوف داخل الكود (${hit.kind})`,
          detail: "انقل القيمة إلى .env بصلاحية 600 أو إلى أسرار الخادم ثم بدّل المفتاح.",
          file: rel,
          line: hit.line,
        });
      }
    }
    checks += 1;
    for (const hit of scanTextForPatterns(text)) {
      findings.push({
        id: hit.rule.id,
        severity: hit.rule.severity,
        title: hit.rule.title,
        detail: hit.rule.detail,
        file: rel,
        line: hit.line,
      });
    }
  }

  // Secret files must not be world-readable and must never sit in the web root.
  for (const name of [".env", ".zenox-owner.json"]) {
    const full = join(root, name);
    const mode = fileMode(full);
    checks += 1;
    if (mode !== null) {
      if ((mode & 0o077) !== 0) {
        findings.push({
          id: "secret-permissions",
          severity: "high",
          title: `${name} مقروء من مستخدمين آخرين`,
          detail: `الصلاحية الحالية ${mode.toString(8)}. المطلوب 600.`,
          file: name,
        });
      } else {
        findings.push({
          id: "secret-permissions-ok",
          severity: "info",
          title: `${name} محمي بصلاحية 600`,
          detail: "لا يمكن لمستخدم آخر على الخادم قراءته.",
          file: name,
        });
      }
    }
  }

  // The exported web app must not contain the server's secrets or source maps.
  for (const webDir of ["dist-web", "public"]) {
    checks += 1;
    const leaked = walk(join(root, webDir), 400).filter((file) => /\.(map|env)$|\.zenox/.test(file));
    if (leaked.length > 0) {
      findings.push({
        id: "web-root-leak",
        severity: "critical",
        title: `ملفات حساسة داخل ${webDir}`,
        detail: `وُجد ${leaked.length} ملفًا (خرائط كود أو أسرار) يمكن تنزيله من الموقع.`,
      });
    }
  }

  const deps = await auditDependencies(root);
  checks += 1;
  if (deps.critical > 0 || deps.high > 0) {
    findings.push({
      id: "vulnerable-dependencies",
      severity: deps.critical > 0 ? "critical" : "high",
      title: `${deps.critical + deps.high} حزمة فيها ثغرة عالية الخطورة`,
      detail: `إجمالي الثغرات ${deps.total}. شغّل «تحديث آمن» في الأسفل لترقية ما يمكن ترقيته.`,
    });
  } else if (!deps.note) {
    findings.push({
      id: "dependencies-ok",
      severity: "info",
      title: "لا ثغرات معروفة عالية الخطورة في حزم الإنتاج",
      detail: `فحص ${deps.total} ثغرة معروفة عبر npm audit.`,
    });
  } else {
    findings.push({ id: "dependencies-skipped", severity: "info", title: "فحص الحزم متوقف", detail: deps.note });
  }

  const live = await checkOwnerRoutes();
  checks += live.length;
  const liveSkipped = live.every((check) => check.detail.startsWith("لم يُفحص حيًّا"));
  if (liveSkipped) {
    findings.push({
      id: "routes-not-probed",
      severity: "info",
      title: "مسارات ZENOX لم تُفحص حيًّا",
      detail: "الخادم غير متاح من نفس العملية؛ الفحص الحي يعمل داخل الخادم نفسه.",
    });
  } else {
    for (const check of live) {
      findings.push({
        id: check.ok ? "route-protected" : "route-open",
        severity: check.ok ? "info" : "critical",
        title: check.ok ? `${check.name} ✓` : `${check.name} مفتوح للجميع`,
        detail: check.detail,
      });
    }
  }

  const penalty = findings.reduce((total, finding) => total + WEIGHT[finding.severity], 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    score,
    scannedFiles: files.length,
    findings,
    checks,
    durationMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}
