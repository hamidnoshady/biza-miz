import JSZip from "jszip";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  DOCX_MIME,
  MAX_ENTRY_INFLATED_BYTES,
  XLSX_MIME,
  extractDocxText,
  extractXlsxText,
  wordXmlToText,
  zipInflatesWithinBounds,
} from "./ai-office-extract";
import { parseChatAttachments, parseOfficeDataUrl, prepareAttachments } from "./ai-attachment";

const docxBytes = async (body: string) => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", `<w:document><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
};
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const dataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

describe("wordXmlToText", () => {
  it("keeps paragraphs, table cells and rows in reading order and decodes entities", () => {
    const xml = `${para("فاکتور &amp; رسید")}<w:tbl><w:tr><w:tc>${para("کالا")}</w:tc><w:tc>${para("۲۰۰")}</w:tc></w:tr></w:tbl>`;
    expect(wordXmlToText(xml)).toBe("فاکتور & رسید\nکالا | ۲۰۰");
  });

  it("drops entities it does not know instead of expanding them", () => {
    expect(wordXmlToText(para("a&xxe;b&#0;c"))).toBe("a&xxe;bc");
  });
});

describe("extractDocxText", () => {
  it("reads a Word document", async () => {
    const out = await extractDocxText(await docxBytes(para("سلام") + para("دنیا")));
    expect(out).toEqual({ text: "سلام\nدنیا", truncated: false });
  });

  it("returns null for a non-zip, an empty document and a zip without a body", async () => {
    expect(await extractDocxText(new TextEncoder().encode("not a zip"))).toBeNull();
    expect(await extractDocxText(await docxBytes(""))).toBeNull();
    const zip = new JSZip();
    zip.file("other.txt", "x");
    expect(await extractDocxText(await zip.generateAsync({ type: "uint8array" }))).toBeNull();
  });

  it("refuses an entry that inflates past the cap, whatever its size on disk", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", Buffer.alloc(MAX_ENTRY_INFLATED_BYTES + 1024, 0x61), { compression: "DEFLATE" });
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bytes.length).toBeLessThan(200_000);
    expect(await extractDocxText(bytes)).toBeNull();
    expect(await zipInflatesWithinBounds(bytes)).toBe(false);
  });
});

describe("extractXlsxText", () => {
  it("reads every sheet with Shamsi dates, bounded to the first rows", async () => {
    const workbook = new ExcelJS.Workbook();
    const sales = workbook.addWorksheet("فروش");
    sales.addRow(["تاریخ", "مبلغ"]);
    sales.addRow([new Date(Date.UTC(2026, 2, 21)), 1500000]);
    for (let i = 0; i < 300; i += 1) sales.addRow([`r${i}`, i]);
    workbook.addWorksheet("خالی");
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const out = await extractXlsxText(bytes);
    expect(out?.truncated).toBe(true);
    expect(out?.text).toContain("[برگه: فروش]");
    expect(out?.text).toContain("۱۴۰۵/۰۱/۰۱\t1500000");
    expect(out?.text).not.toContain("2026-03-21");
    expect(out?.text).not.toContain("r250");
  });

  it("returns null for bytes that are not a workbook", async () => {
    expect(await extractXlsxText(await docxBytes(para("x")))).toBeNull();
  });
});

describe("office attachments", () => {
  it("accepts a zip-signed OOXML data URL and rejects wrong types and non-zip bytes", async () => {
    const bytes = await docxBytes(para("x"));
    expect(parseOfficeDataUrl(dataUrl(DOCX_MIME, bytes))?.mime).toBe(DOCX_MIME);
    expect(parseOfficeDataUrl(dataUrl("application/msword", bytes))).toBeNull();
    expect(parseOfficeDataUrl(dataUrl(XLSX_MIME, new TextEncoder().encode("plain text, not PK")))).toBeNull();
  });

  it("flows through parseChatAttachments and prepareAttachments to extracted text", async () => {
    const bytes = await docxBytes(para("پیوست مهم"));
    const parsed = parseChatAttachments("dashboard", [{ dataUrl: dataUrl(DOCX_MIME, bytes), name: "a.docx" }]);
    expect(parsed.error).toBe(false);
    expect(parsed.attachments[0]).toMatchObject({ kind: "office", name: "a.docx" });
    const [prepared] = await prepareAttachments(parsed.attachments);
    expect(prepared!.extractedText).toBe("پیوست مهم");
  });

  it("still rejects audio and video containers", () => {
    const mp4 = `data:video/mp4;base64,${Buffer.from("....ftypmp42").toString("base64")}`;
    expect(parseChatAttachments("dashboard", [{ dataUrl: mp4 }]).error).toBe(true);
    const mp3 = `data:audio/mpeg;base64,${Buffer.from("ID3....").toString("base64")}`;
    expect(parseChatAttachments("dashboard", [{ dataUrl: mp3 }]).error).toBe(true);
  });
});
