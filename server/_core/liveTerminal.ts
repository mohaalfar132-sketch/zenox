import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Live owner terminal: one shell session that streams its output as it happens
 * and remembers the directory the previous command left it in. There is no
 * command allow-list — the owner controls the machine — so every entry point
 * that reaches this module must be owner-authenticated first.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.ZENOX_TERMINAL_TIMEOUT_MS ?? 600_000);
// A runaway command can print forever; the browser only needs the tail.
const MAX_STREAM_CHARS = 600_000;

let cwd = process.cwd();
const running = new Set<ChildProcess>();

export type TerminalEvent =
  | { type: "chunk"; stream: "stdout" | "stderr"; text: string }
  | { type: "error"; message: string };

export type TerminalResult = {
  code: number | null;
  cwd: string;
  durationMs: number;
  truncated: boolean;
};

export function terminalCwd(): string {
  return cwd;
}

/** Used by the stop button and when a client disconnects mid-command. */
export function stopTerminals(): void {
  for (const child of running) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  running.clear();
}

function applyCd(raw: string): string | null {
  const target = raw.trim().replace(/^~$/, process.env.HOME ?? "/");
  if (!target) return process.env.HOME ?? cwd;
  const next = resolve(cwd, target);
  return next;
}

/**
 * `cd` is resolved here instead of in a subshell, because a subshell would lose
 * the new directory the moment the command exits.
 */
function runCd(raw: string, onEvent: (event: TerminalEvent) => void, startedAt: number): Promise<TerminalResult> {
  return Promise.resolve().then(() => {
    const target = applyCd(raw);
    if (!target) {
      onEvent({ type: "chunk", stream: "stderr", text: "cd: مسار غير صالح\n" });
      return { code: 1, cwd, durationMs: Date.now() - startedAt, truncated: false };
    }
    try {
      process.chdir(target);
      cwd = process.cwd();
      onEvent({ type: "chunk", stream: "stdout", text: `${cwd}\n` });
      return { code: 0, cwd, durationMs: Date.now() - startedAt, truncated: false };
    } catch {
      onEvent({ type: "chunk", stream: "stderr", text: `cd: لا يوجد مجلد بهذا المسار: ${target}\n` });
      return { code: 1, cwd, durationMs: Date.now() - startedAt, truncated: false };
    }
  });
}

export function runTerminalCommand(
  command: string,
  onEvent: (event: TerminalEvent) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): { done: Promise<TerminalResult>; stop: () => void } {
  const startedAt = Date.now();
  const text = command.trim();

  const cdMatch = /^cd(?:\s+([\s\S]*))?$/.exec(text);
  if (cdMatch) {
    return { done: runCd(cdMatch[1] ?? "", onEvent, startedAt), stop: () => undefined };
  }

  let child: ChildProcess;
  try {
    child = spawn("bash", ["-lc", text], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    onEvent({ type: "error", message: error instanceof Error ? error.message : "تعذر تشغيل الأمر" });
    return {
      done: Promise.resolve({ code: 1, cwd, durationMs: Date.now() - startedAt, truncated: false }),
      stop: () => undefined,
    };
  }

  running.add(child);
  let sent = 0;
  let truncated = false;
  let finished = false;

  const push = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!text) return;
    if (sent >= MAX_STREAM_CHARS) {
      truncated = true;
      return;
    }
    const room = MAX_STREAM_CHARS - sent;
    const part = text.length > room ? text.slice(0, room) : text;
    sent += part.length;
    if (part.length < text.length) truncated = true;
    onEvent({ type: "chunk", stream, text: part });
  };

  child.stdout?.on("data", (chunk: Buffer) => push("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => push("stderr", chunk));

  const timer = setTimeout(() => {
    onEvent({ type: "error", message: `تجاوز الأمر المهلة (${Math.round(timeoutMs / 1000)} ثانية) وأُوقف.` });
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, timeoutMs);

  const done = new Promise<TerminalResult>((resolveResult) => {
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      running.delete(child);
      if (truncated) {
        onEvent({ type: "chunk", stream: "stderr", text: "\n… [الإخراج أطول من المسموح؛ عُرض الجزء الأول فقط]\n" });
      }
      resolveResult({ code, cwd, durationMs: Date.now() - startedAt, truncated });
    };
    child.on("error", (error) => {
      onEvent({ type: "error", message: error.message });
      finish(1);
    });
    child.on("exit", (code) => finish(code));
    child.on("close", (code) => finish(code));
  });

  return {
    done,
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
}

/** Exposed for tests: the directory a new session starts from. */
export function resetTerminalCwd(next = process.cwd()): string {
  cwd = next;
  return cwd;
}

/**
 * Every owner command is written to a local audit trail (no output, no secrets),
 * so an unexpected change can always be traced back to the command that did it.
 */
export function logTerminalCommand(command: string, code: number | null, durationMs: number): void {
  const dir = (process.env.ZENOX_DATA_DIR || "").trim() || process.cwd();
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "terminal-audit.jsonl");
    try {
      if (statSync(file).size > 5_000_000) truncateSync(file, 0);
    } catch {
      // New file.
    }
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), command: command.slice(0, 2000), code, durationMs })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Auditing must never break the command itself.
  }
}
