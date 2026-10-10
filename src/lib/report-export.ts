/**
 * Report export — the tabular shape the report routes speak, rendered through
 * the platform's one codec layer.
 *
 * `ReportTable` ({columns, rows}) is deliberately still here: it is the shape
 * the export route builds from a raw view dump or an aggregated dim/value
 * query, and it is what decides which columns to show.
 *
 * What is no longer here is a second CSV writer and a second XLSX writer.
 * Both now delegate to `data-transfer/codecs.ts`, which is the single
 * implementation for the whole product. That is not only tidiness: the copy
 * this file used to carry had **no formula-injection guard**, so a report cell
 * beginning `=`, `+`, `-` or `@` was executed by Excel when the downloaded
 * file was opened. The shared writer neutralises it, and the reports export
 * inherited that fix by losing its private copy.
 */
import { displayCell, sheetsToXlsxBuffer, toCsv } from "./data-transfer/codecs";
import { toPersianDigits } from "./digits";
import { formatJalali, formatShiftWindow } from "./jalali";
import { formatMoney, moneyToInput, type MoneyUnit } from "./money";

export interface ReportColumn {
  key: string;
  label: string;
}

export interface ReportTable {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

/**
 * One cell, as it should appear in a file a human opens.
 *
 * Dates come back from the driver as JS `Date` objects and are shown in
 * Jalali, like everywhere else in the app (stored ISO/Gregorian, Shamsi is
 * display-only); jsonb and array columns are rendered rather than left to
 * stringify into `[object Object]`. All of that is `displayCell`'s job now —
 * the one addition here is the shift window, which is a reports-only string
 * format (`a~b`) that must show both times rather than the raw value.
 */
/** A `YYYY-MM-DD` held as text — how every reporting view emits a `date` column over JSON. */
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function cellValue(value: unknown): string | number {
  if (typeof value === "string") {
    const window = formatShiftWindow(value);
    if (window) return window;
    // A date column arrives from PostgreSQL as text (`sale_date::text`, a
    // date_trunc bucket), not as a JS Date, so `displayCell` cannot know to
    // convert it. Issue #819: the screen shows Jalali while CSV/Excel/PDF
    // showed «2026-08-11» for the same row — one report, five date labels.
    // Date-only strings are unambiguous, so they are Shamsi in every file,
    // exactly like the screen's formatDim.
    if (ISO_DATE_ONLY.test(value)) return toPersianDigits(formatJalali(value));
  }
  return displayCell(value);
}

/** UTF-8 BOM, CRLF, quoted cells, formula-injection guarded. */
export function rowsToCsv(table: ReportTable): string {
  return toCsv(
    table.columns.map((column) => column.label),
    table.rows.map((row) => table.columns.map((column) => cellValue(row[column.key]))),
  );
}

export async function rowsToXlsxBuffer(table: ReportTable, sheetName: string): Promise<Buffer> {
  return sheetsToXlsxBuffer([
    {
      name: sheetName,
      columns: table.columns,
      rows: table.rows.map((row) =>
        Object.fromEntries(table.columns.map((column) => [column.key, cellValue(row[column.key])])),
      ),
    },
  ]);
}

/**
 * The column header of a money column in a file a human opens: it names the
 * unit the numbers are in, the way the ledger statements already do
 * («مبلغ (تومان)»). A bare «فروش خالص» over a Rial integer reads as Toman to a
 * Toman business and is off by ten.
 */
export function moneyColumnLabel(label: string, unit: MoneyUnit): string {
  return `${label} (${unit === "rial" ? "ریال" : "تومان"})`;
}

/**
 * One money cell of a report export, in the business's selected unit.
 *
 * CSV and Excel get a plain number (so a spreadsheet can add the column up),
 * already converted to the unit the header names; the PDF gets the formatted
 * text the screen shows. Input is integer Rial, possibly as the numeric string
 * Postgres returns for a `sum`/`avg`; an average is rounded to the Rial first.
 */
export function moneyExportCell(rial: unknown, unit: MoneyUnit, format: "csv" | "excel" | "pdf"): string | number {
  if (rial === null || rial === undefined || rial === "") return "";
  const n = Math.round(Number(rial));
  if (!Number.isFinite(n)) return String(rial);
  return format === "pdf" ? formatMoney(n, unit) : moneyToInput(n, unit);
}

/**
 * A custom (dimension/metric) report as an export table. When the metric is an
 * amount of money its column is converted to the selected unit and labelled
 * with it; any other numeric value (a count) is handed over as a number rather
 * than the numeric string the driver produced, so Excel does not store it as
 * text.
 */
export function customReportTable(
  rows: { dim: unknown; value: unknown }[],
  labels: { dimensionLabel: string; metricLabel: string },
  money: { isMoney: boolean; unit: MoneyUnit; format: "csv" | "excel" | "pdf" },
): ReportTable {
  return {
    columns: [
      { key: "dim", label: labels.dimensionLabel },
      { key: "value", label: money.isMoney ? moneyColumnLabel(labels.metricLabel, money.unit) : labels.metricLabel },
    ],
    rows: rows.map((row) => ({
      dim: row.dim,
      value: money.isMoney
        ? moneyExportCell(row.value, money.unit, money.format)
        : typeof row.value === "string" && row.value.trim() !== "" && Number.isFinite(Number(row.value))
          ? Number(row.value)
          : row.value,
    })),
  };
}
