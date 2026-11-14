import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetTerminalCwd, runTerminalCommand, stopTerminals, terminalCwd } from "../server/_core/liveTerminal";

const original = process.cwd();

afterEach(() => {
  resetTerminalCwd(original);
  process.chdir(original);
});

function collect(command: string) {
  const chunks: string[] = [];
  const errors: string[] = [];
  const run = runTerminalCommand(command, (event) => {
    if (event.type === "chunk") chunks.push(event.text);
    else errors.push(event.message);
  });
  return { run, chunks, errors };
}

describe("live owner terminal", () => {
  it("streams stdout as the command prints", async () => {
    const { run, chunks } = collect("printf 'one\\ntwo\\n'");
    const result = await run.done;
    expect(result.code).toBe(0);
    expect(chunks.join("")).toContain("one");
    expect(chunks.join("")).toContain("two");
  });

  it("reports a failing command with its exit code and stderr", async () => {
    const { run, chunks } = collect("printf 'boom\\n' >&2; exit 7");
    const result = await run.done;
    expect(result.code).toBe(7);
    expect(chunks.join("")).toContain("boom");
  });

  it("keeps the directory after cd for the next command", async () => {
    const target = mkdtempSync(join(tmpdir(), "zenox-term-"));
    const cd = runTerminalCommand(`cd ${target}`, () => undefined);
    await cd.done;
    expect(terminalCwd()).toBe(target);

    const printed: string[] = [];
    const probe = runTerminalCommand("pwd", (event) => {
      if (event.type === "chunk") printed.push(event.text);
    });
    await probe.done;
    expect(printed.join("").trim()).toBe(target);
  });

  it("stops a long-running command", async () => {
    const started = Date.now();
    const run = runTerminalCommand("sleep 30", () => undefined);
    setTimeout(() => stopTerminals(), 50);
    const result = await run.done;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.code === null || result.code !== 0).toBe(true);
  });
});
