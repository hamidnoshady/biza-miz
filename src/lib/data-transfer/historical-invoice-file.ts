/**
 * Precision-safe input for historical invoice staging. This is deliberately
 * separate from the generic coercing codecs: identifiers and amounts are
 * source evidence, not JavaScript numbers. Not an import/approval endpoint.
 *
 * JSON numeric literals are read directly from their original bytes, never a
 * JavaScript number. XLSX cells must be text (or empty); reject formulas,
 * numeric and date cells whose original precision Excel may have lost.
 */
import { detectDelimiter } from "./csv";
import type { HistoricalRawRow } from "./historical-invoice-mapping";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 512;
const MAX_CELL = 100_000;
const MAX_SHEETS = 10;

export class HistoricalFileError extends Error {
  constructor(readonly code: string) { super(code); this.name = "HistoricalFileError"; }
}

export interface HistoricalFileSheet {
  name: string;
  columns: string[];
  rows: HistoricalRawRow[];
}

type SourceRow = { rowNumber: number; cells: string[] };

function sheet(name: string, source: SourceRow[]): HistoricalFileSheet {
  if (!source.length) throw new HistoricalFileError("empty_file");
  const columns = source[0].cells.map((cell) => cell.trim());
  if (!columns.length || columns.length > MAX_COLUMNS || columns.some((v) => !v || v.length > MAX_CELL)) {
    throw new HistoricalFileError("invalid_headers");
  }
  if (new Set(columns).size !== columns.length) throw new HistoricalFileError("duplicate_source_columns");
  if (source.length - 1 > MAX_ROWS) throw new HistoricalFileError("too_many_rows");
  const rows = source.slice(1).map(({ rowNumber, cells }) => {
    if (cells.length > columns.length) throw new HistoricalFileError("row_wider_than_header");
    const raw: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [i, key] of columns.entries()) {
      const value = cells[i] ?? "";
      if (value.length > MAX_CELL) throw new HistoricalFileError("cell_too_long");
      raw[key] = value;
    }
    return { rowNumber, raw };
  });
  if (!rows.length) throw new HistoricalFileError("no_rows");
  return { name, columns, rows };
}

/** CSV parser that preserves physical row numbers and rejects malformed quoting. */
function csvRows(input: string): SourceRow[] {
  const text = input.replace(/^\uFEFF/, "");
  const sep = detectDelimiter(text);
  const rows: SourceRow[] = [];
  let cells: string[] = [], cell = "", line = 1, start = 1;
  let quoted = false, closed = false;
  const pushCell = () => {
    if (cell.length > MAX_CELL) throw new HistoricalFileError("cell_too_long");
    cells.push(cell); cell = ""; closed = false;
    if (cells.length > MAX_COLUMNS) throw new HistoricalFileError("too_many_columns");
  };
  const pushRow = () => {
    pushCell();
    if (cells.some((v) => v.trim())) rows.push({ rowNumber: start, cells });
    if (rows.length > MAX_ROWS + 1) throw new HistoricalFileError("too_many_rows");
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else {
        if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
        cell += c;
      }
    } else if (c === '"') {
      if (cell || closed) throw new HistoricalFileError("invalid_csv_quote");
      quoted = true;
    } else if (c === sep) pushCell();
    else if (c === "\n" || c === "\r") {
      pushRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
      line++; start = line;
    } else {
      if (closed) throw new HistoricalFileError("invalid_csv_quote");
      cell += c;
    }
    if (cell.length > MAX_CELL) throw new HistoricalFileError("cell_too_long");
  }
  if (quoted) throw new HistoricalFileError("invalid_csv_quote");
  if (cell || cells.length || closed) pushRow();
  return rows;
}

/** Strict JSON parser: detects duplicate keys and retains numeric literals as text. */
function jsonValue(text: string): unknown {
  let i = 0;
  const ws = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i])) i++; };
  const string = (): string => {
    if (text[i] !== '"') throw new HistoricalFileError("invalid_json");
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === '"') {
        try { return JSON.parse(text.slice(start, i)) as string; }
        catch { throw new HistoricalFileError("invalid_json"); }
      }
    }
    throw new HistoricalFileError("invalid_json");
  };
  const parse = (depth: number): unknown => {
    if (depth > 4) throw new HistoricalFileError("invalid_json_shape");
    ws();
    if (text[i] === '"') return string();
    if (text.startsWith("null", i)) { i += 4; return null; }
    if (text[i] === "[" ) {
      i++; ws(); const list: unknown[] = [];
      if (text[i] === "]") { i++; return list; }
      while (true) {
        list.push(parse(depth + 1));
        if (list.length > MAX_ROWS) throw new HistoricalFileError("too_many_rows");
        ws(); if (text[i] === "]") { i++; return list; }
        if (text[i++] !== ",") throw new HistoricalFileError("invalid_json");
      }
    }
    if (text[i] === "{") {
      i++; ws(); const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (text[i] === "}") { i++; return object; }
      while (true) {
        ws(); const key = string();
        if (Object.hasOwn(object, key)) throw new HistoricalFileError("duplicate_source_columns");
        if (Object.keys(object).length >= MAX_COLUMNS) throw new HistoricalFileError("too_many_columns");
        ws(); if (text[i++] !== ":") throw new HistoricalFileError("invalid_json");
        object[key] = parse(depth + 1);
        ws(); if (text[i] === "}") { i++; return object; }
        if (text[i++] !== ",") throw new HistoricalFileError("invalid_json");
      }
    }
    const numeric = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (numeric) {
      i += numeric[0].length;
      return numeric[0];
    }
    throw new HistoricalFileError("invalid_json");
  };
  const parsed = parse(0); ws();
  if (i !== text.length) throw new HistoricalFileError("invalid_json");
  return parsed;
}

function jsonRows(input: string): SourceRow[] {
  let data = jsonValue(input.replace(/^\uFEFF/, ""));
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && ["data", "rows", "items", "records"].includes(keys[0]) && Array.isArray(obj[keys[0]])) data = obj[keys[0]];
    else data = [obj];
  }
  if (!Array.isArray(data) || !data.length) throw new HistoricalFileError("invalid_json_shape");
  const columns: string[] = [];
  const known = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HistoricalFileError("invalid_json_shape");
    for (const [key, value] of Object.entries(item)) {
      if (typeof value !== "string" && value !== null) throw new HistoricalFileError("invalid_json_shape");
      if (!known.has(key)) {
        columns.push(key); known.add(key);
        if (columns.length > MAX_COLUMNS) throw new HistoricalFileError("too_many_columns");
      }
    }
  }
  return [{ rowNumber: 1, cells: columns }, ...data.map((item, index) => ({
    rowNumber: index + 2,
    cells: columns.map((key) => ((item as Record<string, string | null>)[key] ?? "")),
  }))];
}

async function xlsxSheets(buffer: ArrayBuffer): Promise<HistoricalFileSheet[]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { throw new HistoricalFileError("invalid_xlsx"); }
  if (workbook.worksheets.length > MAX_SHEETS) throw new HistoricalFileError("too_many_sheets");
  const sheets: HistoricalFileSheet[] = [];
  let totalRows = 0;
  for (const worksheet of workbook.worksheets) {
    const source: SourceRow[] = [];
    worksheet.eachRow((row, rowNumber) => {
      if (row.cellCount > MAX_COLUMNS) throw new HistoricalFileError("too_many_columns");
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        const value = cell.value;
        if (value === null || value === undefined) cells[column - 1] = "";
        else if (typeof value === "string") cells[column - 1] = value;
        else throw new HistoricalFileError("xlsx_cells_must_be_text");
      });
      if (cells.some((v) => v?.trim())) source.push({ rowNumber, cells });
      if (source.length > MAX_ROWS + 1) throw new HistoricalFileError("too_many_rows");
    });
    if (source.length) {
      const result = sheet(worksheet.name, source);
      totalRows += result.rows.length;
      if (totalRows > MAX_ROWS) throw new HistoricalFileError("too_many_rows");
      sheets.push(result);
    }
  }
  if (!sheets.length) throw new HistoricalFileError("empty_file");
  return sheets;
}

/** No writes. The caller selects/reviews sheets and mappings before staging. */
export async function parseHistoricalInvoiceFile(buffer: ArrayBuffer, format: "csv" | "json" | "xlsx"): Promise<HistoricalFileSheet[]> {
  if (!buffer.byteLength) throw new HistoricalFileError("empty_file");
  if (buffer.byteLength > MAX_BYTES) throw new HistoricalFileError("file_too_large");
  if (format === "xlsx") return xlsxSheets(buffer);
  if (format !== "csv" && format !== "json") throw new HistoricalFileError("unsupported_format");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new HistoricalFileError("invalid_utf8"); }
  return [sheet("", format === "csv" ? csvRows(text) : jsonRows(text))];
}
