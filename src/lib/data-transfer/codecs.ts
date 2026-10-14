/**
 * The one file codec layer: CSV in and out, XLSX in and out, JSON in and out,
 * PDF table extraction in and PDF rendering out.
 *
 * ## Why one file
 *
 * Before the engine there were three CSV parsers (`crm-csv.ts`,
 * `report-export.ts`, `menu-import.ts`), three XLSX writers
 * (`report-export.ts`, `tenant-export.ts`, plus the reader in
 * `xlsx-import.ts`) and no JSON or PDF path at all. Each had learnt a
 * different subset of the same hard lessons, and only one of them had learnt
 * the important one:
 *
 *  - **Formula injection.** A cell beginning `=`, `+`, `-` or `@` is executed
 *    by Excel when the file opens, so an exported customer named
 *    `=HYPERLINK(...)` is an attack on whoever opens the export. `crm-csv`
 *    guarded it; `report-export` did not, which meant the reports export was
 *    the unguarded door. Guarded here, once, for every export in the product.
 *  - **The BOM.** Excel writes `\uFEFF`; unstripped it becomes part of the
 *    first header name and the importer says "no name column" about a file
 *    that has one.
 *  - **Delimiters.** A Persian Windows Excel writes `;` because the locale's
 *    list separator is a semicolon. `menu-import` auto-detected it; the other
 *    two did not, so the same file imported into the menu and failed into the
 *    CRM.
 *  - **Persian digits.** «۰۹۱۲…» has to normalise before anything compares it.
 *
 * Everything below is pure string/buffer work except the exceljs and unpdf
 * calls, which are lazily imported so that a CSV-only request never pays for
 * them — the same lazy shape `ai-attachment.ts` uses for `unpdf`.
 */

import { toPersianDigits } from "../digits";
import { formatJalali } from "../jalali";
import type { FieldType } from "./types";

// The CSV, digit and header helpers live in ./csv, which is client-safe and
// imported directly by browser components. Re-exported here so every server
// consumer keeps its existing import path.
export {
  csvCell,
  detectDelimiter,
  mapHeaders,
  normaliseHeader,
  parseCsv,
  toCsv,
  westernDigits,
} from "./csv";
export type { CsvDelimiter } from "./csv";

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** One sheet of an Excel export. */
export interface SheetData {
  name: string;
  columns: { key: string; label: string; type?: FieldType }[];
  rows: Record<string, unknown>[];
}

/** One parsed worksheet from a provider workbook. */
export interface ParsedWorkbookSheet {
  name: string;
  columns: string[];
  rows: string[][];
}

/**
 * Excel (.xlsx) → string rows. First worksheet, first row = header.
 *
 * Kept as the backward-compatible generic convenience API. In particular,
 * it keeps the original worksheet and row shape; provider adapters that need
 * the relational workbook should use `xlsxToWorkbook` instead.
 */
export async function xlsxToRows(buffer: ArrayBuffer): Promise<string[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  return sheet ? worksheetToRows(sheet) : [];
}

/**
 * Parse every worksheet in an Excel workbook. The first non-empty row is the
 * header; body rows are padded to the workbook sheet's widest row so provider
 * validation never silently shifts or drops a trailing cell.
 */
export async function xlsxToWorkbook(buffer: ArrayBuffer): Promise<ParsedWorkbookSheet[]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.worksheets.map((sheet) => {
    const parsed = worksheetToRows(sheet, true);
    if (parsed.length === 0) return { name: sheet.name, columns: [], rows: [] };
    const width = parsed.reduce((max, row) => Math.max(max, row.length), parsed[0].length);
    const columns = Array.from({ length: width }, (_, index) => (parsed[0][index] ?? "").trim());
    const rows = parsed.slice(1).map((row) =>
      Array.from({ length: width }, (_, index) => row[index] ?? ""),
    );
    return { name: sheet.name, columns, rows };
  });
}

function worksheetToRows(sheet: import("exceljs").Worksheet, rejectUnsafeNumbers = false): string[][] {
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    // row.values is 1-based; index 0 is always empty. Keep this behavior for
    // xlsxToRows so generic one-sheet imports remain compatible.
    const values = row.values as unknown[];
    for (let i = 1; i < values.length; i += 1) {
      const value = values[i];
      if (rejectUnsafeNumbers && typeof value === "number" && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new Error("xlsx_unsafe_numeric_value");
      }
      cells.push(xlsxCellToString(value));
    }
    rows.push(cells);
  });
  return rows;
}

function xlsxCellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("result" in record && record.result !== undefined) return String(record.result);
    if ("richText" in record && Array.isArray(record.richText)) {
      return (record.richText as { text: string }[]).map((part) => part.text).join("");
    }
    if ("text" in record) return String(record.text);
    if ("hyperlink" in record && "text" in record) return String(record.text);
    return "";
  }
  return String(value);
}

/**
 * Sheets → an .xlsx buffer, right-to-left, bold header, sensible widths.
 *
 * Multi-sheet because a relational export ("customers, and their deals") is
 * one workbook with two sheets rather than two downloads. Sheet names are
 * clipped to Excel's 31-character limit and stripped of the characters Excel
 * refuses (`[]:*?/\`), which it otherwise rejects by refusing to open the
 * whole file.
 */
export async function sheetsToXlsxBuffer(sheets: readonly SheetData[]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const sheet of sheets) {
    const name = uniqueSheetName(sheet.name, used);
    const worksheet = workbook.addWorksheet(name, { views: [{ rightToLeft: true }] });
    worksheet.columns = sheet.columns.map((column) => ({
      header: column.label,
      key: column.key,
      width: Math.min(Math.max(column.label.length + 4, 14), 60),
      style: column.type === "date"
        ? { numFmt: "yyyy-mm-dd" }
        : column.type === "money" || column.type === "number" || column.type === "integer"
          ? { numFmt: "#,##0.########" }
          : undefined,
    }));
    worksheet.getRow(1).font = { bold: true };
    for (const row of sheet.rows) {
      worksheet.addRow(
        Object.fromEntries(sheet.columns.map((column) => [column.key, row[column.key] ?? ""])),
      );
    }
  }
  // A workbook with no sheet at all is a file Excel refuses to open, which
  // reads to the operator as "the export is broken" rather than "there was
  // nothing to export".
  if (sheets.length === 0) workbook.addWorksheet("خالی", { views: [{ rightToLeft: true }] });
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function uniqueSheetName(raw: string, used: Set<string>): string {
  const base = (raw.replace(/[[\]:*?/\\]/g, " ").trim() || "داده").slice(0, 31);
  let name = base;
  let n = 2;
  while (used.has(name)) {
    const suffix = ` ${n}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * JSON → rows.
 *
 * Accepts the three shapes a real file arrives in: a bare array of objects, a
 * `{ "data": [...] }` / `{ "rows": [...] }` / `{ "items": [...] }` envelope,
 * and a single object (one row). The union of every object's keys becomes the
 * header, in first-seen order, so a file whose later rows carry extra fields
 * does not silently lose them.
 */
export function jsonToRows(text: string): string[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("json_parse_failed");
  }
  const list = jsonRecordList(parsed);
  if (list.length === 0) return [];

  const columns: string[] = [];
  for (const record of list) {
    for (const key of Object.keys(record)) if (!columns.includes(key)) columns.push(key);
  }
  const rows: string[][] = [columns];
  for (const record of list) {
    rows.push(columns.map((key) => jsonCellToString(record[key])));
  }
  return rows;
}

function jsonRecordList(parsed: unknown): Record<string, unknown>[] {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed)) {
    for (const key of ["data", "rows", "items", "records"]) {
      const value = parsed[key];
      if (Array.isArray(value)) return value.filter(isRecord);
    }
    return [parsed];
  }
  return [];
}

function jsonCellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => jsonCellToString(v)).join("، ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Rows of records → a pretty-printed JSON document. */
export function toJsonDocument(
  columns: readonly { key: string; label: string }[],
  rows: readonly Record<string, unknown>[],
): string {
  return `${JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null]))),
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// PDF (extraction)
// ---------------------------------------------------------------------------

/**
 * Best-effort table extraction from a PDF.
 *
 * A PDF has no table structure — it has glyphs at coordinates — so this is
 * explicitly a *best effort*, and the UI says so rather than pretending
 * otherwise. `textTableToRows` below is the heuristic, and it is deliberately
 * two-pass because real extractors disagree about whitespace:
 *
 *  1. Split on runs of two or more spaces (or a tab). Some extractors preserve
 *     a table's column gutters that way, and when they do it is unambiguous —
 *     a value containing a single space stays one cell.
 *  2. If that finds no table, split on single spaces. pdf.js — which `unpdf`
 *     wraps, and which is what actually runs here — normalises runs of
 *     whitespace down to one space, so a price list extracts as
 *     `"A-1 espresso 85000"` and pass one finds nothing at all.
 *
 * Either way, the modal column count is taken to be the table's width and
 * every line that disagrees is dropped as prose, headers or page furniture.
 * Pass two cannot tell a two-word product name from two columns; that is an
 * inherent limit of the format, which is why the operator still maps and
 * previews before anything is written.
 *
 * `unpdf` is imported lazily, exactly as `ai-attachment.ts` does it: it is a
 * heavy dependency and a CSV import must not pay for it.
 */
export async function pdfToRows(buffer: ArrayBuffer): Promise<string[][]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(document, { mergePages: true });
  const source = Array.isArray(text) ? text.join("\n") : text;
  return textTableToRows(source);
}

/**
 * The pure half of `pdfToRows`, so the heuristic is unit-testable without a
 * PDF fixture.
 */
export function textTableToRows(source: string): string[][] {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\u00A0/g, " ").trim())
    .filter((line) => line.length > 0);

  // Pass one: real gutters. Pass two: pdf.js's normalised single spaces.
  const wide = pickModalTable(lines.map((line) => splitCells(line, /\t|\s{2,}/)));
  if (wide.length >= 2) return wide;
  return pickModalTable(lines.map((line) => splitCells(line, /\s+/)));
}

function splitCells(line: string, separator: RegExp): string[] {
  return line
    .split(separator)
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

/**
 * The rows whose column count is the page's modal one.
 *
 * Anything else is prose, a heading or a page number. Ties go to the wider
 * shape: a spurious two-column reading of a sentence is far more likely than a
 * spurious five-column one.
 */
function pickModalTable(candidates: string[][]): string[][] {
  const counts = new Map<number, number>();
  for (const row of candidates) {
    if (row.length < 2) continue;
    counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  let width = 0;
  let best = 0;
  for (const [candidateWidth, count] of counts) {
    if (count > best || (count === best && candidateWidth > width)) {
      width = candidateWidth;
      best = count;
    }
  }
  // One matching line is a coincidence, not a table: a header with no body is
  // nothing to import, and returning it would produce an empty job whose
  // column list is somebody's sentence.
  if (best < 2) return [];
  return candidates.filter((row) => row.length === width);
}

// ---------------------------------------------------------------------------
// Display coercion shared by every writer
// ---------------------------------------------------------------------------

/**
 * A value as it should appear in a file a human opens.
 *
 * Dates become Shamsi — the repo's standing rule, and it applies to exports
 * exactly as it does to screens. jsonb and arrays are rendered rather than
 * left to stringify into `[object Object]`.
 */
export function displayCell(value: unknown): string | number {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return toPersianDigits(formatJalali(value));
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "بله" : "خیر";
  if (Array.isArray(value)) return value.map((v) => String(displayCell(v))).join("، ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
