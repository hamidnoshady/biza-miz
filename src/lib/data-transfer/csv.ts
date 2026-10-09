/**
 * Client-safe CSV helpers: digit normalisation, delimiter detection, parsing,
 * cell quoting and rendering, and header matching.
 *
 * This file is split out of `codecs.ts` on purpose and must stay free of
 * imports. Client components (the accounting dimension report panel exports
 * CSV from the browser) import it directly. `codecs.ts` pulls in exceljs and
 * unpdf, and every dynamic import reachable from client code is emitted as a
 * static chunk, so importing `codecs.ts` from a page ships both libraries to
 * every visitor even though they never run there. The
 * `csv.test.ts` guard fails if an import is added here.
 *
 * `codecs.ts` re-exports everything below, so server consumers are unchanged.
 */

// ---------------------------------------------------------------------------
// Digits
// ---------------------------------------------------------------------------

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Persian/Arabic-Indic digits to ASCII, leaving everything else alone. */
export function westernDigits(input: string): string {
  let out = "";
  for (const char of input) {
    const p = PERSIAN_DIGITS.indexOf(char);
    if (p >= 0) {
      out += String(p);
      continue;
    }
    const a = ARABIC_DIGITS.indexOf(char);
    out += a >= 0 ? String(a) : char;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** The delimiter a CSV file uses. Detected, never assumed. */
export type CsvDelimiter = "," | ";" | "\t";

/**
 * Which delimiter the file's first non-empty line is built from.
 *
 * Counted on the header line only, and only outside quotes: a header of
 * `name,"a;b;c;d",phone` must not be read as semicolon-delimited because one
 * quoted cell happens to contain four of them.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const firstLine = firstNonEmptyLine(text);
  const candidates: CsvDelimiter[] = [",", ";", "\t"];
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function firstNonEmptyLine(text: string): string {
  const stripped = text.replace(/^\uFEFF/, "");
  let line = "";
  let quoted = false;
  for (const char of stripped) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === "\n" || char === "\r")) {
      if (line.trim()) return line;
      line = "";
      continue;
    }
    line += char;
  }
  return line;
}

function countOutsideQuotes(line: string, needle: string): number {
  let count = 0;
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === needle) count += 1;
  }
  return count;
}

/**
 * Parse CSV text into rows of cells.
 *
 * A real state machine rather than a regex or a split, because quoting is not
 * expressible in either: `"" `is an escaped quote, a quoted field may span
 * lines, and `شرکت الف، شعبهٔ ۲` must survive being a single cell.
 */
export function parseCsv(text: string, delimiter?: CsvDelimiter): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const sep = delimiter ?? detectDelimiter(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === sep) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  // A file ending in "\n\n" is not a row of one empty cell, and importing it
  // as a nameless customer is nobody's intent.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Quote one cell for output.
 *
 * The leading apostrophe on a formula-looking cell is the part that matters:
 * Excel evaluates a cell beginning `=`, `+`, `-` or `@`, so an exported value
 * of `=cmd|...` runs on the machine of whoever opens the file. Prefixing makes
 * it inert text and is the standard mitigation.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // A finite JS number cannot carry a formula, and prefixing a negative one
  // (`-1800000` → `'-1800000`) turned a balance-sheet overdraft into text a
  // spreadsheet will not add up. Only strings are neutralised.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r;\t]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/**
 * Render rows as a CSV document.
 *
 * Emits the BOM and CRLF, because the overwhelmingly common consumer is Excel
 * on Windows, which otherwise reads UTF-8 Persian as mojibake.
 */
export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * Map a parsed header row onto named fields.
 *
 * Matching is case-insensitive, whitespace-tolerant and digit-normalised,
 * because the file comes from a human: «تلفن», «موبایل», `phone` and `Phone `
 * all mean the same column, and rejecting three of them is pedantry the user
 * experiences as a broken importer.
 */
export function mapHeaders(
  header: readonly string[],
  aliases: Record<string, readonly string[]>,
): Record<string, number> {
  const normalised = header.map(normaliseHeader);
  const out: Record<string, number> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const index = normalised.findIndex((h) => names.some((n) => normaliseHeader(n) === h));
    if (index >= 0) out[field] = index;
  }
  return out;
}

/**
 * The comparison form of a header: ASCII digits, no surrounding space, no
 * internal runs of space, lower case, and the Arabic ي/ك folded onto the
 * Persian ی/ک (a file exported from an Arabic-locale Excel writes the former,
 * and «كد كالا» must match «کد کالا»).
 */
export function normaliseHeader(value: string): string {
  return westernDigits(value)
    .replace(/[\u064A\u0649]/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u200C\u200F\u200E]/g, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
