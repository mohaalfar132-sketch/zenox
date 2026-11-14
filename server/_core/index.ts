import "dotenv/config";
import compression from "compression";
import express from "express";
import { createOrderStore, ownerOrderFile } from "./orderStore";
import { createServer } from "http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerGoogleRoutes } from "./googleRoutes";
import { readGoogleSession } from "../google";
import { registerOwnerGateRoutes } from "./ownerGateRoutes";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { ownerCoreStartupLine } from "./ownerGuarantee";
import { createContext } from "./context";
import { createCorsMiddleware } from "./cors";
import { clearLegacySessionCookie } from "./cookies";
import { startLlmKeyMonitor } from "./llmHealth";
import { llmHasKey, openChatStream } from "./llm";
import { normalizeChatMessages } from "./chatGuard";
import { answerCache, chatLimiter } from "./chatRuntime";
import { recordRequest } from "./monitor";
import { logChatTurn } from "./chatLogs";
import { MAX_UPLOAD_BYTES, receiveAnyUpload, resolveUpload, uploadContentType, uploadStream } from "./ownerUpload";
import { archiveFolder, archiveKind, extractArchive } from "./archiveTools";
import { ownerChatPrompt, runOwnerAgent, shouldAnswerDirectly } from "./ownerAgent";
import { modeLabel, modeModel, modeSystem } from "./chatModes";
import { startFreeModelRefresh } from "./freeModels";
import { bootstrapOwnerCredential } from "./ownerAuth";
import { loadSealedSecretsIntoEnv } from "./ownerSecrets";
import { readOwnerSession } from "./ownerAuth";
import { lockDownSecretFiles } from "./env";
import { publicControls } from "./siteControls";
import { directSiteIntent, planFromText } from "./execIntent";
import { runOwnerTool } from "./ownerTools";
import { logTerminalCommand, runTerminalCommand, stopTerminals, terminalCwd } from "./liveTerminal";
import { runShell } from "../terminal";

const WEB_ROOT_CANDIDATES = ["dist-web", "web-build"];

/** Static web app root: `dist-web` from `pnpm build:web`, or an explicit override. */
function resolveWebRoot(): string | null {
  const configured = process.env.ZENOX_WEB_ROOT?.trim();
  if (configured) {
    const full = resolve(configured);
    return existsSync(join(full, "index.html")) ? full : null;
  }
  for (const candidate of WEB_ROOT_CANDIDATES) {
    const full = join(process.cwd(), candidate);
    if (existsSync(join(full, "index.html"))) return full;
  }
  return null;
}

const WEB_NOT_BUILT_PAGE = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ZENOX</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0A0D1F;color:#F8FAFC;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:560px;padding:32px;border:1px solid #303B61;border-radius:22px;background:#11162B}
  h1{margin:0 0 6px;font-size:26px;letter-spacing:4px}
  p{color:#94A3B8;line-height:1.9;font-size:14px}
  code{background:#0A0D1F;border:1px solid #27304D;border-radius:8px;padding:2px 8px;color:#C4B5FD;direction:ltr;display:inline-block}
  .ok{color:#2DD4BF;font-weight:700}
</style></head>
<body><main>
  <h1>ZENOX</h1>
  <p class="ok">الخادم يعمل. واجهة الويب لم تُبنَ بعد على هذه النسخة.</p>
  <p>لتشغيل مساحتي التطبيق — مساحة المستخدمين ومركز ZENOX — نفّذ:</p>
  <p><code>pnpm build:web</code> ثم أعد تشغيل الخادم.</p>
  <p>بعدها يفتح <code>/</code> مساحة المستخدم، و<code>/console</code> مركز ZENOX.</p>
</main></body></html>`;

async function startServer() {
  lockDownSecretFiles();
  const app = express();
  const server = createServer(app);
  const webRoot = resolveWebRoot();

  app.use(createCorsMiddleware());
  app.use(clearLegacySessionCookie());
  // Baseline hardening: no MIME sniffing, no referrer leakage to third parties.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Feeds the owner's monitoring panel: volume, errors, latency, last activity.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => recordRequest(res.statusCode, Date.now() - started));
    next();
  });

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // The web bundle is ~3 MB raw; without this the app feels slow to open.
  app.use(compression());

  // A rejected body must look like the rest of the API, not an HTML error page.
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      const status = Number((error as { status?: number })?.status ?? 0);
      const type = String((error as { type?: string })?.type ?? "");
      if (type === "entity.too.large" || status === 413) {
        res.status(413).json({ ok: false, error: "payload_too_large", message: "الطلب أكبر من الحد المسموح." });
        return;
      }
      if (status === 400 && error instanceof SyntaxError) {
        res.status(400).json({ ok: false, error: "bad_json", message: "صيغة الطلب غير صحيحة." });
        return;
      }
      next(error);
    },
  );

  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerGoogleRoutes(app);
  registerOwnerGateRoutes(app);

  // Baseline browser hardening. No framing policy here on purpose: the app is
  // legitimately embedded in the preview panel, and the data routes are gated.
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
    res.removeHeader("X-Powered-By");
    if ((req.headers["x-forwarded-proto"] || req.protocol) === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // What the browser shows without any rebuild: banner, maintenance, notice.
  app.get("/api/site/state", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(publicControls());
  });

  // A retried order (after a dropped connection) must not run twice: the id is
  // remembered for a few minutes and the same result is returned.
  // The ids live on disk (owner-orders.json), not in memory: a restart in the
  // middle of a retry must not run the same order again.
  const recentOrders = createOrderStore(ownerOrderFile());
  const rememberOrder = (id: string, summary: string, action?: string) => recentOrders.remember(id, summary, action);

  // The console: one sentence in, one action out. Site orders apply at once and
  // commands run immediately with live output — no plan, no steps.
  app.post("/api/owner/exec-intent", express.json({ limit: "1mb" }), async (req, res) => {
    const owner = await readOwnerSession(req).catch(() => null);
    if (!owner) {
      res.status(403).json({ ok: false, error: "owner_only", message: "هذا الإجراء لـ ZENOX فقط." });
      return;
    }
    const body = (req.body ?? {}) as { text?: unknown; id?: unknown };
    const orderId = String(body.id ?? "").slice(0, 80);
    const text = String(body.text ?? "").trim();
    const seen = orderId ? recentOrders.get(orderId) : undefined;
    if (seen) {
      res.json({ ok: true, cached: true, summary: seen.summary, action: seen.action });
      return;
    }
    if (!text) {
      res.status(400).json({ ok: false, error: "empty_text", message: "اكتب طلبك أولًا." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    let closed = false;
    let run: { stop: () => void } | null = null;
    res.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      run?.stop();
    });

    let plan;
    try {
      plan = await planFromText(text);
    } catch (error) {
      write({ type: "error", message: `تعذر فهم الطلب: ${String(error).slice(0, 120)}` });
      clearInterval(heartbeat);
      res.end();
      return;
    }
    // An owner order that no deterministic rule understands is not refused:
    // the executor receives it with full owner reach and performs it.
    if (plan.kind === "message") {
      write({ type: "plan", kind: "command", command: "", summary: "أنفّذ الطلب الآن بوكيل ZENOX…" });
      try {
        const result = await runOwnerAgent({
          messages: [{ role: "user", content: text }],
          fullAccess: true,
          onStep: (step) =>
            write({ type: "chunk", stream: step.ok ? "stdout" : "stderr", text: `• ${step.summary}\n` }),
        });
        rememberOrder(orderId, result.content, "agent");
        write({ type: "chunk", stream: "stdout", text: `${result.content}\n` });
        write({ type: "result", ok: true, summary: result.content });
        write({ type: "exit", code: 0, cwd: terminalCwd(), durationMs: 0, truncated: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : "تعذر تنفيذ الطلب.";
        write({ type: "error", message: message.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 300) });
      }
      clearInterval(heartbeat);
      if (!closed) res.end();
      return;
    }

    write({ type: "plan", ...plan });

    if (plan.kind === "site" || plan.kind === "tool") {
      rememberOrder(orderId, plan.summary, plan.action);
      write({ type: "result", ok: true, summary: plan.summary, data: plan.kind === "tool" ? plan.data : undefined });
      write({ type: "exit", code: 0, cwd: terminalCwd(), durationMs: 0, truncated: false });
      clearInterval(heartbeat);
      if (!closed) res.end();
      return;
    }

    const started = runTerminalCommand(plan.command, write);
    run = started;
    const result = await started.done;
    logTerminalCommand(plan.command, result.code, result.durationMs);
    rememberOrder(orderId, `نُفّذ: ${plan.command} (exit ${result.code})`, "command");
    clearInterval(heartbeat);
    if (!closed) {
      write({ type: "exit", ...result });
      res.end();
    }
  });

  // The owner opens any uploaded file (his own or a user's) from the panel.
  app.get("/api/owner/file", async (req, res) => {
    const owner = await readOwnerSession(req).catch(() => null);
    if (!owner) {
      res.status(403).json({ ok: false, error: "owner_only", message: "هذا الملف لـ ZENOX فقط." });
      return;
    }
    const file = resolveUpload(req.query.name);
    if (!file) {
      res.status(404).json({ ok: false, error: "not_found", message: "الملف غير موجود." });
      return;
    }
    res.setHeader("Content-Type", uploadContentType(file.path));
    res.setHeader("Content-Length", String(file.size));
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(basename(file.path))}`);
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    uploadStream(file.path).pipe(res);
  });

  // Stated once at boot, so a missing owner power is never a silent regression.
  console.log(
    ownerCoreStartupLine(
      Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures),
    ),
  );

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  // Nothing under /api should answer with an HTML 404: the client always gets JSON.
  app.get("/api", (_req, res) => {
    res.json({
      ok: true,
      service: "ZENOX",
      web: webRoot ? "built" : "not-built",
      endpoints: ["/api/health", "/api/trpc/<router>.<procedure>", "/api/oauth/*", "/api/storage/*"],
    });
  });

  // Server-sent events: the browser renders tokens as the model writes them,
  // so a long answer never looks like a frozen screen.
  // The limiter and cache are shared with tRPC chat.complete (see chatRuntime).
  // Small body cap for this route: a chat turn can never need megabytes.
  const chatBody = express.json({ limit: "2mb" });

  app.post("/api/chat/stream", chatBody, async (req, res) => {
    // Reject early: the global parser already accepted up to 50 MB, but a chat
    // turn is tiny, so anything large is either a bug or an attempt.
    // A long conversation is normal. normalizeChatMessages keeps it inside the
    // model budget, so only a truly enormous body is refused here.
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > 2 * 1024 * 1024) {
      res.status(413).json({ ok: false, error: "payload_too_large", message: "المحادثة أطول من الحد. ابدأ محادثة جديدة." });
      return;
    }
    const body = (req.body ?? {}) as { mode?: unknown; messages?: unknown };
    const messages = normalizeChatMessages(body);

    if (messages.length === 0) {
      res.status(400).json({ ok: false, error: "empty_messages", message: "لا توجد رسالة لإرسالها." });
      return;
    }

    const mode = typeof body.mode === "string" ? body.mode.slice(0, 120) : "general";
    // The owner signs in with the owner cookie: no guest budget applies to them.
    const ownerSession = await readOwnerSession(req).catch(() => null);
    const isOwner = Boolean(ownerSession);

    // Every turn here spends the owner's model credits, so a client is budgeted
    // per window, and only a few streams may run at once.
    const clientKey = (req.ip || req.socket.remoteAddress || "unknown").toString();
    if (!isOwner) {
      const decision = chatLimiter.check(clientKey);
      if (!decision.allowed) {
        res.setHeader("Retry-After", String(decision.retryAfterSeconds));
        res.status(429).json({
          ok: false,
          error: "rate_limited",
          message: "طلبات كثيرة في وقت قصير. انتظر قليلًا ثم أعد المحاولة.",
        });
        return;
      }
    }
    if (!chatLimiter.acquire()) {
      res.status(429).json({
        ok: false,
        error: "busy",
        message: "الخدمة مشغولة الآن. أعد المحاولة بعد لحظات.",
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    // Keeps proxies and tunnels from closing an idle connection mid-answer.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    // Listen on the response: `req` emits "close" as soon as the request body
    // is received, which would cancel the stream before it starts.
    let closed = false;
    res.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
    });    try {
      // A site order is deterministic: apply it here, answer at once, no model.
      if (isOwner) {
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        // `/run <command>` (or «شغل») executes on the spot, no model involved:
        // the owner's chat is wired straight to the real shell.
        const pending = lastUser ? String(lastUser.content ?? "").trim() : "";
        const runOrder = pending.match(/^\/(?:run|شغل)\s+([\s\S]+)$/);
        if (runOrder) {
          const command = runOrder[1].trim();
          write({ delta: `$ ${command}\n` });
          const result = await runShell(command);
          const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "(بلا مخرجات)";
          const summary = `$ ${command}\n${output}\n(exit ${result.code} · ${result.durationMs}ms)`;
          write({ delta: output });
          write({ done: true, content: summary, code: result.code });
          logChatTurn({ messages, answer: summary, mode, owner: true, cached: false, client: clientKey });
          clearInterval(heartbeat);
          if (!closed) res.end();
          return;
        }
        const intent = lastUser ? directSiteIntent(String(lastUser.content ?? "")) : null;
        if (intent) {
          write({ delta: intent.summary });
          write({ done: true, content: intent.summary, ...(intent.kind === "site" ? { action: intent.action } : {}) });
          logChatTurn({ messages, answer: intent.summary, mode, owner: true, cached: false, client: clientKey });
          clearInterval(heartbeat);
          if (!closed) res.end();
          return;
        }
        // Fast path: any message containing a URL is fetched directly, so the
        // agent never refuses with "I cannot access links".
        const urlMatch = pending.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          const url = urlMatch[0];
          const result = await runOwnerTool("http_request", { url });
          const summary = result.summary || (result.ok ? "تم جلب الرابط." : "تعذر جلب الرابط.");
          write({ delta: summary });
          write({ done: true, content: summary });
          logChatTurn({ messages, answer: summary, mode, owner: true, cached: false, client: clientKey });
          clearInterval(heartbeat);
          if (!closed) res.end();
          return;
        }
      }

      // A repeated question is answered instantly and costs no credits.
      const cacheKey = answerCache.keyFor(mode, messages);
      // A cached reply is text only: an order that must change something has to
      // run every time, so execution requests bypass the cache entirely.
      const mayUseCache = !isOwner || shouldAnswerDirectly(messages);
      const cached = mayUseCache ? answerCache.get(cacheKey) : null;
      if (cached) {
        write({ delta: cached });
        write({ done: true, content: cached, cached: true });
        logChatTurn({ messages, answer: cached, mode, owner: isOwner, cached: true, client: clientKey });
        return;
      }

      // The owner gets an executor: it edits files and adds keys itself, then
      // answers with what it did instead of handing over instructions.
      if (isOwner) {
        if (!(await llmHasKey())) {
          write({
            error:
              "المساعد التنفيذي يحتاج مفتاح نموذج حقيقيًا: أضفه من مركز ZENOX ← «الذكاء الاصطناعي»، أو اكتبه هنا وسأحفظه بنفسي.",
          });
          clearInterval(heartbeat);
          return;
        }
        const ownerMessages = messages.map((message) => ({
          role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        }));
        // Conversation calls no tool: stream it so the first words arrive at once.
        if (shouldAnswerDirectly(ownerMessages)) {
          try {
            const upstream = await openChatStream(
              [{ role: "system", content: ownerChatPrompt(isOwner) }, ...ownerMessages],
              700,
            );
            const streamReader = upstream.body!.getReader();
            const streamDecoder = new TextDecoder();
            let streamBuffer = "";
            let streamed = "";
            for (;;) {
              const { done, value } = await streamReader.read();
              if (done) break;
              streamBuffer += streamDecoder.decode(value, { stream: true });
              const frames = streamBuffer.split("\n\n");
              streamBuffer = frames.pop() ?? "";
              for (const frame of frames) {
                const line = frame.split("\n").find((row) => row.startsWith("data:"));
                if (!line) continue;
                const raw = line.slice(5).trim();
                if (!raw || raw === "[DONE]") continue;
                try {
                  const parsed = JSON.parse(raw) as { choices?: { delta?: { content?: string } }[] };
                  const delta = parsed.choices?.[0]?.delta?.content;
                  if (delta) {
                    streamed += delta;
                    write({ delta });
                  }
                } catch {
                  // keep-alive or partial frame
                }
              }
            }
            if (streamed.trim()) {
              if (mayUseCache) answerCache.set(cacheKey, streamed);
              logChatTurn({ messages, answer: streamed, mode, owner: true, client: clientKey });
              write({ done: true, content: streamed });
              return;
            }
          } catch (error) {
            console.warn("[chat] direct owner stream failed, using the executor:", String(error).slice(0, 160));
          }
        }
        try {
          const googleSession = await readGoogleSession(req).catch(() => null);
          const result = await runOwnerAgent({
            messages: messages.map((message) => ({
              role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
              content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
            })),
            onStep: (step) => write({ step }),
            fullAccess: isOwner,
            googleSub: googleSession?.sub ?? null,
          });
          if (mayUseCache) answerCache.set(cacheKey, result.content);
          logChatTurn({ messages, answer: result.content, mode, owner: true, client: clientKey });
          write({ delta: result.content });
          write({ done: true, content: result.content, steps: result.steps });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "";
          const needsKey = /مفتاح|key|401|403|api\s*key|unauthorized/i.test(detail);
          write({
            error: needsKey
              ? "المساعد التنفيذي يحتاج مفتاح نموذج شغّالًا: أضفه من صفحة المفاتيح أو اكتبه هنا وسأحفظه بنفسي."
              : `تعذر تشغيل المساعد التنفيذي الآن. لم يُنفَّذ أي تغيير — أعد المحاولة. (${detail.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 160)})`,
          });
        }
        return;
      }

      const system = `${modeSystem(mode)}\n\nأنت الآن في نمط «${modeLabel(mode)}» مع مستخدم ضيف: ساعد باحترام ولا تكشف معلومات داخلية عن ZENOX. ZENOX مؤسسة، وإذا سُئلت عن جهة الإدارة فلا تؤكد وجود إدارة فردية ولا تفصح عن أفراد أو حسابات.`;
      const upstream = await openChatStream(
        [{ role: "system", content: system }, ...messages],
        isOwner ? 4000 : 900,
        modeModel(mode),
      );
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      const isEventStream = (upstream.headers.get("content-type") || "").includes("text/event-stream");

      // Some providers ignore stream:true and answer with one JSON body; then
      // the whole text is emitted as a single delta and the UI still works.
      if (!isEventStream) {
        let whole = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          whole += decoder.decode(value, { stream: true });
        }
        try {
          const parsed = JSON.parse(whole) as { choices?: { message?: { content?: string } }[] };
          const content = parsed.choices?.[0]?.message?.content;
          if (typeof content === "string" && content.trim()) {
            answer = content;
            write({ delta: content });
          }
        } catch {
          // Fall through to the empty-answer message below.
        }
      }

      while (isEventStream && !closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                answer += delta;
                write({ delta });
              }
            } catch {
              // Upstream keep-alive or a partial event: ignore and keep reading.
            }
          }
        }
      }

      if (!answer.trim()) write({ error: "لم يصل نص من النموذج. أعد المحاولة." });
      else {
        answerCache.set(cacheKey, answer);
        // The owner can read every guest conversation from the owner center.
        logChatTurn({ messages, answer, mode, owner: isOwner, client: clientKey });
        write({ done: true, content: answer });
      }
    } catch (error) {
      // Details stay in the server log: the browser only needs a friendly line.
      console.warn("[chat] stream failed", error instanceof Error ? error.message : error);
      write({ error: "تعذر الوصول إلى النموذج الآن. جرّب مرة أخرى بعد لحظات." });
    } finally {
      clearInterval(heartbeat);
      chatLimiter.release();
      res.end();
    }
  });

  // Owner uploads from the phone. The body is streamed straight to disk, so a
  // packed folder of photos (hundreds of megabytes) goes through untouched.
  // ZIP/RAR from the phone: unpack next to the uploads so the owner can open
  // every extracted file from the panel.
  app.post("/api/owner/archive/extract", express.json({ limit: "1mb" }), async (req, res) => {
    const owner = await readOwnerSession(req).catch(() => null);
    if (!owner) {
      res.status(403).json({ ok: false, error: "owner_only", message: "هذا الإجراء لـ ZENOX فقط." });
      return;
    }
    const name = String((req.body as { name?: unknown })?.name ?? "");
    const file = resolveUpload(name);
    if (!file) {
      res.status(404).json({ ok: false, error: "not_found", message: "الملف غير موجود." });
      return;
    }
    if (!archiveKind(name)) {
      res.status(400).json({ ok: false, error: "not_archive", message: "هذا الملف ليس ZIP أو RAR." });
      return;
    }
    try {
      const result = await extractArchive({ path: file.path, destRoot: archiveFolder(name) });
      console.info(`[owner] extracted ${result.kind} «${name}»: ${result.files.length} files, ${result.skipped} skipped`);
      res.json({
        ok: true,
        kind: result.kind,
        dir: result.dir.replace(`${process.cwd()}/`, ""),
        files: result.files,
        skipped: result.skipped,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: "extract_failed", message: error instanceof Error ? error.message : "تعذر فك الضغط." });
    }
  });

  app.post("/api/owner/upload", async (req, res) => {
    const owner = await readOwnerSession(req).catch(() => null);
    if (!owner) {
      req.resume();
      res.status(403).json({ ok: false, error: "owner_only", message: "هذا الإجراء لـ ZENOX فقط." });
      return;
    }
    try {
      // Inside the project so the uploaded file shows up in the code tree; in a
      // container this path is a mounted volume, not the image layer.
      const uploadDir = join(process.cwd(), "uploads");
      const result = await receiveAnyUpload(
        req,
        uploadDir,
        String(req.query.name ?? "upload.bin"),
        String(req.headers["content-type"] ?? ""),
      );
      res.json({ ok: true, path: `uploads/${basename(result.path)}`, size: result.size });
    } catch (error) {
      const code = error instanceof Error ? error.message : "upload_failed";
      const status = code === "too_large" ? 413 : code === "empty_file" || code === "bad_multipart" ? 400 : 500;
      const message =
        code === "too_large"
          ? `الملف أكبر من الحد المسموح (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} ميجابايت).`
          : code === "empty_file"
            ? "لم يصل ملف."
            : "تعذر حفظ الملف.";
      res.status(status).json({ ok: false, error: code, message });
    }
  });

  // Live owner terminal: output arrives as it happens and the working directory
  // survives between commands, so a build shows progress instead of a silent wait.
  app.get("/api/owner/terminal/state", async (req, res) => {
    const owner = await readOwnerSession(req).catch(() => null);
    if (!owner) {
      res.status(403).json({ ok: false, error: "owner_only", message: "هذا الإجراء لـ ZENOX فقط." });
      return;
    }
    res.json({ ok: true, cwd: terminalCwd() });
  });

  app.post("/api/owner/terminal/stop", async (req, res) => {
    const owner = await readOwnerSession(req).catch(() => null);
    if (!owner) {
      res.status(403).json({ ok: false, error: "owner_only", message: "هذا الإجراء لـ ZENOX فقط." });
      return;
    }
    stopTerminals();
    res.json({ ok: true, cwd: terminalCwd() });
  });

  app.post("/api/owner/terminal/stream", express.json({ limit: "1mb" }), async (req, res) => {
    const owner = await readOwnerSession(req).catch(() => null);
    if (!owner) {
      res.status(403).json({ ok: false, error: "owner_only", message: "هذا الإجراء لـ ZENOX فقط." });
      return;
    }
    const command = String((req.body as { command?: unknown } | undefined)?.command ?? "").trim();
    if (!command) {
      res.status(400).json({ ok: false, error: "empty_command", message: "اكتب أمرًا أولًا." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    let closed = false;
    res.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      run.stop();
    });
    const run = runTerminalCommand(command, write);
    const result = await run.done;
    logTerminalCommand(command, result.code, result.durationMs);
    clearInterval(heartbeat);
    if (!closed) {
      write({ type: "exit", ...result });
      res.end();
    }
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  app.use("/api", (req, res) => {
    res.status(404).json({
      ok: false,
      error: "not_found",
      path: req.originalUrl,
      message: "المسار غير موجود. تحقق من اسم الإجراء أو النسخة المنشورة من الخادم.",
    });
  });

  // Static assets declared in public/ (manifest, route list).
  app.use(express.static(join(process.cwd(), "public"), { index: false, maxAge: "1h" }));

  // The exported Expo web app: `/` and `/console` resolve to their real pages.
  // Pages are revalidated on every load so a new build is never hidden behind a
  // cached HTML shell; hashed JS/CSS bundles keep the long cache.
  if (webRoot) {
    app.use(
      express.static(webRoot, {
        index: false,
        extensions: ["html"],
        maxAge: "1h",
        setHeaders: (res, filePath) => {
          if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
        },
      }),
    );
  }

  // Last resort: never leave a browser with a bare 404 page.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(404).json({ ok: false, error: "not_found", path: req.originalUrl });
      return;
    }
    const indexFile = webRoot ? join(webRoot, "index.html") : null;
    if (indexFile && existsSync(indexFile)) {
      res.sendFile(indexFile);
      return;
    }
    if (req.path === "/" || req.path === "/console") {
      res.status(200).type("html").send(WEB_NOT_BUILT_PAGE);
      return;
    }
    next();
  });

  const port = parseInt(process.env.PORT || "3000");
  // The free OpenRouter catalogue is refreshed in the background, so a newly
  // added or retired `:free` model is picked up without a deploy.
  // Keys from the delivered archive: decrypted into memory only.
  bootstrapOwnerCredential();
  const sealedCount = loadSealedSecretsIntoEnv();
  if (sealedCount > 0) console.log(`[secrets] loaded ${sealedCount} sealed variables into the environment`);
  startFreeModelRefresh();
  server.listen(port, () => {
    console.log(`[api] server listening on :${port} (web: ${webRoot ? webRoot : "not built"})`);
    // Hourly probe: a key marked failing comes back on its own when it recovers.
    startLlmKeyMonitor();
  });
}

startServer().catch(() => {
  console.error("[api] server failed to start");
});
