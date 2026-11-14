import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = [
  { id: 1, label: "recovering", provider: "groq", baseUrl: "", model: "", apiKey: "good", enabled: 1, status: "failing" },
  { id: 2, label: "broken", provider: "groq", baseUrl: "", model: "", apiKey: "bad", enabled: 1, status: "ok" },
  { id: 3, label: "disabled", provider: "groq", baseUrl: "", model: "", apiKey: "bad", enabled: 0, status: "failing" },
];

vi.mock("../server/db", () => ({
  listLlmKeys: vi.fn(async () => rows),
  setLlmKeyHealth: vi.fn(async (_id: number, _status: string, _error: string | null) => undefined),
}));

vi.mock("../server/_core/llm", () => ({
  invalidateLlmKeyCache: vi.fn(),
  probeLlmKey: vi.fn(async ({ apiKey }: { apiKey: string }) =>
    apiKey === "good" ? { ok: true, error: "" } : { ok: false, error: "401 Unauthorized" },
  ),
}));

describe("hourly key health sweep", () => {
  beforeEach(async () => {
    const db = await import("../server/db");
    vi.mocked(db.setLlmKeyHealth).mockClear();
  });

  it("restores a recovered key and keeps a broken one out", async () => {
    const { runLlmKeyHealthCheck } = await import("../server/_core/llmHealth");
    const db = await import("../server/db");
    const summary = await runLlmKeyHealthCheck();

    expect(summary).toEqual({ checked: 2, recovered: 1, failing: 1 });
    expect(db.setLlmKeyHealth).toHaveBeenCalledWith(1, "ok", null);
    expect(db.setLlmKeyHealth).toHaveBeenCalledWith(2, "failing", "401 Unauthorized");
    // Disabled keys are never probed.
    expect(db.setLlmKeyHealth).not.toHaveBeenCalledWith(3, expect.anything(), expect.anything());
  });

  it("never overlaps two sweeps", async () => {
    const { runLlmKeyHealthCheck } = await import("../server/_core/llmHealth");
    const [a, b] = await Promise.all([runLlmKeyHealthCheck(), runLlmKeyHealthCheck()]);
    expect([a.checked, b.checked].sort()).toEqual([0, 2]);
  });
});
