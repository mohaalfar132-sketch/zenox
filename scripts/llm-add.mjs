#!/usr/bin/env node
/**
 * Interactive secret wizard: adds model keys to the pool and probes each one.
 * Everything typed is hidden (no echo, no history, no log). Only the provider,
 * model, status and latency are ever printed — never a key value.
 *
 *   DATABASE_URL=... node scripts/llm-add.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const PRESETS = {
  groq: { base: "https://api.groq.com/openai", model: "openai/gpt-oss-120b" },
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash" },
  openai: { base: "https://api.openai.com", model: "gpt-4o-mini" },
  openrouter: { base: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  zai: { base: "https://api.z.ai/api/paas/v4", model: "glm-4.6" },
};

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL غير مضبوط.");
  process.exit(2);
}

function readLine(promptText, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.resume();
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (hidden && stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (hidden) {
        for (const char of text) {
          if (char === "\r" || char === "\n") {
            cleanup();
            process.stdout.write("\n");
            resolve(value.trim());
            return;
          }
          if (char === "\u0003") {
            cleanup();
            process.stdout.write("\n");
            reject(new Error("cancelled"));
            return;
          }
          if (char === "\u007f" || char === "\b") {
            value = value.slice(0, -1);
            continue;
          }
          value += char;
        }
        return;
      }
      value += text;
      if (value.includes("\n")) {
        cleanup();
        resolve(value.split("\n")[0].trim());
      }
    };
    stdin.on("data", onData);
  });
}

function chatUrl(base) {
  const trimmed = String(base || "").replace(/\/$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v\d+[a-z]*$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

const guessProvider = (key) => {
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("sk-proj-") || key.startsWith("sk-")) return "openai";
  if (key.startsWith("AIza")) return "gemini";
  return "";
};

async function probe(preset, apiKey) {
  const started = Date.now();
  const response = await fetch(chatUrl(preset.base), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: preset.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "say ok" }],
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => ({ ok: false, status: 0, text: async () => (error?.name === "TimeoutError" ? "timeout 30s" : String(error?.message || error)) }));
  const text = typeof response.text === "function" ? await response.text() : "";
  return {
    ok: Boolean(response.ok),
    ms: Date.now() - started,
    detail: response.ok
      ? "مفتاح سليم ✓"
      : `HTTP ${response.status} · ${String(text).replace(/\s+/g, " ").slice(0, 140)}`,
  };
}

console.log("— حفظ مفاتيح الذكاء الاصطناعي (كل ما تكتبه هنا مخفي ولا يُسجَّل) —\n");

let added = 0;
for (;;) {
  const key = await readLine("الصق المفتاح ثم Enter (لن يظهر): ", { hidden: true });
  if (!key) {
    console.log("لا يوجد مفتاح — انتهى.");
    break;
  }
  if (key.split(" ").length > 1) {
    console.log("يبدو أنك لصقت أكثر من قيمة في سطر واحد. الصق مفتاحًا واحدًا في كل مرة.");
    continue;
  }

  const guessed = guessProvider(key);
  const answer = (await readLine(`المزوّد [${guessed || "groq"}] (groq/gemini/openai/openrouter/zai): `)).toLowerCase();
  const provider = answer || guessed || "groq";
  const preset = PRESETS[provider];
  if (!preset) {
    console.log(`مزوّد غير معروف: ${provider} — لم يُحفظ شيء لهذه القيمة.`);
    continue;
  }

  const label = (await readLine(`اسم المفتاح [مفتاح ${provider} ${added + 1}]: `)) || `مفتاح ${provider} ${added + 1}`;

  const connection = await mysql.createConnection(process.env.DATABASE_URL);
  let id = 0;
  try {
    const [result] = await connection.query(
      "INSERT INTO llm_keys (label, provider, baseUrl, model, apiKey, enabled, status) VALUES (?,?,?,?,?,1,'untested')",
      [label, provider, preset.base, preset.model, key],
    );
    id = Number(result.insertId);
  } finally {
    await connection.end();
  }

  const result = await probe(preset, key);
  const health = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    await health.query("UPDATE llm_keys SET status=?, lastError=?, lastCheckedAt=NOW() WHERE id=?", [
      result.ok ? "ok" : "failing",
      result.ok ? null : result.detail,
      id,
    ]);
  } finally {
    await health.end();
  }

  added += 1;
  console.log(`#${id} ${label} · ${provider}/${preset.model} — ${result.ok ? "PASS" : "FAIL"} ${result.ms}ms · ${result.detail}\n`);

  const more = (await readLine("مفتاح آخر؟ (y / Enter للإنهاء): ")).toLowerCase();
  if (!more.startsWith("y")) break;
}

console.log(`تم حفظ ${added} مفتاحًا. شغّل الفحص الكامل: node scripts/llm-check.mjs`);
process.exit(added > 0 ? 0 : 1);
