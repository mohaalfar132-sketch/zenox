import {
  getSessionCookieName,
  getSessionCookieOptions,
} from "./_core/cookies";
import { PROVIDER_PRESETS, invalidateLlmKeyCache, invokeLLM, keyLatencySnapshot, llmHasKey, llmStatus, markKeyRejected, probeLlmKey, recordKeyLatency, type Message } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV } from "./_core/env";
import { acceptDeviceSession, addIntegrationAuditLog, listIntegrationAuditLogs, addRootAuditLog, authorizeDeviceAction, createApiKeyRef, createDeviceSession, createFileChangeRequest, createRootChangeRequest, deleteExternalConnection, deleteOwnerPolicy, endDeviceSession, getExternalConnection, listApiKeyRefs, listDeviceSessions, listExternalConnections, listFileChangeRequests, listOwnerPolicies, listRootChangeRequests, revokeApiKeyRef, revokeDeviceSession, updateFileChangeRequest, updateRootChangeRequest, upsertExternalConnection, upsertOwnerPolicy } from "./db";
import { DEVICE_CAPABILITIES } from "./device-policy";
import { testExternalConnection } from "./external-connectors";
import { TRPCError } from "@trpc/server";
import { NOT_ADMIN_ERR_MSG } from "../shared/const.js";
import { sealedSecretPairs, sealedSecretsSummary } from "./_core/ownerSecrets";
import { modeLabel, modeSystem } from "./_core/chatModes";
import { applyPatchToWorkspace, runShell, workspaceRoot } from "./terminal";
import { runSecurityAudit } from "./_core/securityAudit";
import { readControls, updateControls } from "./_core/siteControls";
import { loginBlockedFor, recordLoginFailure, recordLoginSuccess } from "./_core/ownerThrottle";
import { OWNER_TOOLS, runOwnerTool } from "./_core/ownerTools";
import { listUploads } from "./_core/ownerUpload";
import { ownerCoreReport } from "./_core/ownerGuarantee";
import { OWNER_COOKIE, createOwnerSession, hashOwnerPassword, ownerCookieOptions, persistOwnerHash, resolveOwnerHash } from "./_core/ownerAuth";
import { diagnoseBlockedFor, diagnoseOwnerGate, ownerGateStatus, persistOwnerGateHash, recordDiagnoseAttempt, verifyOwnerGatePassword } from "./_core/ownerGate";
import { listWorkspaceTree, readWorkspaceFile, writeWorkspaceFile } from "./workspace-files";
import { monitorSnapshot } from "./_core/monitor";
import { clearChatLogs, listChatSessions, memoryZChatTotals, readChatConversation, logChatTurn } from "./_core/chatLogs";
import { runOwnerAgent, shouldAnswerDirectly } from "./_core/ownerAgent";
import { addMemory, clearMemory, deleteMemory, listMemory } from "./_core/agentMemory";
import { freeModelReport, recordFreeModelResult, refreshFreeModels } from "./_core/freeModels";
import { PROVIDER_ENV, providersInEnv, sanitizeApiKey, saveKeyToEnvFile } from "./_core/keyVault";
import { addLlmKey, deleteLlmKey, listLlmKeys, setLlmKeyHealth } from "./db";
import { normalizeChatMessages } from "./_core/chatGuard";
import { answerCache, chatLimiter, startedAt } from "./_core/chatRuntime";
import { googleRouter } from "./googleRouter";
import { saveGoogleCredentials } from "./googleCredentials";

const AUDIO_MIME_TYPES = ["audio/m4a", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"] as const;
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
const rootPlanSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  affectedFiles: z.array(z.string().trim().min(1).max(2000)).max(2000),
  changes: z.array(z.string().trim().min(1).max(20000)).max(2000),
  validation: z.array(z.string().trim().min(1).max(20000)).max(2000),
  risk: z.enum(["low", "medium", "high"]),
  requiresConfirmation: z.boolean(),
}).strict();
// The owner has full control of the project: no path, secret or content filtering.
const secretRefSchema = z.string().trim().min(1).max(200);
const filePathSchema = z.string().trim().min(1).max(400);

async function transcribeAudio(audioBase64: string, mimeType: (typeof AUDIO_MIME_TYPES)[number]) {
  const audioBytes = Buffer.from(audioBase64, "base64");
  if (audioBytes.length === 0 || audioBytes.length > 64_000_000) {
    throw new Error("ملف الصوت فارغ أو أكبر من 9 ميجابايت");
  }

  const apiUrl = (ENV.manusApiUrl || ENV.forgeApiUrl || "https://forge.manus.im").replace(/\/$/, "");
  const apiKey = ENV.manusApiKey || ENV.forgeApiKey;
  if (!apiKey) {
    throw new Error("خدمة التفريغ الصوتي غير مهيأة على الخادم");
  }

  const form = new FormData();
  const extension = mimeType === "audio/webm" ? "webm" : mimeType === "audio/wav" ? "wav" : mimeType === "audio/ogg" ? "ogg" : "m4a";
  form.append("file", new Blob([audioBytes], { type: mimeType }), `zenox-${Date.now()}.${extension}`);
  form.append("model", "whisper-1");
  form.append("prompt", "فرّغ كلام المستخدم كما قيل. لغة العمل الأساسية العربية، وقد تكون باللهجة المصرية، مع الحفاظ على أسماء ZENOX والمصطلحات التقنية.");
  form.append("response_format", "verbose_json");

  const response = await fetch(`${apiUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`فشل التفريغ الصوتي: ${response.status} ${details}`);
  }

  const result = (await response.json()) as { text?: string; language?: string };
  if (!result.text?.trim()) {
    throw new Error("لم يتم التقاط كلام واضح في التسجيل");
  }
  return { text: result.text.trim(), language: result.language ?? "unknown" };
}

/** Names of the mounted procedures, read lazily to avoid a type cycle. */
function ownerProcedureNames(): string[] {
  const router = appRouter as unknown as { _def?: { procedures?: Record<string, unknown> } };
  return Object.keys(router._def?.procedures ?? {});
}

/** Obvious paste damage (extra text, wrong length) — reported before any call. */
function keyFormatProblem(provider: string, apiKey: string): string {
  if (provider === "openrouter" && !/^sk-or-v1-[0-9a-f]{64}$/.test(apiKey)) {
    return `صيغة مفتاح OpenRouter غير مطابقة: الطول ${apiKey.length} حرفًا والصحيح 73 (sk-or-v1- ثم 64 حرفًا) — أعد نسخه كاملًا بلا أي إضافات.`;
  }
  if (provider === "openai" && !/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
    return "صيغة مفتاح OpenAI غير مطابقة — أعد نسخه بلا مسافات أو رموز إضافية.";
  }
  if (provider === "groq" && !/^gsk_[A-Za-z0-9]{20,}$/.test(apiKey)) {
    return "صيغة مفتاح Groq غير مطابقة (يبدأ بـ gsk_) — أعد نسخه.";
  }
  return "";
}

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  google: googleRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(getSessionCookieName(ctx.req), {
        ...cookieOptions,
        maxAge: -1,
      });
      return {
        success: true,
      } as const;
    }),
  }),

  owner: router({
    auth: router({
      status: publicProcedure.query(async ({ ctx }) => {
        const gate = await ownerGateStatus();
        return {
          authenticated: Boolean(ctx.owner) || ctx.user?.role === "admin",
          passwordConfigured: gate.configured,
          passwordStorage: gate.sources[0] ?? "none",
          mode: ctx.owner ? "owner-session" : ctx.user?.role === "admin" ? "oauth-admin" : "none",
          gate,
        } as const;
      }),
      setup: publicProcedure
        .input(z.object({ password: z.string().min(8).max(500) }))
        .mutation(async ({ ctx, input }) => {
          if (await resolveOwnerHash()) {
            throw new TRPCError({ code: "CONFLICT", message: "كلمة مرور ZENOX مضبوطة بالفعل. استخدم تسجيل الدخول." });
          }
          const hash = hashOwnerPassword(input.password);
          const storage = await persistOwnerHash(hash);
          persistOwnerGateHash(hash);
          const token = await createOwnerSession();
          if (!token) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد مفتاح جلسة. اضبط OWNER_SESSION_SECRET أو JWT_SECRET." });
          }
          await addIntegrationAuditLog({
            ownerOpenId: ctx.user?.openId ?? ENV.ownerOpenId ?? "owner",
            entityType: "owner_credential",
            entityId: 0,
            action: "owner.password.created",
            result: "allowed",
            details: `أُنشئت كلمة مرور ZENOX وحُفظت كتجزئة scrypt في ${storage}.`,
          }).catch(() => undefined);
          ctx.res.cookie(OWNER_COOKIE, token, ownerCookieOptions(ctx.req));
          return { ok: true as const, created: true as const, storage };
        }),
      /**
       * Rotates the owner password. Requires the live owner session and the
       * current password, so a borrowed unlocked browser cannot silently take
       * over the gate. The new hash replaces every credential source.
       */
      change: adminProcedure
        .input(
          z.object({
            currentPassword: z.string().min(1).max(200),
            newPassword: z.string().min(10).max(500),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const verification = await verifyOwnerGatePassword(input.currentPassword);
          if (!verification.ok) {
            const code = verification.reason === "no_credential" ? "PRECONDITION_FAILED" : "UNAUTHORIZED";
            throw new TRPCError({ code, message: "كلمة المرور الحالية غير صحيحة." });
          }
          if (input.newPassword === input.currentPassword) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "اختر كلمة مرور جديدة مختلفة عن الحالية." });
          }
          const hash = hashOwnerPassword(input.newPassword);
          const storage = await persistOwnerHash(hash);
          persistOwnerGateHash(hash);
          await addIntegrationAuditLog({
            ownerOpenId: ctx.user?.openId ?? ENV.ownerOpenId ?? "owner",
            entityType: "owner_credential",
            entityId: 0,
            action: "owner.password.changed",
            result: "allowed",
            details: `غيّر المالك كلمة مرور ZENOX؛ حُفظت التجزئة الجديدة في ${storage}.`,
          }).catch(() => undefined);
          return { ok: true as const, storage };
        }),

      login: publicProcedure
        .input(z.object({ password: z.string().min(1).max(200) }))
        .mutation(async ({ ctx, input }) => {
          // Password guessing is rate limited per client, and each wrong guess
          // costs time, so a script cannot walk a dictionary here.
          const client = String(ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown");
          const blockedFor = loginBlockedFor(client);
          if (blockedFor > 0) {
            throw new TRPCError({
              code: "TOO_MANY_REQUESTS",
              message: `محاولات كثيرة. انتظر ${Math.ceil(blockedFor / 60)} دقيقة.`,
            });
          }
          const verification = await verifyOwnerGatePassword(input.password);
          if (!verification.ok) {
            const { lockedSeconds } = recordLoginFailure(client);
            await new Promise((resolve) => setTimeout(resolve, 250));
            throw new TRPCError({
              code: lockedSeconds ? "TOO_MANY_REQUESTS" : verification.reason === "no_credential" ? "PRECONDITION_FAILED" : "UNAUTHORIZED",
              message: lockedSeconds
                ? `محاولات كثيرة. انتظر ${Math.ceil(lockedSeconds / 60)} دقيقة.`
                : verification.reason === "no_credential"
                  ? "لم تُضبط كلمة مرور ZENOX بعد. أنشئها من الخانة السرية في المركز."
                  : "كلمة المرور غير صحيحة.",
            });
          }
          recordLoginSuccess(client);
          const token = await createOwnerSession();
          if (!token) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد مفتاح جلسة. اضبط OWNER_SESSION_SECRET أو JWT_SECRET." });
          }
          ctx.res.cookie(OWNER_COOKIE, token, ownerCookieOptions(ctx.req));
          return { ok: true as const };
        }),
      logout: publicProcedure.mutation(({ ctx }) => {
        ctx.res.clearCookie(OWNER_COOKIE, ownerCookieOptions(ctx.req));
        return { ok: true as const };
      }),
      diagnose: publicProcedure
        .input(z.object({ reason: z.string().max(300).optional(), errorCode: z.string().max(80).optional() }).optional())
        .mutation(async ({ ctx, input }) => {
          const client = String(ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown");
          const blocked = diagnoseBlockedFor(client);
          if (blocked > 0) {
            throw new TRPCError({
              code: "TOO_MANY_REQUESTS",
              message: `طلبات تشخيص كثيرة. انتظر ${Math.ceil(blocked / 60)} دقيقة.`,
            });
          }
          recordDiagnoseAttempt(client);
          return diagnoseOwnerGate(input ?? {});
        }),
    }),

    // The owner's own powers (shell, code, upload, console) are a fixed contract:
    // this reports whether any of them is ever missing. It has no off switch.
    guarantee: adminProcedure.query(() => ownerCoreReport(ownerProcedureNames())),

    // Everything uploaded to the platform, so the owner can open any file.
    // Sealed project secrets: ciphertext lives in the repo, the key does not.
    secrets: router({
      status: adminProcedure.query(() => sealedSecretsSummary()),
      open: adminProcedure
        .input(z.object({ password: z.string().min(1).max(200) }))
        .mutation(async ({ ctx, input }) => {
          const verification = await verifyOwnerGatePassword(input.password);
          if (!verification.ok) {
            throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة المرور غير صحيحة." });
          }
          const pairs = sealedSecretPairs();
          if (!pairs) {
            throw new TRPCError({ code: "NOT_FOUND", message: "لا يوجد ملف أسرار مشفّر على هذا الخادم." });
          }
          await addIntegrationAuditLog({
            ownerOpenId: ctx.user.openId,
            entityType: "owner_secrets",
            entityId: 0,
            action: "owner.secrets.opened",
            result: "allowed",
            details: `فُتح ملف الأسرار المشفّر (${pairs.length} متغيّرًا).`,
          }).catch(() => undefined);
          return { ok: true as const, secrets: pairs };
        }),
    }),

    // Google OAuth client credentials entered from the owner panel. The values
    // are encrypted outside the project and are never returned to the browser.
    google: router({
      configure: adminProcedure
        .input(
          z.object({
            clientId: z.string().trim().min(20).max(300),
            clientSecret: z.string().trim().min(10).max(300),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const saved = saveGoogleCredentials(input);
          await addIntegrationAuditLog({
            ownerOpenId: ctx.user?.openId ?? ENV.ownerOpenId ?? "owner",
            entityType: "google_oauth_client",
            entityId: 0,
            action: "owner.google.credentials.saved",
            result: "allowed",
            details: "حُفظت بيانات OAuth الخاصة بـGoogle مشفّرة خارج المشروع.",
          }).catch(() => undefined);
          return saved;
        }),
    }),

    uploads: router({
      list: adminProcedure.query(() => listUploads()),
    }),

    // Fast deterministic tools: one call, no model, immediate result.
    tools: router({
      list: adminProcedure.query(() => OWNER_TOOLS.map((tool) => ({ ...tool }))),
      run: adminProcedure
        .input(
          z.object({
            name: z.string().min(1).max(60),
            args: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .mutation(({ input }) => runOwnerTool(input.name, input.args ?? {})),
    }),

    // Live site controls: a sentence becomes a visible banner instantly.
    site: router({
      get: adminProcedure.query(() => readControls()),
      set: adminProcedure
        .input(
          z.object({
            bannerText: z.string().max(400).optional(),
            bannerTone: z.enum(["info", "warning", "danger"]).optional(),
            bannerAlarm: z.boolean().optional(),
            bannerEnabled: z.boolean().optional(),
            maintenance: z.boolean().optional(),
            maintenanceMessage: z.string().max(1000).optional(),
            announcementTitle: z.string().max(160).optional(),
            announcementBody: z.string().max(1500).optional(),
            announcementEnabled: z.boolean().optional(),
          }),
        )
        .mutation(({ input }) =>
          updateControls({
            banner:
              input.bannerText !== undefined || input.bannerTone !== undefined || input.bannerEnabled !== undefined
                ? { text: input.bannerText, tone: input.bannerTone, enabled: input.bannerEnabled, alarm: input.bannerAlarm }
                : undefined,
            maintenance:
              input.maintenance !== undefined || input.maintenanceMessage !== undefined
                ? { enabled: input.maintenance, message: input.maintenanceMessage }
                : undefined,
            announcement:
              input.announcementTitle !== undefined ||
              input.announcementBody !== undefined ||
              input.announcementEnabled !== undefined
                ? { title: input.announcementTitle, body: input.announcementBody, enabled: input.announcementEnabled }
                : undefined,
          }),
        ),
    }),

    // Promo site (ZANOX9.AI) control — owner edits texts, features, FAQ,
    // download links and ads remotely through the owner interface.
    promo: router({
      // The owner console opens the static editor with a five-minute signed
      // link. The Worker verifies it with the site password it already holds
      // and exchanges it for the ordinary HttpOnly editor session.
      adminLink: adminProcedure.query(() => {
        const pw = promoAdminPassword();
        if (!pw) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "كلمة مرور إدارة الموقع غير مضبوطة." });
        }
        const now = Date.now();
        const expires = now + 5 * 60_000;
        const payload = Buffer.from(
          JSON.stringify({ v: 1, scope: "zanox9-site-admin", aud: "zanox9-site", iat: now, exp: expires }),
        ).toString("base64url");
        const signature = createHmac("sha256", pw).update(`owner-link.${payload}`).digest("base64url");
        return {
          url: `${PROMO_SITE_URL}/admin?owner_token=${encodeURIComponent(`${payload}.${signature}`)}`,
          expiresAt: expires,
        };
      }),
      get: adminProcedure.query(async () => {
        const url = `${PROMO_SITE_URL}/api/content`;
        const res = await fetch(url);
        if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: "تعذر جلب محتوى موقع ZANOX9.AI." });
        const data = (await res.json()) as { content?: unknown; updatedAt?: string | null; owner?: boolean };
        return { content: data.content ?? null, updatedAt: data.updatedAt ?? null, owner: Boolean(data.owner) };
      }),
      set: adminProcedure
        .input(z.object({ content: z.record(z.string(), z.any()), password: z.string().max(200).optional() }))
        .mutation(async ({ input }) => {
          const pw = input.password || promoAdminPassword();
          if (!pw) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "كلمة مرور إدارة الموقع غير مضبوطة. اضبط PROMO_ADMIN_PASSWORD أو مرّرها." });
          const loginRes = await fetch(`${PROMO_SITE_URL}/api/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: pw }),
          });
          if (!loginRes.ok) throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة مرور إدارة الموقع غير صحيحة." });
          const cookie = loginRes.headers.get("set-cookie") || "";
          const putRes = await fetch(`${PROMO_SITE_URL}/api/content`, {
            method: "PUT",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify(input.content),
          });
          if (!putRes.ok) {
            const err = (await putRes.json().catch(() => ({}))) as { error?: string };
            throw new TRPCError({ code: "BAD_REQUEST", message: err.error || "تعذّر حفظ محتوى الموقع." });
          }
          const data = (await putRes.json()) as { content?: unknown };
          return { ok: true as const, content: data.content };
        }),
      ads: router({
        add: adminProcedure
          .input(z.object({ ad: z.record(z.string(), z.any()), password: z.string().max(200).optional() }))
          .mutation(async ({ input }) => {
            const current = await (async () => {
              const res = await fetch(`${PROMO_SITE_URL}/api/content`);
              if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: "تعذر جلب محتوى الموقع." });
              const data = (await res.json()) as { content?: Record<string, unknown> };
              return data.content ?? {};
            })();
            const ads = Array.isArray(current.ads) ? [...current.ads] : [];
            if (ads.length >= 6) throw new TRPCError({ code: "BAD_REQUEST", message: "الحد الأقصى 6 إعلانات." });
            ads.push({ id: `ad-${Date.now()}`, enabled: true, tone: "info", ...input.ad });
            const next = { ...current, ads };
            const pw = input.password || promoAdminPassword();
            if (!pw) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "كلمة مرور إدارة الموقع غير مضبوطة." });
            const loginRes = await fetch(`${PROMO_SITE_URL}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
            if (!loginRes.ok) throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة مرور إدارة الموقع غير صحيحة." });
            const cookie = loginRes.headers.get("set-cookie") || "";
            const putRes = await fetch(`${PROMO_SITE_URL}/api/content`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(next) });
            if (!putRes.ok) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذّر حفظ الإعلان." });
            const data = (await putRes.json()) as { content?: unknown };
            return { ok: true as const, content: data.content };
          }),
        remove: adminProcedure
          .input(z.object({ id: z.string().min(1).max(80), password: z.string().max(200).optional() }))
          .mutation(async ({ input }) => {
            const current = await (async () => {
              const res = await fetch(`${PROMO_SITE_URL}/api/content`);
              if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: "تعذر جلب محتوى الموقع." });
              const data = (await res.json()) as { content?: Record<string, unknown> };
              return data.content ?? {};
            })();
            const ads = (Array.isArray(current.ads) ? current.ads : []).filter((a: { id?: string }) => a?.id !== input.id);
            const next = { ...current, ads };
            const pw = input.password || promoAdminPassword();
            if (!pw) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "كلمة مرور إدارة الموقع غير مضبوطة." });
            const loginRes = await fetch(`${PROMO_SITE_URL}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
            if (!loginRes.ok) throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة مرور إدارة الموقع غير صحيحة." });
            const cookie = loginRes.headers.get("set-cookie") || "";
            const putRes = await fetch(`${PROMO_SITE_URL}/api/content`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(next) });
            if (!putRes.ok) throw new TRPCError({ code: "BAD_REQUEST", message: "تعذّر حذف الإعلان." });
            const data = (await putRes.json()) as { content?: unknown };
            return { ok: true as const, content: data.content };
          }),
      }),
    }),

    // Security center: audits the owner's own project and deployment.
    security: router({
      audit: adminProcedure.mutation(async () => runSecurityAudit()),
    }),

    terminal: router({
      status: adminProcedure.query(() => ({ cwd: workspaceRoot() })),
      exec: adminProcedure
        .input(z.object({ command: z.string().trim().min(1).max(64_000), cwd: z.string().trim().max(4000).optional() }))
        .mutation(async ({ ctx, input }) => {
          const result = await runShell(input.command, input.cwd);
          await addIntegrationAuditLog({
            ownerOpenId: ctx.user.openId,
            entityType: "terminal",
            entityId: 0,
            action: "terminal.exec",
            result: result.code === 0 ? "allowed" : "failed",
            details: `أمر في ${result.cwd} — رمز الخروج ${result.code} — ${result.durationMs}ms`,
          }).catch(() => undefined);
          return result;
        }),
    }),

    // Project structure and file content, owner-only: what "كود البنية" opens.
    // Model key pool: several keys, daily rotation, automatic failover.
    ai: router({
      list: adminProcedure.query(async () => {
        const [dbRows, status] = await Promise.all([listLlmKeys().catch(() => []), llmStatus()]);
        // Keys saved to .env (no database) are listed without their values.
        const envRows = providersInEnv()
          .filter((provider) => !dbRows.some((row) => row.provider === provider))
          .map((provider, index) => ({
            id: -1 - index,
            label: `${PROVIDER_PRESETS[provider]?.model ?? provider} (ملف البيئة)`,
            provider,
            model: PROVIDER_PRESETS[provider]?.model ?? "",
            baseUrl: PROVIDER_PRESETS[provider]?.base ?? "",
            enabled: 1,
            status: "ok",
            lastError: null,
            lastUsedAt: null,
            masked: "…env",
          }));
        const rows = [...dbRows, ...envRows] as (typeof dbRows[number] & { masked?: string })[];
        return {
          ...status,
          keys: rows.map((row) => ({
            id: row.id,
            label: row.label,
            provider: row.provider,
            model: row.model,
            baseUrl: row.baseUrl,
            enabled: Boolean(row.enabled),
            status: row.status,
            lastError: row.lastError,
            lastUsedAt: row.lastUsedAt,
            masked: row.masked ?? (row.apiKey.length > 8 ? `…${row.apiKey.slice(-4)}` : "…"),
          })),
        };
      }),
      add: adminProcedure
        .input(
          z.object({
            label: z.string().trim().min(1).max(80),
            provider: z.enum(["groq", "gemini", "openai", "openrouter", "zai", "custom"]),
            baseUrl: z.string().trim().max(400).optional(),
            model: z.string().trim().max(120).optional(),
            apiKey: z.string().trim().min(8).max(400),
          }),
        )
        .mutation(async ({ input }) => {
          const preset = input.provider === "custom" ? null : PROVIDER_PRESETS[input.provider];
          const baseUrl = input.baseUrl?.trim() || preset?.base;
          if (!baseUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان المزود مطلوب مع custom." });
          const model = input.model?.trim() || preset?.model || "gpt-4o-mini";
          const probe = await probeLlmKey({ baseUrl, model, apiKey: input.apiKey });
          // The database can be missing on a fresh host; `.env` keeps the key
          // working and loads it again on the next start.
          let id = -1;
          let storage: "database" | "env-file" = "database";
          try {
            const created = await addLlmKey({ label: input.label, provider: input.provider, baseUrl, model, apiKey: input.apiKey });
            id = created.id;
            await setLlmKeyHealth(created.id, probe.ok ? "ok" : "failing", probe.ok ? null : probe.error).catch(() => undefined);
          } catch {
            storage = saveKeyToEnvFile(input.provider, input.apiKey) ? "env-file" : "database";
            if (storage === "database") {
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذر حفظ المفتاح: لا قاعدة بيانات ولا مكان دائم لهذا المزود." });
            }
          }
          invalidateLlmKeyCache();
          // Diagnosis without the secret: which provider, stored where, did the
          // provider accept it, and only the first line of any error.
          console.info(
            `[owner] api key added: provider=${input.provider} model=${model} storage=${storage} ok=${probe.ok}${probe.ok ? "" : ` error=${String(probe.error ?? "").split("\n")[0].slice(0, 160)}`}`,
          );
          return { id, ok: probe.ok, error: probe.error, storage };
        }),
      // The live free catalogue, ranked by what answered, for the keys screen.
      freeModels: adminProcedure.query(async () => {
        await refreshFreeModels();
        return freeModelReport();
      }),
      // Checks every provider the server can use — environment keys and stored
      // ones — with its measured latency, so Gemini and OpenAI can sit together.
      probeAll: adminProcedure.mutation(async () => {
        const latencies = keyLatencySnapshot();
        const rows: { provider: string; label: string; source: "env" | "stored"; model: string; ok: boolean; ms: number; error: string; latency: number }[] = [];
        for (const [provider, envName] of Object.entries(PROVIDER_ENV)) {
          const apiKey = sanitizeApiKey(process.env[envName]);
          const preset = PROVIDER_PRESETS[provider];
          if (!apiKey || !preset) continue;
          const started = Date.now();
          // A key pasted with a stray fragment never reaches the provider: say so
          // plainly instead of showing a misleading "401 User not found".
          const format = keyFormatProblem(provider, apiKey);
          if (format) {
            rows.push({ provider, label: envName, source: "env", model: preset.model, ok: false, ms: 0, error: format, latency: 0 });
            markKeyRejected(`env:${envName}`);
            continue;
          }
          // OpenRouter: every free model is checked, so the owner sees exactly
          // which `:free` models answer and the rest are skipped automatically.
          if (provider === "openrouter") {
            const catalogue = await refreshFreeModels(true);
            for (const freeModel of catalogue.map((item) => item.id)) {
              const modelStarted = Date.now();
              const freeProbe = await probeLlmKey({ baseUrl: preset.base, model: freeModel, apiKey });
              recordFreeModelResult(freeModel, freeProbe.ok, Date.now() - modelStarted);
              rows.push({
                provider,
                label: freeModel,
                source: "env",
                model: freeModel,
                ok: freeProbe.ok,
                ms: Date.now() - modelStarted,
                error: freeProbe.ok ? "" : String(freeProbe.error ?? "").split("\n")[0].slice(0, 120),
                latency: latencies[`env:${envName}`] ?? 0,
              });
            }
            continue;
          }
          const probe = await probeLlmKey({ baseUrl: preset.base, model: preset.model, apiKey });
          // A key the account rejected (bad key, no credits) steps aside at once,
          // so the healthy provider answers instead of every message failing.
          if (probe.ok) recordKeyLatency(`env:${envName}`, Date.now() - started);
          if (!probe.ok && /401|402|403|429|insufficient_quota|incorrect api key|ByteString|invalid/i.test(String(probe.error ?? ""))) {
            markKeyRejected(`env:${envName}`);
          }
          rows.push({
            provider,
            label: `${envName}`,
            source: "env",
            model: preset.model,
            ok: probe.ok,
            ms: Date.now() - started,
            error: probe.ok ? "" : String(probe.error ?? "").split("\n")[0].slice(0, 160),
            latency: latencies[`env:${envName}`] ?? 0,
          });
        }
        for (const row of await listLlmKeys().catch(() => [])) {
          const started = Date.now();
          const storedKey = sanitizeApiKey(row.apiKey);
          const probe = await probeLlmKey({ baseUrl: row.baseUrl, model: row.model, apiKey: storedKey });
          if (probe.ok) recordKeyLatency(`db:${row.id}`, Date.now() - started);
          rows.push({
            provider: row.provider,
            label: row.label,
            source: "stored",
            model: row.model,
            ok: probe.ok,
            ms: Date.now() - started,
            error: probe.ok ? "" : String(probe.error ?? "").split("\n")[0].slice(0, 160),
            latency: latencies[`db:${row.id}`] ?? 0,
          });
        }
        return { active: await llmStatus(), rows };
      }),
      remove: adminProcedure
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(async ({ input }) => {
          const removed = await deleteLlmKey(input.id);
          invalidateLlmKeyCache();
          return removed;
        }),
      test: adminProcedure.mutation(async () => {
        const rows = await listLlmKeys();
        const results: { id: number; label: string; ok: boolean; error: string }[] = [];
        for (const row of rows) {
          const probe = await probeLlmKey({ baseUrl: row.baseUrl, model: row.model, apiKey: row.apiKey });
          await setLlmKeyHealth(row.id, probe.ok ? "ok" : "failing", probe.ok ? null : probe.error).catch(() => undefined);
          results.push({ id: row.id, label: row.label, ok: probe.ok, error: probe.error });
        }
        invalidateLlmKeyCache();
        return results;
      }),
      // Owner-only operational view: no secrets, just health and load.
      stats: adminProcedure.query(async () => {
        const [rows, status] = await Promise.all([listLlmKeys(), llmStatus()]);
        return {
          ...status,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          cacheEntries: answerCache.size,
          inFlightStreams: chatLimiter.inFlightCount,
          healthyKeys: rows.filter((row) => row.status === "ok").length,
          failingKeys: rows.filter((row) => row.status === "failing").length,
          totalKeys: rows.length,
        };
      }),
      clearCache: adminProcedure.mutation(() => {
        const removed = answerCache.size;
        answerCache.clear();
        return { removed };
      }),
    }),

    code: router({
      tree: adminProcedure
        .input(z.object({ path: z.string().trim().max(1000).optional(), depth: z.number().int().min(1).max(6).default(2) }))
        .query(({ input }) => listWorkspaceTree(input)),
      read: adminProcedure
        .input(z.object({ path: z.string().trim().min(1).max(1000) }))
        .query(({ input }) => readWorkspaceFile(input.path)),
      // The owner edits the platform itself from the phone. Every save keeps a
      // copy of the previous file and lands in the audit log.
      write: adminProcedure
        .input(
          z.object({
            path: z.string().trim().min(1).max(1000),
            content: z.string().max(300_000),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const saved = writeWorkspaceFile(input);
          await addIntegrationAuditLog({
            ownerOpenId: ctx.user?.openId ?? ENV.ownerOpenId ?? "owner",
            entityType: "workspace_file",
            entityId: 0,
            action: saved.created ? "owner.file.created" : "owner.file.updated",
            result: "allowed",
            details: `${saved.path} (${saved.size} بايت${saved.backup ? `، نسخة احتياطية: ${saved.backup}` : ""})`,
          }).catch(() => undefined);
          return saved;
        }),
    }),

    // One screen that answers "is the platform healthy right now".
    monitor: router({
      stats: adminProcedure.query(async () => {
        const [rows, status] = await Promise.all([
          listLlmKeys().catch(() => []),
          llmStatus().catch(() => null),
        ]);
        return {
          ...monitorSnapshot(),
          ai: status,
          keys: {
            total: rows.length,
            healthy: rows.filter((row) => row.status === "ok").length,
            failing: rows.filter((row) => row.status === "failing").length,
          },
          chat: {
            cacheEntries: answerCache.size,
            inFlight: chatLimiter.inFlightCount,
          },
        };
      }),
      audit: adminProcedure
        .input(z.object({ limit: z.number().int().min(1).max(60).default(25) }).optional())
        .query(async ({ input }) => {
          const logs = await listIntegrationAuditLogs(input?.limit ?? 25).catch(() => []);
          return logs.map((log) => ({
            id: log.id,
            action: log.action,
            result: log.result,
            details: log.details,
            at: log.createdAt,
          }));
        }),
    }),
    // Long-term notes the assistant keeps about the platform and its owner.
    memory: router({
      list: adminProcedure.query(() => listMemory()),
      add: adminProcedure
        .input(z.object({ text: z.string().min(3).max(2000) }))
        .mutation(({ input }) => addMemory(input.text)),
      delete: adminProcedure
        .input(z.object({ id: z.string().min(1).max(64) }))
        .mutation(({ input }) => deleteMemory(input.id)),
      clear: adminProcedure.mutation(() => clearMemory()),
    }),
    // Read what users ask the assistant, straight from the owner center.
    chats: router({
      list: adminProcedure
        .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).optional())
        .query(({ input }) => listChatSessions(input?.limit ?? 30)),
      messages: adminProcedure
        .input(
          z.object({
            conversation: z.string().min(6).max(64),
            limit: z.number().int().min(1).max(1000).default(300),
          }),
        )
        .query(({ input }) => readChatConversation(input.conversation, input.limit)),
      totals: adminProcedure.query(() => memoryZChatTotals()),
      clear: adminProcedure.mutation(async ({ ctx }) => {
        const result = clearChatLogs();
        await addIntegrationAuditLog({
          ownerOpenId: ctx.user?.openId ?? ENV.ownerOpenId ?? "owner",
          entityType: "chat_log",
          entityId: 0,
          action: "owner.chats.cleared",
          result: "allowed",
          details: `حُذفت ${result.removedFiles} ملف محادثات`,
        }).catch(() => undefined);
        return result;
      }),
    }),
  }),

  chat: router({
    // Lets the client tell the owner that the model key is missing, instead of
    // pretending the assistant is online and failing on every message.
    status: publicProcedure.query(async () => llmStatus()),
    complete: publicProcedure
      .input(
        z.object({
          mode: z.string().max(200).default("general"),
          audience: z.enum(["guest", "owner"]).default("guest"),
          messages: z
            .array(
              z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string().min(1).max(400_000),
              }),
            )
            .min(1)
            .max(1000),
        }),
      )
      .mutation(async ({ input, ctx }) => {
          const isOwner = ctx.user?.role === "admin" || Boolean(ctx.owner);
          if (input.audience === "owner" && !isOwner) {
            throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
          }
          // Same budget as the streaming route: switching endpoints must not
          // give a guest a second free quota.
          if (!isOwner) {
            const clientKey = (ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown").toString();
            const decision = chatLimiter.check(clientKey);
            if (!decision.allowed) {
              throw new TRPCError({
                code: "TOO_MANY_REQUESTS",
                message: `طلبات كثيرة. أعد المحاولة بعد ${decision.retryAfterSeconds} ثانية.`,
              });
            }
          }
          if (!chatLimiter.acquire()) {
            throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "الخدمة مشغولة الآن. أعد المحاولة بعد لحظات." });
          }
          const normalized = normalizeChatMessages({ messages: input.messages });
          if (normalized.length === 0) {
            chatLimiter.release();
            throw new TRPCError({ code: "BAD_REQUEST", message: "لا توجد رسالة صالحة." });
          }
          const cacheKey = answerCache.keyFor(input.mode, normalized);
          // An execution request must run every time; only conversation is cached.
          const mayUseCache = !isOwner || shouldAnswerDirectly(normalized);
          const cached = mayUseCache ? answerCache.get(cacheKey) : null;
          if (cached) {
            chatLimiter.release();
            return { content: cached, model: "cache" };
          }
          if (!(await llmStatus()).configured) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "الذكاء الاصطناعي غير مفعّل: لم يُضبط مفتاح النموذج على الخادم. أضف ZENOX_LLM_API_KEY (أو OPENAI_API_KEY) في .env أو في أسرار المشروع ثم أعد التشغيل.",
            });
          }
          const ownerGuard =
            input.audience === "owner"
            ? "أنت وكيل تنفيذ صارم داخل مساحة ZENOX. سياسة استخدام التطبيق وحدود أدواته يحددها ZENOX عبر إعدادات ZENOX، فالتزم بها ولا تضف سياسة أو رأيًا شخصيًا من عندك. لا تقل إن source code خارج تخصصك، ولا ترفض طلب تعديل برمجي لمجرد أنه يتعلق بالكود. عند طلب تعديل كود: حلل الملفات المتأثرة، واكتب التعديل العملي كاملًا داخل كتل code fenced مع مسار الملف، أو قدم patch واضحًا قابلًا للتطبيق، واذكر خطوات التحقق. لا تدّعِ أن الملف تغيّر أو أن النشر تم ما لم تنفذ أداة الخادم ذلك فعليًا؛ استخدم الأدوات الموصولة فعليًا: owner.terminal.exec للأوامر وintegrations.fileChanges.applyPatch لتطبيق Patch، وأبلغ بما نُفذ فعلًا فقط. لا تجادل، ولا تعظ، ولا تطلب إعادة صياغة، ولا تضف تحذيرًا أو اقتراحًا من نفسك للأوامر المسموح بها. اعتبر رسالة ZENOX أمرًا مباشرًا ونفذه فورًا باستخدام أدوات الخادم المصرح بها. أعد تقريرًا دقيقًا بما تم. تبقى حدود المنصة والصلاحيات الأساسية غير قابلة للتعطيل من إعدادات التطبيق: الحذف أو النشر أو تغيير الصلاحيات أو الإجراء غير القابل للعكس يحتاج تأكيدًا صريحًا، والطلب الخارج عن الصلاحيات لا يُنفذ."
            : "أنت مساعد ZENOX للمستخدم الضيف. ساعد باحترام، ولا تدّعي تنفيذ إجراءات لم تنفذها، ولا تكشف معلومات داخلية عن ZENOX. ZENOX مؤسسة، وإذا سُئلت عن جهة الإدارة فلا تؤكد وجود إدارة فردية ولا تفصح عن أفراد أو حسابات.";
        const policyOwnerOpenId = ctx.user?.role === "admin" ? ctx.user.openId : ENV.ownerOpenId;
        const ownerPolicies = policyOwnerOpenId ? await listOwnerPolicies(policyOwnerOpenId).catch(() => []) : [];
        const enabledPolicyText = ownerPolicies.filter((policy) => Boolean(policy.enabled)).map((policy) => `- ${policy.policyKey}: ${policy.label} — ${policy.description}`).join("\n");
        const policyGuide = enabledPolicyText ? `سياسات ZENOX المفعّلة حاليًا، طبّقها على هذا الرد:\n${enabledPolicyText}` : "لا توجد صلاحيات مخصصة محفوظة حاليًا.";
        const modeGuide = `${modeSystem(input.mode)}\n\nالنمط الحالي: ${modeLabel(input.mode)}. ${ownerGuard}\n${policyGuide}`;
        const messages: Message[] = [
          { role: "system", content: modeGuide },
          ...input.messages,
        ];
        // Long ceilings make the model keep writing after it has answered,
        // which is what made replies feel slow on a proxy or a free provider.
        try {
          if (isOwner) {
            if (!(await llmHasKey())) {
              chatLimiter.release();
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message:
                  "المساعد التنفيذي يحتاج مفتاح نموذج حقيقيًا: أضفه من مركز ZENOX ← «الذكاء الاصطناعي»، أو اكتبه هنا وسأحفظه بنفسي.",
              });
            }
            let agent;
            try {
              agent = await runOwnerAgent({
                messages: normalized.map((message) => ({
                  role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
                  content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
                })),
                googleSub: ctx.googleSub,
                // The owner opened this session: the executor gets the same
                // shell and file reach as the streaming owner route. Without
                // this flag every command was refused as if it came from a guest.
                fullAccess: isOwner,
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : "";
              const needsKey = /مفتاح|key|401|403|api\s*key|unauthorized/i.test(detail);
              throw new TRPCError({
                code: needsKey ? "PRECONDITION_FAILED" : "INTERNAL_SERVER_ERROR",
                message: needsKey
                  ? "المساعد التنفيذي يحتاج مفتاح نموذج شغّالًا: أضفه من صفحة المفاتيح أو اكتبه هنا وسأحفظه بنفسي."
                  : `تعذر تشغيل المساعد التنفيذي الآن. لم يُنفَّذ أي تغيير — أعد المحاولة. (${detail.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 160)})`,
              });
            }
            if (mayUseCache) answerCache.set(cacheKey, agent.content.trim());
            logChatTurn({
              messages: normalized,
              answer: agent.content,
              mode: input.mode,
              owner: true,
              client: (ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown").toString(),
            });
            return { content: agent.content.trim(), model: "owner-agent", steps: agent.steps };
          }
          const result = await invokeLLM({ messages, max_tokens: input.audience === "owner" ? 4000 : 900 });
          const content = result.choices?.[0]?.message?.content;
          if (typeof content !== "string" || !content.trim()) {
            throw new Error("لم يرجع نموذج الذكاء الاصطناعي ردًا نصيًا صالحًا");
          }
          answerCache.set(cacheKey, content.trim());
          // The owner center can read every conversation the assistant answered.
          logChatTurn({
            messages: normalized,
            answer: content.trim(),
            mode: input.mode,
            owner: isOwner,
            client: (ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown").toString(),
          });
          return { content: content.trim(), model: result.model };
        } finally {
          chatLimiter.release();
        }
      }),
  }),

  speech: router({
    transcribe: publicProcedure
      .input(
        z.object({
          audioBase64: z.string().min(100).max(80_000_000),
          mimeType: z.enum(AUDIO_MIME_TYPES).default("audio/m4a"),
        }),
      )
      .mutation(({ input }) => transcribeAudio(input.audioBase64, input.mimeType)),
  }),

  devices: router({
    listSessions: adminProcedure.query(({ ctx }) => listDeviceSessions(ctx.user.openId)),

    requestSession: adminProcedure
      .input(z.object({
        deviceId: z.string().min(3).max(128),
        deviceName: z.string().min(1).max(160),
        platform: z.string().min(1).max(32),
        capabilities: z.array(z.enum(DEVICE_CAPABILITIES)).min(1).max(DEVICE_CAPABILITIES.length),
        expiresInMinutes: z.number().int().min(1).max(525_600).default(30),
      }))
      .mutation(({ ctx, input }) => createDeviceSession({
        ownerOpenId: ctx.user.openId,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        platform: input.platform,
        capabilities: input.capabilities,
        expiresAt: new Date(Date.now() + input.expiresInMinutes * 60_000),
      })),

    acceptSession: publicProcedure
      .input(z.object({
        consentToken: z.string().min(40).max(128),
        deviceId: z.string().min(3).max(128),
        deviceName: z.string().min(1).max(160),
        platform: z.string().min(1).max(32),
      }))
      .mutation(({ input }) => acceptDeviceSession(input)),

    authorizeAction: publicProcedure
      .input(z.object({
        sessionId: z.string().min(3).max(64),
        sessionToken: z.string().min(40).max(128),
        capability: z.enum(DEVICE_CAPABILITIES),
        action: z.string().min(1).max(1000),
      }))
      .mutation(({ input }) => authorizeDeviceAction(input)),

    endSession: publicProcedure
      .input(z.object({ sessionId: z.string().min(3).max(64), sessionToken: z.string().min(40).max(128) }))
      .mutation(({ input }) => endDeviceSession(input)),

    revokeSession: adminProcedure
      .input(z.object({ sessionId: z.string().min(3).max(64) }))
      .mutation(({ ctx, input }) => revokeDeviceSession(ctx.user.openId, input.sessionId)),
  }),

  policies: router({
    list: adminProcedure.query(({ ctx }) => listOwnerPolicies(ctx.user.openId)),
    save: adminProcedure
      .input(z.object({
        id: z.number().int().positive().optional(),
        policyKey: z.string().trim().min(2).max(80).regex(/^[a-z0-9._-]+$/),
        label: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(2000),
        enabled: z.boolean(),
      }))
      .mutation(({ ctx, input }) => upsertOwnerPolicy({ ...input, ownerOpenId: ctx.user.openId })),
    remove: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ ctx, input }) => deleteOwnerPolicy(ctx.user.openId, input.id)),
  }),

  integrations: router({
    connections: router({
      list: adminProcedure.query(({ ctx }) => listExternalConnections(ctx.user.openId)),
      test: adminProcedure
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
          const connection = await getExternalConnection(ctx.user.openId, input.id);
          const result = await testExternalConnection(connection);
          await addIntegrationAuditLog({
            ownerOpenId: ctx.user.openId,
            entityType: "connection",
            entityId: input.id,
            action: "connection.tested",
            result: result.reachable ? "allowed" : "failed",
            details: result.reachable ? "نجح اختبار الاتصال دون تسجيل السر أو نتيجة بيانات خارجية." : "فشل اختبار الاتصال؛ تم تسجيل الحالة فقط دون تسجيل تفاصيل سرية.",
          });
          return result;
        }),
      save: adminProcedure.input(z.object({
        id: z.number().int().positive().optional(),
        label: z.string().trim().min(1).max(120),
        kind: z.enum(["mysql", "postgres", "supabase", "rest_api"]),
        host: z.string().trim().min(1).max(255),
        databaseName: z.string().trim().max(160).optional(),
        username: z.string().trim().max(160).optional(),
        secretRef: secretRefSchema,
        sslRequired: z.boolean().default(true),
        enabled: z.boolean().default(true),
      })).mutation(async ({ ctx, input }) => {
        const result = await upsertExternalConnection({ ...input, ownerOpenId: ctx.user.openId, sslRequired: input.sslRequired ? 1 : 0, enabled: input.enabled ? 1 : 0 });
        await addIntegrationAuditLog({ ownerOpenId: ctx.user.openId, entityType: "connection", entityId: result.id, action: input.id ? "connection.updated" : "connection.created", result: "allowed", details: "تم حفظ بيانات الاتصال ومرجع السر فقط دون قيمة سرية." });
        return result;
      }),
      remove: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
        const result = await deleteExternalConnection(ctx.user.openId, input.id);
        await addIntegrationAuditLog({ ownerOpenId: ctx.user.openId, entityType: "connection", entityId: input.id, action: "connection.removed", result: "allowed", details: "تم حذف تعريف الاتصال؛ لم تُقرأ قيمة السر." });
        return result;
      }),
    }),
    apiKeys: router({
      list: adminProcedure.query(({ ctx }) => listApiKeyRefs(ctx.user.openId)),
      register: adminProcedure.input(z.object({ provider: z.string().trim().min(1).max(120), label: z.string().trim().min(1).max(120), secretRef: secretRefSchema, scopes: z.array(z.string().trim().min(1).max(2000)).max(2000) })).mutation(async ({ ctx, input }) => {
        const result = await createApiKeyRef({ ownerOpenId: ctx.user.openId, provider: input.provider, label: input.label, secretRef: input.secretRef, scopes: JSON.stringify(input.scopes), status: "unconfigured", fingerprint: null });
        await addIntegrationAuditLog({ ownerOpenId: ctx.user.openId, entityType: "api_key", entityId: result.id, action: "api_key.registered", result: "allowed", details: "تم تسجيل مرجع المفتاح فقط؛ القيمة نفسها تُدار خارج قاعدة البيانات." });
        return result;
      }),
      revoke: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
        const result = await revokeApiKeyRef(ctx.user.openId, input.id);
        await addIntegrationAuditLog({ ownerOpenId: ctx.user.openId, entityType: "api_key", entityId: input.id, action: "api_key.revoked", result: "allowed", details: "تم إلغاء مرجع المفتاح دون إظهار قيمته." });
        return result;
      }),
    }),
    fileChanges: router({
      list: adminProcedure.query(({ ctx }) => listFileChangeRequests(ctx.user.openId)),
      propose: adminProcedure.input(z.object({ filePath: filePathSchema, summary: z.string().trim().min(1).max(500), patch: z.string().min(10).max(5_000_000), risk: z.enum(["low", "medium", "high"]) })).mutation(async ({ ctx, input }) => {
        const result = await createFileChangeRequest({ ownerOpenId: ctx.user.openId, filePath: input.filePath, summary: input.summary, patch: input.patch, risk: input.risk, status: "awaiting_approval" });
        await addIntegrationAuditLog({ ownerOpenId: ctx.user.openId, entityType: "file_change", entityId: result.id, action: "file_change.proposed", result: "allowed", details: "تم حفظ Patch للمراجعة دون تطبيق مباشر." });
        return result;
      }),
      approve: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
        const result = await updateFileChangeRequest(ctx.user.openId, input.id, "approved", new Date());
        await addIntegrationAuditLog({ ownerOpenId: ctx.user.openId, entityType: "file_change", entityId: input.id, action: "file_change.approved", result: "allowed", details: "اعتمد ZENOX Patch؛ التطبيق المباشر متاح من نفس الشاشة." });
        return result;
      }),
      applyPatch: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
        const record = (await listFileChangeRequests(ctx.user.openId)).find((item) => item.id === input.id);
        if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التعديل غير موجود." });
        if (record.status === "cancelled") throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب ملغى ولا يمكن تطبيقه." });
        const result = await applyPatchToWorkspace(record.patch, record.id);
        await updateFileChangeRequest(ctx.user.openId, input.id, result.ok ? "applied" : "failed", result.ok ? new Date() : undefined);
        await addIntegrationAuditLog({
          ownerOpenId: ctx.user.openId,
          entityType: "file_change",
          entityId: input.id,
          action: "file_change.apply",
          result: result.ok ? "allowed" : "failed",
          details: result.ok ? "طُبّق Patch داخل مساحة المشروع عبر git apply." : "فشل تطبيق Patch؛ لم يتغير أي ملف.",
        }).catch(() => undefined);
        return { applied: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr, cwd: result.cwd };
      }),
      cancel: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
        const result = await updateFileChangeRequest(ctx.user.openId, input.id, "cancelled");
        await addIntegrationAuditLog({ ownerOpenId: ctx.user.openId, entityType: "file_change", entityId: input.id, action: "file_change.cancelled", result: "allowed", details: "ألغى ZENOX Patch." });
        return result;
      }),
    }),
  }),

  rootManager: router({
    list: adminProcedure.query(({ ctx }) => listRootChangeRequests(ctx.user.openId)),
    plan: adminProcedure
      .input(z.object({ requestText: z.string().trim().min(5).max(200_000) }))
      .mutation(async ({ ctx, input }) => {
        const planResult = await invokeLLM({
          messages: [
            { role: "system", content: "أنت مخطط Root Manager. حوّل طلب ZENOX إلى خطة تغيير قابلة للتنفيذ والمراجعة، ويمكنك اقتراح أوامر Shell ومسارات ملفات دقيقة وخطوات تحقق. لا تضع أسرارًا، ولا مسارات خارج مشروع ZENOX، ولا تدّعِ أن التعديل طُبّق أو نُشر. صنّف الخطورة: low لتغيير واجهة أو نص، medium لتغيير خادم أو API، high للمصادقة أو قاعدة البيانات أو النشر." },
            { role: "user", content: input.requestText },
          ],
          max_tokens: 8000,
          outputSchema: {
            name: "root_change_plan",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                summary: { type: "string" },
                affectedFiles: { type: "array", items: { type: "string" } },
                changes: { type: "array", items: { type: "string" } },
                validation: { type: "array", items: { type: "string" } },
                risk: { type: "string", enum: ["low", "medium", "high"] },
                requiresConfirmation: { type: "boolean" },
              },
              required: ["summary", "affectedFiles", "changes", "validation", "risk", "requiresConfirmation"],
            },
          },
        });
        const plan = planResult.choices?.[0]?.message?.content;
        if (typeof plan !== "string" || !plan.trim()) throw new Error("تعذر إنشاء خطة Root Manager");
        let parsed: z.infer<typeof rootPlanSchema>;
        try {
          parsed = rootPlanSchema.parse(JSON.parse(plan));
        } catch {
          throw new Error("خطة Root Manager لم ترجع بصيغة منظمة");
        }
        const record = await createRootChangeRequest({ ownerOpenId: ctx.user.openId, requestText: input.requestText, summary: parsed.summary, affectedFiles: JSON.stringify(parsed.affectedFiles), planJson: JSON.stringify(parsed), risk: parsed.risk, status: "awaiting_approval" });
        await addRootAuditLog({ ownerOpenId: ctx.user.openId, requestId: record.id, action: "plan.created", result: "allowed", details: "تم إنشاء خطة تغيير للمراجعة دون تطبيق أو نشر." });
        return { ...record, plan: parsed, status: "awaiting_approval" as const };
      }),
    approve: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        await updateRootChangeRequest(ctx.user.openId, input.id, "approved", new Date());
        await addRootAuditLog({ ownerOpenId: ctx.user.openId, requestId: input.id, action: "plan.approved", result: "allowed", details: "وافق ZENOX على الخطة؛ لم يتم تطبيق التعديل أو نشره تلقائيًا." });
        return { approved: true as const };
      }),
    cancel: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        await updateRootChangeRequest(ctx.user.openId, input.id, "cancelled");
        await addRootAuditLog({ ownerOpenId: ctx.user.openId, requestId: input.id, action: "plan.cancelled", result: "allowed", details: "ألغى ZENOX خطة Root Manager." });
        return { cancelled: true as const };
      }),
  }),

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
