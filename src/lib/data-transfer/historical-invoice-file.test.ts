import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { HistoricalFileError, parseHistoricalInvoiceFile } from "./historical-invoice-file";
import { boundedHistoricalWorkbook } from "./historical-invoice-xlsx";

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
  it("statically bundles the workbook helper so Next does not trace its raw TypeScript", () => {
    const source = ts.createSourceFile("historical-invoice-file.ts", readFileSync(new URL("./historical-invoice-file.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const localImports: string[] = [];
    const dynamicImports: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) localImports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length && ts.isStringLiteral(node.arguments[0])) dynamicImports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(localImports).toContain("./historical-invoice-xlsx");
    expect(dynamicImports).not.toContain("./historical-invoice-xlsx");
  });
  it("preserves the public error type for errors raised by the workbook helper", async () => {
    await expect(parseHistoricalInvoiceFile(bytes("not a zip"), "xlsx")).rejects.toBeInstanceOf(HistoricalFileError);
  });
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
  it("refuses a worksheet merge before ExcelJS expands its range", async () => {
    const buffer = await workbook([[["id"], ["001"]]]);
    const zip = await JSZip.loadAsync(buffer);
    const worksheet = zip.file("xl/worksheets/sheet1.xml")!;
    zip.file(worksheet.name, (await worksheet.async("string")).replace("</worksheet>", '<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>'));
    const mutated = await zip.generateAsync({ type: "uint8array" });
    await expect(parseHistoricalInvoiceFile(Uint8Array.from(mutated).buffer, "xlsx")).rejects.toMatchObject({ code: "xlsx_unsupported_layout" });
  });
  it("rejects validation and named ranges before ExcelJS can expand them", async () => {
    const input = await workbook([[["id"], ["001"]]]);
    const validations = await JSZip.loadAsync(input);
    const worksheet = validations.file("xl/worksheets/sheet1.xml")!;
    validations.file(worksheet.name, (await worksheet.async("string")).replace("</worksheet>",
      '<dataValidations count="1"><dataValidation type="list" sqref="A1:XFD1048576"><formula1>1</formula1></dataValidation></dataValidations></worksheet>'));
    await expect(boundedHistoricalWorkbook(Uint8Array.from(await validations.generateAsync({ type: "uint8array" })).buffer))
      .rejects.toMatchObject({ code: "xlsx_unsupported_layout" });
    const named = await JSZip.loadAsync(input);
    const workbookXml = named.file("xl/workbook.xml")!;
    named.file(workbookXml.name, (await workbookXml.async("string")).replace("</workbook>",
      '<definedNames><definedName name="Huge">Headers!$A$1:$XFD$1048576</definedName></definedNames></workbook>'));
    await expect(boundedHistoricalWorkbook(Uint8Array.from(await named.generateAsync({ type: "uint8array" })).buffer))
      .rejects.toMatchObject({ code: "xlsx_unsupported_layout" });
  });
  it("rejects duplicate row coordinates instead of allowing ExcelJS to overwrite evidence", async () => {
    const input = await workbook([[["id"], ["original"]]]);
    const zip = await JSZip.loadAsync(input);
    const worksheet = zip.file("xl/worksheets/sheet1.xml")!;
    const xml = await worksheet.async("string");
    const row = xml.match(/<row r="2"[^>]*>[\s\S]*?<\/row>/)?.[0];
    expect(row).toBeTruthy();
    zip.file(worksheet.name, xml.replace(row!, `${row}${row}`));
    const mutated = Uint8Array.from(await zip.generateAsync({ type: "uint8array" })).buffer;
    await expect(parseHistoricalInvoiceFile(mutated, "xlsx")).rejects.toMatchObject({ code: "invalid_xlsx_archive" });
  });
  it("rejects excessive or ambiguous workbook sheet identifiers before materialization", async () => {
    const input = await workbook([[["id"], ["1"]], [["id"], ["2"]]]);
    for (const change of [
      (xml: string) => xml.replace('sheetId="1"', 'sheetId="999999999"'),
      (xml: string) => xml.replace('sheetId="2"', 'sheetId="1"'),
      (xml: string) => xml.replace('name="Lines"', 'name="Headers"'),
      (xml: string) => {
        const first = /<sheet\b[^>]*name="Headers"[^>]*r:id="([^"]+)"/.exec(xml)?.[1];
        return xml.replace(/(<sheet\b[^>]*name="Lines"[^>]*r:id=")[^"]+/, `$1${first}`);
      },
    ]) {
      const zip = await JSZip.loadAsync(input);
      const file = zip.file("xl/workbook.xml")!;
      const xml = await file.async("string");
      const changed = change(xml);
      expect(changed).not.toBe(xml);
      zip.file(file.name, changed);
      await expect(boundedHistoricalWorkbook(Uint8Array.from(await zip.generateAsync({ type: "uint8array" })).buffer))
        .rejects.toMatchObject({ code: "invalid_xlsx_archive" });
    }
  });
  it("rejects missing, duplicated and unsupported worksheet relationships rather than dropping a sheet", async () => {
    const input = await workbook([[["id"], ["1"]], [["id"], ["2"]]]);
    for (const change of [
      (xml: string) => xml.replace('Target="worksheets/sheet2.xml"', 'Target="worksheets/missing.xml"'),
      (xml: string) => xml.replace('Target="worksheets/sheet2.xml"', 'Target="worksheets/sheet1.xml"'),
      (xml: string) => xml.replace('Target="worksheets/sheet2.xml"', 'Target="chartsheets/sheet2.xml"'),
      (xml: string) => xml.replace('Target="worksheets/sheet2.xml"', 'Target="worksheets/sheet2.xml" TargetMode="External"'),
      (xml: string) => {
        const first = /<Relationship Id="([^"]+)"[^>]+Target="worksheets\/sheet1.xml"/.exec(xml)?.[1];
        return xml.replace(/(<Relationship Id=")[^"]+("[^>]+Target="worksheets\/sheet2.xml")/, `$1${first}$2`);
      },
    ]) {
      const zip = await JSZip.loadAsync(input);
      const file = zip.file("xl/_rels/workbook.xml.rels")!;
      const xml = await file.async("string");
      const changed = change(xml);
      expect(changed).not.toBe(xml);
      zip.file(file.name, changed);
      const mutated = Uint8Array.from(await zip.generateAsync({ type: "uint8array" })).buffer;
      await expect(boundedHistoricalWorkbook(mutated)).rejects.toMatchObject({ code: "invalid_xlsx_archive" });
    }
    const zip = await JSZip.loadAsync(input);
    zip.file("xl/worksheets/sheet3.xml", await zip.file("xl/worksheets/sheet2.xml")!.async("string"));
    await expect(boundedHistoricalWorkbook(Uint8Array.from(await zip.generateAsync({ type: "uint8array" })).buffer))
      .rejects.toMatchObject({ code: "invalid_xlsx_archive" });
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
  it("rejects text PostgreSQL cannot store without corrupting Unicode", async () => {
    await expect(parseHistoricalInvoiceFile(bytes("id\n\u0000"), "csv")).rejects.toMatchObject({ code: "invalid_text" });
    await expect(parseHistoricalInvoiceFile(bytes('[{"id":"\\u0000"}]'), "json")).rejects.toMatchObject({ code: "invalid_text" });
    await expect(parseHistoricalInvoiceFile(bytes('[{"id":"\\ud800"}]'), "json")).rejects.toMatchObject({ code: "invalid_text" });
    const parsed = await parseHistoricalInvoiceFile(bytes('[{"id":"\\ud83d\\ude00"}]'), "json");
    expect(parsed[0].rows[0].raw.id).toBe("😀");
  });
  it("rejects oversized files and invalid UTF-8", async () => {
    await expect(parseHistoricalInvoiceFile(new ArrayBuffer(20 * 1024 * 1024 + 1), "csv")).rejects.toMatchObject({ code: "file_too_large" });
    await expect(parseHistoricalInvoiceFile(new Uint8Array([0xff]).buffer, "csv")).rejects.toMatchObject({ code: "invalid_utf8" });
  });
});
