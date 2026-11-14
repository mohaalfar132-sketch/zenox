import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_MODES, isChatMode, modeLabel, modeSystem } from "../server/_core/chatModes";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("every mode is a real persona", () => {
  it("covers the chips the app shows", () => {
    for (const id of ["general", "emotional", "debate", "medical", "study", "code", "live"] as const) {
      expect(isChatMode(id)).toBe(true);
      expect(modeLabel(id).length).toBeGreaterThan(2);
    }
  });

  it("gives each mode its own instructions", () => {
    const systems = Object.values(CHAT_MODES).map((mode) => mode.system);
    expect(new Set(systems).size).toBe(systems.length);
    expect(modeSystem("debate")).toContain("جدلي");
    expect(modeSystem("medical")).toContain("طبيب");
    expect(modeSystem("code")).toContain("مهندس برمجيات");
    expect(modeSystem("live")).toContain("صوتية");
  });

  it("falls back safely for an unknown mode", () => {
    expect(modeSystem("nonsense")).toBe(CHAT_MODES.general.system);
  });

  it("is actually wired into both chat paths", () => {
    expect(read("server/routers.ts")).toContain("modeSystem(input.mode)");
    expect(read("server/_core/index.ts")).toContain("modeSystem(mode)");
  });
});
