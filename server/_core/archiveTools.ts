import AdmZip from "adm-zip";
import { createExtractorFromFile } from "node-unrar-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

/**
 * ZIP and RAR extraction for the owner's uploads. Entry names are sanitised so a
 * crafted archive cannot write outside the destination folder.
 */
export type ArchiveKind = "zip" | "rar";

export function archiveKind(name: string): ArchiveKind | null {
  const ext = extname(name).toLowerCase();
  if (ext === ".zip") return "zip";
  if (ext === ".rar") return "rar";
  return null;
}

export function safeArchiveEntry(entry: string): string | null {
  const normalised = entry.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalised || normalised.endsWith("/")) return null;
  if (normalised.split("/").some((part) => part === ".." || part === "")) return null;
  return normalised;
}

export type ExtractResult = { kind: ArchiveKind; dir: string; files: string[]; skipped: number };

export async function extractArchive(input: {
  path: string;
  destRoot: string;
  maxFiles?: number;
}): Promise<ExtractResult> {
  const kind = archiveKind(input.path);
  if (!kind) throw new Error("الملف ليس ZIP أو RAR.");
  const maxFiles = input.maxFiles ?? 500;
  const dir = resolve(input.destRoot);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  let skipped = 0;

  if (kind === "zip") {
    const zip = new AdmZip(input.path);
    for (const entry of zip.getEntries()) {
      if (files.length >= maxFiles) {
        skipped += 1;
        continue;
      }
      const relative = safeArchiveEntry(entry.entryName);
      if (!relative || entry.isDirectory) continue;
      const target = resolve(join(dir, relative));
      if (!target.startsWith(dir + sep)) {
        skipped += 1;
        continue;
      }
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, entry.getData());
      files.push(relative);
    }
    return { kind, dir, files, skipped };
  }

  // RAR: the wasm extractor writes the tree itself; only vetted names are passed.
  const extractor = await createExtractorFromFile({ filepath: input.path, targetPath: dir });
  const listed = extractor.getFileList();
  const names = [...listed.fileHeaders]
    .filter((header) => !header.flags.directory)
    .map((header) => header.name)
    .filter((name): name is string => Boolean(safeArchiveEntry(name)))
    .slice(0, maxFiles);
  if (names.length === 0) return { kind, dir, files, skipped };

  const extracted = extractor.extract({ files: names });
  for (const file of extracted.files) {
    if (file.extraction) files.push(file.fileHeader.name);
    else skipped += 1;
  }
  return { kind, dir, files, skipped };
}

export function archiveFolder(name: string) {
  const base = basename(name.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\.[^.]+$/, "");
  return join(process.cwd(), "uploads", "extracted", `${base}-${Date.now()}`);
}
