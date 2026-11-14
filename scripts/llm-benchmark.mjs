#!/usr/bin/env node
/**
 * ZENOX LLM benchmark: measures real latency and answer correctness for every
 * configured provider key, then names the fastest correct one.
 *
 * A model passes only when it returns the right arithmetic answer on every run.
 * Keys are read from the environment and never printed.
 *
 * Usage: node scripts/llm-benchmark.mjs [runs]
 */
import "dotenv/config";

const RUNS = Math.max(1, Math.min(5, Number(process.argv[2] || 3)));
const TIMEOUT_MS = 30_000;

const TARGETS = [
  {
    provider: "groq",
    env: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
  },
  {
    provider: "gemini",
    env: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    models: ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"],
  },
  {
    provider: "openai",
    env: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/chat/completions",
    models: ["gpt-4o-mini"],
  },
  {
    provider: "openrouter",
    env: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    models: ["particle-ai/particle-1:free"],
  },
  {
    provider: "zai",
    env: "ZAI_API_KEY",
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    models: ["glm-4.6"],
  },
];

const keys = {};
for (const target of TARGETS) {
  const key = (process.env[target.env] || "").trim();
  if (key) keys[target.provider] = key;
}

async function ask(target, model, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${keys[target.provider]}`,
    };
    if (target.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://zenox.app";
      headers["X-Title"] = "ZENOX";
    }
    const response = await fetch(target.url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const text = await response.text();
    let reply = "";
    try {
      reply = String(JSON.parse(text)?.choices?.[0]?.message?.content ?? "").trim();
    } catch {
      reply = "";
    }
    return { ok: response.ok, status: response.status, reply, ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reply: "",
      ms: Date.now() - started,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const rows = [];
for (const target of TARGETS) {
  if (!keys[target.provider]) {
    console.log(`SKIP  ${target.provider} — ${target.env} غير مضبوط`);
    continue;
  }
  for (const model of target.models) {
    const latencies = [];
    let correct = 0;
    let last = null;
    for (let run = 0; run < RUNS; run += 1) {
      const result = await ask(target, model, "What is 17*23? Reply with only the number.");
      last = result;
      latencies.push(result.ms);
      if (result.ok && result.reply.replace(/[^\d]/g, "") === "391") correct += 1;
    }
    const passed = correct === RUNS;
    rows.push({ provider: target.provider, model, ms: median(latencies), passed, correct, runs: RUNS, last });
    console.log(
      `${passed ? "PASS" : "FAIL"}  ${target.provider}/${model}  median ${median(latencies)}ms  ${correct}/${RUNS} correct` +
        (passed ? "" : `  status=${last?.status} ${last?.error ?? JSON.stringify(last?.reply?.slice(0, 60))}`),
    );
  }
}

const healthy = rows.filter((row) => row.passed).sort((a, b) => a.ms - b.ms);
console.log("");
if (healthy.length === 0) {
  console.log("لا يوجد نموذج يرد إجابة صحيحة. أصلح المفاتيح أو أضف مفتاحًا جديدًا.");
  process.exit(1);
}
console.log(`الأسرع مع إجابة صحيحة: ${healthy[0].provider}/${healthy[0].model} — ${healthy[0].ms}ms`);
console.log(`النماذج السليمة: ${healthy.length}/${rows.length}`);
