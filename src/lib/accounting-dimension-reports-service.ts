/**
 * «گزارش ابعاد» — the database half: reads the lines of a period, grouped by
 * one dimension kind, and hands them to the pure builders in
 * `accounting-dimension-reports.ts` for the arithmetic.
 *
 * Every query scopes to the business in its own WHERE clause (tenancy is not
 * left to row-level security alone), and the grouping column is chosen from a
 * closed map by kind, never from the request.
 */
import { query } from "./db";
import { isValidIsoDate } from "./iso-date";
import { getBusinessIndustry } from "./industry-guard";
import {
  DIMENSION_COLUMN,
  type DimensionKind,
} from "./accounting-dimensions";
import {
  buildAccountDimensionMatrix,
  buildDimensionProfitReport,
  buildDimensionRollup,
  type AccountDimensionMatrix,
  type DimensionProfitReport,
  type DimensionRollupReport,
  type DimensionRollupValue,
  type MatrixAccountRow,
  type MatrixAccountTotal,
  type ProfitRow,
} from "./accounting-dimension-reports";
import { listDimensionValuesUncapped } from "./accounting-dimensions-service";
import type { Industry } from "./industries";

export interface DimensionReportScope {
  kind: DimensionKind;
  /** Inclusive, ISO `YYYY-MM-DD`. */
  dateFrom: string;
  dateTo: string;
}

/** Refuses a scope that is not two real days in order, before any SQL runs. */
export function assertDimensionReportScope(scope: DimensionReportScope): void {
  if (!isValidIsoDate(scope.dateFrom) || !isValidIsoDate(scope.dateTo) || scope.dateFrom > scope.dateTo) {
    throw new Error("invalid_dimension_report_scope");
  }
}

interface MatrixSqlRow extends Record<string, unknown> {
  account_id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: "debit" | "credit";
  is_contra: boolean;
  value_id: string | null;
  debit: string;
  credit: string;
}

/**
 * Account × dimension matrix for one kind over a period. Optionally limited to
 * one account type (for example «expense» for expenses by cost centre).
 */
export async function getAccountDimensionMatrix(
  businessId: string,
  scope: DimensionReportScope & { accountType?: string | null },
): Promise<AccountDimensionMatrix & { scope: DimensionReportScope; accountType: string | null }> {
  assertDimensionReportScope(scope);
  const column = DIMENSION_COLUMN[scope.kind];
  const accountType = scope.accountType ?? null;

  // One statement, two grouping sets: the per-value rows and each account's
  // unfiltered total are read from the same snapshot, so a posting that
  // commits while the report loads cannot land in one half and not the other.
  const [groupedResult, values] = await Promise.all([
    query<MatrixSqlRow & { is_total: boolean }>(
      `SELECT a.id AS account_id, a.code, a.name, a.type::text AS type,
              a.normal_balance::text AS normal_balance, a.is_contra,
              jl.${column} AS value_id,
              (GROUPING(jl.${column}) = 1) AS is_total,
              COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.business_id = $1
         JOIN accounts a ON a.id = jl.account_id AND a.business_id = $1
        WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
          AND ($4::text IS NULL OR a.type::text = $4::text)
        GROUP BY GROUPING SETS (
          (a.id, a.code, a.name, a.type, a.normal_balance, a.is_contra, jl.${column}),
          (a.id, a.code, a.name, a.type, a.normal_balance, a.is_contra)
        )`,
      [businessId, scope.dateFrom, scope.dateTo, accountType],
    ),
    // Archived values are included: a historical line still names them. The
    // 2000-row cap is for the picker; reports must read every value so totals
    // are correct, so we go directly through the service helper that returns
    // the full list rather than through the capped catalogue.
    listDimensionValuesUncapped(businessId, { kind: scope.kind, includeArchived: true }),
  ]);
  const rowsResult = { rows: groupedResult.rows.filter((row) => !row.is_total) };
  const totalsResult = { rows: groupedResult.rows.filter((row) => row.is_total) };

  const rows: MatrixAccountRow[] = rowsResult.rows.map((row) => ({
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normal_balance,
    isContra: row.is_contra,
    valueId: row.value_id,
    debit: BigInt(row.debit),
    credit: BigInt(row.credit),
  }));
  const accountTotals: MatrixAccountTotal[] = totalsResult.rows.map((row) => ({
    accountId: row.account_id,
    debit: BigInt(row.debit),
    credit: BigInt(row.credit),
  }));

  const built = buildAccountDimensionMatrix({
    rows,
    accountTotals,
    values: values.map((value) => ({ id: value.id, code: value.code, name: value.name, isActive: value.isActive })),
  });
  return { ...built, scope, accountType };
}

interface ProfitSqlRow extends Record<string, unknown> {
  value_id: string | null;
  account_id: string;
  code: string;
  type: string;
  debit: string;
  credit: string;
}

/**
 * Profit and loss per value of one kind. Revenue and expense accounts only, the
 * same accounts `getProfitAndLoss` reads, classified by the same rules.
 */
export async function getProfitAndLossByDimension(
  businessId: string,
  scope: DimensionReportScope,
): Promise<DimensionProfitReport & { scope: DimensionReportScope; industry: Industry | null }> {
  assertDimensionReportScope(scope);
  const column = DIMENSION_COLUMN[scope.kind];

  // One statement, two grouping sets (see the matrix above): the per-value rows
  // and the unfiltered rows they reconcile against share one snapshot.
  const [groupedResult, industry, values] = await Promise.all([
    query<ProfitSqlRow & { is_total: boolean }>(
      `SELECT jl.${column} AS value_id, a.id AS account_id, a.code, a.type::text AS type,
              (GROUPING(jl.${column}) = 1) AS is_total,
              COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.business_id = $1
         JOIN accounts a ON a.id = jl.account_id AND a.business_id = $1
        WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
          AND a.type::text IN ('revenue', 'expense')
        GROUP BY GROUPING SETS ((jl.${column}, a.id, a.code, a.type), (a.id, a.code, a.type))`,
      [businessId, scope.dateFrom, scope.dateTo],
    ),
    getBusinessIndustry(businessId),
    listDimensionValuesUncapped(businessId, { kind: scope.kind, includeArchived: true }),
  ]);
  const byValue = { rows: groupedResult.rows.filter((row) => !row.is_total) };
  // A total row's value_id is NULL by GROUPING, the same shape the separate
  // unfiltered query used to return.
  const unfilteredResult = { rows: groupedResult.rows.filter((row) => row.is_total).map((row) => ({ ...row, value_id: null })) };

  const toProfitRow = (row: ProfitSqlRow): ProfitRow => ({
    valueId: row.value_id,
    accountId: row.account_id,
    code: row.code,
    type: row.type,
    debit: BigInt(row.debit),
    credit: BigInt(row.credit),
  });

  const report = buildDimensionProfitReport({
    rows: byValue.rows.map(toProfitRow),
    unfilteredRows: unfilteredResult.rows.map(toProfitRow),
    values: values.map((value) => ({ id: value.id, code: value.code, name: value.name, isActive: value.isActive })),
    industry,
  });
  return { ...report, scope, industry };
}

interface RollupSqlRow extends Record<string, unknown> {
  value_id: string | null;
  amount: string;
}

/**
 * Hierarchy rollup for one kind over a period (issue #868 Phase 7): every
 * posted line's natural signed amount lands in exactly one value's `own`
 * (posting is leaf-only), parents roll their descendants up without double
 * counting, archived values stay in the tree as history, and the grand total
 * plus the unattributed remainder reconciles to the unfiltered journal total
 * of the same period — asserted here, not merely displayed, so a report can
 * never quietly disagree with the ledger it summarises.
 */
export async function getDimensionRollup(
  businessId: string,
  scope: DimensionReportScope,
): Promise<DimensionRollupReport & { scope: DimensionReportScope }> {
  assertDimensionReportScope(scope);
  const column = DIMENSION_COLUMN[scope.kind];

  const [grouped, values] = await Promise.all([
    query<RollupSqlRow>(
      `SELECT jl.${column} AS value_id,
              COALESCE(SUM(
                CASE WHEN (a.normal_balance::text = 'debit') <> a.is_contra
                     THEN jl.debit - jl.credit
                     ELSE jl.credit - jl.debit END), 0)::text AS amount
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.business_id = $1
         JOIN accounts a ON a.id = jl.account_id AND a.business_id = $1
        WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
        GROUP BY jl.${column}`,
      [businessId, scope.dateFrom, scope.dateTo],
    ),
    listDimensionValuesUncapped(businessId, { kind: scope.kind, includeArchived: true }),
  ]);

  const ownByValue = new Map<string, bigint>();
  let unassigned = 0n;
  let journalTotal = 0n;
  for (const row of grouped.rows) {
    const amount = BigInt(row.amount);
    journalTotal += amount;
    if (row.value_id === null) unassigned += amount;
    else ownByValue.set(row.value_id, amount);
  }

  // A line may name a value of another kind only through its own column, so
  // every non-null id above is a value of THIS kind — but a value deleted
  // outside the API (no FK violation possible; the columns reference the
  // table) or one the uncapped list somehow missed must not vanish from the
  // totals. The reconcile guard below turns any such drift into a loud
  // failure instead of a silently short report.
  const rollupValues: DimensionRollupValue[] = values.map((value) => ({
    id: value.id,
    code: value.code,
    name: value.name,
    parentId: value.parentId,
    isActive: value.isActive,
    own: ownByValue.get(value.id) ?? 0n,
  }));

  const report = buildDimensionRollup({ values: rollupValues, unassigned, journalTotal });
  if (!report.reconciled) {
    throw new Error("dimension_rollup_reconcile_failed");
  }
  return { ...report, scope };
}
