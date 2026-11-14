/**
 * Real-request benchmark for every free OpenRouter model.
 *
 *   node scripts/bench-free-models.mjs --rounds 40 --concurrency 8
 *
 * It reads OPENROUTER_API_KEY from .env (never prints it), asks the public
 * catalogue for the current `:free` models, then sends `rounds` requests per
 * model and records latency and failures. Results are merged into
 * artifacts/free-models-bench.json so several runs accumulate into one report.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) || fallback : fallback;
};
const ROUNDS = arg("rounds", 10);
const CONCURRENCY = arg("concurrency", 6);
const OUT = arg("out", "artifacts/free-models-bench.json");

const env = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) env[match[1]] = match[2].trim();
}
const key = (env.OPENROUTER_API_KEY || "").replace(/[^\x20-\x7E]/g, "");
if (!key) throw new Error("OPENROUTER_API_KEY is missing in .env");

const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${key}`,
  "HTTP-Referer": "https://zenox.app",
  "X-Title": "ZENOX",
};

async function catalogue() {
  const response = await fetch("https://openrouter.ai/api/v1/models", { headers });
  const body = await response.json();
  return body.data.filter((model) => model.id.endsWith(":free")).map((model) => model.id);
}

async function once(model, prompt) {
  const started = Date.now();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 24,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const ms = Date.now() - started;
    if (!response.ok) return { model, ok: false, ms, error: `${response.status}` };
    const body = await response.json();
    const message = body.choices?.[0]?.message ?? {};
    const text = message.content ?? message.reasoning ?? "";
    return { model, ok: true, ms, empty: !String(text).trim() };
  } catch (error) {
    return { model, ok: false, ms: Date.now() - started, error: String(error).slice(0, 60) };
  }
}

const prompts = [
  "Reply with one short Arabic sentence about speed.",
  "أجب بكلمة واحدة: جاهز",
  "Name one benefit of caching in a single line.",
  "اكتب جملة قصيرة عن الصبر.",
];

const models = await catalogue();
console.log(`benchmarking ${models.length} free models × ${ROUNDS} rounds (concurrency ${CONCURRENCY})`);

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < models.length * ROUNDS) {
    const index = cursor++;
    const model = models[index % models.length];
    results.push(await once(model, prompts[index % prompts.length]));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, models.length * ROUNDS) }, worker));

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { runs: [], models: {} };
const run = { at: new Date().toISOString(), rounds: ROUNDS, requests: results.length };
previous.runs = [...(previous.runs || []), run];

for (const model of models) {
  const own = results.filter((row) => row.model === model);
  const oks = own.filter((row) => row.ok && !row.empty).map((row) => row.ms).sort((a, b) => a - b);
  const bucket = previous.models[model] ?? { attempts: 0, successes: 0, latencies: [] };
  bucket.attempts += own.length;
  bucket.successes += oks.length;
  bucket.latencies = [...bucket.latencies, ...oks].slice(-400);
  bucket.empty = bucket.latencies.length === 0;
  previous.models[model] = bucket;
}

const summary = Object.entries(previous.models).map(([model, bucket]) => {
  const latencies = [...bucket.latencies].sort((a, b) => a - b);
  const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? null;
  return {
    model,
    attempts: bucket.attempts,
    successes: bucket.successes,
    successRate: bucket.attempts ? Number(((bucket.successes / bucket.attempts) * 100).toFixed(1)) : 0,
    p50: p(0.5),
    p95: p(0.95),
  };
});
previous.summary = summary.sort((a, b) => (a.p50 ?? 1e9) - (b.p50 ?? 1e9));
previous.totalRequests = (previous.runs || []).reduce((sum, item) => sum + item.requests, 0);
writeFileSync(OUT, JSON.stringify(previous, null, 2));

console.log(`total requests recorded: ${previous.totalRequests}`);
for (const row of previous.summary) {
  console.log(
    `${row.model.padEnd(52)} ${String(row.successRate).padStart(5)}%  p50=${row.p50 ?? "-"}ms  p95=${row.p95 ?? "-"}ms`,
  );
}
