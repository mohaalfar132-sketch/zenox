import { describe, expect, it, vi } from "vitest";
import { sendOwnerOrder } from "../lib/owner-order";

function sse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("owner order transport", () => {
  it("sends an id with the order and reports the applied action", async () => {
    const fetchImpl = vi.fn(async () =>
      sse([
        { type: "plan", kind: "site", action: "banner-on", summary: "ظهر شريط" },
        { type: "result", ok: true, summary: "ظهر شريط" },
        { type: "exit", code: 0, durationMs: 0 },
      ]),
    );
    const results: string[] = [];
    const outcome = await sendOwnerOrder(
      "أظهر إعلان تحذير",
      { onResult: (summary) => results.push(summary) },
      { fetchImpl: fetchImpl as unknown as typeof fetch, newId: () => "fixed-id" },
    );
    expect(outcome.ok).toBe(true);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.id).toBe("fixed-id");
    expect(body.text).toBe("أظهر إعلان تحذير");
    expect(results).toEqual(["ظهر شريط"]);
  });

  it("retries a dropped stream with the same id and succeeds", async () => {
    const dropped = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"chunk","text":"جزء"}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(dropped)
      .mockResolvedValueOnce(sse([{ type: "result", ok: true, summary: "تم" }]));
    const retries: number[] = [];
    const outcome = await sendOwnerOrder(
      "شغّل الاختبارات",
      { onRetry: (attempt) => retries.push(attempt) },
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, newId: () => "same-id" },
    );
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([2]);
    const ids = fetchImpl.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).id);
    expect(ids).toEqual(["same-id", "same-id"]);
  });

  it("accepts a cached JSON answer without re-running", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, cached: true, summary: "نُفّذ سابقًا" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const seen: Array<{ summary: string; cached: boolean }> = [];
    const outcome = await sendOwnerOrder(
      "أخف إعلان المنصة",
      { onResult: (summary, cached) => seen.push({ summary, cached }) },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(outcome.cached).toBe(true);
    expect(seen[0].cached).toBe(true);
  });

  it("gives up after the allowed attempts and reports why", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const errors: string[] = [];
    const outcome = await sendOwnerOrder(
      "اعرض الملفات",
      { onError: (message) => errors.push(message) },
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, attempts: 3 },
    );
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(errors[0]).toContain("network down");
  });

  it("does not retry a rejected order", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: "هذا الإجراء للمالك فقط." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    const outcome = await sendOwnerOrder("pwd", {}, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
