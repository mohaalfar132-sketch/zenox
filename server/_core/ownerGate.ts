import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getOwnerCredentialHash } from "../db";
import { invokeLLM, llmHasKey } from "./llm";
import { ownerCredentialDir, storedOwnerHash, verifyOwnerPassword } from "./ownerAuth";
import { ownerSigningSecretSource } from "./ownerSigningSecret";

/**
 * Owner Gate is deliberately independent from the chat database and the main
 * app model pool. It reads every credential source it can find, and stores a
 * local copy after the first successful login so a later database outage does
 * not lock the owner out.
 */

type GateSource = { name: string; hash: string };

const DIAGNOSE_WINDOW_MS = 10 * 60_000;
const DIAGNOSE_MAX = 3;
const diagnoseHits = new Map<string, number[]>();

export function ownerGateFile() {
  const configured = process.env.ZENOX_OWNER_GATE_FILE?.trim();
  return configured && configured.length > 0 ? configured : join(ownerCredentialDir(), "owner-gate.json");
}

export function ownerAuthModel() {
  return process.env.OWNER_AUTH_MODEL?.trim() || "openai/gpt-oss-120b";
}

function hashFromJson(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { hash?: unknown };
    return typeof parsed.hash === "string" && parsed.hash.startsWith("scrypt$") ? parsed.hash : null;
  } catch {
    return null;
  }
}

function databaseHash(): Promise<string | null> {
  if (!process.env.DATABASE_URL) return Promise.resolve(null);
  return Promise.race([
    getOwnerCredentialHash().then((row) => row?.hash ?? null).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
  ]);
}

export async function ownerGateCredentialSources(): Promise<GateSource[]> {
  const sources: GateSource[] = [];
  const seen = new Set<string>();
  const add = (name: string, hash: string | null | undefined) => {
    if (!hash || !hash.startsWith("scrypt$") || seen.has(hash)) return;
    seen.add(hash);
    sources.push({ name, hash });
  };

  add("gate_env", process.env.OWNER_GATE_PASSWORD_HASH?.trim());
  add("gate_file", hashFromJson(ownerGateFile()));
  add("bundled", hashFromJson(join(process.cwd(), "secrets", "owner-credential.json")));
  add("owner_env", process.env.OWNER_PASSWORD_HASH?.trim());
  add("owner_file", storedOwnerHash());
  add("database", await databaseHash());

  return sources;
}

export function persistOwnerGateHash(hash: string) {
  try {
    const file = ownerGateFile();
    const existing = hashFromJson(file);
    if (existing === hash) return true;
    mkdirSync(ownerCredentialDir(), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ hash, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    renameSync(temp, file);
    chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

export async function verifyOwnerGatePassword(password: string): Promise<
  | { ok: true; source: string; persisted: boolean }
  | { ok: false; reason: "no_credential" | "wrong_password"; sources: string[] }
> {
  const sources = await ownerGateCredentialSources();
  if (!sources.length) return { ok: false, reason: "no_credential", sources: [] };

  let matched: GateSource | null = null;
  // Check every source even after a match so a wrong password does not reveal
  // which store answered first.
  for (const source of sources) {
    if (verifyOwnerPassword(password, source.hash) && !matched) matched = source;
  }
  if (!matched) return { ok: false, reason: "wrong_password", sources: sources.map((source) => source.name) };
  const persisted = persistOwnerGateHash(matched.hash);
  return { ok: true, source: matched.name, persisted };
}

export async function ownerGateStatus() {
  const sources = await ownerGateCredentialSources();
  const signingKey = ownerSigningSecretSource();
  return {
    configured: sources.length > 0,
    sources: sources.map((source) => source.name),
    sourceCount: sources.length,
    signingKey,
    sessionReady: signingKey !== "none",
    gateFile: existsSync(ownerGateFile()),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    databaseSourceAvailable: sources.some((source) => source.name === "database"),
    databaseRequired: false,
    independent: true,
    model: ownerAuthModel(),
  };
}

export function diagnoseBlockedFor(key: string) {
  const now = Date.now();
  const recent = (diagnoseHits.get(key) ?? []).filter((at) => now - at < DIAGNOSE_WINDOW_MS);
  if (recent.length) diagnoseHits.set(key, recent);
  else diagnoseHits.delete(key);
  if (recent.length >= DIAGNOSE_MAX) {
    return Math.ceil((DIAGNOSE_WINDOW_MS - (now - recent[0]!)) / 1000);
  }
  return 0;
}

export function recordDiagnoseAttempt(key: string) {
  const existing = (diagnoseHits.get(key) ?? []).filter((at) => Date.now() - at < DIAGNOSE_WINDOW_MS);
  existing.push(Date.now());
  diagnoseHits.set(key, existing);
  if (diagnoseHits.size > 2000) {
    const oldest = diagnoseHits.keys().next().value;
    if (oldest) diagnoseHits.delete(oldest);
  }
}

function deterministicDiagnosis(input: {
  reason?: string;
  snapshot: Awaited<ReturnType<typeof ownerGateStatus>>;
}) {
  const lines: string[] = [];
  if (!input.snapshot.configured) {
    lines.push("لا يوجد أي تجزئة كلمة مرور متاحة للبوابة. عيّن كلمة مرور من شاشة أول تشغيل أو عبر OWNER_PASSWORD_HASH.");
  } else if (!input.snapshot.sessionReady) {
    lines.push("كلمة المرور موجودة لكن مفتاح الجلسة غير جاهز. البوابة تحاول إنشاء مفتاح دائم خارج المشروع؛ تحقق من صلاحية الكتابة في مجلد ZENOX.");
  } else {
    lines.push("البوابة قرأت مصدر اعتماد واحدًا على الأقل ومفتاح الجلسة جاهز. إن استمر الرفض فالكلمة المرسلة لا تطابق أي مصدر محفوظ.");
  }
  if (input.snapshot.databaseConfigured && !input.snapshot.databaseSourceAvailable) {
    lines.push("قاعدة البيانات لم تُجب خلال المهلة، وهذا لا يمنع الدخول: البوابة تستخدم المصادر المحلية المذكورة ولا تحتاج قاعدة البيانات.");
  }
  if (input.reason?.trim()) lines.push(`سبب المحاولة الأخيرة: ${input.reason.trim().slice(0, 180)}`);
  lines.push(`مصادر الاعتماد: ${input.snapshot.sources.join(", ") || "لا يوجد"} · مفتاح الجلسة: ${input.snapshot.signingKey}.`);
  return lines.join(" ");
}

export async function diagnoseOwnerGate(input: { reason?: string; errorCode?: string } = {}) {
  const snapshot = await ownerGateStatus();
  const fallback = deterministicDiagnosis({ reason: input.reason, snapshot });

  if (!(await llmHasKey().catch(() => false))) {
    return { model: "deterministic", diagnosis: fallback, snapshot };
  }

  try {
    const result = await invokeLLM({
      model: ownerAuthModel(),
      maxTokens: 700,
      messages: [
        {
          role: "system",
          content:
            "أنت مهندس تشغيل ZENOX. تشخّص سبب فشل دخول ZENOX من بيانات صحية غير سرية فقط. بوابة ZENOX مستقلة: قاعدة البيانات ليست شرطًا للدخول، ولا تقل إن الجلسة تحتاجها. إذا كانت المصادر موجودة ومفتاح الجلسة جاهزًا فالمشكلة في مطابقة كلمة المرور أو في الواجهة. لا تطلب كلمة المرور أو التجزئة ولا تخمّنها. أجب بالعربية في 2 إلى 4 جمل قصيرة، واذكر إجراءً واحدًا محددًا يمكن تنفيذه الآن.",
        },
        {
          role: "user",
          content: JSON.stringify({
            reason: input.reason?.slice(0, 300) ?? "",
            errorCode: input.errorCode?.slice(0, 80) ?? "",
            at: new Date().toISOString(),
            snapshot,
            rules: ["login is independent of the chat database", "never request the password or hash", "use the listed credential sources first"],
          }),
        },
      ],
    });
    const content = result.choices[0]?.message?.content;
    const diagnosis =
      typeof content === "string"
        ? content.trim()
        : Array.isArray(content)
          ? content.map((part) => ("text" in part ? part.text : "")).join("").trim()
          : "";
    return { model: result.model || ownerAuthModel(), diagnosis: diagnosis || fallback, snapshot };
  } catch {
    return { model: "deterministic", diagnosis: fallback, snapshot };
  }
}
