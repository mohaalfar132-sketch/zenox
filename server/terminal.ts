import { exec } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUTPUT_LIMIT = Number(process.env.ZENOX_TERMINAL_OUTPUT_LIMIT ?? 2_000_000);
const DEFAULT_TIMEOUT_MS = Number(process.env.ZENOX_TERMINAL_TIMEOUT_MS ?? 600_000);

export type ShellResult = {
  code: number;
  stdout: string;
  stderr: string;
  cwd: string;
  durationMs: number;
  truncated: boolean;
};

export function workspaceRoot() {
  const configured = process.env.ZENOX_WORKSPACE?.trim();
  if (configured && existsSync(configured)) return resolve(configured);
  return process.cwd();
}

function clip(value: string) {
  if (value.length <= OUTPUT_LIMIT) return { value, truncated: false };
  return { value: value.slice(-OUTPUT_LIMIT), truncated: true };
}

/**
 * Owner-only shell. Runs inside the project workspace by default.
 * There is no command allow-list: the owner controls the machine. Access is
 * gated by the owner session in the tRPC layer, so this must never be public.
 */
export function runShell(command: string, cwd?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ShellResult> {
  const root = workspaceRoot();
  const target = cwd?.trim() ? resolve(root, cwd.trim()) : root;
  const startedAt = Date.now();

  return new Promise((resolveResult) => {
    exec(
      command,
      {
        cwd: target,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        shell: "/bin/bash",
        env: { ...process.env, CI: "1", FORCE_COLOR: "0", PAGER: "cat" },
      },
      (error, stdout, stderr) => {
        const out = clip(String(stdout ?? ""));
        const err = clip(String(stderr ?? ""));
        const exitCode = error && typeof (error as { code?: unknown }).code === "number"
          ? Number((error as { code?: number }).code)
          : error
            ? 1
            : 0;
        resolveResult({
          code: exitCode,
          stdout: out.value,
          stderr: err.value,
          cwd: target,
          durationMs: Date.now() - startedAt,
          truncated: out.truncated || err.truncated,
        });
      },
    );
  });
}

/** Applies a unified diff to the workspace with `git apply`, checking first. */
export async function applyPatchToWorkspace(patch: string, requestId: number): Promise<ShellResult & { ok: boolean }> {
  const file = join(workspaceRoot(), `.zenox-${requestId}.patch`);
  writeFileSync(file, patch, "utf8");
  const check = await runShell(`git apply --check --whitespace=nowarn ${JSON.stringify(file)}`);
  if (check.code !== 0) {
    try { unlinkSync(file); } catch { /* already gone */ }
    return { ...check, ok: false };
  }
  const applied = await runShell(`git apply --whitespace=nowarn ${JSON.stringify(file)}`);
  try { unlinkSync(file); } catch { /* already gone */ }
  return { ...applied, ok: applied.code === 0 };
}
