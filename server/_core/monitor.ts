import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceRoot } from "../terminal";

/**
 * In-process counters for the owner's monitoring panel. Cheap enough to update
 * on every request, and they reset with the process, which is exactly what an
 * "is it alive right now" panel should show.
 */
type Counters = {
  requests: number;
  errors: number;
  slowestMs: number;
  totalMs: number;
  startedAt: number;
  lastRequestAt: number;
};

const counters: Counters = {
  requests: 0,
  errors: 0,
  slowestMs: 0,
  totalMs: 0,
  startedAt: Date.now(),
  lastRequestAt: 0,
};

export function recordRequest(status: number, durationMs: number) {
  counters.requests += 1;
  counters.totalMs += durationMs;
  counters.lastRequestAt = Date.now();
  if (status >= 500) counters.errors += 1;
  if (durationMs > counters.slowestMs) counters.slowestMs = Math.round(durationMs);
}

function tailBackups(limit: number) {
  const dir = join(workspaceRoot(), ".zenox-backups");
  try {
    return readdirSync(dir)
      .sort()
      .reverse()
      .slice(0, limit)
      .map((name) => {
        const full = join(dir, name);
        let size = 0;
        try {
          size = readFileSync(full).length;
        } catch {
          size = 0;
        }
        return { name, size };
      });
  } catch {
    return [];
  }
}

export function monitorSnapshot() {
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.round((Date.now() - counters.startedAt) / 1000),
    requests: counters.requests,
    errors: counters.errors,
    averageMs: counters.requests ? Math.round(counters.totalMs / counters.requests) : 0,
    slowestMs: counters.slowestMs,
    lastRequestSecondsAgo: counters.lastRequestAt ? Math.round((Date.now() - counters.lastRequestAt) / 1000) : null,
    memoryMb: Math.round(memory.rss / 1024 / 1024),
    heapMb: Math.round(memory.heapUsed / 1024 / 1024),
    nodeVersion: process.version,
    backups: tailBackups(8),
  };
}
