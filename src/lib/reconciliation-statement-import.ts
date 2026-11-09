import { parseCsv } from "./data-transfer/csv";
import { toLatinDigits } from "./digits";
import { isValidIsoDate } from "./iso-date";

export const MAX_STATEMENT_IMPORT_BYTES = 64 * 1024;
export const MAX_STATEMENT_IMPORT_ROWS = 500;

export interface ImportedStatementLine {
  rowNumber: number;
  date: string;
  amountRial: string;
}

export type StatementMatchPreviewLine = ImportedStatementLine & {
  status: "matched" | "ambiguous" | "unmatched";
  journalLineId: string | null;
  entryId: string | null;
};

/** Canonical manual CSV. A positive amount is money in, a negative one money out. */
export function parseStatementImport(csv: string):
  { ok: true; lines: ImportedStatementLine[] } |
  { ok: false; error: string; rowNumber?: number } {
  // The two supported fields cannot contain newlines or literal quotes. Keep
  // physical line numbers so a malformed row can be found in the original file.
  const [headerRow, ...dataRows] = csv.replace(/^\uFEFF/, "").split(/\r?\n/)
    .map((value, index) => ({ value, rowNumber: index + 1 }))
    .filter(({ value }) => value.trim());
  const rows = dataRows.map(({ value, rowNumber }) => ({
    rowNumber,
    cells: /^\s*(?:"[^"]*"|[^",]*)\s*,\s*(?:"[^"]*"|[^",]*)\s*$/.test(value)
      ? parseCsv(value, ",")[0] ?? []
      : [],
  }));
  const header = headerRow && parseCsv(headerRow.value, ",")[0];
  if (!header || header.length !== 2 || header[0].trim() !== "date" || header[1].trim() !== "amount_rial") {
    return { ok: false, error: "invalid_statement_header" };
  }
  if (rows.length === 0 || rows.length > MAX_STATEMENT_IMPORT_ROWS) {
    return { ok: false, error: "invalid_statement_row_count" };
  }
  const lines: ImportedStatementLine[] = [];
  for (const { cells, rowNumber } of rows) {
    const [date, amount] = cells.map((cell) => toLatinDigits(cell.trim()));
    if (cells.length !== 2 || !isValidIsoDate(date) || !/^-?\d{1,19}$/.test(amount)) {
      return { ok: false, error: "invalid_statement_row", rowNumber };
    }
    const rial = BigInt(amount);
    if (rial === 0n || rial < -9223372036854775808n || rial > 9223372036854775807n) {
      return { ok: false, error: "invalid_statement_row", rowNumber };
    }
    lines.push({ rowNumber, date, amountRial: rial.toString() });
  }
  return { ok: true, lines };
}
