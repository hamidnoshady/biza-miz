import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parseHistoricalInvoiceFile } from "./historical-invoice-file";

const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
async function workbook(rows: unknown[][][], names = ["Headers", "Lines"]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  rows.forEach((sheetRows, index) => {
    const sheet = wb.addWorksheet(names[index] ?? `Sheet${index}`);
    sheetRows.forEach((r) => sheet.addRow(r));
  });
  const buffer = await wb.xlsx.writeBuffer();
  return Uint8Array.from(buffer as unknown as Uint8Array).buffer;
}

describe("historical invoice file parsing", () => {
  it("preserves exact CSV values, identifiers, quoted newlines and physical row numbers", async () => {
    const [s] = await parseHistoricalInvoiceFile(bytes('\uFEFFid;total;note\r\n\r\n"00001";"9223372036854775807";"a\r\nb"\r\n2;0.1;x\r\n'), "csv");
    expect(s.columns).toEqual(["id", "total", "note"]);
    expect(s.rows).toEqual([
      { rowNumber: 3, raw: { id: "00001", total: "9223372036854775807", note: "a\r\nb" } },
      { rowNumber: 5, raw: { id: "2", total: "0.1", note: "x" } },
    ]);
  });
  it("rejects malformed CSV and never truncates unlabelled evidence", async () => {
    await expect(parseHistoricalInvoiceFile(bytes('id,total\na,"oops'), "csv")).rejects.toMatchObject({ code: "invalid_csv_quote" });
    await expect(parseHistoricalInvoiceFile(bytes('id,total\na,"ok"extra'), "csv")).rejects.toMatchObject({ code: "invalid_csv_quote" });
    await expect(parseHistoricalInvoiceFile(bytes('id,total\na,1,extra'), "csv")).rejects.toMatchObject({ code: "row_wider_than_header" });
    await expect(parseHistoricalInvoiceFile(bytes('id,id\na,b'), "csv")).rejects.toMatchObject({ code: "duplicate_source_columns" });
  });
  it("preserves string and numeric JSON literals without numeric coercion", async () => {
    const [s] = await parseHistoricalInvoiceFile(bytes('{"rows":[{"id":"0001","total":9007199254740993},{"id":"0002","note":"سلام","total":null}]}'), "json");
    expect(s.columns).toEqual(["id", "total", "note"]);
    expect(s.rows[0].raw.total).toBe("9007199254740993");
    expect(s.rows[1].raw).toEqual({ id: "0002", total: "", note: "سلام" });
  });
  it("refuses duplicate keys and malformed or nested JSON records", async () => {
    for (const source of ['[{"id":"a","id":"b"}]', '[{"id":{"value":"a"}}]', '[{"id":"a"},]', '[{"id":"a"}garbage]']) {
      await expect(parseHistoricalInvoiceFile(bytes(source), "json")).rejects.toBeInstanceOf(Error);
    }
    const [number] = await parseHistoricalInvoiceFile(bytes('[{"total":1.234567890123456789,"other":1e20}]'), "json");
    expect(number.rows[0].raw).toEqual({ total: "1.234567890123456789", other: "1e20" });
    await expect(parseHistoricalInvoiceFile(bytes('[{"id":"x","id":"y"}]'), "json")).rejects.toMatchObject({ code: "duplicate_source_columns" });
  });
  it("parses separate header and line worksheets without losing text or row identity", async () => {
    const buffer = await workbook([
      [["id", "total"], ["00001", "999999999999999999"]],
      [["id", "name"], ["00001", "کالا"]],
    ]);
    const result = await parseHistoricalInvoiceFile(buffer, "xlsx");
    expect(result.map((s) => s.name)).toEqual(["Headers", "Lines"]);
    expect(result[0].rows[0]).toEqual({ rowNumber: 2, raw: { id: "00001", total: "999999999999999999" } });
    expect(result[1].rows[0].raw.name).toBe("کالا");
  });
  it("rejects blank XLSX headers rather than losing or mislabelling evidence", async () => {
    await expect(parseHistoricalInvoiceFile(await workbook([[["id", null, "total"], ["1", "hidden", "2"]]]), "xlsx"))
      .rejects.toMatchObject({ code: "invalid_headers" });
  });
  it("rejects XLSX numbers, dates, formulas and errors instead of rounding them", async () => {
    for (const value of [9007199254740992, 10, 1.5, new Date("2024-01-01"), { formula: "1+1", result: 2 }, { error: "#N/A" }]) {
      await expect(parseHistoricalInvoiceFile(await workbook([[["id"], [value]]]), "xlsx")).rejects.toMatchObject({ code: "xlsx_cells_must_be_text" });
    }
  });
  it("bounds expanded XLSX data, even if the compressed upload is small", async () => {
    const zip = new JSZip();
    zip.file("large.xml", "0".repeat(32 * 1024 * 1024 + 1));
    const compressed = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(compressed.byteLength).toBeLessThan(100_000);
    await expect(parseHistoricalInvoiceFile(Uint8Array.from(compressed).buffer, "xlsx")).rejects.toMatchObject({ code: "xlsx_expanded_too_large" });
    // A forged central-directory size must not bypass the actual output bound.
    const forged = Buffer.from(compressed);
    const central = forged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    forged.writeUInt32LE(1, central + 24);
    await expect(parseHistoricalInvoiceFile(Uint8Array.from(forged).buffer, "xlsx")).rejects.toBeInstanceOf(Error);
  });
  it("rejects damaged data, duplicate and ambiguous archive names before ExcelJS", async () => {
    const zip = new JSZip();
    zip.file("a.xml", "abc", { createFolders: false });
    zip.file("b.xml", "def", { createFolders: false });
    const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "STORE" }));
    const damaged = Buffer.from(bytes);
    const local = damaged.indexOf(Buffer.from("abc"));
    expect(local).toBeGreaterThan(0);
    damaged[local] ^= 1;
    await expect(parseHistoricalInvoiceFile(Uint8Array.from(damaged).buffer, "xlsx")).rejects.toMatchObject({ code: "invalid_xlsx_archive" });
    const duplicate = Buffer.from(bytes);
    const centralName = duplicate.lastIndexOf(Buffer.from("b.xml"));
    expect(centralName).toBeGreaterThan(0);
    duplicate[centralName] = 0x61;
    await expect(parseHistoricalInvoiceFile(Uint8Array.from(duplicate).buffer, "xlsx")).rejects.toMatchObject({ code: "invalid_xlsx_archive" });
    const ambiguous = new JSZip();
    ambiguous.file("xl/./workbook.xml", "x", { createFolders: false });
    await expect(parseHistoricalInvoiceFile(Uint8Array.from(await ambiguous.generateAsync({ type: "uint8array" })).buffer, "xlsx")).rejects.toMatchObject({ code: "invalid_xlsx_archive" });
  });
  it("rejects XLSX archives with too many entries", async () => {
    const zip = new JSZip();
    for (let i = 0; i <= 1000; i++) zip.file(`f${i}.xml`, "", { createFolders: false });
    await expect(parseHistoricalInvoiceFile(Uint8Array.from(await zip.generateAsync({ type: "uint8array" })).buffer, "xlsx"))
      .rejects.toMatchObject({ code: "invalid_xlsx_archive" });
  });
  it("bounds materialized sparse CSV cells before building row objects", async () => {
    const header = Array.from({ length: 512 }, (_, i) => `c${i}`).join(",");
    const payload = `${header}\n${"value\n".repeat(1954)}`;
    await expect(parseHistoricalInvoiceFile(bytes(payload), "csv")).rejects.toMatchObject({ code: "too_many_cells" });
    const wide = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`c${i}`, "x"]));
    const json = JSON.stringify([wide, ...Array.from({ length: 1953 }, () => ({ c0: "x" }))]);
    await expect(parseHistoricalInvoiceFile(bytes(json), "json")).rejects.toMatchObject({ code: "too_many_cells" });
  });
  it("bounds staging amplification from repeated long column names", async () => {
    const payload = `${"h".repeat(100_000)}\n${"value\n".repeat(336)}`;
    await expect(parseHistoricalInvoiceFile(bytes(payload), "csv")).rejects.toMatchObject({ code: "staged_data_too_large" });
    const escaped = `${"\\".repeat(100_000)}\n${"value\n".repeat(168)}`;
    await expect(parseHistoricalInvoiceFile(bytes(escaped), "csv")).rejects.toMatchObject({ code: "staged_data_too_large" });
  });
  it("rejects oversized files and invalid UTF-8", async () => {
    await expect(parseHistoricalInvoiceFile(new ArrayBuffer(20 * 1024 * 1024 + 1), "csv")).rejects.toMatchObject({ code: "file_too_large" });
    await expect(parseHistoricalInvoiceFile(new Uint8Array([0xff]).buffer, "csv")).rejects.toMatchObject({ code: "invalid_utf8" });
  });
});
