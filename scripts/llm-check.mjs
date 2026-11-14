#!/usr/bin/env node
/**
 * Probes every configured model key (env + the pool saved from the owner center)
 * and prints provider / model / HTTP status / latency only.
 *
 * The key value is never printed, logged or written anywhere: it is read from
 * the environment or the database and used for one request.
 *
 * Usage:  DATABASE_URL=... node scripts/llm-check.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const PRESETS = {
  groq: { base: "https://api.groq.com/openai", model: "openai/gpt-oss-120b" },
  // 3.8 flash is frequently 503/timeout; the lite flash answers in <1s.
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.5-flash-lite" },
  openai: { base: "https://api.openai.com", model: "gpt-4o-mini" },
  openrouter: { base: "https://openrouter.ai/api/v1", model: "particle-ai/particle-1:free" },
  zai: { base: "https://api.z.ai/api/paas/v4", model: "glm-4.6" },
};

function chatUrl(base) {
  const trimmed = String(base || "").replace(/\/$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v\d+[a-z]*$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

async function probe({ label, provider, url, model, apiKey }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "say ok" }],
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let reply = "";
    try {
      reply = JSON.parse(text)?.choices?.[0]?.message?.content ?? "";
    } catch {
      reply = "";
    }
    const detail = response.ok
      ? `ok · ${String(reply).trim().slice(0, 40) || "(empty reply)"}`
      : `HTTP ${response.status} · ${text.replace(/\s+/g, " ").slice(0, 160)}`;
    return { label, provider, model, ms: Date.now() - started, ok: response.ok, detail };
  } catch (error) {
    return {
      label,
      provider,
      model,
      ms: Date.now() - started,
      ok: false,
      detail: error?.name === "AbortError" ? "timeout after 30s" : String(error?.message || error).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

const ENV_PROVIDER_KEYS = [
  { provider: "groq", env: "GROQ_API_KEY" },
  { provider: "gemini", env: "GEMINI_API_KEY" },
  { provider: "openai", env: "OPENAI_API_KEY" },
  { provider: "openrouter", env: "OPENROUTER_API_KEY" },
  { provider: "zai", env: "ZAI_API_KEY" },
];

async function fromEnv() {
  const list = [];

  const provider = (process.env.ZENOX_LLM_PROVIDER || "").trim().toLowerCase();
  const pinned = PRESETS[provider];
  const explicit = (process.env.ZENOX_LLM_API_URL || process.env.OPENAI_BASE_URL || "").trim();
  const pinnedKey = (process.env.ZENOX_LLM_API_KEY || (explicit || pinned ? process.env.OPENAI_API_KEY : "") || "").trim();
  const base = explicit || pinned?.base;
  if (pinnedKey && base) {
    list.push({
      label: "env:ZENOX_LLM_API_KEY",
      provider: provider || "custom",
      url: chatUrl(base),
      model: (process.env.ZENOX_LLM_MODEL || "").trim() || pinned?.model || "",
      apiKey: pinnedKey,
    });
  }

  for (const { provider: name, env } of ENV_PROVIDER_KEYS) {
    const apiKey = (process.env[env] || "").trim();
    const preset = PRESETS[name];
    if (!apiKey || !preset) continue;
    list.push({ label: `env:${env}`, provider: name, url: chatUrl(preset.base), model: preset.model, apiKey });
  }

  return list;
}

async function fromDatabase() {
  if (!process.env.DATABASE_URL) return [];
  const connection = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    const [rows] = await connection.query(
      "SELECT id, label, provider, baseUrl, model, apiKey, enabled FROM llm_keys ORDER BY id",
    );
    return rows
      .filter((row) => Number(row.enabled) === 1)
      .map((row) => ({
        label: `db#${row.id} ${row.label}`.trim(),
        provider: row.provider,
        url: chatUrl(row.baseUrl),
        model: row.model,
        apiKey: row.apiKey,
      }));
  } finally {
    await connection.end();
  }
}

const targets = [];
targets.push(...(await fromEnv()));
try {
  targets.push(...(await fromDatabase()));
} catch (error) {
  console.log(`database: skipped (${String(error?.message || error).slice(0, 120)})`);
}

if (targets.length === 0) {
  console.log("No model key configured (env or owner center). Nothing to probe.");
  process.exit(2);
}

console.log(`Probing ${targets.length} key(s) — values are never printed.\n`);
let failures = 0;
for (const target of targets) {
  const result = await probe(target);
  if (!result.ok) failures += 1;
  console.log(
    `${result.ok ? "PASS" : "FAIL"}  ${result.label}  [${result.provider}/${result.model}]  ${result.ms}ms  ${result.detail}`,
  );
}
console.log(`\n${targets.length - failures}/${targets.length} healthy.`);
process.exit(failures === 0 ? 0 : 1);
