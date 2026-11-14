/**
 * The free OpenRouter catalogue, read from the provider's public model list
 * instead of a hand-written array: models appear and retire weekly, so the
 * server refreshes the list itself and ranks it by what actually answered.
 */
export type FreeModel = { id: string; name: string; context: number };
type Health = { ok: number; fail: number; lastMs: number };

const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";
const TTL_MS = 6 * 60 * 60_000;

/** Last resort only, used before the first successful catalogue fetch. */
const SEED: FreeModel[] = [
  { id: "particle-ai/particle-1:free", name: "Particle-1", context: 0 },
  { id: "liquid/lfm-3-1.7b:free", name: "LFM3 1.7B", context: 0 },
  { id: "cohere/north-mini-code:free", name: "North Mini Code", context: 0 },
];

let cache: { at: number; models: FreeModel[]; source: "live" | "seed" } = {
  at: 0,
  models: SEED,
  source: "seed",
};
const health = new Map<string, Health>();

/** Pure: keeps only `:free` models, de-duplicated and sorted by context size. */
export function extractFreeModels(payload: unknown): FreeModel[] {
  const list = (payload as { data?: { id?: string; name?: string; context_length?: number }[] })?.data;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const models: FreeModel[] = [];
  for (const item of list) {
    const id = (item?.id ?? "").trim();
    if (!id || !id.endsWith(":free") || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: (item?.name ?? id).trim(), context: Number(item?.context_length) || 0 });
  }
  return models.sort((a, b) => b.context - a.context);
}

/**
 * Pure: working models first (successes before failures), then measured speed.
 * A model nobody tried yet keeps catalogue order, so it is still reachable.
 */
export function rankFreeModels(models: FreeModel[], stats: Map<string, Health>): FreeModel[] {
  return [...models].sort((a, b) => {
    const left = stats.get(a.id);
    const right = stats.get(b.id);
    const leftScore = left ? (left.ok > 0 ? 1 : -1) : 0;
    const rightScore = right ? (right.ok > 0 ? 1 : -1) : 0;
    if (leftScore !== rightScore) return rightScore - leftScore;
    const leftMs = left?.lastMs ?? Number.POSITIVE_INFINITY;
    const rightMs = right?.lastMs ?? Number.POSITIVE_INFINITY;
    if (leftMs !== rightMs) return leftMs - rightMs;
    return a.id.localeCompare(b.id);
  });
}

/** Records a real request outcome so the ranking reflects reality. */
export function recordFreeModelResult(id: string, ok: boolean, ms: number) {
  const current = health.get(id) ?? { ok: 0, fail: 0, lastMs: 0 };
  const next: Health = {
    ok: current.ok + (ok ? 1 : 0),
    fail: current.fail + (ok ? 0 : 1),
    lastMs: ok && ms > 0 ? Math.round(ms) : current.lastMs,
  };
  health.set(id, next);
}

/** Synchronous view for the request path: never blocks on the network. */
export function freeModelChain(): string[] {
  const ranked = rankFreeModels(cache.models, health);
  return (ranked.length > 0 ? ranked : SEED).map((model) => model.id);
}

/** Full view for the owner panel. */
export function freeModelReport() {
  const ranked = rankFreeModels(cache.models, health);
  return {
    source: cache.source,
    fetchedAt: cache.at ? new Date(cache.at).toISOString() : null,
    models: ranked.map((model) => {
      const stat = health.get(model.id);
      return {
        id: model.id,
        name: model.name,
        context: model.context,
        ok: (stat?.ok ?? 0) > 0,
        attempts: (stat?.ok ?? 0) + (stat?.fail ?? 0),
        lastMs: stat?.lastMs ?? 0,
      };
    }),
  };
}

/** Refreshes from the public catalogue; on any failure the previous list stays. */
export async function refreshFreeModels(force = false): Promise<FreeModel[]> {
  if (!force && cache.at && Date.now() - cache.at < TTL_MS) return cache.models;
  try {
    const response = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`catalogue ${response.status}`);
    const models = extractFreeModels(await response.json());
    if (models.length > 0) {
      cache = { at: Date.now(), models, source: "live" };
      for (const model of models) if (!health.has(model.id)) health.set(model.id, { ok: 0, fail: 0, lastMs: 0 });
    }
    return cache.models;
  } catch {
    // Keep serving the last known list; the seed covers a cold start.
    return cache.models;
  }
}

/** Starts a background refresh and repeats it, so the list never goes stale. */
export function startFreeModelRefresh(intervalMs = TTL_MS) {
  void refreshFreeModels();
  const timer = setInterval(() => void refreshFreeModels(), intervalMs);
  timer.unref?.();
  return timer;
}
