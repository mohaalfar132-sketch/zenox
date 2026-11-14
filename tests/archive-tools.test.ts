import AdmZip from "adm-zip";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveKind, extractArchive, safeArchiveEntry } from "../server/_core/archiveTools";

let work = "";
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = "";
});

describe("archives the owner uploads", () => {
  it("extracts a ZIP and keeps its folders", async () => {
    work = mkdtempSync(join(tmpdir(), "zenox-zip-"));
    const zip = new AdmZip();
    zip.addFile("report.txt", Buffer.from("hello zip", "utf8"));
    zip.addFile("folder/data.csv", Buffer.from("a,b\n1,2", "utf8"));
    const archive = join(work, "bundle.zip");
    writeFileSync(archive, zip.toBuffer());

    const result = await extractArchive({ path: archive, destRoot: join(work, "out") });
    expect(result.kind).toBe("zip");
    expect(result.files.sort()).toEqual(["folder/data.csv", "report.txt"]);
    expect(readFileSync(join(work, "out", "report.txt"), "utf8")).toBe("hello zip");
  });

  it("refuses traversal entries and non-archive files", async () => {
    work = mkdtempSync(join(tmpdir(), "zenox-zip-"));
    // A crafted entry name must never leave the destination folder.
    expect(safeArchiveEntry("../../etc/passwd")).toBeNull();
    expect(safeArchiveEntry("/absolute/path")).toBe("absolute/path");
    expect(safeArchiveEntry("folder/../../../x")).toBeNull();
    expect(safeArchiveEntry("folder/")).toBeNull();

    const zip = new AdmZip();
    zip.addFile("ok.txt", Buffer.from("yes", "utf8"));
    const archive = join(work, "evil.zip");
    writeFileSync(archive, zip.toBuffer());
    const result = await extractArchive({ path: archive, destRoot: join(work, "out") });
    expect(result.files).toEqual(["ok.txt"]);
    expect(archiveKind("notes.txt")).toBeNull();
    await expect(extractArchive({ path: join(work, "notes.txt"), destRoot: join(work, "o") })).rejects.toThrow();
  });
});
