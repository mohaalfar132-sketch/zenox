import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * The owner sends whole folders packed as one archive from the phone, so the
 * ceiling is generous and nothing is buffered in memory: the body is streamed
 * straight to disk and the transfer is cut off once it passes the limit.
 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** Keeps a name usable on disk: no slashes, no dots-only, no control chars. */
export function sanitizeUploadName(raw: unknown): string {
  const text = String(raw ?? "").trim();
  const cleaned = text
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "upload.bin";
}

/** A free path inside `dir`; never walks out of it because the name is sanitized. */
export function uploadTarget(dir: string, name: string): string {
  const safe = sanitizeUploadName(name);
  const first = join(dir, safe);
  if (!existsSync(first)) return first;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${stamp}-${safe}`);
}

export interface UploadResult {
  path: string;
  size: number;
}

/**
 * Streams one request body to `dir`. Throws "too_large" (after deleting the
 * partial file) or "empty_file"; never leaves a truncated archive behind.
 */
export async function receiveUpload(
  stream: Readable,
  dir: string,
  name: string,
  max: number = MAX_UPLOAD_BYTES,
): Promise<UploadResult> {
  mkdirSync(dir, { recursive: true });
  const target = uploadTarget(dir, name);
  const out = createWriteStream(target);
  let size = 0;
  let failed: Error | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        if (size > max) {
          failed = new Error("too_large");
          stream.destroy();
          out.destroy();
          reject(failed);
          return;
        }
        if (!out.write(chunk)) stream.pause();
      });
      stream.on("error", (error: Error) => {
        failed = error;
        reject(error);
      });
      out.on("drain", () => stream.resume());
      out.on("error", (error: Error) => {
        failed = error;
        reject(error);
      });
      stream.on("end", () => {
        if (failed) return;
        out.end(() => resolve());
      });
    });
  } catch (error) {
    out.destroy();
    try {
      unlinkSync(target);
    } catch {
      // Nothing was written, or the partial file was already removed.
    }
    throw error;
  }

  if (size === 0) {
    try {
      unlinkSync(target);
    } catch {
      // Already gone.
    }
    throw new Error("empty_file");
  }
  return { path: target, size };
}

/** Multipart (what a browser sends for a chosen file) keeps its own framing. */
function boundaryOf(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = (match?.[1] || match?.[2] || "").trim();
  return value || null;
}

function writeChunk(out: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    out.once("error", reject);
    if (out.write(chunk)) {
      out.removeListener("error", reject);
      resolve();
      return;
    }
    out.once("drain", () => {
      out.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * Streams the first file of a multipart/form-data body to disk. The envelope
 * (boundaries, part headers) is stripped as it arrives, so nothing is buffered
 * in memory and the stored file is exactly the bytes the owner chose.
 */
export async function receiveMultipart(
  stream: AsyncIterable<Buffer>,
  dir: string,
  contentType: string,
  fallbackName: string,
  max: number = MAX_UPLOAD_BYTES,
): Promise<UploadResult> {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new Error("bad_multipart");
  const delim = Buffer.from(`--${boundary}`);
  const crlfDelim = Buffer.from(`\r\n--${boundary}`);
  mkdirSync(dir, { recursive: true });

  let buffer = Buffer.alloc(0);
  let state: "preamble" | "headers" | "body" | "done" = "preamble";
  let target = "";
  let out: ReturnType<typeof createWriteStream> | null = null;
  let size = 0;

  const cleanup = () => {
    try {
      if (target) unlinkSync(target);
    } catch {
      // Already gone.
    }
  };

  try {
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (state === "preamble") {
          const index = buffer.indexOf(delim);
          if (index < 0) {
            buffer = buffer.subarray(Math.max(0, buffer.length - delim.length - 4));
            break;
          }
          buffer = buffer.subarray(index + delim.length);
          state = "headers";
          continue;
        }

        if (state === "headers") {
          const index = buffer.indexOf("\r\n\r\n");
          if (index < 0) {
            if (buffer.length > 16 * 1024) throw new Error("bad_multipart");
            break;
          }
          const head = buffer.subarray(0, index).toString("utf8");
          buffer = buffer.subarray(index + 4);
          const fileMatch = /filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i.exec(head);
          if (fileMatch) {
            let name = fileMatch[1].trim();
            try {
              name = decodeURIComponent(name);
            } catch {
              // Keep the raw name.
            }
            target = uploadTarget(dir, name || fallbackName);
            out = createWriteStream(target);
            state = "body";
          } else {
            // A plain field, not the file: skip to the next part.
            state = "preamble";
          }
          continue;
        }

        if (state === "body" && out) {
          const index = buffer.indexOf(crlfDelim);
          if (index < 0) {
            const keep = crlfDelim.length + 4;
            if (buffer.length > keep) {
              const slice = buffer.subarray(0, buffer.length - keep);
              size += slice.length;
              if (size > max) throw new Error("too_large");
              await writeChunk(out, slice);
              buffer = buffer.subarray(buffer.length - keep);
            }
            break;
          }
          const slice = buffer.subarray(0, index);
          size += slice.length;
          if (size > max) throw new Error("too_large");
          await writeChunk(out, slice);
          buffer = buffer.subarray(index + crlfDelim.length);
          state = "done";
          break;
        }

        break;
      }
      if (state === "done") break;
    }
  } catch (error) {
    out?.destroy();
    cleanup();
    throw error;
  }

  if (!out) throw new Error("empty_file");
  await new Promise<void>((resolve, reject) => {
    out!.once("error", reject);
    out!.end(() => resolve());
  });

  if (size === 0) {
    cleanup();
    throw new Error("empty_file");
  }
  return { path: target, size };
}

/** Raw body (`application/octet-stream`) streams straight through. */
export async function receiveRaw(stream: Readable, dir: string, name: string, max: number = MAX_UPLOAD_BYTES) {
  return receiveUpload(stream, dir, name, max);
}

/**
 * One entry point for both shapes: a browser's multipart upload and a client
 * that posts raw bytes with the name in the query string.
 */
export async function receiveAnyUpload(
  stream: Readable,
  dir: string,
  name: string,
  contentType: string,
  max: number = MAX_UPLOAD_BYTES,
): Promise<UploadResult> {
  if (/multipart\/form-data/i.test(contentType)) {
    return receiveMultipart(stream as unknown as AsyncIterable<Buffer>, dir, contentType, name, max);
  }
  return receiveUpload(stream, dir, name, max);
}

/** Where owner (and user) uploads live: inside the project, so they are browsable. */
export function uploadsDirectory() {
  return join(process.cwd(), "uploads");
}

export interface UploadEntry {
  name: string;
  size: number;
  modifiedMs: number;
}

/** Every uploaded file, newest first — the owner browses and opens them. */
export function listUploads(dir: string = uploadsDirectory(), limit = 200): UploadEntry[] {
  try {
    return readdirSync(dir)
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .map((name) => {
        const info = statSync(join(dir, name));
        return { name, size: info.size, modifiedMs: info.mtimeMs };
      })
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** One uploaded file by name, or null when the name is not a real file in `dir`. */
export function resolveUpload(name: unknown, dir: string = uploadsDirectory()): { path: string; size: number } | null {
  const safe = sanitizeUploadName(name);
  if (safe !== String(name ?? "").trim()) return null;
  const path = join(dir, safe);
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return { path, size: statSync(path).size };
  } catch {
    return null;
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

export function uploadContentType(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

export function uploadStream(path: string) {
  return createReadStream(path);
}
