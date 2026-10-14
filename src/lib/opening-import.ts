/**
 * Issue #867 — opening balances import from a file (CSV / XLSX), the pure
 * part.
 *
 * A file the accountant exports from the old system (or types by hand) is a
 * table: an account column, a debit, a credit, optionally a reference and a
 * note. This module turns that table into validated opening lines without
 * touching the database — account *resolution* (code or name → the tenant's
 * account id) is the service's job, everything here is string-in,
 * lines-out:
 *
 *  - the codec layer is the one in `data-transfer/codecs.ts` (quoting-aware
 *    CSV state machine, delimiter detection, BOM, the Excel reader) — no
 *    second parser;
 *  - amounts parse through the exact-money primitive in `money.ts`, in the
 *    business's **selected unit** (a Rial business's file says Rial; a Toman
 *    business's file says Toman). `parseToRialText` rejects decimals and
 *    signs instead of coercing them — a «1,500,000.50» cell is a problem the
 *    preview must show, never a silently truncated integer;
 *  - every row problem carries its row number, because the preview screen's
 *    whole job is telling the accountant which row to fix.
 */
import {
  detectDelimiter,
  mapHeaders,
  parseCsv,
  xlsxToRows,
} from "./data-transfer/codecs";
import { parseToRialText, type MoneyUnit } from "./money";
import { OPENING_LINES_MAX } from "./opening-balances";

/**
 * The headers a file may carry, in the forms the product meets in the wild:
 * Persian (the app's language) and English, folded through the codec's
 * `normaliseHeader` (so «كد» matches «کد»).
 */
export const OPENING_IMPORT_ALIASES: Record<string, readonly string[]> = {
  code: ["code", "account code", "account_code", "کد", "کد حساب", "کدحساب"],
  name: ["name", "account", "account name", "account_name", "حساب", "نام", "نام حساب", "نامحساب"],
  debit: ["debit", "بدهکار", "بدهی"],
  credit: ["credit", "بستانکار", "بستانداری"],
  reference: ["reference", "ref", "مرجع", "شماره مرجع"],
  note: ["note", "source note", "توضیح", "توضیحات", "منبع"],
};

/** One body row of the file, after parsing and validation. */
export interface ParsedOpeningImportLine {
  /** The row's number in the file, 1-based, header = row 1. */
  rowIndex: number;
  /** The account's code as written ("" when the file has no code column). */
  code: string;
  /** The account's name as written ("" when the file has no name column). */
  name: string;
  /** Debit, exact Rial integer text — storage is always Rial. */
  debit: string;
  /** Credit, exact Rial integer text. */
  credit: string;
  reference: string | null;
  note: string | null;
}

/** A row (or the file) the preview must show the accountant. */
export interface OpeningImportProblem {
  /** null = the file as a whole, not one row. */
  rowIndex: number | null;
  problem:
    | "unsupported_format"
    | "empty_file"
    | "unrecognised_headers"
    | "missing_account_column"
    | "missing_amount_columns"
    | "too_many_rows"
    | "invalid_amount"
    | "missing_account";
  detail?: string;
}

export interface ParsedOpeningImport {
  lines: ParsedOpeningImportLine[];
  problems: OpeningImportProblem[];
}

/**
 * Table (header + body rows, any width) → validated opening lines.
 *
 * `unit` is the business's selected money unit: the file's amounts are read
 * in that unit and stored as integer Rial. A row with an amount the money
 * primitive rejects (decimals, signs, garbage) is a problem, not a 0.
 */
export function parseOpeningImportTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  unit: MoneyUnit,
): ParsedOpeningImport {
  const problems: OpeningImportProblem[] = [];
  const lines: ParsedOpeningImportLine[] = [];

  const map = mapHeaders(headers, OPENING_IMPORT_ALIASES);
  const hasAccount = "code" in map || "name" in map;
  const hasAmount = "debit" in map || "credit" in map;
  if (!hasAccount) {
    problems.push({ rowIndex: null, problem: "missing_account_column" });
  }
  if (!hasAmount) {
    problems.push({ rowIndex: null, problem: "missing_amount_columns" });
  }
  if (!hasAccount || !hasAmount) {
    problems.push({ rowIndex: null, problem: "unrecognised_headers" });
    return { lines, problems };
  }

  if (rows.length > OPENING_LINES_MAX) {
    problems.push({ rowIndex: null, problem: "too_many_rows", detail: String(OPENING_LINES_MAX) });
  }

  const cell = (row: readonly string[], field: string): string => {
    const index = map[field];
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rowIndex = i + 2; // header is row 1

    const code = cell(row, "code");
    const name = cell(row, "name");
    if (code === "" && name === "") continue; // a blank line in the middle
    if (code === "" && name === "") {
      problems.push({ rowIndex, problem: "missing_account" });
    }

    const parseAmount = (field: string): { text: string; bad: boolean } => {
      const text = cell(row, field);
      if (text === "") return { text: "0", bad: false };
      try {
        const rial = parseToRialText(text, unit);
        // A minus sign parses — the money primitive tolerates it for signed
        // nets — but a debit or credit column has no sign: negative money in
        // either side is a row to fix, not a number to store.
        if (rial.startsWith("-")) return { text: "0", bad: true };
        return { text: rial, bad: false };
      } catch {
        return { text: "0", bad: true };
      }
    };
    const debit = parseAmount("debit");
    const credit = parseAmount("credit");
    if (debit.bad || credit.bad) {
      problems.push({
        rowIndex,
        problem: "invalid_amount",
        detail: `${debit.bad ? "بدهکار" : ""}${debit.bad && credit.bad ? " و " : ""}${credit.bad ? "بستانکار" : ""} = «${
          debit.bad ? cell(row, "debit") : ""
        }${debit.bad && credit.bad ? "، " : ""}${credit.bad ? cell(row, "credit") : ""}»`,
      });
      continue;
    }

    lines.push({
      rowIndex,
      code,
      name,
      debit: debit.text,
      credit: credit.text,
      reference: cell(row, "reference") || null,
      note: cell(row, "note") || null,
    });
  }

  return { lines, problems };
}

/**
 * A file's bytes → header + body rows, through the one codec layer.
 *
 * CSV is decoded UTF-8 (the BOM is stripped by `parseCsv`); XLSX is read by
 * the shared Excel reader (first worksheet). Anything else is a problem, not
 * a guess. `xlsxToRows` loads through exceljs, hence async.
 */
export async function openingImportTableFromBuffer(
  filename: string,
  buffer: Buffer,
): Promise<{ headers: string[]; rows: string[][] } | { problem: OpeningImportProblem }> {
  const lower = filename.toLowerCase();
  let parsed: string[][];
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = buffer.toString("utf8");
    parsed = parseCsv(text, detectDelimiter(text));
  } else if (lower.endsWith(".xlsx")) {
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    parsed = await xlsxToRows(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
  } else {
    return { problem: { rowIndex: null, problem: "unsupported_format", detail: filename } };
  }
  if (parsed.length === 0) return { problem: { rowIndex: null, problem: "empty_file" } };
  return { headers: parsed[0], rows: parsed.slice(1) };
}
