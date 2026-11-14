import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Owner orders that already ran, kept on disk so a restart cannot make the same
 * order run a second time. Each entry holds the id the console sent, when it
 * ran and the result it produced.
 */
export type StoredOrder = { at: number; summary: string; action?: string };

export type OrderRecord = StoredOrder & { id: string };

export type OrderStore = {
  get: (id: string) => StoredOrder | undefined;
  list: (limit?: number) => OrderRecord[];
  remember: (id: string, summary: string, action?: string) => void;
  size: () => number;
  file: string;
};

export const ORDER_TTL_MS = 10 * 60_000;
const MAX_ORDERS = 500;

export function ownerOrderFile() {
  const root = (process.env.ZENOX_DATA_DIR || "").trim() || process.cwd();
  return join(root, "owner-orders.json");
}

function readFile(file: string): Record<string, StoredOrder> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: Record<string, StoredOrder> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { at?: unknown; summary?: unknown; action?: unknown };
      const at = Number(entry.at);
      if (!Number.isFinite(at) || typeof entry.summary !== "string") continue;
      clean[id] = {
        at,
        summary: entry.summary.slice(0, 500),
        action: typeof entry.action === "string" ? entry.action.slice(0, 40) : undefined,
      };
    }
    return clean;
  } catch {
    // A missing or unreadable file simply means no orders have run yet.
    return {};
  }
}

function writeFile(file: string, orders: Record<string, StoredOrder>) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(orders), { mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // Never fail an owner order because the bookkeeping could not be written.
  }
}

export function createOrderStore(file = ownerOrderFile(), ttlMs = ORDER_TTL_MS): OrderStore {
  const now = Date.now();
  const orders = Object.fromEntries(
    Object.entries(readFile(file)).filter(([, value]) => now - value.at <= ttlMs),
  ) as Record<string, StoredOrder>;

  const prune = () => {
    const cut = Date.now() - ttlMs;
    for (const [id, value] of Object.entries(orders)) if (value.at <= cut) delete orders[id];
    const ids = Object.keys(orders);
    if (ids.length > MAX_ORDERS) {
      for (const id of ids.sort((a, b) => orders[a].at - orders[b].at).slice(0, ids.length - MAX_ORDERS)) delete orders[id];
    }
  };

  return {
    file,
    get: (id: string) => {
      const entry = orders[id];
      if (!entry) return undefined;
      if (Date.now() - entry.at > ttlMs) {
        delete orders[id];
        writeFile(file, orders);
        return undefined;
      }
      return entry;
    },
    remember: (id: string, summary: string, action?: string) => {
      if (!id) return;
      orders[id] = { at: Date.now(), summary: summary.slice(0, 500), action };
      prune();
      writeFile(file, orders);
    },
    list: (limit = 10) => {
      prune();
      return Object.entries(orders)
        .map(([id, entry]) => ({ id, ...entry }))
        .sort((a, b) => b.at - a.at)
        .slice(0, Math.max(1, limit));
    },
    size: () => Object.keys(orders).length,
  };
}
