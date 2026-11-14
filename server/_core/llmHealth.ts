import { listLlmKeys, setLlmKeyHealth } from "../db";
import { invalidateLlmKeyCache, probeLlmKey } from "./llm";

/**
 * Hourly health sweep over the owner's model keys: every enabled key gets one
 * cheap probe, so a key that failed earlier (rate limit, outage, rotation of the
 * provider) returns to service automatically once it starts answering again.
 * Disable with ZENOX_LLM_MONITOR=off, tune with ZENOX_LLM_MONITOR_MS.
 */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 20 * 1000;

let started = false;
let running = false;

export type LlmHealthSummary = { checked: number; recovered: number; failing: number };

export async function runLlmKeyHealthCheck(): Promise<LlmHealthSummary> {
  if (running) return { checked: 0, recovered: 0, failing: 0 };
  running = true;
  try {
    const rows = await listLlmKeys().catch(() => []);
    let recovered = 0;
    let failing = 0;
    let checked = 0;
    for (const row of rows) {
      if (!row.enabled || !row.apiKey) continue;
      checked += 1;
      const probe = await probeLlmKey({ baseUrl: row.baseUrl, model: row.model, apiKey: row.apiKey });
      if (probe.ok) {
        if (row.status === "failing") recovered += 1;
        await setLlmKeyHealth(row.id, "ok", null).catch(() => undefined);
      } else {
        failing += 1;
        await setLlmKeyHealth(row.id, "failing", probe.error).catch(() => undefined);
      }
    }
    if (checked > 0) invalidateLlmKeyCache();
    return { checked, recovered, failing };
  } finally {
    running = false;
  }
}

export function startLlmKeyMonitor() {
  if (started) return;
  if ((process.env.ZENOX_LLM_MONITOR || "").trim().toLowerCase() === "off") return;
  started = true;

  const parsed = Number(process.env.ZENOX_LLM_MONITOR_MS);
  const interval = Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_INTERVAL_MS;

  const tick = async () => {
    try {
      const summary = await runLlmKeyHealthCheck();
      if (summary.checked > 0) {
        console.log(
          `[llm-health] checked=${summary.checked} recovered=${summary.recovered} failing=${summary.failing}`,
        );
      }
    } catch (error) {
      console.error("[llm-health] sweep failed:", String(error).slice(0, 200));
    }
  };

  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  first.unref?.();
  const timer = setInterval(() => void tick(), interval);
  timer.unref?.();
}
