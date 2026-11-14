import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { receiveAnyUpload, sanitizeUploadName } from "../server/_core/ownerUpload";

const DIR = () => mkdtempSync(join(tmpdir(), "zenox-upload-"));

function multipart(fileName: string, bytes: Buffer, boundary = "----ZENOXBOUNDARY"): { body: Buffer; type: string } {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), type: `multipart/form-data; boundary=${boundary}` };
}

describe("owner upload", () => {
  it("stores raw octet-stream bytes exactly", async () => {
    const dir = DIR();
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    const result = await receiveAnyUpload(
      Readable.from([bytes]),
      dir,
      "icon.png",
      "application/octet-stream",
    );
    expect(result.size).toBe(bytes.length);
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
  });

  it("strips the multipart envelope a browser sends", async () => {
    const dir = DIR();
    const bytes = Buffer.alloc(5000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const { body, type } = multipart("صورة تجربة.bin", bytes);
    const result = await receiveAnyUpload(Readable.from([body]), dir, "fallback.bin", type);
    expect(result.size).toBe(bytes.length);
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
    expect(result.path).toContain("صورة_تجربة");
  });

  it("handles a multipart body split across many chunks", async () => {
    const dir = DIR();
    const bytes = Buffer.from("x".repeat(9000));
    const { body, type } = multipart("big.txt", bytes);
    const chunks: Buffer[] = [];
    for (let index = 0; index < body.length; index += 777) chunks.push(body.subarray(index, index + 777));
    const result = await receiveAnyUpload(Readable.from(chunks), dir, "big.txt", type);
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
  });

  it("rejects an empty upload and a nameless boundary", async () => {
    await expect(receiveAnyUpload(Readable.from([Buffer.alloc(0)]), DIR(), "x.bin", "application/octet-stream")).rejects.toThrow("empty_file");
    await expect(receiveAnyUpload(Readable.from([Buffer.from("x")]), DIR(), "x.bin", "multipart/form-data")).rejects.toThrow("bad_multipart");
  });

  it("keeps names on disk harmless", () => {
    expect(sanitizeUploadName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeUploadName("تقرير 2026.pdf")).toBe("تقرير_2026.pdf");
  });
});
