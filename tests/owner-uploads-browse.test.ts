import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listUploads, resolveUpload, uploadContentType } from "../server/_core/ownerUpload";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("owner file browser", () => {
  it("lists every uploaded file, newest first", () => {
    dir = mkdtempSync(join(tmpdir(), "zenox-uploads-"));
    writeFileSync(join(dir, "old.txt"), "قديم");
    writeFileSync(join(dir, "new.txt"), "جديد");
    const listed = listUploads(dir);
    expect(listed.map((entry) => entry.name).sort()).toEqual(["new.txt", "old.txt"]);
    expect(listed.find((entry) => entry.name === "new.txt")?.size).toBeGreaterThan(0);
  });

  it("returns an empty list for a missing folder", () => {
    expect(listUploads(join(tmpdir(), "zenox-none-here"))).toEqual([]);
  });

  it("resolves a real file and refuses anything that escapes the folder", () => {
    dir = mkdtempSync(join(tmpdir(), "zenox-uploads-"));
    writeFileSync(join(dir, "report.txt"), "محتوى");
    expect(resolveUpload("report.txt", dir)?.path).toBe(join(dir, "report.txt"));
    expect(resolveUpload("../etc/passwd", dir)).toBeNull();
    expect(resolveUpload("/etc/passwd", dir)).toBeNull();
    expect(resolveUpload("missing.txt", dir)).toBeNull();
  });

  it("serves text as text and unknown files as binary", () => {
    expect(uploadContentType("notes.txt")).toContain("text/plain");
    expect(uploadContentType("photo.PNG")).toBe("image/png");
    expect(uploadContentType("archive.bin")).toBe("application/octet-stream");
  });
});
