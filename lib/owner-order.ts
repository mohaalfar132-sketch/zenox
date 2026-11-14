/**
 * One owner order → the console endpoint, with an id and retries.
 *
 * The id makes the server idempotent: if the stream drops after the order ran,
 * the retry returns the stored result instead of running it again. This module
 * is separate from the screen so the behaviour is testable without a browser.
 */

export type OrderEvent = {
  type?: string;
  kind?: string;
  command?: string;
  summary?: string;
  text?: string;
  message?: string;
  stream?: string;
  code?: number | null;
  durationMs?: number;
  ok?: boolean;
};

export type OrderHandlers = {
  onAsk?: (request: string) => void;
  onPlan?: (event: OrderEvent) => void;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  onResult?: (summary: string, cached: boolean) => void;
  onError?: (message: string) => void;
  onRetry?: (attempt: number, reason: string) => void;
};

export type OrderOptions = {
  fetchImpl?: typeof fetch;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  endpoint?: string;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseFrames(buffer: string, onEvent: (event: OrderEvent) => void): string {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
    if (!line) continue;
    try {
      onEvent(JSON.parse(line.slice(5).trim()) as OrderEvent);
    } catch {
      // keep-alive or partial frame
    }
  }
  return rest;
}

/** Sends an order; retries with the same id when the connection drops. */
export async function sendOwnerOrder(
  request: string,
  handlers: OrderHandlers = {},
  options: OrderOptions = {},
): Promise<{ ok: boolean; cached: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? defaultSleep;
  const endpoint = options.endpoint ?? "/api/owner/exec-intent";
  const id = (options.newId ?? (() => `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))();

  handlers.onAsk?.(request);

  let lastError = "تعذر التنفيذ.";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) handlers.onRetry?.(attempt, lastError);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text: request, id }),
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null;
        // A 4xx answer is final: retrying cannot fix a rejected order.
        if (response.status >= 400 && response.status < 500) {
          handlers.onError?.(detail?.message ?? `تعذر التنفيذ (${response.status}).`);
          return { ok: false, cached: false };
        }
        throw new Error(detail?.message ?? `تعذر التنفيذ (${response.status}).`);
      }

      // A repeated id answers with JSON, not a stream.
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const done = (await response.json()) as { summary?: string; cached?: boolean; ok?: boolean };
        handlers.onResult?.(done.summary ?? "نُفّذ سابقًا", Boolean(done.cached));
        return { ok: done.ok !== false, cached: Boolean(done.cached) };
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("لا يوجد بثّ من الخادم.");
      const decoder = new TextDecoder();
      let buffer = "";
      let sawResult = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseFrames(buffer, (event) => {
          if (event.type === "plan") handlers.onPlan?.(event);
          if (event.type === "chunk") handlers.onOutput?.(event.stream === "stderr" ? "stderr" : "stdout", event.text ?? "");
          if (event.type === "result") {
            handlers.onResult?.(event.summary ?? "تم", false);
            sawResult = true;
          }
          if (event.type === "error") {
            handlers.onError?.(event.message ?? "خطأ");
            sawResult = true;
          }
          if (event.type === "exit") sawResult = true;
        });
      }

      if (!sawResult) throw new Error("انقطع الاتصال قبل وصول النتيجة.");
      return { ok: true, cached: false };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "انقطع الاتصال.";
      if (attempt === attempts) {
        handlers.onError?.(lastError);
        return { ok: false, cached: false };
      }
      await sleep(400 * attempt);
    }
  }

  return { ok: false, cached: false };
}
