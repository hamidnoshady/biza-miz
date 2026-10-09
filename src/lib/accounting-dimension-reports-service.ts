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
  type AccountDimensionMatrix,
  type DimensionProfitReport,
  type MatrixAccountRow,
  type MatrixAccountTotal,
  type ProfitRow,
} from "./accounting-dimension-reports";
import { listDimensionValues } from "./accounting-dimensions-service";
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

  const [rowsResult, totalsResult, values] = await Promise.all([
    query<MatrixSqlRow>(
      `SELECT a.id AS account_id, a.code, a.name, a.type::text AS type,
              a.normal_balance::text AS normal_balance, a.is_contra,
              jl.${column} AS value_id,
              COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.business_id = $1
         JOIN accounts a ON a.id = jl.account_id AND a.business_id = $1
        WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
          AND ($4::text IS NULL OR a.type::text = $4::text)
        GROUP BY a.id, a.code, a.name, a.type, a.normal_balance, a.is_contra, jl.${column}`,
      [businessId, scope.dateFrom, scope.dateTo, accountType],
    ),
    // The same scope with no dimension at all: what each account really moved.
    query<{ account_id: string; debit: string; credit: string }>(
      `SELECT a.id AS account_id, COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.business_id = $1
         JOIN accounts a ON a.id = jl.account_id AND a.business_id = $1
        WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
          AND ($4::text IS NULL OR a.type::text = $4::text)
        GROUP BY a.id`,
      [businessId, scope.dateFrom, scope.dateTo, accountType],
    ),
    // Archived values are included: a historical line still names them.
    listDimensionValues(businessId, { kind: scope.kind, includeArchived: true }),
  ]);

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

  const [byValue, unfilteredResult, industry, values] = await Promise.all([
    query<ProfitSqlRow>(
      `SELECT jl.${column} AS value_id, a.id AS account_id, a.code, a.type::text AS type,
              COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.business_id = $1
         JOIN accounts a ON a.id = jl.account_id AND a.business_id = $1
        WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
          AND a.type::text IN ('revenue', 'expense')
        GROUP BY jl.${column}, a.id, a.code, a.type`,
      [businessId, scope.dateFrom, scope.dateTo],
    ),
    query<ProfitSqlRow>(
      `SELECT NULL::uuid AS value_id, a.id AS account_id, a.code, a.type::text AS type,
              COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.business_id = $1
         JOIN accounts a ON a.id = jl.account_id AND a.business_id = $1
        WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
          AND a.type::text IN ('revenue', 'expense')
        GROUP BY a.id, a.code, a.type`,
      [businessId, scope.dateFrom, scope.dateTo],
    ),
    getBusinessIndustry(businessId),
    listDimensionValues(businessId, { kind: scope.kind, includeArchived: true }),
  ]);

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
