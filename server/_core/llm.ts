import { ENV } from "./env";
import { freeModelChain, recordFreeModelResult } from "./freeModels";
import { sanitizeApiKey } from "./keyVault";
import { listLlmKeys, setLlmKeyHealth, touchLlmKey } from "../db";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4";
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
  /** Provider tool state: must be echoed back unchanged on the next round. */
  tool_calls?: unknown[];
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice = ToolChoicePrimitive | ToolChoiceByName | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  model?: string;
  thinking?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (value: MessageContent | MessageContent[]): MessageContent[] =>
  Array.isArray(value) ? value : [value];

const normalizeContentPart = (part: MessageContent): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;
  // Gemini signs every tool call (thought_signature) and rejects the next round
  // if it is dropped, which is why a tool call used to fail intermittently.
  const toolCalls = message.tool_calls;
  const toolFields = Array.isArray(toolCalls) && toolCalls.length > 0 ? { tool_calls: toolCalls } : {};

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
      ...toolFields,
    };
  }

  return {
    role,
    name,
    content: contentParts,
    ...toolFields,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined,
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error("tool_choice 'required' was provided but no tools were configured");
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly",
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

/** Known OpenAI-compatible providers: one env var picks base URL + default model. */
export const PROVIDER_PRESETS: Record<string, { base: string; model: string }> = {
  groq: { base: "https://api.groq.com/openai", model: "openai/gpt-oss-120b" },
  gemini: {
    base: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    // "-latest" aliases keep working when Google retires a dated model.
    // 3.8 is frequently rate-limited and 2.5 is retired for new keys; the lite
    // flash answers in well under a second.
    model: "gemini-3.5-flash-lite",
  },
  openai: { base: "https://api.openai.com", model: "gpt-4o-mini" },
  openrouter: { base: "https://openrouter.ai/api/v1", model: "particle-ai/particle-1:free" },
  mistral: { base: "https://api.mistral.ai/v1", model: "mistral-small-latest" },
  sambanova: { base: "https://api.sambanova.ai/v1", model: "Meta-Llama-3.3-70B-Instruct" },
  zai: { base: "https://api.z.ai/api/paas/v4", model: "glm-4.6" },
};

/** Lighter models for the same key, tried when the primary is retired or busy. */
const MODEL_FALLBACKS: Record<string, string[]> = {
  gemini: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-flash-lite-latest"],
  groq: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
};

/** OpenRouter fallbacks come from the live catalogue, refreshed by the server. */
const openrouterFallbacks = () => freeModelChain();

/**
 * Respan hosted gateway. One server-side key reaches every provider and each
 * call is logged in Respan, so the assistant's replies can be traced without
 * adding a provider SDK. Unset RESPAN_API_KEY leaves the pool untouched.
 */
const RESPAN_PROVIDER = "respan";

const respanBaseUrl = () =>
  (process.env.RESPAN_BASE_URL || "https://api.respan.ai/api").trim();

/** Gateway model IDs carry no vendor prefix: `gpt-5.5`, not `openai/gpt-5.5`. */
const respanModel = () => (process.env.RESPAN_MODEL || "gpt-5.5").trim();

const respanCandidate = (): LlmCandidate | null => {
  const apiKey = (process.env.RESPAN_API_KEY || "").trim();
  if (!apiKey) return null;
  return {
    label: "env:RESPAN_API_KEY",
    provider: RESPAN_PROVIDER,
    url: buildChatUrl(respanBaseUrl()),
    model: respanModel(),
    apiKey,
  };
};

const providerPreset = () => {
  const key = (process.env.ZENOX_LLM_PROVIDER || "").trim().toLowerCase();
  return key ? PROVIDER_PRESETS[key] ?? null : null;
};

/** Custom OpenAI-compatible endpoint (any provider) wins over the built-in proxy. */
const customBaseUrl = () =>
  (process.env.ZENOX_LLM_API_URL || process.env.OPENAI_BASE_URL || "").trim() || (providerPreset()?.base ?? "");

/**
 * Accepts any of: a full `/chat/completions` endpoint, a versioned base
 * (`https://api.z.ai/api/paas/v4`, `https://openrouter.ai/api/v1`) or a bare
 * host (`https://api.openai.com`), and builds the right completions URL.
 */
/** OpenRouter asks for attribution headers; without them free models can 404. */
function providerHeaders(url: string, headers: Record<string, string>) {
  if (url.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://zenox.app";
    headers["X-Title"] = "ZENOX";
  }
  return headers;
}

const buildChatUrl = (base: string) => {
  const trimmed = base.replace(/\/$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v\d+[a-z]*$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
};

const resolveApiUrl = () => {
  const explicit = customBaseUrl();
  if (explicit) return buildChatUrl(explicit);
  const baseUrl = ENV.manusApiUrl || ENV.forgeApiUrl;
  return baseUrl && baseUrl.trim().length > 0
    ? `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`
    : "https://forge.manus.im/v1/chat/completions";
};

const resolveApiKey = () =>
  (process.env.ZENOX_LLM_API_KEY || "").trim() ||
  // A bare OPENAI_API_KEY is handled by providerEnvCandidates(); only use it
  // here when the owner pinned a base URL or provider alongside it.
  ((customBaseUrl() || providerPreset() ? (process.env.OPENAI_API_KEY || "").trim() : "") as string) ||
  ENV.manusApiKey ||
  ENV.forgeApiKey;

export type LlmCandidate = {
  id?: number;
  label: string;
  provider: string;
  url: string;
  model: string;
  apiKey: string;
  /** "failing" keys go last so a dead provider never delays a reply. */
  health?: string;
};

/**
 * Per-provider environment keys, e.g. `GROQ_API_KEY`, `GEMINI_API_KEY`.
 * They are read at request time and never logged, echoed or written to disk.
 * Order matters: the fastest provider is tried first.
 */
const ENV_PROVIDER_KEYS: { provider: string; env: string }[] = [
  { provider: "groq", env: "GROQ_API_KEY" },
  { provider: "gemini", env: "GEMINI_API_KEY" },
  { provider: "openai", env: "OPENAI_API_KEY" },
  { provider: "openrouter", env: "OPENROUTER_API_KEY" },
  { provider: "mistral", env: "MISTRAL_API_KEY" },
  { provider: "sambanova", env: "SAMBANOVA_API_KEY" },
  { provider: "zai", env: "ZAI_API_KEY" },
];

const envCandidate = (): LlmCandidate | null => {
  const apiKey = resolveApiKey();
  if (!apiKey) return null;
  const preset = providerPreset();
  const explicit = (process.env.ZENOX_LLM_API_URL || process.env.OPENAI_BASE_URL || "").trim();
  const base = explicit || preset?.base || "";
  return {
    label: "env:ZENOX_LLM_API_KEY",
    provider: preset ? (process.env.ZENOX_LLM_PROVIDER || "").trim().toLowerCase() : base ? "custom" : "manus",
    url: base ? buildChatUrl(base) : resolveApiUrl(),
    model: (process.env.ZENOX_LLM_MODEL || "").trim() || preset?.model || (base ? "gpt-4o-mini" : "default"),
    apiKey,
  };
};

/** One candidate per provider that has its own env var set. */
const providerEnvCandidates = (): LlmCandidate[] => {
  const list: LlmCandidate[] = [];
  for (const { provider, env } of ENV_PROVIDER_KEYS) {
    const apiKey = sanitizeApiKey(process.env[env]);
    const preset = PROVIDER_PRESETS[provider];
    if (!apiKey || !preset) continue;
    list.push({
      label: `env:${env}`,
      provider,
      url: buildChatUrl(preset.base),
      model: preset.model,
      apiKey,
    });
  }
  return list;
};

/**
 * Keyless OpenAI-compatible fallback so the assistant answers before the owner
 * adds a key. It is slower and rate-limited; real keys always win over it.
 * Disable with ZENOX_LLM_FREE=off.
 */
const FREE_FALLBACK: LlmCandidate = {
  label: "free",
  provider: "pollinations",
  url: "https://text.pollinations.ai/openai",
  model: "openai",
  apiKey: "",
};

const freeFallbackEnabled = () => (process.env.ZENOX_LLM_FREE || "").trim().toLowerCase() !== "off";/**
 * One short-lived snapshot of the enabled keys, so a single chat request does
 * not read the key table three times (status + candidates + rotation).
 */
const KEY_CACHE_MS = 5_000;
let keyCache: { at: number; rows: Awaited<ReturnType<typeof listLlmKeys>> } | null = null;

/** Call after any write to the key table so the next request sees it at once. */
export function invalidateLlmKeyCache() {
  keyCache = null;
}

async function llmKeyRows() {
  const now = Date.now();
  if (keyCache && now - keyCache.at < KEY_CACHE_MS) return keyCache.rows;
  try {
    const rows = await listLlmKeys();
    keyCache = { at: now, rows };
    return rows;
  } catch (error) {
    // A database blip must not disable the assistant: keep using the last keys
    // we know about instead of silently falling back to the slow free tier.
    console.warn("[llm] key lookup failed, reusing the last known keys");
    if (keyCache) return keyCache.rows;
    throw error;
  }
}

/** Environment key first, then every enabled key saved from the owner center. */
async function llmCandidates(): Promise<LlmCandidate[]> {
  const list: LlmCandidate[] = [];

  const respan = respanCandidate();
  if (respan) list.push(respan);
  const env = envCandidate();
  if (env) list.push(env);
  list.push(...providerEnvCandidates());
  const rows = await llmKeyRows().catch(() => []);
  for (const row of rows) {
    if (!row.enabled || !row.apiKey) continue;
    list.push({
      id: row.id,
      label: row.label,
      provider: row.provider,
      url: buildChatUrl(row.baseUrl),
      model: row.model || "gpt-4o-mini",
      apiKey: row.apiKey,
      health: row.status,
    });
  }
  // Last resort only: a keyless public endpoint, so a broken or exhausted key
  // still produces an answer instead of an error.
  if (freeFallbackEnabled()) list.push(FREE_FALLBACK);
  return list;
}

/**
 * Keyed candidates rotated daily (one key carries a whole day), with the
 * keyless fallback pinned last so it is only reached when keys fail.
 */
/** Exported so tests can assert the failover order. */
/**
 * A key the provider rejected (401/402/403) is demoted for half an hour, so the
 * next request goes straight to a working provider instead of waiting through
 * retries. It returns to the pool automatically when the window expires.
 */
const rejectedUntil = new Map<string, number>();
const REJECT_TTL_MS = 30 * 60_000;

export function markKeyRejected(label: string, now = Date.now()) {
  if (!label) return;
  rejectedUntil.set(label, now + REJECT_TTL_MS);
}

export function isKeyRejected(label: string, now = Date.now()) {
  const until = rejectedUntil.get(label);
  if (!until) return false;
  if (until <= now) {
    rejectedUntil.delete(label);
    return false;
  }
  return true;
}

export function resetKeyHealth() {
  rejectedUntil.clear();
}

/**
 * Measured latency per key: healthy keys answer from the fastest one, so Gemini
 * and OpenAI sit side by side and the quicker one takes the request while the
 * other stays ready as an instant fallback.
 */
const keyLatency = new Map<string, number>();

export function recordKeyLatency(label: string, ms: number) {
  if (!label || !Number.isFinite(ms) || ms <= 0) return;
  keyLatency.set(label, Math.round(ms));
}

export function keyLatencySnapshot(): Record<string, number> {
  return Object.fromEntries(keyLatency);
}

export async function orderedPool() {
  const all = await llmCandidates();
  const keyed = all.filter((item) => item.provider !== FREE_FALLBACK.provider);
  const free = all.filter((item) => item.provider === FREE_FALLBACK.provider);
  // The hosted gateway leads the pool and is never rotated: every reply is
  // traced, and a gateway hiccup falls through to the keys below it.
  const gateway = keyed.filter((item) => item.provider === RESPAN_PROVIDER);
  const direct = keyed.filter((item) => item.provider !== RESPAN_PROVIDER);
  const usable = (item: LlmCandidate) => item.health !== "failing" && !isKeyRejected(item.label);
  const healthy = direct.filter(usable);
  const broken = direct.filter((item) => !usable(item));
  // Healthy keys rotate daily; failing ones are kept only as a last try.
  // Working keys share the traffic: each request starts at the next key (fastest
  // measured first, the rest right behind it as an instant fallback).
  const prefer = preferredProvider();
  const byLatency = [...healthy].sort((a, b) => {
    const wanted = Number(b.provider === prefer) - Number(a.provider === prefer);
    if (wanted !== 0) return wanted;
    return (keyLatency.get(a.label) ?? 2_500) - (keyLatency.get(b.label) ?? 2_500);
  });
  return [...gateway, ...rotateByRequest(byLatency.length > 0 ? byLatency : []), ...broken, ...free];
}

/**
 * True when the pool holds a real provider key. The keyless fallback cannot call
 * tools and must not be mistaken for a configured assistant.
 */
export async function llmHasKey(): Promise<boolean> {
  const pool = await orderedPool();
  return pool.some((candidate) => candidate.provider !== FREE_FALLBACK.provider);
}

/** Daily rotation so one key carries a whole day, not one request each. */
/** Provider the owner chose to prefer: it goes first whenever its key works. */
export function preferredProvider(): string {
  return (process.env.ZENOX_LLM_PREFER || "groq").trim().toLowerCase();
}

/** Round-robin cursor: healthy keys take turns so several providers share load. */
let poolCursor = 0;

export function rotateByRequest<T>(items: T[]): T[] {
  if (items.length <= 1) return items;
  const start = poolCursor++ % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

export function rotateDaily<T>(items: T[], now = Date.now()): T[] {
  if (items.length <= 1) return items;
  const start = Math.floor(now / 86_400_000) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** Public, key-free status: which key the pool will use today. */
export async function llmStatus() {
  const pool = await orderedPool();
  const rows = await llmKeyRows();
  const first = pool[0];
  let host = "";
  try {
    host = new URL(first?.url ?? "").host;
  } catch {
    host = "";
  }
  return {
    configured: pool.length > 0,
    provider: first?.provider ?? "none",
    host,
    model: first?.model ?? "default",
    keys: pool.length,
    fallback: pool[0]?.provider === FREE_FALLBACK.provider,
    okKeys: rows.filter((row) => row.status === "ok").length,
    failingKeys: rows.filter((row) => row.status === "failing").length,
    // Every key the provider rejected: the model will answer with a failure
    // until one valid key is added, whatever mode the user picks.
    rejected: rows.length > 0 && rows.every((row) => row.status === "failing"),
    activeLabel: first?.label ?? "",
  };
}

/**
 * Opens a streaming completion from the same key pool, so the browser can show
 * tokens as they arrive instead of waiting for a whole answer.
 */
export async function openChatStream(messages: Message[], maxTokens: number, modeModel?: string): Promise<Response> {
  const pool = await orderedPool();
  if (pool.length === 0) {
    throw new Error("الذكاء الاصطناعي غير مفعّل: أضف مفتاحًا من مركز ZENOX ← «الذكاء الاصطناعي».");
  }

  let lastError: unknown = null;
  for (const candidate of pool.slice(0, 5)) {
    const attemptStarted = Date.now();
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (candidate.apiKey) headers.authorization = `Bearer ${candidate.apiKey}`;
    providerHeaders(candidate.url, headers);
    const body: Record<string, unknown> = {
      messages: messages.map(normalizeMessage),
      max_tokens: maxTokens,
      stream: true,
    };
    // The mode's own free model leads on OpenRouter; if it is retired the pool's
    // next free model answers instead.
    const perModeModel =
      candidate.provider === "openrouter" && modeModel && freeModelChain().includes(modeModel) ? modeModel : undefined;
    const chosenModel = perModeModel || candidate.model;
    if (chosenModel && chosenModel !== "default") body.model = chosenModel;

    try {
      // Only the wait for response headers is capped here: a provider that hangs
      // must not block the user, while a long answer may keep streaming.
      const controller = new AbortController();
      const headerTimer = setTimeout(() => controller.abort(), LLM_STREAM_HEADERS_MS);
      let response: Response;
      try {
        response = await fetch(candidate.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(headerTimer);
      }
      if (response.ok && response.body) return response;
      console.warn(`[llm] stream headers rejected: ${candidate.label} (${candidate.provider}) → HTTP ${response.status}`);
      lastError = new Error(`LLM stream failed on key «${candidate.label}»: ${response.status}`);
      console.warn(`[llm] stream attempt failed: ${candidate.label} (${candidate.provider}) → HTTP ${response.status}`);
      if (!candidate.id && response.status !== 404 && response.status !== 429 && response.status !== 503) markKeyRejected(candidate.label);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("LLM stream failed");
}

/** Exposed for tests: the exact completions URL the server will call. */
export function llmEndpoint() {
  return resolveApiUrl();
}

/** One cheap round-trip to prove a single key works, without touching the pool. */
export async function probeLlmKey(input: { baseUrl: string; model: string; apiKey: string }) {
  try {
    const response = await fetch(buildChatUrl(input.baseUrl), {
      method: "POST",
      headers: providerHeaders(buildChatUrl(input.baseUrl), {
        "content-type": "application/json",
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      }),
      body: JSON.stringify({
        model: input.model || "gpt-4o-mini",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      return { ok: false as const, error: `${response.status} ${response.statusText} – ${text}` };
    }
    await response.json().catch(() => null);
    return { ok: true as const, error: "" };
  } catch (error) {
    return { ok: false as const, error: String(error).slice(0, 300) };
  }
}

const assertApiKey = () => {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      "الذكاء الاصطناعي غير مهيأ على الخادم: أضف ZENOX_LLM_API_KEY (أو OPENAI_API_KEY) في .env، ومع أي مزود غير OpenAI أضف ZENOX_LLM_API_URL ونموذجًا في ZENOX_LLM_MODEL، ثم أعد تشغيل الخادم.",
    );
  }
  return apiKey;
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (explicitFormat.type === "json_schema" && !explicitFormat.json_schema?.schema) {
      throw new Error("responseFormat json_schema requires a defined schema object");
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

const RETRY_MAX_RETRIES = 4;
// A single provider call is bounded, so the server always answers with JSON.
const LLM_REQUEST_TIMEOUT_MS = Number(process.env.ZENOX_LLM_TIMEOUT_MS) || 45_000;
// A streaming reply is long-lived on purpose; the client sees tokens meanwhile.
const LLM_STREAM_TIMEOUT_MS = Number(process.env.ZENOX_LLM_STREAM_TIMEOUT_MS) || 120_000;
/** How long to wait for response headers from one provider before failing over. */
const LLM_STREAM_HEADERS_MS = Number(process.env.ZENOX_LLM_HEADERS_TIMEOUT_MS) || 6_000;
/**
 * The keyless shared endpoint is a safety net, not a primary: waiting 45s on it
 * is what made a reply take half a minute. It gets a short leash instead.
 */
const FREE_FALLBACK_TIMEOUT_MS = Number(process.env.ZENOX_LLM_FREE_TIMEOUT_MS) || 9_000;
const FREE_FALLBACK_TOKENS = 600;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

// Equal-jitter exponential backoff. The cap/2 floor guarantees a minimum delay so a
// misbehaving caller loop slows down instead of hammering the upstream while it keeps
// returning errors.
const computeBackoffDelay = (attempt: number, retryAfterMs?: number): number => {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jittered = cap / 2 + Math.random() * (cap / 2);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), RETRY_MAX_DELAY_MS);
};

// Retries non-2xx responses and network errors with exponential backoff, then returns
// the final Response so callers keep their existing error handling.
const fetchWithBackoff = async (
  url: string,
  init: FetchInit,
  maxRetries: number = RETRY_MAX_RETRIES,
): Promise<Response> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || attempt === maxRetries) {
        return response;
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      try {
        await response.body?.cancel();
      } catch {
        // Body already settled; nothing to clean up.
      }
      console.warn("LLM request retry scheduled after HTTP failure");
      await sleep(computeBackoffDelay(attempt, retryAfterMs));
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) throw error;
      console.warn("LLM request retry scheduled after network failure");
      await sleep(computeBackoffDelay(attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("LLM request failed after exhausting retries");
};

async function invokeLLMOnce(params: InvokeParams): Promise<InvokeResult> {
  // Daily rotation first; on failure the next enabled key is tried immediately.
  const pool = await orderedPool();
  if (pool.length === 0) {
    throw new Error(
      "الذكاء الاصطناعي غير مفعّل: أضف مفتاح النموذج من مركز ZENOX ← قسم «الذكاء الاصطناعي»، أو اضبط ZENOX_LLM_API_KEY في بيئة الخادم.",
    );
  }

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    model,
    thinking,
    reasoning,
    maxTokens,
    max_tokens,
  } = params;

  const payload: Record<string, unknown> = {
    messages: messages.map(normalizeMessage),
  };

  const requestedModel = (model ?? (process.env.ZENOX_LLM_MODEL || "").trim()) || undefined;

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }

  if (thinking) {
    payload.thinking = thinking;
  }
  if (reasoning) {
    payload.reasoning = reasoning;
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  let lastError: unknown = null;
  for (const candidate of pool.slice(0, Math.min(pool.length, 5))) {
    const attemptStarted = Date.now();
    const onFreeTier = candidate.provider === FREE_FALLBACK.provider;
    // A retired or overloaded model must not stall the reply: the same key tries
    // a lighter model before the next key is considered. Gateway model IDs are
    // Respan's own, so an app-wide ZENOX_LLM_MODEL is not sent to it.
    const candidateRequested = candidate.provider === RESPAN_PROVIDER ? undefined : requestedModel;
    const fallbacks = candidate.provider === "openrouter" ? openrouterFallbacks() : MODEL_FALLBACKS[candidate.provider] ?? [];
    const modelList = [candidateRequested ?? candidate.model, ...fallbacks]
      .map((name) => (name || "").trim())
      .filter((name, index, all) => Boolean(name) && all.indexOf(name) === index);
    const modelsToTry = modelList.length > 0 ? modelList : ["default"];

    for (const candidateModel of modelsToTry) {
    const body = { ...payload } as Record<string, unknown>;
    if (candidateModel && candidateModel !== "default") body.model = candidateModel;
    if (onFreeTier && typeof body.max_tokens === "number" && body.max_tokens > FREE_FALLBACK_TOKENS) {
      body.max_tokens = FREE_FALLBACK_TOKENS;
    }

    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (candidate.apiKey) headers.authorization = `Bearer ${candidate.apiKey}`;

      // One retry only: chat must answer before an interactive client or a
      // tunnel in front of it gives up waiting.
      const response = await fetchWithBackoff(
        candidate.url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(onFreeTier ? FREE_FALLBACK_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS),
        },
        1,
      );

      if (!response.ok) {
        const errorText = await response.text();
        lastError = new Error(
          `LLM invoke failed on key «${candidate.label}»: ${response.status} ${response.statusText} – ${errorText.slice(0, 300)}`,
        );
        // 404/503/429 mean the model, not the key: keep the key healthy and move on.
        const modelIssue = response.status === 404 || response.status === 503 || response.status === 429;
        if (candidate.id && !modelIssue) {
          await setLlmKeyHealth(candidate.id, "failing", String(lastError).slice(0, 380)).catch(() => undefined);
        }
        if (!candidate.id && !modelIssue) markKeyRejected(candidate.label);
        continue;
      }

      recordKeyLatency(candidate.label, Date.now() - attemptStarted);
      if (candidate.id) {
        await setLlmKeyHealth(candidate.id, "ok", null).catch(() => undefined);
        await touchLlmKey(candidate.id).catch(() => undefined);
      }
      return (await response.json()) as InvokeResult;
    } catch (error) {
      lastError = error;
      if (candidate.id) {
        await setLlmKeyHealth(candidate.id, "failing", String(error).slice(0, 380)).catch(() => undefined);
      }
    }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("فشلت كل مفاتيح النموذج المتاحة");
}

export type ModelInfo = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type ModelsResponse = {
  object: string;
  data: ModelInfo[];
};

export async function listLLMModels(): Promise<ModelsResponse> {
  const apiKey = assertApiKey();

  const baseUrl = ENV.manusApiUrl || ENV.forgeApiUrl;
  const url =
    baseUrl && baseUrl.trim().length > 0
      ? `${baseUrl.replace(/\/$/, "")}/v1/models`
      : "https://forge.manus.im/v1/models";

  const response = await fetchWithBackoff(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `List LLM models failed: ${response.status} ${response.statusText} – ${errorText}`,
    );
  }

  return (await response.json()) as ModelsResponse;
}

/**
 * A busy or briefly failing provider is normal on a free tier: retry twice with
 * a short backoff before telling the owner the model is unreachable.
 */
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const transient = /429|500|502|503|504|rate.?limit|overloaded|timeout|timed out|ECONNRESET|fetch failed|quota/i;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await invokeLLMOnce(params);
    } catch (error) {
      lastError = error;
      if (!transient.test(String(error))) throw error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw lastError;
}
