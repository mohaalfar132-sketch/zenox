import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDocument, documentKind, editDocument, readDocument } from "../server/_core/documentTools";

const dir = join(process.cwd(), "generated");
afterAll(() => {
  for (const name of ["note.md", "rows.csv", "report.pdf", "letter.docx", "table.xlsx"]) {
    rmSync(join(dir, name), { force: true });
  }
});

describe("documents, not just code", () => {
  it("knows every supported family", () => {
    expect(documentKind("a.md")).toBe("text");
    expect(documentKind("a.pdf")).toBe("pdf");
    expect(documentKind("a.docx")).toBe("word");
    expect(documentKind("a.xlsx")).toBe("sheet");
    expect(documentKind("a.png")).toBe("image");
    expect(documentKind("a.mp3")).toBe("audio");
  });

  it("creates and reads text, CSV, PDF, Word and Excel files", async () => {
    const text = await createDocument({ name: "note.md", content: "# تقرير\nسطر أول\nسطر ثانٍ" });
    expect(text.kind).toBe("text");
    const readText = await readDocument({ path: text.path });
    expect(readText.text).toContain("سطر أول");

    const csv = await createDocument({ name: "rows.csv", content: "name,qty\nقلم,3\nورق,10" });
    expect((await readDocument({ path: csv.path })).text).toContain("ورق,10");

    const pdf = await createDocument({ name: "report.pdf", content: "PDF inside text\nsecond line" });
    expect(existsSync(join(dir, "report.pdf"))).toBe(true);
    expect(readFileSync(join(dir, "report.pdf")).subarray(0, 4).toString()).toBe("%PDF");
    const readPdf = await readDocument({ path: pdf.path });
    expect(readPdf.kind).toBe("pdf");
    expect(readPdf.text).toContain("PDF inside text");

    const docx = await createDocument({ name: "letter.docx", content: "خطاب رسمي\nالفقرة الثانية" });
    expect(readFileSync(join(dir, "letter.docx")).subarray(0, 2).toString()).toBe("PK");
    expect((await readDocument({ path: docx.path })).text).toContain("الفقرة الثانية");

    const xlsx = await createDocument({ name: "table.xlsx", content: "اسم,عدد\nأحمد,2\nسارة,5" });
    expect(readFileSync(join(dir, "table.xlsx")).subarray(0, 2).toString()).toBe("PK");
    const readSheet = await readDocument({ path: xlsx.path });
    expect(readSheet.kind).toBe("sheet");
    expect(readSheet.text).toContain("أحمد");
  });

  it("edits a document in place", async () => {
    const file = await createDocument({ name: "note.md", content: "الإصدار الأول" });
    const edited = await editDocument({ path: file.path, find: "الأول", replace: "الثاني" });
    expect(edited.replaced).toBe(1);
    expect((await readDocument({ path: file.path })).text).toContain("الإصدار الثاني");
  });

  it("refuses binary formats it cannot edit and paths outside the project", async () => {
    await expect(editDocument({ path: "../../etc/hosts", find: "a", replace: "b" })).rejects.toThrow();
  });
});
