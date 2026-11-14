import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import { generateImage } from "./imageGeneration";
import { insideProject } from "./agentWorkspace";

/**
 * Reading and writing documents, not just code: text, PDF, Word, Excel, CSV,
 * HTML, JSON, images and generated artwork. Everything lands inside the project
 * (or its uploads folder), so the owner can open it from the panel immediately.
 */
const require = createRequire(import.meta.url);
const mammoth = require("mammoth") as {
  extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
};

const MAX_READ_CHARS = 40_000;

export type DocumentKind = "text" | "pdf" | "word" | "sheet" | "image" | "audio" | "video" | "archive" | "binary";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".yaml", ".yml",
  ".log", ".ini", ".env", ".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".sql", ".sh", ".py",
  ".java", ".kt", ".swift", ".dart", ".php", ".rb", ".go", ".rs", ".c", ".cpp", ".h", ".svg", ".srt",
]);

export function documentKind(name: string): DocumentKind {
  const ext = extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx" || ext === ".doc" || ext === ".rtf" || ext === ".odt") return "word";
  if (ext === ".xlsx" || ext === ".xls" || ext === ".ods") return "sheet";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  if ([".zip", ".tar", ".gz", ".rar", ".7z"].includes(ext)) return "archive";
  return "binary";
}

export type DocumentRead = {
  name: string;
  path: string;
  kind: DocumentKind;
  bytes: number;
  text: string;
  truncated: boolean;
  note?: string;
};

export function generatedDirectory() {
  const dir = join(process.cwd(), "generated");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeTarget(name: string) {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "document";
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120).trim();
  if (!cleaned) throw new Error("اسم الملف غير صالح.");
  return join(generatedDirectory(), cleaned);
}

function clip(text: string) {
  if (text.length <= MAX_READ_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_READ_CHARS), truncated: true };
}

/** Reads any supported document and returns searchable text plus a short note. */
export async function readDocument(input: { path: string }): Promise<DocumentRead> {
  const path = insideProject(input.path);
  if (!existsSync(path)) throw new Error(`لا يوجد ملف في ${input.path}`);
  const bytes = statSync(path).size;
  const name = path.split("/").pop() ?? path;
  const kind = documentKind(name);
  const buffer = readFileSync(path);

  if (kind === "text") {
    const { text, truncated } = clip(buffer.toString("utf8"));
    return { name, path: input.path, kind, bytes, text, truncated };
  }
  if (kind === "pdf") {
    try {
      const extracted = await extractPdfText(buffer);
      const { text, truncated } = clip(extracted.text.trim());
      return { name, path: input.path, kind, bytes, text, truncated, note: `${extracted.pages} صفحة` };
    } catch {
      return {
        name,
        path: input.path,
        kind,
        bytes,
        text: "",
        truncated: false,
        note: "تعذّر استخراج النص من هذا PDF (قد يكون مصوّرًا)؛ استخدم Terminal لتحويله أو أعد إنشاءه.",
      };
    }
  }
  if (kind === "word") {
    if (!name.toLowerCase().endsWith(".docx")) {
      return { name, path: input.path, kind, bytes, text: "", truncated: false, note: "الصيغة القديمة .doc غير مدعومة للقراءة؛ حوّلها إلى .docx." };
    }
    const extracted = await mammoth.extractRawText({ buffer });
    const { text, truncated } = clip(extracted.value.trim());
    return { name, path: input.path, kind, bytes, text, truncated };
  }
  if (kind === "sheet") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const parts: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      parts.push(`# ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet)}`);
    }
    const { text, truncated } = clip(parts.join("\n\n").trim());
    return { name, path: input.path, kind, bytes, text, truncated, note: `${workbook.SheetNames.length} ورقة` };
  }
  if (kind === "image") {
    return {
      name,
      path: input.path,
      kind,
      bytes,
      text: "",
      truncated: false,
      note: "صورة: يمكن تصميم نسخة جديدة منها عبر generate_image مع وصف التعديل.",
    };
  }
  return {
    name,
    path: input.path,
    kind,
    bytes,
    text: "",
    truncated: false,
    note: kind === "archive" ? "أرشيف مضغوط: افتحه من Terminal إن أردت استخراج محتواه." : "ملف ثنائي: لا نص داخله.",
  };
}

/** Builds a real document from plain text or CSV rows. */
export async function createDocument(input: {
  name: string;
  content: string;
  title?: string;
}): Promise<{ name: string; path: string; kind: DocumentKind; bytes: number }> {
  const target = safeTarget(input.name);
  const kind = documentKind(target);
  const title = input.title?.trim() || input.name.replace(/\.[^.]+$/, "");

  if (kind === "pdf") {
    const buffer = await renderPdf(title, input.content);
    writeFileSync(target, buffer);
  } else if (kind === "word") {
    const buffer = await renderDocx(title, input.content);
    writeFileSync(target, buffer);
  } else if (kind === "sheet") {
    const workbook = XLSX.utils.book_new();
    const rows = parseRows(input.content);
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
    XLSX.writeFile(workbook, target);
  } else if (kind === "image") {
    throw new Error("لإنشاء صورة استخدم أداة generate_image بالوصف المطلوب.");
  } else {
    writeFileSync(target, input.content, "utf8");
  }

  return { name: target.split("/").pop() ?? input.name, path: relative(target), kind, bytes: statSync(target).size };
}

function parseRows(content: string): string[][] {
  const trimmed = content.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [String(row ?? "")]));
      }
    } catch {
      // Fall through to CSV parsing.
    }
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => line.split(/\t|,/).map((cell) => cell.trim()));
}

function renderPdf(title: string, content: string): Promise<Buffer> {
  return new Promise((resolveBuffer, reject) => {
    // PDF 1.3 keeps the file readable by the bundled extractor too.
    const doc = new PDFDocument({ margin: 48, size: "A4", pdfVersion: "1.3" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolveBuffer(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(18).text(title, { align: "right" });
    doc.moveDown();
    doc.fontSize(12).text(content, { align: "right" });
    doc.end();
  });
}

async function renderDocx(title: string, content: string): Promise<Buffer> {
  const paragraphs = [
    new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 32 })] }),
    ...content.split(/\r?\n/).map((line) => new Paragraph({ children: [new TextRun({ text: line, size: 24 })] })),
  ];
  const document = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(document);
}

/** Modern extractor: handles real-world PDFs, not only the ones we generate. */
async function extractPdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
    getDocument: (options: Record<string, unknown>) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }> }> };
  };
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  const pages: string[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str ?? "").join(" "));
  }
  return { text: pages.join("\n\n"), pages: pdf.numPages };
}

function relative(target: string) {
  return resolve(target).slice(process.cwd().length + 1);
}

/** Replaces text inside a text document, or regenerates a Word/PDF file. */
export async function editDocument(input: {
  path: string;
  find: string;
  replace: string;
  all?: boolean;
}): Promise<{ path: string; replaced: number; kind: DocumentKind }> {
  if (!input.find) throw new Error("حدّد النص المطلوب استبداله.");
  const path = insideProject(input.path);
  if (!existsSync(path)) throw new Error(`لا يوجد ملف في ${input.path}`);
  const name = path.split("/").pop() ?? path;
  const kind = documentKind(name);

  if (kind === "text") {
    const original = readFileSync(path, "utf8");
    if (!original.includes(input.find)) throw new Error("النص غير موجود في الملف.");
    const replaced = input.all
      ? original.split(input.find).join(input.replace)
      : original.replace(input.find, input.replace);
    writeFileSync(path, replaced, "utf8");
    return { path: input.path, replaced: input.all ? original.split(input.find).length - 1 : 1, kind };
  }

  if (kind === "pdf" || kind === "word") {
    const read = await readDocument({ path: input.path });
    if (!read.text.includes(input.find)) throw new Error("النص غير موجود في الملف.");
    const updated = read.text.replace(input.find, input.replace);
    await createDocument({ name, content: updated });
    return { path: `generated/${name}`, replaced: 1, kind };
  }

  throw new Error("هذا النوع غير قابل للتعديل نصيًا؛ أنشئ ملفًا جديدًا بالمحتوى المطلوب.");
}

/** Designs or edits an image and saves it inside the project. */
export async function createImage(input: {
  prompt: string;
  name?: string;
  baseImageUrl?: string;
}): Promise<{ path: string; bytes: number }> {
  const result = await generateImage({
    prompt: input.prompt,
    ...(input.baseImageUrl
      ? { originalImages: [{ url: input.baseImageUrl, mimeType: guessImageMime(input.baseImageUrl) }] }
      : {}),
  });
  if (!result.url) throw new Error("لم يُعد مولّد الصور رابطًا.");
  const response = await fetch(result.url);
  if (!response.ok) throw new Error(`تعذّر تنزيل الصورة (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const suggested = input.name?.trim() || `image-${Date.now()}.png`;
  const target = safeTarget(suggested.includes(".") ? suggested : `${suggested}.png`);
  writeFileSync(target, buffer);
  return { path: relative(target), bytes: buffer.length };
}

function guessImageMime(url: string) {
  if (/\.jpg|\.jpeg/i.test(url)) return "image/jpeg";
  if (/\.webp/i.test(url)) return "image/webp";
  return "image/png";
}
