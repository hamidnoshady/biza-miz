/**
 * «گزارش ابعاد» — the arithmetic of the dimension reports, as pure functions.
 *
 * The database reads (`accounting-dimension-reports-service.ts`) hand these
 * functions pre-aggregated rows: one per (account, value) with BIGINT sums. What
 * is decided here is the part a report can get wrong without anyone noticing:
 *
 *   * which sign a figure is shown with (the account's own side, as the trial
 *     balance shows it, and the P&L's revenue-positive convention);
 *   * which column a line belongs to — exactly one, the value it carries, or
 *     «بدون بُعد» when it carries none, so every line lands in exactly one
 *     column and a total cannot be a sum of overlapping groups;
 *   * whether the report reconciles to the ledger it came from — the same
 *     accounts, the same dates, no dimension — and says so when it does not.
 *
 * The rule that makes these reports trustworthy is one sentence: a report groups
 * by ONE kind, and a filter by any number of kinds is an AND on the lines. Two
 * groupings of different kinds are never added together, because a line that
 * carries both would be counted twice.
 */
import {
  DIMENSION_COLUMN,
  UNASSIGNED_DIMENSION,
  naturalAmount,
  type DimensionFilter,
} from "./accounting-dimensions";
import { WELL_KNOWN_CODES, costOfSalesCodesForIndustry } from "./coa-template";
import type { Industry } from "./industries";

/** The key a column is stored under in a report's `cells` and `columnTotals`. */
export const UNASSIGNED_COLUMN_KEY = "unassigned" as const;

export function columnKey(valueId: string | null): string {
  return valueId ?? UNASSIGNED_COLUMN_KEY;
}

/**
 * The SQL predicate that keeps only the lines a filter names. The column comes
 * from a closed, whitelisted map by kind — never from the request — and the value
 * is bound through `bind`, so a value is always a parameter and never text.
 */
export function dimensionLinePredicate(
  filter: DimensionFilter | null | undefined,
  bind: (value: string) => string,
): string {
  if (!filter) return "TRUE";
  const column = DIMENSION_COLUMN[filter.kind];
  if (filter.valueId === UNASSIGNED_DIMENSION) return `jl.${column} IS NULL`;
  return `jl.${column} = ${bind(filter.valueId)}::uuid`;
}

/** A report's column header: one per value that has activity, plus the unassigned column. */
export interface DimensionColumn {
  valueId: string | null;
  code: string | null;
  name: string;
  isActive: boolean;
}

export interface MatrixAccountRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  normalBalance: "debit" | "credit";
  isContra: boolean;
  /** The line's value of the report's kind, or null for a line that carries none. */
  valueId: string | null;
  debit: bigint;
  credit: bigint;
}

export interface MatrixAccountTotal {
  accountId: string;
  debit: bigint;
  credit: bigint;
}

export interface MatrixRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  /** Signed as the account's own side of the ledger shows it. Keyed by `columnKey`. */
  cells: Record<string, number>;
  total: number;
}

export interface AccountDimensionMatrix {
  columns: DimensionColumn[];
  rows: MatrixRow[];
  columnTotals: Record<string, number>;
  grandTotal: number;
  /**
   * True when every account's cells add up to its own unfiltered total over the
   * same period. False means a line was lost or counted twice, and the report
   * must not be presented as correct.
   */
  reconciled: boolean;
}

/** The effective normal side of an account: a contra account shows the opposite of its type's side. */
export function effectiveNormalBalance(normalBalance: "debit" | "credit", isContra: boolean): "debit" | "credit" {
  if (!isContra) return normalBalance;
  return normalBalance === "debit" ? "credit" : "debit";
}

export function buildAccountDimensionMatrix(input: {
  rows: MatrixAccountRow[];
  accountTotals: MatrixAccountTotal[];
  values: ReadonlyArray<{ id: string; code: string; name: string; isActive: boolean }>;
}): AccountDimensionMatrix {
  const valueById = new Map(input.values.map((value) => [value.id, value]));

  // Columns: every value that has activity in the period, plus the unassigned
  // column when any line lacks a value. An archived value with no activity in
  // the period is left out — there is nothing to show under it.
  const activeValueIds = new Set<string>();
  let hasUnassigned = false;
  for (const row of input.rows) {
    if (row.valueId) activeValueIds.add(row.valueId);
    else hasUnassigned = true;
  }
  const columns: DimensionColumn[] = [];
  for (const id of activeValueIds) {
    const value = valueById.get(id);
    columns.push({
      valueId: id,
      code: value?.code ?? null,
      name: value?.name ?? "—",
      isActive: value?.isActive ?? false,
    });
  }
  columns.sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
  if (hasUnassigned) columns.push({ valueId: null, code: null, name: "بدون بُعد", isActive: true });

  const byAccount = new Map<string, MatrixRow>();
  const columnTotals: Record<string, number> = {};
  for (const column of columns) columnTotals[columnKey(column.valueId)] = 0;
  const grandSums = { value: 0 };

  for (const row of input.rows) {
    let matrixRow = byAccount.get(row.accountId);
    if (!matrixRow) {
      matrixRow = { accountId: row.accountId, code: row.code, name: row.name, type: row.type, cells: {}, total: 0 };
      byAccount.set(row.accountId, matrixRow);
    }
    const amount = Number(
      naturalAmount(row.debit, row.credit, effectiveNormalBalance(row.normalBalance, row.isContra)),
    );
    const key = columnKey(row.valueId);
    matrixRow.cells[key] = (matrixRow.cells[key] ?? 0) + amount;
    matrixRow.total += amount;
    columnTotals[key] = (columnTotals[key] ?? 0) + amount;
    grandSums.value += amount;
  }

  const rows = [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code));

  // Reconciliation: each account's cells must sum to what the account shows with
  // no dimension at all. The unfiltered totals come from the same period, so this
  // is the arithmetic proof that the columns partition the account's lines.
  const unfiltered = new Map(input.accountTotals.map((t) => [t.accountId, t]));
  const normalByAccount = new Map(
    input.rows.map((r) => [r.accountId, effectiveNormalBalance(r.normalBalance, r.isContra)]),
  );
  let reconciled = true;
  for (const row of rows) {
    const total = unfiltered.get(row.accountId);
    const normal = normalByAccount.get(row.accountId) ?? "debit";
    const expected = total ? Number(naturalAmount(total.debit, total.credit, normal)) : 0;
    if (expected !== row.total) reconciled = false;
  }

  return { columns, rows, columnTotals, grandTotal: grandSums.value, reconciled };
}

// ---------------------------------------------------------------------------
// Profit by dimension
// ---------------------------------------------------------------------------

export interface ProfitRow {
  valueId: string | null;
  accountId: string;
  code: string;
  type: string;
  debit: bigint;
  credit: bigint;
}

export interface ProfitGroup {
  valueId: string | null;
  code: string | null;
  name: string;
  isActive: boolean;
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  laborCost: number;
  operatingExpenses: number;
  totalExpenses: number;
  netIncome: number;
}

export interface DimensionProfitReport {
  groups: ProfitGroup[];
  /** The same figures summed over every group — equal to the unfiltered P&L when `reconciled`. */
  total: ProfitGroup;
  reconciled: boolean;
}

/**
 * Profit and loss per value of one kind. The classification is the one
 * `getProfitAndLoss` applies: a revenue account earns credit − debit, an expense
 * account costs debit − credit, cost of sales is the industry's COGS codes, and
 * labour is the salaries code. Using the same rules is what makes the groups add
 * up to the statement the business already reads.
 */
export function buildDimensionProfitReport(input: {
  rows: ProfitRow[];
  unfilteredRows: ProfitRow[];
  values: ReadonlyArray<{ id: string; code: string; name: string; isActive: boolean }>;
  industry: Industry | null;
}): DimensionProfitReport {
  const costOfSalesCodes = new Set<string>(costOfSalesCodesForIndustry(input.industry ?? "food_service"));
  const valueById = new Map(input.values.map((value) => [value.id, value]));

  const groups = new Map<string, ProfitGroup>();
  const groupFor = (valueId: string | null): ProfitGroup => {
    const key = columnKey(valueId);
    let group = groups.get(key);
    if (!group) {
      const value = valueId ? valueById.get(valueId) : undefined;
      group = {
        valueId,
        code: valueId ? (value?.code ?? null) : null,
        name: valueId ? (value?.name ?? "—") : "بدون بُعد",
        isActive: valueId ? (value?.isActive ?? false) : true,
        revenue: 0,
        costOfSales: 0,
        grossProfit: 0,
        laborCost: 0,
        operatingExpenses: 0,
        totalExpenses: 0,
        netIncome: 0,
      };
      groups.set(key, group);
    }
    return group;
  };

  for (const row of input.rows) {
    if (row.type !== "revenue" && row.type !== "expense") continue;
    const group = groupFor(row.valueId);
    const amount = Number(row.type === "revenue" ? row.credit - row.debit : row.debit - row.credit);
    if (row.type === "revenue") {
      group.revenue += amount;
    } else {
      group.totalExpenses += amount;
      if (costOfSalesCodes.has(row.code)) group.costOfSales += amount;
      if (row.code === WELL_KNOWN_CODES.salariesExpense) group.laborCost += amount;
    }
  }

  for (const group of groups.values()) {
    group.grossProfit = group.revenue - group.costOfSales;
    group.operatingExpenses = group.totalExpenses - group.costOfSales - group.laborCost;
    group.netIncome = group.revenue - group.totalExpenses;
  }

  const sorted = [...groups.values()].sort((a, b) => {
    if (a.valueId === null) return 1;
    if (b.valueId === null) return -1;
    return (a.code ?? "").localeCompare(b.code ?? "");
  });

  const total: ProfitGroup = {
    valueId: null,
    code: null,
    name: "جمع",
    isActive: true,
    revenue: 0,
    costOfSales: 0,
    grossProfit: 0,
    laborCost: 0,
    operatingExpenses: 0,
    totalExpenses: 0,
    netIncome: 0,
  };
  for (const group of sorted) {
    total.revenue += group.revenue;
    total.costOfSales += group.costOfSales;
    total.laborCost += group.laborCost;
    total.totalExpenses += group.totalExpenses;
  }
  total.grossProfit = total.revenue - total.costOfSales;
  total.operatingExpenses = total.totalExpenses - total.costOfSales - total.laborCost;
  total.netIncome = total.revenue - total.totalExpenses;

  // The unfiltered statement, computed from the same rows with no dimension.
  const unfiltered = buildUnfilteredProfit(input.unfilteredRows, costOfSalesCodes);
  const reconciled =
    unfiltered.revenue === total.revenue &&
    unfiltered.totalExpenses === total.totalExpenses &&
    unfiltered.costOfSales === total.costOfSales &&
    unfiltered.laborCost === total.laborCost;

  return { groups: sorted, total, reconciled };
}

function buildUnfilteredProfit(rows: ProfitRow[], costOfSalesCodes: Set<string>) {
  let revenue = 0;
  let totalExpenses = 0;
  let costOfSales = 0;
  let laborCost = 0;
  for (const row of rows) {
    if (row.type === "revenue") revenue += Number(row.credit - row.debit);
    else if (row.type === "expense") {
      const amount = Number(row.debit - row.credit);
      totalExpenses += amount;
      if (costOfSalesCodes.has(row.code)) costOfSales += amount;
      if (row.code === WELL_KNOWN_CODES.salariesExpense) laborCost += amount;
    }
  }
  return { revenue, totalExpenses, costOfSales, laborCost };
}
