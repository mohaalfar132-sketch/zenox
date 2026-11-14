import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// workspaceRoot() reads this, so each test gets its own throwaway project.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenox-ws-"));
  process.env.ZENOX_WORKSPACE = dir;
});

afterEach(() => {
  delete process.env.ZENOX_WORKSPACE;
});

async function api() {
  return import("../server/workspace-files");
}

describe("owner file editing", () => {
  it("creates a new file and reports it as new", async () => {
    const { writeWorkspaceFile, readWorkspaceFile } = await api();
    const saved = writeWorkspaceFile({ path: "notes/today.txt", content: "مرحبًا" });
    expect(saved.created).toBe(true);
    expect(saved.backup).toBeNull();
    expect(readWorkspaceFile("notes/today.txt").content).toBe("مرحبًا");
  });

  it("keeps a backup of the previous content before overwriting", async () => {
    const { writeWorkspaceFile } = await api();
    writeFileSync(join(dir, "app.ts"), "old");
    const saved = writeWorkspaceFile({ path: "app.ts", content: "new" });
    expect(saved.created).toBe(false);
    expect(saved.backup).toBeTruthy();
    expect(readFileSync(join(dir, saved.backup!), "utf8")).toBe("old");
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("new");
  });

  it("prunes old backups so they cannot grow without bound", async () => {
    const { writeWorkspaceFile } = await api();
    for (let i = 0; i < 45; i += 1) writeWorkspaceFile({ path: "same.txt", content: `v${i}` });
    const backups = readdirSync(join(dir, ".zenox-backups"));
    expect(backups.length).toBeLessThanOrEqual(40);
  });

  it("refuses paths outside the project", async () => {
    const { writeWorkspaceFile } = await api();
    expect(() => writeWorkspaceFile({ path: "../escape.txt", content: "x" })).toThrow();
    expect(() => writeWorkspaceFile({ path: "/etc/passwd", content: "x" })).toThrow();
  });

  it("refuses generated or dependency folders", async () => {
    const { writeWorkspaceFile } = await api();
    for (const path of ["node_modules/pkg/index.js", "dist/index.js", ".git/config"]) {
      expect(() => writeWorkspaceFile({ path, content: "x" })).toThrow();
    }
  });

  it("caps the size of an edit", async () => {
    const { writeWorkspaceFile } = await api();
    expect(() => writeWorkspaceFile({ path: "big.txt", content: "x".repeat(300_001) })).toThrow();
  });
});
