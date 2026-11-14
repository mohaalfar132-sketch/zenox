import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { workspaceRoot } from "./terminal";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-web", "web-build", ".expo", ".webdev", "import", ".cache"]);
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 400_000;

const WRITE_DENY_DIRS = new Set(["node_modules", ".git", "dist", "dist-web", "web-build", ".expo"]);
const MAX_WRITE_BYTES = 300_000;
const BACKUP_DIR = ".zenox-backups";
const KEEP_BACKUPS = 40;

export type WorkspaceEntry = {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  children?: WorkspaceEntry[];
};

function safeTarget(input?: string) {
  const root = workspaceRoot();
  const target = resolve(root, input?.trim() ? input.trim() : ".");
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المسار خارج مساحة المشروع." });
  }
  return { root, target };
}

/** Project structure for the owner: depth-limited, without dependencies or build output. */
export function listWorkspaceTree(input: { path?: string; depth?: number } = {}): {
  root: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
} {
  const { root, target } = safeTarget(input.path);
  const maxDepth = Math.min(Math.max(input.depth ?? 2, 1), 6);
  let count = 0;

  function walk(dir: string, depth: number): WorkspaceEntry[] {
    if (depth > maxDepth || count >= MAX_ENTRIES) return [];
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries: WorkspaceEntry[] = [];
    for (const item of items) {
      if (count >= MAX_ENTRIES) break;
      const name = String(item.name);
      if (name.startsWith(".zenox-")) continue;
      const full = join(dir, name);
      const rel = relative(root, full) || name;
      const isDir = item.isDirectory();
      if (isDir && SKIP_DIRS.has(name)) {
        entries.push({ path: rel, name, type: "dir", size: 0 });
        continue;
      }
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      count += 1;
      if (isDir) {
        entries.push({ path: rel, name, type: "dir", size, children: walk(full, depth + 1) });
      } else {
        entries.push({ path: rel, name, type: "file", size });
      }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return entries;
  }

  return { root, entries: walk(target, 1), truncated: count >= MAX_ENTRIES };
}

/**
 * Saves a file the owner edited from their phone. The previous version is copied
 * into .zenox-backups first, so a bad edit is always one step away from undo.
 */
export function writeWorkspaceFile(input: { path: string; content: string }): {
  path: string;
  size: number;
  backup: string | null;
  created: boolean;
} {
  const { root, target } = safeTarget(input.path);
  if (!input.path.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "حدد مسار الملف." });
  const rel = relative(root, target);
  const segments = rel.split(/[\\/]/);
  if (segments.some((part) => WRITE_DENY_DIRS.has(part))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "هذا المجلد محمي من التعديل." });
  }
  if (Buffer.byteLength(input.content, "utf8") > MAX_WRITE_BYTES) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "الملف أكبر من الحد المسموح للتعديل." });
  }

  const existed = existsSync(target);
  let backup: string | null = null;
  if (existed) {
    if (!statSync(target).isFile()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المسار مجلد لا ملف." });
    }
    const dir = join(root, BACKUP_DIR);
    mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(target)}`;
    copyFileSync(target, join(dir, name));
    backup = `${BACKUP_DIR}/${name}`;
    const stale = readdirSync(dir)
      .filter((item) => item.endsWith(`-${basename(target)}`))
      .sort()
      .slice(0, -KEEP_BACKUPS);
    for (const item of stale) {
      try {
        unlinkSync(join(dir, item));
      } catch {
        // A backup that cannot be pruned is harmless.
      }
    }
  } else {
    mkdirSync(join(target, ".."), { recursive: true });
  }

  writeFileSync(target, input.content, "utf8");
  return { path: rel, size: statSync(target).size, backup, created: !existed };
}

/** Reads one text file from the workspace for the owner, with a hard size cap. */
export function readWorkspaceFile(inputPath: string): {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
} {
  const { root, target } = safeTarget(inputPath);
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats || !stats.isFile()) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الملف غير موجود داخل المشروع." });
  }
  const bytes = readFileSync(target);
  const slice = bytes.subarray(0, MAX_FILE_BYTES);
  if (slice.includes(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الملف ثنائي ولا يُعرض كنص." });
  }
  return {
    path: relative(root, target),
    size: stats.size,
    content: slice.toString("utf8"),
    truncated: stats.size > slice.length,
  };
}
