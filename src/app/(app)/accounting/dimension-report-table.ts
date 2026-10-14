/**
 * The tabular form of the dimension reports, shared by the screen and the CSV
 * export. One function per report turns its figures into headers and rows; the
 * screen draws them and the export writes them, so a column can never be on
 * screen and missing from the file (or the reverse).
 *
 * Amounts stay exact Rial numbers here, and are formatted by the caller through
 * the business's money unit. Dates are formatted as Shamsi (the repo's rule), and
 * the calendar stays Gregorian in storage.
 */
import { formatJalali } from "@/lib/jalali";
import type { DimensionKind } from "@/lib/accounting-dimensions";
import { JOURNAL_DIMENSION_PARAMS } from "@/lib/journal-filters";
import { accountingSectionHref } from "./accounting-routes";

export interface PlainTable {
  headers: string[];
  rows: (string | number)[][];
}

/** The part of a matrix report the table needs. */
export interface MatrixTableInput {
  columns: { valueId: string | null; code: string | null; name: string }[];
  rows: { code: string; name: string; cells: Record<string, number>; total: number }[];
  columnTotals: Record<string, number>;
  grandTotal: number;
}

/** The part of a profit-by-dimension report the table needs. */
export interface ProfitTableInput {
  groups: {
    code: string | null;
    name: string;
    revenue: number;
    costOfSales: number;
    grossProfit: number;
    laborCost: number;
    operatingExpenses: number;
    netIncome: number;
  }[];
  total: {
    revenue: number;
    costOfSales: number;
    grossProfit: number;
    laborCost: number;
    operatingExpenses: number;
    netIncome: number;
  };
}

/** The part of an account statement the card table needs. */
export interface CardTableInput {
  openingBalance: number;
  closingBalance: number;
  lines: { date: string; memo: string | null; debit: number; credit: number; balance: number }[];
}

/** A column header: the value's code and name, or «بدون بُعد» for the unassigned column. */
/**
 * The journal page a matrix cell drills into (issue #868): the lines of one
 * account, at one value of the kind, over the period the report was run for. The
 * journal already reads these parameters from the URL, so the link is the whole
 * drill-down, and the reader lands on the figure the cell showed. The unassigned
 * column has no link: the journal filters by a value, not by the absence of one.
 */
export function matrixCellDrillHref(input: {
  kind: DimensionKind;
  accountId: string;
  valueId: string | null;
  dateFrom: string;
  dateTo: string;
}): string | null {
  if (input.valueId === null) return null;
  const params = new URLSearchParams({
    account: input.accountId,
    [JOURNAL_DIMENSION_PARAMS[input.kind]]: input.valueId,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
  });
  return `${accountingSectionHref("entries")}?${params.toString()}`;
}

/** The part of a matrix report a drill-down needs: each row names its account. */
export interface MatrixDrillInput {
  columns: MatrixTableInput["columns"];
  rows: (MatrixTableInput["rows"][number] & { accountId: string })[];
}

/**
 * The journal link behind one body cell of a matrix table (issue #868). Body
 * rows are `[code, name, ...value columns, total]`, so a cell's value column is
 * two places back from its index. Only a non-zero cell in a value column links:
 * the code, the name, the total and the totals row have nothing to drill into.
 */
export function matrixCellDrill(input: {
  report: MatrixDrillInput;
  kind: DimensionKind;
  period: { dateFrom: string; dateTo: string };
  rowIndex: number;
  cellIndex: number;
  columnKeyOf: (valueId: string | null) => string;
}): string | null {
  const row = input.report.rows[input.rowIndex];
  const column = input.report.columns[input.cellIndex - 2];
  if (!row || !column) return null;
  if ((row.cells[input.columnKeyOf(column.valueId)] ?? 0) === 0) return null;
  return matrixCellDrillHref({
    kind: input.kind,
    accountId: row.accountId,
    valueId: column.valueId,
    dateFrom: input.period.dateFrom,
    dateTo: input.period.dateTo,
  });
}

export function matrixColumnTitle(column: MatrixTableInput["columns"][number]): string {
  if (column.valueId === null) return column.name;
  return column.code ? `${column.code} · ${column.name}` : column.name;
}

export function matrixTable(report: MatrixTableInput, columnKeyOf: (valueId: string | null) => string): PlainTable {
  const headers = ["کد حساب", "نام حساب", ...report.columns.map(matrixColumnTitle), "جمع"];
  const rows: (string | number)[][] = report.rows.map((row) => [
    row.code,
    row.name,
    ...report.columns.map((column) => row.cells[columnKeyOf(column.valueId)] ?? 0),
    row.total,
  ]);
  rows.push([
    "",
    "جمع کل",
    ...report.columns.map((column) => report.columnTotals[columnKeyOf(column.valueId)] ?? 0),
    report.grandTotal,
  ]);
  return { headers, rows };
}

export function profitTable(report: ProfitTableInput): PlainTable {
  const headers = ["مرکز", "درآمد", "بهای تمام‌شده", "سود ناخالص", "هزینهٔ حقوق", "سایر هزینه‌ها", "سود خالص"];
  const rows: (string | number)[][] = report.groups.map((g) => [
    g.code ? `${g.code} · ${g.name}` : g.name,
    g.revenue,
    g.costOfSales,
    g.grossProfit,
    g.laborCost,
    g.operatingExpenses,
    g.netIncome,
  ]);
  rows.push([
    "جمع",
    report.total.revenue,
    report.total.costOfSales,
    report.total.grossProfit,
    report.total.laborCost,
    report.total.operatingExpenses,
    report.total.netIncome,
  ]);
  return { headers, rows };
}

export function cardTable(card: CardTableInput): PlainTable {
  const headers = ["تاریخ", "شرح سند", "بدهکار", "بستانکار", "مانده"];
  const rows: (string | number)[][] = [["", "مانده اول دوره", "", "", card.openingBalance]];
  for (const line of card.lines) {
    rows.push([formatJalali(line.date), line.memo ?? "", line.debit, line.credit, line.balance]);
  }
  rows.push(["", "مانده پایان دوره", "", "", card.closingBalance]);
  return { headers, rows };
}
