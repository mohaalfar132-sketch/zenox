import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOrderStore, ownerOrderFile } from "../server/_core/orderStore";

let dir = "";
const store = (file: string, ttlMs?: number) => createOrderStore(file, ttlMs);

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("owner order ids persist across a restart", () => {
  it("finds the order again from a new store on the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "zenox-orders-"));
    const file = join(dir, "owner-orders.json");

    const before = store(file);
    expect(before.get("order-1")).toBeUndefined();
    before.remember("order-1", "نُفّذ: pnpm test (exit 0)", "command");

    // A fresh process reads the same file: the id is still known.
    const after = store(file);
    expect(after.get("order-1")).toEqual({ at: expect.any(Number), summary: "نُفّذ: pnpm test (exit 0)", action: "command" });
    expect(after.size()).toBe(1);
  });

  it("remembers site orders too, with their action", () => {
    dir = mkdtempSync(join(tmpdir(), "zenox-orders-"));
    const file = join(dir, "owner-orders.json");
    store(file).remember("banner-1", "ظهر شريط على المنصة", "banner-on");
    expect(store(file).get("banner-1")?.action).toBe("banner-on");
  });

  it("drops an order once its window has passed", () => {
    dir = mkdtempSync(join(tmpdir(), "zenox-orders-"));
    const file = join(dir, "owner-orders.json");
    const old = Date.now() - 11 * 60_000;
    writeFileSync(file, JSON.stringify({ stale: { at: old, summary: "قديم" } }));
    const reopened = store(file);
    expect(reopened.get("stale")).toBeUndefined();
    expect(reopened.size()).toBe(0);
  });

  it("survives a corrupt file instead of failing the order", () => {
    dir = mkdtempSync(join(tmpdir(), "zenox-orders-"));
    const file = join(dir, "owner-orders.json");
    writeFileSync(file, "{not json");
    const opened = store(file);
    expect(opened.get("anything")).toBeUndefined();
    opened.remember("fresh", "تم");
    expect(JSON.parse(readFileSync(file, "utf8")).fresh.summary).toBe("تم");
  });

  it("lists the newest orders first for the monitoring panel", () => {
    dir = mkdtempSync(join(tmpdir(), "zenox-orders-"));
    const file = join(dir, "owner-orders.json");
    const now = Date.now();
    writeFileSync(
      file,
      JSON.stringify({
        older: { at: now - 5_000, summary: "الأول", action: "command" },
        newest: { at: now - 1_000, summary: "الثاني", action: "banner-on" },
      }),
    );
    const listed = store(file).list(1);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "newest", summary: "الثاني", action: "banner-on" });
    expect(store(file).list(10).map((entry) => entry.id)).toEqual(["newest", "older"]);
  });

  it("keeps the file under the data directory", () => {
    const previous = process.env.ZENOX_DATA_DIR;
    process.env.ZENOX_DATA_DIR = "/tmp/zenox-orders-check";
    expect(ownerOrderFile()).toBe("/tmp/zenox-orders-check/owner-orders.json");
    if (previous === undefined) delete process.env.ZENOX_DATA_DIR;
    else process.env.ZENOX_DATA_DIR = previous;
  });
});
