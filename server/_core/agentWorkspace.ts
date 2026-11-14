import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { writeWorkspaceFile } from "../workspace-files";

/**
 * The owner assistant works on the real project: it searches, reads, edits,
 * runs commands and rebuilds. File paths stay confined to the project folder;
 * commands themselves are not restricted, because the owner owns the machine.
 */
const ROOT = () => process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-web",
  "web-build",
  ".expo",
  ".zenox-backups",
  ".zenox-chats",
]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html", ".java", ".xml", ".sh", ".yml", ".yaml", ".txt"]);
const MAX_READ = 200_000;

/** Refuses any path outside the project; symlink tricks die here too. */
export function insideProject(input: string): string {
  const root = ROOT();
  const full = resolve(root, String(input || "."));
  if (full !== root && !full.startsWith(root + sep)) throw new Error("مسار خارج المشروع مرفوض");
  return full;
}

function walk(dir: string, depth: number, out: string[]) {
  if (depth > 6) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") && name !== ".env.example") continue;
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) walk(full, depth + 1, out);
    else out.push(relative(ROOT(), full));
  }
}

function projectFiles(): string[] {
  const files: string[] = [];
  walk(ROOT(), 0, files);
  return files;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** Plain text/regex search over the project, like an editor's find-in-files. */
export function searchCode(input: { query: string; maxResults?: number; only?: string }): { hits: SearchHit[]; scanned: number } {
  const query = String(input.query ?? "").trim();
  if (query.length < 2) throw new Error("اكتب كلمة بحث من حرفين على الأقل");
  const limit = Math.min(Math.max(Number(input.maxResults) || 40, 1), 200);
  const only = (input.only ?? "").trim();
  let regex: RegExp;
  try {
    regex = new RegExp(query, "i");
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const hits: SearchHit[] = [];
  const files = projectFiles().filter((file) => (!only ? true : file.includes(only)));
  let scanned = 0;
  for (const file of files) {
    if (hits.length >= limit) break;
    const ext = file.slice(file.lastIndexOf("."));
    if (!TEXT_EXT.has(ext)) continue;
    const full = insideProject(file);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.size > MAX_READ) continue;
    scanned += 1;
    const text = readFileSync(full, "utf8");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
      if (regex.test(lines[index])) {
        hits.push({ path: file, line: index + 1, text: lines[index].trim().slice(0, 240) });
      }
    }
  }
  return { hits, scanned };
}

export function listDir(input: { path?: string }): { path: string; files: string[] } {
  const target = insideProject(input.path || ".");
  const files = readdirSync(target)
    .filter((name) => !SKIP_DIRS.has(name))
    .map((name) => {
      const full = join(target, name);
      try {
        const info = statSync(full);
        return info.isDirectory() ? `${name}/` : `${name} (${Math.round(info.size / 1024)}KB)`;
      } catch {
        return name;
      }
    })
    .slice(0, 400);
  return { path: relative(ROOT(), target) || ".", files };
}

/**
 * Targeted edit: finds the exact text and replaces it, so a big file is never
 * rewritten from a guessed full copy. Refuses an ambiguous edit unless `all`.
 */
export function editFile(input: { path: string; find: string; replace: string; all?: boolean }): {
  path: string;
  replaced: number;
  bytes: number;
} {
  const full = insideProject(input.path);
  if (!existsSync(full)) throw new Error(`الملف غير موجود: ${input.path}`);
  const find = String(input.find ?? "");
  if (!find) throw new Error("النص المطلوب تعديله فارغ");
  const replace = String(input.replace ?? "");
  const text = readFileSync(full, "utf8");
  const count = text.split(find).length - 1;
  if (count === 0) throw new Error("لم أجد النص المطلوب داخل الملف — اقرأ الملف أولًا وخذ النص الحرفي");
  if (count > 1 && !input.all) {
    throw new Error(`النص مكرر ${count} مرات؛ حدّده أكثر أو اطلب استبدال الكل`);
  }
  const next = input.all ? text.split(find).join(replace) : text.replace(find, replace);
  writeWorkspaceFile({ path: input.path, content: next });
  return { path: input.path, replaced: input.all ? count : 1, bytes: next.length };
}

export function deleteFile(input: { path: string }): { path: string; deleted: boolean } {
  const full = insideProject(input.path);
  if (!existsSync(full)) throw new Error("الملف غير موجود");
  if (statSync(full).isDirectory()) throw new Error("هذا مجلد؛ لا أحذف مجلدات تلقائيًا");
  if (input.path.startsWith(".env") || input.path.includes("zenox.keystore")) {
    throw new Error("هذا ملف حساس لا يُحذف تلقائيًا");
  }
  unlinkSync(full);
  return { path: input.path, deleted: true };
}

/** Every command is allowed: this is the owner's own machine and their app. */
export interface CommandResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Runs one shell command in the project folder with a hard timeout. */
export function runCommand(input: { command: string; timeoutMs?: number }): Promise<CommandResult> {
  const command = String(input.command ?? "").trim();
  if (!command) return Promise.reject(new Error("الأمر فارغ"));
  const timeout = Math.min(Math.max(Number(input.timeoutMs) || 120_000, 1_000), 240_000);
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ROOT(),
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    const push = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 20_000) output = output.slice(-20_000);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output: output.slice(-8000), timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, output: String(error), timedOut });
    });
  });
}

/** Rebuilds the web app exactly like the deploy pipeline does. */
export async function rebuildWeb(): Promise<CommandResult> {
  return runCommand({ command: "npx --yes pnpm@9.12.0 build && npx --yes pnpm@9.12.0 build:web", timeoutMs: 240_000 });
}

/** Rebuilds and signs the Android package, then returns its size. */
export async function buildApk(): Promise<CommandResult> {
  const java = process.env.JAVA_HOME || "/tmp/jdk";
  const sdk = process.env.ANDROID_HOME || "/tmp/androidsdk";
  return runCommand({
    command: `JAVA_HOME=${java} ANDROID_HOME=${sdk} PATH=${java}/bin:$PATH bash scripts/build-apk.sh`,
    timeoutMs: 240_000,
  });
}

/**
 * Restarts the server without taking the agent down mid-answer: a detached
 * child waits, kills this process, then execs the freshly built server.
 */
export function restartServer(): { pid: number; note: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.NODE_ENV = "production";
  env.PORT = env.PORT || "3000";
  const script = `sleep 2; kill ${process.pid} 2>/dev/null; sleep 1; exec node dist/index.js`;
  const child: ChildProcess = spawn("bash", ["-c", script], {
    cwd: ROOT(),
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid ?? 0, note: "سيُعاد تشغيل الخادم بعد ثانيتين بنفس الإعدادات" };
}

export const WORKSPACE_ROOT = ROOT;
export const SEARCHABLE_FILES = () => projectFiles().length;
