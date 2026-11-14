import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { editFile, listDir, runCommand, searchCode } from "../server/_core/agentWorkspace";
import { addMemory, clearMemory, deleteMemory, listMemory, memoryPrompt } from "../server/_core/agentMemory";

describe("owner agent tools", () => {
  it("finds code with line numbers", () => {
    const result = searchCode({ query: "runOwnerAgent", maxResults: 5, only: "server/" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((hit) => hit.path.includes("ownerAgent"))).toBe(true);
    expect(result.hits[0].line).toBeGreaterThan(0);
  });

  it("refuses a path outside the project", () => {
    expect(() => listDir({ path: "../../etc" })).toThrow();
    expect(() => editFile({ path: "/etc/passwd", find: "root", replace: "x" })).toThrow();
  });

  it("edits exactly the requested text and keeps the rest", () => {
    const path = `tests/tmp-edit-${Date.now()}.txt`;
    writeFileSync(path, "أول\nثاني\nثالث\n");
    const result = editFile({ path, find: "ثاني", replace: "معدّل" });
    expect(result.replaced).toBe(1);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("معدّل");
    expect(text).toContain("أول");
    expect(text).toContain("ثالث");
    rmSync(path, { force: true });
  });

  it("refuses an ambiguous edit", () => {
    const path = `tests/tmp-edit-dup-${Date.now()}.txt`;
    writeFileSync(path, "س\nس\n");
    expect(() => editFile({ path, find: "س", replace: "ص" })).toThrow();
    expect(editFile({ path, find: "س", replace: "ص", all: true }).replaced).toBe(2);
    rmSync(path, { force: true });
  });

  it("runs any owner command, including destructive ones", async () => {
    // The owner removed the restrictions: a delete must actually delete.
    const dir = `tests/tmp-rm-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.txt"), "x");
    const result = await runCommand({ command: `rm -rf ${dir}` });
    expect(result.code).toBe(0);
    expect(existsSync(dir)).toBe(false);

    const echo = await runCommand({ command: "echo zenox-ok" });
    expect(echo.output).toContain("zenox-ok");
  });
});

describe("assistant memory", () => {
  beforeEach(() => {
    process.env.ZENOX_AGENT_MEMORY = join(mkdtempSync(join(tmpdir(), "zenox-mem-")), "memory.json");
    clearMemory();
  });

  it("stores a note once and injects it into the prompt", () => {
    addMemory("المالك يفضّل العربية المصرية");
    addMemory("المالك يفضّل العربية المصرية");
    expect(listMemory()).toHaveLength(1);
    expect(memoryPrompt()).toContain("المصرية");
  });

  it("deletes a note on request", () => {
    const item = addMemory("ملاحظة للحذف");
    expect(deleteMemory(item.id).removed).toBe(1);
    expect(listMemory()).toHaveLength(0);
    expect(existsSync(process.env.ZENOX_AGENT_MEMORY!)).toBe(true);
  });
});
