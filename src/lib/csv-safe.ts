/**
 * Spreadsheet-safe CSV text — Issue #829.
 *
 * Escaping quotes is not enough: a cell whose first character is `=`, `+`,
 * `-` or `@` is interpreted as a formula by Excel/Sheets when the CSV is
 * opened by double-click. Party names, memos and references are untrusted
 * input (a supplier named `=cmd|...` is a stored formula), so every textual
 * cell is passed through `sanitizeCsvText` before it is quoted.
 *
 * The fix is the standard one: prefix a single quote when the trimmed text
 * starts with a formula character (or is a DDE-looking `cmd|...`). Numeric
 * amount cells are never passed through here — they stay numeric so a
 * spreadsheet can add the column up.
 *
 * Framework-free so the browser export and the server export share it.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_LEADERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

function startsWithFormulaLeader(trimmed: string): boolean {
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  if (FORMULA_LEADERS.has(first)) return true;
  // DDE without a leader (`cmd|'/c ...'`) — rare, but the same payload shape.
  if (/^[A-Za-z]+\|/.test(trimmed)) return true;
  return false;
}

/**
 * Makes untrusted text safe to place in a CSV cell.
 *
 * Returns the text unchanged unless it would be interpreted as a formula,
 * in which case it is prefixed with a single quote (the value a person reads
 * is unchanged; the spreadsheet treats the cell as text).
 */
export function sanitizeCsvText(value: string): string {
  const text = String(value ?? "");
  if (!startsWithFormulaLeader(text.trimStart())) return text;
  return `'${text}`;
}

/** Quotes one CSV cell (doubled quotes, wrapped in quotes). */
export function quoteCsvCell(value: string): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

/** One CSV row from already-sanitized cells. */
export function csvRow(cells: readonly string[]): string {
  return cells.map(quoteCsvCell).join(",");
}

/**
 * Builds a complete CSV document (LF-joined, no trailing newline).
 * Text cells must already be sanitized by the caller; this only quotes.
 */
export function buildCsv(head: readonly string[], body: readonly (readonly string[])[]): string {
  return [head, ...body].map(csvRow).join("\n");
}
