import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOwnerTool } from "../server/_core/ownerTools";
import { createOrderStore } from "../server/_core/orderStore";

let dir = "";
const previous = process.env.ZENOX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenox-report-"));
  process.env.ZENOX_DATA_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ZENOX_DATA_DIR;
  else process.env.ZENOX_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("«سجل الأوامر» tool", () => {
  it("says plainly when nothing has been stored", async () => {
    const result = await runOwnerTool("orders_report");
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("لا يوجد أمر محفوظ");
    expect(result.data).toMatchObject({ count: 0, orders: [] });
  });

  it("lists the stored orders, newest first, from disk", async () => {
    const store = createOrderStore(join(dir, "owner-orders.json"));
    store.remember("order-old", "نُفّذ: pnpm test (exit 0)", "command");
    store.remember("order-new", "ظهر شريط على المنصة", "banner-on");

    const result = await runOwnerTool("orders_report");
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("2 أمر محفوظ");
    expect(result.summary).toContain("pnpm test");
    expect(result.summary).toContain("ظهر شريط");
    const data = result.data as { count: number; orders: Array<{ id: string; action?: string }>; file: string };
    expect(data.count).toBe(2);
    expect(data.orders.map((order) => order.id).sort()).toEqual(["order-new", "order-old"]);
    expect(data.file).toBe(join(dir, "owner-orders.json"));
  });

  it("ignores orders older than the ten-minute window", async () => {
    const now = Date.now();
    writeFileSync(
      join(dir, "owner-orders.json"),
      JSON.stringify({
        fresh: { at: now - 1_000, summary: "نُفّذ الآن", action: "command" },
        expired: { at: now - 11 * 60_000, summary: "قديم", action: "command" },
      }),
    );
    const result = await runOwnerTool("orders_report");
    const data = result.data as { orders: Array<{ id: string }> };
    expect(data.orders.map((order) => order.id)).toEqual(["fresh"]);
  });
});
