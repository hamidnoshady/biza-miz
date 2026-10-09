/**
 * DB-touching reporting orchestration (not unit-tested directly, per repo
 * convention — pure logic lives in reports.ts and is what *.test.ts covers).
 */
import { createHash } from "node:crypto";
import { queryReportPage } from "./report-page-query";
import { query, getPool } from "./db";
import {
  buildFoodCostVariance,
  buildReportQuery,
  previousPeriodRange,
  REPORT_VIEWS,
  STANDARD_REPORTS,
  standardReportsFor,
  reportViewsFor,
  validateReportConfig,
  type FoodCostVariance,
  type FoodCostVarianceItemInput,
  type ReportConfig,
  type ChartType,
} from "./reports";
import { addDays } from "./rollup";
import { reportScopeLocationId, type ReportScope } from "./report-scope";
import {
  costOfSalesCodesForIndustry,
  isNonCurrentCode,
  WELL_KNOWN_CODES,
  type AccountType,
  type NormalBalance,
} from "./coa-template";
import { getBusinessIndustry } from "./industry-guard";
import { classifyAccounts, isClearing, isUsableLiquidity } from "./account-classification";
import { ledgerSourceLabel } from "./ledger-source-labels";
import type { Role } from "./auth";
import type { Industry } from "./industries";

export interface ReportRow extends Record<string, unknown> {
  dim: string | null;
  value: string | number | null;
}

/**
 * Runs a validated custom (or standard) report config against its view. Throws
 * if invalid — call validateReportConfig first for a user-facing error.
 *
 * The scope is required and comes from `authorizedReportScope` (issue #819):
 * this function used to take an optional `locationId`, so a caller that forgot
 * to resolve one read every branch in the business. `buildReportQuery` now
 * refuses a missing scope as well, so the widening has nowhere left to hide.
 */
export async function runCustomReportQuery(
  businessId: string,
  config: ReportConfig,
  scope: ReportScope,
): Promise<ReportRow[]> {
  const { sql, params } = buildReportQuery(config, businessId, scope);
  const { rows } = await query<ReportRow>(sql, params);
  return rows;
}

export interface DateRangeFilters {
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Raw (unaggregated) rows from a standard report's backing view, for its table
 * display. Null-view reports (P&L, Balance Sheet) use their own dedicated
 * functions instead.
 *
 * Every one of these views exposes `location_id` (checked by
 * `report-scope.test.ts`, which reads the migrations), so the branch predicate
 * is always applicable — a row dump is one branch's trading regardless of which
 * report it came from. The scope is required for the same reason it is on
 * `runCustomReportQuery`.
 */
export async function runStandardReportRows(
  key: string,
  businessId: string,
  scope: ReportScope,
  filters: DateRangeFilters = {},
): Promise<Record<string, unknown>[]> {
  const def = STANDARD_REPORTS.find((r) => r.key === key);
  if (!def || !def.view) throw new Error(`no_table_view_for_report: ${key}`);
  const view = REPORT_VIEWS[def.view]!;

  const params: unknown[] = [businessId];
  const where = ["business_id = $1"];
  const locationId = reportScopeLocationId(scope);
  if (locationId) {
    params.push(locationId);
    where.push("location_id = $" + params.length);
  }
  if (view.dateColumn && filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`${view.dateColumn} >= $${params.length}`);
  }
  if (view.dateColumn && filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`${view.dateColumn} <= $${params.length}`);
  }
  const order = view.dateColumn ? `ORDER BY ${view.dateColumn} DESC` : "";
  const { rows } = await query(
    `SELECT * FROM ${def.view} WHERE ${where.join(" AND ")} ${order} LIMIT 1000`,
    params,
  );
  return rows;
}

interface LedgerAccountTotal extends Record<string, unknown> {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  debit: string;
  credit: string;
}

async function ledgerAccountTotals(
  businessId: string,
  accountTypes: string[],
  dateTo?: string,
  dateFrom?: string,
  locationId?: string,
): Promise<LedgerAccountTotal[]> {
  const params: unknown[] = [businessId, accountTypes];
  const where = ["business_id = $1", "account_type::text = ANY($2::text[])"];
  if (locationId) {
    params.push(locationId);
    where.push("location_id = $" + params.length);
  }
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`entry_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`entry_date <= $${params.length}`);
  }
  const { rows } = await query<LedgerAccountTotal>(
    `SELECT account_id, account_code, account_name, account_type,
            sum(debit) AS debit, sum(credit) AS credit
       FROM v_ledger_by_account
      WHERE ${where.join(" AND ")}
      GROUP BY account_id, account_code, account_name, account_type
      ORDER BY account_code`,
    params,
  );
  return rows;
}

/** Debit − credit for a specific set of account codes over a period — used where a report needs one or two named accounts' totals rather than a whole account_type (ledgerAccountTotals above). */
async function ledgerAccountCodeTotals(
  businessId: string,
  codes: string[],
  dateFrom?: string,
  dateTo?: string,
  locationId?: string,
): Promise<Map<string, number>> {
  const params: unknown[] = [businessId, codes];
  const where = ["business_id = $1", "account_code = ANY($2::text[])"];
  if (locationId) {
    params.push(locationId);
    where.push("location_id = $" + params.length);
  }
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`entry_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`entry_date <= $${params.length}`);
  }
  const { rows } = await query<{ account_code: string; debit: string; credit: string }>(
    `SELECT account_code, sum(debit) AS debit, sum(credit) AS credit
       FROM v_ledger_by_account
      WHERE ${where.join(" AND ")}
      GROUP BY account_code`,
    params,
  );
  return new Map(rows.map((r) => [r.account_code, Number(r.debit) - Number(r.credit)]));
}

export interface PnlLine {
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface ProfitAndLoss {
  revenue: PnlLine[];
  expenses: PnlLine[];
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
  /** Material cost + inventory shrinkage (COGS, waste, count/write-down losses) — cost of sales, not overhead. */
  costOfSales: number;
  /** totalRevenue - costOfSales. */
  grossProfit: number;
  /** Staff wages (salariesExpense), tracked apart from other overhead. */
  laborCost: number;
  /** costOfSales + laborCost — the standard F&B "prime cost" metric. */
  primeCost: number;
  /** totalExpenses - costOfSales - laborCost: rent, utilities, marketing, and everything else. */
  operatingExpenses: number;
}

/**
 * The branch this statement is read for, or the consolidated scope.
 *
 * These entry points used to take `locationId?: string` and simply omit the
 * predicate when it was absent — the same "undefined location widens the query"
 * shape the audit found in `buildReportQuery` (issue #819). They now require an
 * explicit `ReportScope`, and `reportScopeLocationId` is the runtime backstop,
 * so a caller cannot reach the ledger without having decided *whose* books it
 * is reading. The branch predicate itself stays where it belongs — a query
 * builder must not invent authorization.
 */

/** P&L for a date range, traced directly from the Phase 7 ledger (v_ledger_by_account, revenue/expense accounts only). */
export async function getProfitAndLoss(
  businessId: string,
  filters: DateRangeFilters = {},
  scope: ReportScope,
): Promise<ProfitAndLoss> {
  const locationId = reportScopeLocationId(scope);
  const [rows, industry] = await Promise.all([
    ledgerAccountTotals(businessId, ["revenue", "expense"], filters.dateTo, filters.dateFrom, locationId),
    getBusinessIndustry(businessId),
  ]);
  // Which expense codes are cost of sales depends on what the business sells —
  // a jeweller's COGS is 5110, not F&B's 5100. An unknown business falls back
  // to F&B, the same default every other industry lookup in the app uses.
  const costOfSalesCodes = new Set(costOfSalesCodesForIndustry(industry ?? "food_service"));
  const revenue: PnlLine[] = [];
  const expenses: PnlLine[] = [];
  for (const r of rows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    if (r.account_type === "revenue") {
      revenue.push({ accountCode: r.account_code, accountName: r.account_name, amount: credit - debit });
    } else {
      expenses.push({ accountCode: r.account_code, accountName: r.account_name, amount: debit - credit });
    }
  }
  const totalRevenue = revenue.reduce((s, l) => s + l.amount, 0);
  const totalExpenses = expenses.reduce((s, l) => s + l.amount, 0);
  const costOfSales = expenses
    .filter((l) => costOfSalesCodes.has(l.accountCode))
    .reduce((s, l) => s + l.amount, 0);
  const laborCost = expenses
    .filter((l) => l.accountCode === WELL_KNOWN_CODES.salariesExpense)
    .reduce((s, l) => s + l.amount, 0);
  return {
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    netIncome: totalRevenue - totalExpenses,
    costOfSales,
    grossProfit: totalRevenue - costOfSales,
    laborCost,
    primeCost: costOfSales + laborCost,
    operatingExpenses: totalExpenses - costOfSales - laborCost,
  };
}

/**
 * Food-cost variance for a date range (#160 §4, closes the last of Wave 4's
 * three deliberate deferrals — see buildFoodCostVariance's doc comment in
 * reports.ts for what "theoretical" vs. "actual" mean here). Per-item
 * theoretical cost is read straight off order_item_inventory_snapshots — the
 * same frozen per-unit ingredient requirements deductForOrder itself
 * consumes from — priced at each ingredient's current avg_cost, so it never
 * has to re-derive a recipe (and its modifier deltas) from scratch. Actual
 * COGS/waste come straight from the ledger (v_ledger_by_account), matching
 * the P&L's own figures exactly.
 */
async function readFoodCostVariance(
  businessId: string,
  filters: DateRangeFilters = {},
  locationId?: string,
  page?: number,
) {
  const params: unknown[] = [businessId];
  const where = [
    "o.status = 'completed'",
    "oi.status != 'voided'",
    "o.location_id = oi.location_id",
    `l.business_id = $${params.length}`,
  ];
  if (locationId) {
    params.push(locationId);
    where.push(`oi.location_id = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`o.closed_at::date >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`o.closed_at::date <= $${params.length}`);
  }

  const result = await queryReportPage<{
    menu_item_id: string | null; menu_item_name: string | null; units_sold: string;
    revenue: string; theoretical_cost: string;
  }, { theoreticalCost: number }>(
    `WITH sales AS (SELECT oi.menu_item_id, COALESCE(mi.name, MAX(oi.name_snapshot)) AS menu_item_name,
            SUM(oi.quantity)::text AS units_sold, SUM(oi.unit_price * oi.quantity)::text AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id AND o.location_id = oi.location_id
       JOIN locations l ON l.id = oi.location_id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id AND mi.location_id = oi.location_id
      WHERE ${where.join(" AND ")}
      GROUP BY oi.menu_item_id, mi.name), theoretical AS (SELECT s.source_menu_item_id AS menu_item_id,
            ROUND(SUM(s.required_quantity * oi.quantity * ii.avg_cost))::text AS theoretical_cost
       FROM order_item_inventory_snapshots s
       JOIN order_items oi ON oi.id = s.order_item_id
       JOIN orders o ON o.id = oi.order_id AND o.location_id = oi.location_id
       JOIN locations l ON l.id = oi.location_id
       JOIN inventory_items ii ON ii.id = s.inventory_item_id AND ii.location_id = oi.location_id
      WHERE ${where.join(" AND ")}
      GROUP BY s.source_menu_item_id)
     SELECT sales.*, coalesce(theoretical.theoretical_cost,'0') AS theoretical_cost
       FROM sales LEFT JOIN theoretical ON theoretical.menu_item_id IS NOT DISTINCT FROM sales.menu_item_id`,
    params,
    { page,
      orderBy: "(CASE WHEN revenue::numeric > 0 THEN theoretical_cost::double precision / revenue::double precision ELSE -1 END) DESC, menu_item_id NULLS LAST",
      summary: `jsonb_build_object('theoreticalCost', coalesce(sum(theoretical_cost::numeric),0))`,
    },
  );
  const items: FoodCostVarianceItemInput[] = result.rows.map((r) => ({
    menuItemId: r.menu_item_id, menuItemName: r.menu_item_name ?? "قلم حذف‌شده",
    unitsSold: Number(r.units_sold), theoreticalCost: Number(r.theoretical_cost), revenue: Number(r.revenue),
  }));

  const codeTotals = await ledgerAccountCodeTotals(
    businessId,
    [WELL_KNOWN_CODES.cogs, WELL_KNOWN_CODES.wasteExpense],
    filters.dateFrom,
    filters.dateTo,
    locationId,
  );

  return { pagination: result.pagination, report: buildFoodCostVariance(
    items,
    codeTotals.get(WELL_KNOWN_CODES.cogs) ?? 0,
    codeTotals.get(WELL_KNOWN_CODES.wasteExpense) ?? 0,
    result.summary,
  ) };
}

export async function getFoodCostVariance(
  businessId: string,
  filters: DateRangeFilters = {},
  scope: ReportScope,
): Promise<FoodCostVariance> {
  return (await readFoodCostVariance(businessId, filters, reportScopeLocationId(scope))).report;
}
export const getFoodCostVariancePage = (
  businessId: string,
  filters: DateRangeFilters,
  scope: ReportScope,
  page: number,
) => readFoodCostVariance(businessId, filters, reportScopeLocationId(scope), page);

export interface BalanceSheet {
  assets: PnlLine[];
  liabilities: PnlLine[];
  equity: PnlLine[];
  /** cumulative net income to date, folded into equity so the sheet balances without a period-close step. */
  retainedEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
  /**
   * The جاری/غیرجاری split a classified balance sheet is read by — fixed assets
   * and borrowings apart from everything that turns over within the year. Sub-
   * totals only: `assets`/`liabilities` still list every line once, and
   * `currentAssets + nonCurrentAssets === totalAssets` by construction
   * (`isNonCurrentCode` partitions, it doesn't filter).
   */
  currentAssets: number;
  nonCurrentAssets: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
}

/**
 * Balance Sheet as of a date, traced directly from the ledger. There's no
 * period-closing step in this system (Phase 7 never transfers revenue/
 * expense into an equity account), so retained earnings is computed here as
 * all-time net income up to asOfDate and folded into equity — otherwise
 * assets would never equal liabilities + equity. This always balances by
 * construction: every posted entry balances (ledger.ts), so trial balance
 * across ALL accounts sums to zero, i.e. assets - (liabilities + equity +
 * (revenue - expenses)) = 0 identically.
 */
export async function getBalanceSheet(
  businessId: string,
  asOfDate: string | undefined,
  scope: ReportScope,
): Promise<BalanceSheet> {
  const locationId = reportScopeLocationId(scope);
  const [balanceRows, incomeRows] = await Promise.all([
    ledgerAccountTotals(businessId, ["asset", "liability", "equity"], asOfDate, undefined, locationId),
    ledgerAccountTotals(businessId, ["revenue", "expense"], asOfDate, undefined, locationId),
  ]);

  const assets: PnlLine[] = [];
  const liabilities: PnlLine[] = [];
  const equity: PnlLine[] = [];
  for (const r of balanceRows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    if (r.account_type === "asset") assets.push({ accountCode: r.account_code, accountName: r.account_name, amount: debit - credit });
    else if (r.account_type === "liability") liabilities.push({ accountCode: r.account_code, accountName: r.account_name, amount: credit - debit });
    else equity.push({ accountCode: r.account_code, accountName: r.account_name, amount: credit - debit });
  }

  let retainedEarnings = 0;
  for (const r of incomeRows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    retainedEarnings += r.account_type === "revenue" ? credit - debit : -(debit - credit);
  }

  const totalAssets = assets.reduce((s, l) => s + l.amount, 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + l.amount, 0);
  const totalEquity = equity.reduce((s, l) => s + l.amount, 0) + retainedEarnings;

  const sumWhere = (lines: PnlLine[], type: AccountType, nonCurrent: boolean) =>
    lines
      .filter((l) => isNonCurrentCode(type, l.accountCode) === nonCurrent)
      .reduce((s, l) => s + l.amount, 0);

  return {
    assets,
    liabilities,
    equity,
    retainedEarnings,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
    currentAssets: sumWhere(assets, "asset", false),
    nonCurrentAssets: sumWhere(assets, "asset", true),
    currentLiabilities: sumWhere(liabilities, "liability", false),
    nonCurrentLiabilities: sumWhere(liabilities, "liability", true),
  };
}

// ---------------------------------------------------------------------------
// Cash flow (direct method, by posting source)
// ---------------------------------------------------------------------------

/**
 * "Cash and cash equivalents" for this statement are the accounts the shared
 * classifier (`account-classification.ts`) calls usable liquidity: صندوق، بانک
 * and تنخواه, including any custom sub-account under them — the same set the
 * Accounting overview totals, so the two cannot disagree (dashboard audit F02,
 * F10). Card/PSP money in transit (1120) and platform receivables (1230) are
 * *not* cash: a sale paid by card is a movement into clearing, and the cash
 * flow happens when the settlement reaches the bank. Their net change over
 * the period is disclosed separately as `clearingChange`.
 *
 * Each cash-touching entry is classified IAS 7-style by its counter-lines:
 * a non-current asset (15xx) → investing; equity or a non-current liability
 * (≥ 2500) → financing; anything else → operating. The source-type grouping is
 * kept inside each activity as the operational movement detail, labelled
 * through the canonical `ledgerSourceLabel` vocabulary.
 */
export type CashFlowActivity = "operating" | "investing" | "financing";

export const CASH_FLOW_ACTIVITY_LABELS: Record<CashFlowActivity, string> = {
  operating: "فعالیت‌های عملیاتی",
  investing: "فعالیت‌های سرمایه‌گذاری",
  financing: "فعالیت‌های تأمین مالی",
};

export interface CashFlowLine {
  sourceType: string;
  label: string;
  amount: number;
  activity: CashFlowActivity;
}

export interface CashFlowStatement {
  openingCash: number;
  closingCash: number;
  netChange: number;
  lines: CashFlowLine[];
  /** Net cash flow per IAS 7 activity. */
  activities: Record<CashFlowActivity, number>;
  /** Net change in settlement-in-transit (card/gateway clearing, platform receivables) over the period — not cash. */
  clearingChange: number;
  /** What "cash" means here, for the screen to print. */
  cashDefinition: string;
}

async function liquidityAccountIds(businessId: string): Promise<{ cash: string[]; clearing: string[] }> {
  const { rows } = await query<{ id: string; code: string; parent_id: string | null; type: AccountType }>(
    `SELECT id, code, parent_id, type FROM accounts WHERE business_id = $1`,
    [businessId],
  );
  const roles = classifyAccounts(rows.map((r) => ({ id: r.id, code: r.code, parentId: r.parent_id, type: r.type })));
  const cash: string[] = [];
  const clearing: string[] = [];
  for (const [id, role] of roles) {
    if (isUsableLiquidity(role)) cash.push(id);
    else if (isClearing(role)) clearing.push(id);
  }
  return { cash, clearing };
}

async function cashBalanceAsOf(
  businessId: string,
  cashAccountIds: string[],
  asOfDate?: string,
  locationId?: string,
): Promise<number> {
  if (cashAccountIds.length === 0) return 0;
  const params: unknown[] = [businessId, cashAccountIds];
  const where = ["je.business_id = $1", "jl.account_id = ANY($2::uuid[])"];
  if (asOfDate) {
    params.push(asOfDate);
    where.push("je.entry_date <= $" + params.length);
  }
  if (locationId) {
    params.push(locationId);
    where.push("je.location_id = $" + params.length);
  }
  const { rows } = await query<{ debit: string; credit: string }>(
    "SELECT COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit " +
      "FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE " +
      where.join(" AND "),
    params,
  );
  return Number(rows[0].debit) - Number(rows[0].credit);
}

/**
 * Cash flow for a date range, direct method, by activity and posting source.
 * See the block comment above for what counts as cash and how an entry is
 * classified.
 */
export async function getCashFlow(
  businessId: string,
  filters: DateRangeFilters = {},
  scope: ReportScope,
): Promise<CashFlowStatement> {
  const locationId = reportScopeLocationId(scope);
  const cashDefinition = "صندوق، بانک و تنخواه (وجوه در راه کارت‌خوان و درگاه جزو نقد نیست)";
  const empty = { operating: 0, investing: 0, financing: 0 };
  const { cash: cashAccountIds, clearing: clearingAccountIds } = await liquidityAccountIds(businessId);
  if (cashAccountIds.length === 0) {
    return { openingCash: 0, closingCash: 0, netChange: 0, lines: [], activities: empty, clearingChange: 0, cashDefinition };
  }

  const params: unknown[] = [businessId, cashAccountIds];
  const where = ["je.business_id = $1"];
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`je.entry_date >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`je.entry_date <= $${params.length}`);
  }
  if (locationId) {
    params.push(locationId);
    where.push("je.location_id = $" + params.length);
  }

  const clearingRange = async (): Promise<number> => {
    if (clearingAccountIds.length === 0) return 0;
    const [open, close] = await Promise.all([
      filters.dateFrom
        ? cashBalanceAsOf(businessId, clearingAccountIds, addDays(filters.dateFrom, -1), locationId)
        : Promise.resolve(0),
      cashBalanceAsOf(businessId, clearingAccountIds, filters.dateTo, locationId),
    ]);
    return close - open;
  };

  const [openingCash, closingCash, lineRows, clearingChange] = await Promise.all([
    filters.dateFrom
      ? cashBalanceAsOf(businessId, cashAccountIds, addDays(filters.dateFrom, -1), locationId)
      : Promise.resolve(0),
    cashBalanceAsOf(businessId, cashAccountIds, filters.dateTo, locationId),
    query<{ source_type: string | null; activity: CashFlowActivity; amount: string }>(
      `WITH per_entry AS (
         SELECT je.id, je.source_type,
                SUM(CASE WHEN jl.account_id = ANY($2::uuid[]) THEN jl.debit - jl.credit ELSE 0 END) AS cash_delta,
                bool_or(jl.account_id = ANY($2::uuid[])) AS touches_cash,
                bool_or(NOT (jl.account_id = ANY($2::uuid[])) AND a.type = 'asset'
                        AND COALESCE(substring(a.code from '^[0-9]+')::numeric, 0) BETWEEN 1500 AND 1599) AS investing,
                bool_or(NOT (jl.account_id = ANY($2::uuid[])) AND (a.type = 'equity'
                        OR (a.type = 'liability' AND COALESCE(substring(a.code from '^[0-9]+')::numeric, 0) >= 2500))) AS financing
           FROM journal_entries je
           JOIN journal_lines jl ON jl.entry_id = je.id
           JOIN accounts a ON a.id = jl.account_id
          WHERE ${where.join(" AND ")}
          GROUP BY je.id, je.source_type
       )
       SELECT source_type,
              CASE WHEN investing THEN 'investing' WHEN financing THEN 'financing' ELSE 'operating' END AS activity,
              SUM(cash_delta)::text AS amount
         FROM per_entry
        WHERE touches_cash
        GROUP BY 1, 2`,
      params,
    ),
    clearingRange(),
  ]);

  const activities = { ...empty };
  const lines: CashFlowLine[] = lineRows.rows
    .map((r) => {
      const sourceType = r.source_type ?? "manual";
      const amount = Number(r.amount);
      activities[r.activity] += amount;
      return { sourceType, label: ledgerSourceLabel(sourceType), amount, activity: r.activity };
    })
    .filter((line) => line.amount !== 0)
    .sort((a, b) => a.activity.localeCompare(b.activity) || b.amount - a.amount);

  return {
    openingCash,
    closingCash,
    netChange: closingCash - openingCash,
    lines,
    activities,
    clearingChange,
    cashDefinition,
  };
}

// ---------------------------------------------------------------------------
// VAT / tax reporting — output vs input VAT and the net payable position
// ---------------------------------------------------------------------------

async function vatAccountTotals(
  businessId: string,
  codes: string[],
  dateFrom?: string,
  dateTo?: string,
): Promise<Map<string, { debit: number; credit: number }>> {
  const params: unknown[] = [businessId, codes];
  const where = ["je.business_id = $1", "a.code = ANY($2::text[])"];
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`je.entry_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`je.entry_date <= $${params.length}`);
  }
  const { rows } = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE ${where.join(" AND ")}
      GROUP BY a.code`,
    params,
  );
  return new Map(rows.map((r) => [r.code, { debit: Number(r.debit), credit: Number(r.credit) }]));
}

export interface VatReport {
  periodFrom: string | null;
  periodTo: string | null;
  /** Net movement on vatPayable in the period — VAT collected on sales, net of any credited back (e.g. sales returns). */
  outputVat: number;
  /** Net movement on vatReceivable in the period — VAT paid on purchases (posted on receipt from the supplier invoice, or by a manual entry). */
  inputVat: number;
  /** outputVat - inputVat: positive is owed to the tax authority for the period, negative is a refundable position. */
  netPayable: number;
  /** All-time balance of vatPayable as of periodTo (or today, if not given) — not reset by reporting a period. */
  vatPayableBalance: number;
  /** All-time balance of vatReceivable as of periodTo. */
  vatReceivableBalance: number;
}

/**
 * Output VAT has posted to vatPayable since Phase 7 (every order payment
 * credits it). Input VAT is debited to vatReceivable when a purchase is
 * received with its supplier invoice's VAT (audit F11: the purchase posting's
 * own leg, in the same entry as the goods), and a manual journal entry can
 * still post to it for anything bought outside «خرید». This report just reads
 * both control accounts' movements over a period and nets them — a
 * return-shaped summary, not a new posting path.
 *
 * This is intentionally a business-wide accounting read, like the trial
 * balance: VAT liability is held in the business's central ledger and the
 * endpoint/tool is gated by `ledger.view`, not `reports.view`. It must not be
 * given a branch filter merely because the operational reports are branch-scoped.
 */
export async function getVatReport(businessId: string, filters: DateRangeFilters = {}): Promise<VatReport> {
  const codes = [WELL_KNOWN_CODES.vatPayable, WELL_KNOWN_CODES.vatReceivable];
  const [period, cumulative] = await Promise.all([
    vatAccountTotals(businessId, codes, filters.dateFrom, filters.dateTo),
    vatAccountTotals(businessId, codes, undefined, filters.dateTo),
  ]);
  const payablePeriod = period.get(WELL_KNOWN_CODES.vatPayable) ?? { debit: 0, credit: 0 };
  const receivablePeriod = period.get(WELL_KNOWN_CODES.vatReceivable) ?? { debit: 0, credit: 0 };
  const payableCumulative = cumulative.get(WELL_KNOWN_CODES.vatPayable) ?? { debit: 0, credit: 0 };
  const receivableCumulative = cumulative.get(WELL_KNOWN_CODES.vatReceivable) ?? { debit: 0, credit: 0 };

  const outputVat = payablePeriod.credit - payablePeriod.debit;
  const inputVat = receivablePeriod.debit - receivablePeriod.credit;

  return {
    periodFrom: filters.dateFrom ?? null,
    periodTo: filters.dateTo ?? null,
    outputVat,
    inputVat,
    netPayable: outputVat - inputVat,
    vatPayableBalance: payableCumulative.credit - payableCumulative.debit,
    vatReceivableBalance: receivableCumulative.debit - receivableCumulative.credit,
  };
}

// ---------------------------------------------------------------------------
// Period comparison — "vs previous period", same shape as the statement itself
// ---------------------------------------------------------------------------

export interface Comparison<T> {
  current: T;
  /** null when the range is open-ended (no dateFrom) — there's no length to mirror for a previous period. */
  previous: T | null;
}

export async function getProfitAndLossComparison(
  businessId: string,
  filters: DateRangeFilters,
  scope: ReportScope,
): Promise<Comparison<ProfitAndLoss>> {
  const current = await getProfitAndLoss(businessId, filters, scope);
  if (!filters.dateFrom || !filters.dateTo) return { current, previous: null };
  const previous = await getProfitAndLoss(
    businessId,
    previousPeriodRange(filters.dateFrom, filters.dateTo),
    scope,
  );
  return { current, previous };
}

export async function getCashFlowComparison(
  businessId: string,
  filters: DateRangeFilters,
  scope: ReportScope,
): Promise<Comparison<CashFlowStatement>> {
  const current = await getCashFlow(businessId, filters, scope);
  if (!filters.dateFrom || !filters.dateTo) return { current, previous: null };
  const previous = await getCashFlow(
    businessId,
    previousPeriodRange(filters.dateFrom, filters.dateTo),
    scope,
  );
  return { current, previous };
}

/**
 * Balance Sheet comparison: a snapshot has no "length" to mirror, so instead
 * of guessing one, the caller supplies the earlier as-of date directly (e.g.
 * "same day last month", or a fiscal period's start).
 */
export async function getBalanceSheetComparison(
  businessId: string,
  asOfDate: string | undefined,
  previousAsOfDate: string | undefined,
  scope: ReportScope,
): Promise<Comparison<BalanceSheet>> {
  const current = await getBalanceSheet(businessId, asOfDate, scope);
  if (!previousAsOfDate) return { current, previous: null };
  const previous = await getBalanceSheet(businessId, previousAsOfDate, scope);
  return { current, previous };
}

// ---------------------------------------------------------------------------
// Drill-down — the journal entries behind one account's figure in a statement
// ---------------------------------------------------------------------------

export interface DrillDownLine {
  lineId: string;
  entryId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  debit: string;
  credit: string;
}

export interface AccountDrillDownPage {
  lines: DrillDownLine[];
  totals: { debit: string; credit: string; signedBalance: string };
  totalLines: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/**
 * Exact, paginated journal lines behind one account figure. Window aggregates
 * carry the full debit/credit sum on each fetched row, so even a large account
 * ledger can prove its displayed amount without loading every posting at once.
 */
export async function getAccountDrillDown(
  businessId: string,
  accountCode: string,
  filters: DateRangeFilters & { offset?: number; limit?: number; locationId?: string } = {},
): Promise<AccountDrillDownPage> {
  const params: unknown[] = [businessId, accountCode];
  const where = ["je.business_id = $1", "a.business_id = $1", "a.code = $2"];
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`je.entry_date >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`je.entry_date <= $${params.length}`);
  }
  // The reporting caller passes its authorized branch, so the postings behind a
  // statement figure are the same postings the figure was computed from. The
  // accounting caller (the trial-balance overlay) deliberately does not: it
  // reads the business's whole ledger, which is what a trial balance is.
  if (filters.locationId) {
    params.push(filters.locationId);
    where.push(`je.location_id = $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const { rows: summaryRows } = await query<{
    debit: string;
    credit: string;
    total_lines: string;
  }>(
    `SELECT COALESCE(SUM(jl.debit), 0)::text AS debit,
            COALESCE(SUM(jl.credit), 0)::text AS credit,
            COUNT(jl.id)::text AS total_lines
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE ${whereSql}`,
    params,
  );
  const summary = summaryRows[0];
  const totalDebit = summary?.debit ?? "0";
  const totalCredit = summary?.credit ?? "0";
  const totalLines = Number(summary?.total_lines ?? 0);
  const offset = Number.isSafeInteger(filters.offset) && (filters.offset ?? 0) >= 0
    ? filters.offset!
    : 0;
  const limit = Number.isSafeInteger(filters.limit) && (filters.limit ?? 0) > 0
    ? Math.min(filters.limit!, 200)
    : 200;
  const pageParams = [...params, limit + 1, offset];
  const { rows } = await query<{
    line_id: string;
    entry_id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    source_id: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT jl.id::text AS line_id, je.id AS entry_id, je.entry_date::text AS entry_date,
            je.memo, je.source_type, je.source_id, jl.debit::text, jl.credit::text
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE ${whereSql}
      ORDER BY je.entry_date DESC, je.posted_at DESC, jl.id DESC
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    lines: page.map((row) => ({
      lineId: row.line_id,
      entryId: row.entry_id,
      entryDate: row.entry_date,
      memo: row.memo,
      sourceType: row.source_type,
      sourceId: row.source_id,
      debit: row.debit,
      credit: row.credit,
    })),
    totals: {
      debit: totalDebit,
      credit: totalCredit,
      signedBalance: (BigInt(totalDebit) - BigInt(totalCredit)).toString(),
    },
    totalLines,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

// ---------------------------------------------------------------------------
// Account statement (دفتر معین / گردش حساب) — Phase 22 Wave 5, issue #160 §7.3
// ---------------------------------------------------------------------------

export interface AccountStatementLine {
  entryId: string;
  date: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
  /** Running balance after this line, signed per the account's own normal balance (see below). */
  balance: number;
}

export interface AccountStatement {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  /** Net movement before `dateFrom` (0 if `dateFrom` is omitted — the statement then covers all history). */
  openingBalance: number;
  lines: AccountStatementLine[];
  closingBalance: number;
}

/**
 * One account's full ledger for a period — opening balance, every movement
 * chronologically with a running balance, closing balance — the standard
 * دفتر معین/گردش حساب presentation `getAccountDrillDown` above doesn't
 * provide (that's a flat, newest-first list for one report figure; this is
 * a browsable per-account statement, reached from the chart-of-accounts
 * tab). `null` if the account doesn't exist or isn't this business's.
 *
 * A debit-normal account's balance moves by (debit − credit) each line, a
 * credit-normal account's by (credit − debit) — the same convention
 * getProfitAndLoss/getBalanceSheet already use per `account.type`, now read
 * directly off the stored `normal_balance` column (Wave 2) instead of
 * re-deriving it from type inline.
 */
export async function getAccountStatement(
  businessId: string,
  accountId: string,
  filters: DateRangeFilters = {},
): Promise<AccountStatement | null> {
  const { rows: accountRows } = await query<{
    code: string;
    name: string;
    type: AccountType;
    normal_balance: NormalBalance;
  }>(`SELECT code, name, type, normal_balance FROM accounts WHERE id = $1 AND business_id = $2`, [
    accountId,
    businessId,
  ]);
  const account = accountRows[0];
  if (!account) return null;
  const sign = account.normal_balance === "debit" ? 1 : -1;

  let openingBalance = 0;
  if (filters.dateFrom) {
    const { rows } = await query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2 AND je.entry_date < $3`,
      [businessId, accountId, filters.dateFrom],
    );
    openingBalance = sign * (Number(rows[0].debit) - Number(rows[0].credit));
  }

  const params: unknown[] = [businessId, accountId];
  const where = ["je.business_id = $1", "jl.account_id = $2"];
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`je.entry_date >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`je.entry_date <= $${params.length}`);
  }
  const { rows } = await query<{
    entry_id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT je.id AS entry_id, je.entry_date::text AS entry_date, je.memo, je.source_type, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE ${where.join(" AND ")}
      ORDER BY je.entry_date ASC, je.posted_at ASC`,
    params,
  );

  let balance = openingBalance;
  const lines: AccountStatementLine[] = rows.map((r) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    balance += sign * (debit - credit);
    return { entryId: r.entry_id, date: r.entry_date, memo: r.memo, sourceType: r.source_type, debit, credit, balance };
  });

  return {
    accountId,
    accountCode: account.code,
    accountName: account.name,
    accountType: account.type,
    normalBalance: account.normal_balance,
    openingBalance,
    lines,
    closingBalance: balance,
  };
}

interface SavedReportRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  created_by: string | null;
  name: string;
  /** Optional free text saying what the report is for (issue #819, Step 8). */
  description: string | null;
  config: ReportConfig;
  is_standard: boolean;
  standard_key: string | null;
  /** Bumped by every edit, so a shared report says whether it changed. */
  version: number;
  created_at: string;
  updated_at: string;
}

export async function listSavedReports(businessId: string): Promise<SavedReportRow[]> {
  const { rows } = await query<SavedReportRow>(
    "SELECT * FROM saved_reports WHERE business_id = $1 ORDER BY is_standard DESC, created_at",
    [businessId],
  );
  return rows;
}

export async function getSavedReport(businessId: string, id: string): Promise<SavedReportRow | null> {
  const { rows } = await query<SavedReportRow>(
    "SELECT * FROM saved_reports WHERE id = $1 AND business_id = $2",
    [id, businessId],
  );
  return rows[0] ?? null;
}

export async function createSavedReport(
  businessId: string,
  createdBy: string | null,
  name: string,
  config: ReportConfig,
  description?: string | null,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO saved_reports (business_id, created_by, name, description, config)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [businessId, createdBy, name, description?.trim() || null, JSON.stringify(config)],
  );
  return rows[0].id;
}

/**
 * Edits a saved report. Every accepted patch bumps `version` (migration 0212):
 * the row is a shared definition, and "has it changed since I ran it" is only
 * answerable if edits are counted — including a rename or a description change,
 * which are exactly the edits a reader notices.
 */
export async function updateSavedReport(
  businessId: string,
  id: string,
  patch: { name?: string; description?: string | null; config?: ReportConfig },
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [id, businessId];
  if (patch.name !== undefined) {
    values.push(patch.name);
    fields.push(`name = $${values.length}`);
  }
  if (patch.description !== undefined) {
    // An explicit empty string clears it, matching how the builder's input
    // reports "the field is empty" rather than "the field was not sent".
    values.push(patch.description?.trim() || null);
    fields.push(`description = $${values.length}`);
  }
  if (patch.config !== undefined) {
    values.push(JSON.stringify(patch.config));
    fields.push(`config = $${values.length}`);
  }
  if (fields.length === 0) return false;
  fields.push("version = version + 1");
  fields.push("updated_at = now()");
  const { rowCount } = await query(
    `UPDATE saved_reports SET ${fields.join(", ")} WHERE id = $1 AND business_id = $2 AND is_standard = false`,
    values,
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteSavedReport(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM saved_reports WHERE id = $1 AND business_id = $2 AND is_standard = false",
    [id, businessId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Which of `ids` name a saved report of this business.
 *
 * Used by the widgets route to check client-supplied report ids before it
 * stores a layout (issue #819): an id from another tenant (or a deleted one)
 * would otherwise be written into `dashboard_widgets` and render as a widget
 * nobody can open — and a dashboard layout is written from the browser, so the
 * ids are caller input, not facts.
 */
export interface SavedReportIdsInBusiness {
  /** IDs that exist in this tenant; caller-supplied IDs are not ownership facts. */
  owned: Set<string>;
  /** Owned IDs that still satisfy this business's trade and current engine schema. */
  applicable: Set<string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function savedReportIdsInBusiness(
  businessId: string,
  ids: string[],
): Promise<SavedReportIdsInBusiness> {
  // Never pass arbitrary strings through `::uuid[]`: invalid client input must
  // be a 400, not a Postgres cast error turned into a 500.
  const unique = [...new Set(ids)].filter((id) => UUID_RE.test(id));
  if (unique.length === 0) return { owned: new Set(), applicable: new Set() };
  const [industry, result] = await Promise.all([
    getBusinessIndustry(businessId),
    query<{ id: string; config: ReportConfig; standard_key: string | null }>(
      "SELECT id, config, standard_key FROM saved_reports WHERE business_id = $1 AND id = ANY($2::uuid[])",
      [businessId, unique],
    ),
  ]);
  const offeredStandardKeys = new Set(standardReportsFor(industry).map((report) => report.key));
  const offeredViewKeys = new Set(reportViewsFor(industry).map(({ key }) => key));
  const owned = new Set(result.rows.map((row) => row.id));
  const applicable = new Set(
    result.rows
      .filter((row) => savedReportApplicability(row, offeredStandardKeys, offeredViewKeys).applicable)
      .map((row) => row.id),
  );
  return { owned, applicable };
}

/**
 * Idempotently materializes the pre-built report library as saved_reports rows
 * for a business, so they can be pinned to a dashboard like any custom report.
 * Safe to call repeatedly (upsert on standard_key).
 *
 * Only the reports this business's trade actually has: seeding all of them gave
 * a jewellery shop pinnable «چرخش میزها» and «گزارش ضایعات» tiles that could
 * only ever draw an empty chart. Rows seeded before this narrowing are left
 * alone rather than deleted — a `dashboard_widgets` row references them, and
 * silently removing a tile an owner arranged is worse than an empty one they
 * can remove themselves.
 */
export async function ensureStandardSavedReports(businessId: string): Promise<Map<string, string>> {
  const industry = await getBusinessIndustry(businessId);
  const withCharts = standardReportsFor(industry).filter((r) => r.defaultChart);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const report of withCharts) {
      await client.query(
        `INSERT INTO saved_reports (business_id, name, config, is_standard, standard_key)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (business_id, standard_key) WHERE standard_key IS NOT NULL
         DO UPDATE SET config = EXCLUDED.config, name = EXCLUDED.name`,
        [businessId, report.label, JSON.stringify(report.defaultChart!.config), report.key],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const offeredKeys = new Set(withCharts.map((report) => report.key));
  const { rows } = await query<{ standard_key: string; id: string }>(
    "SELECT standard_key, id FROM saved_reports WHERE business_id = $1 AND standard_key IS NOT NULL",
    [businessId],
  );
  // Old standard rows remain because existing dashboard_widgets may reference
  // them, but they are not candidates for this trade's current default layout.
  return new Map(rows.filter((r) => offeredKeys.has(r.standard_key)).map((r) => [r.standard_key, r.id]));
}

export function standardChartType(key: string): ChartType | null {
  return STANDARD_REPORTS.find((r) => r.key === key)?.defaultChart?.chartType ?? null;
}

export interface DashboardWidgetRow extends Record<string, unknown> {
  id: string;
  saved_report_id: string;
  chart_type: ChartType;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  report_name: string;
  report_config: ReportConfig;
  standard_key: string | null;
  /** Set by `getDashboardWidgets`: whether this report still means something for the business's trade. */
  applicable?: boolean;
  applicable_reason?: "standard_report_not_in_trade" | "unknown_view";
}

/**
 * Whether a pinned report still says something about this business.
 *
 * A widget stores a `saved_reports` row, and that row can stop being usable for
 * reasons nobody deleted it for (issue #819):
 *
 *  - a **standard** report the trade no longer has. `ensureStandardSavedReports`
 *    seeds only the current trade's reports and deliberately keeps rows seeded
 *    before a business changed trade, because a `dashboard_widgets` row
 *    references them and silently removing a tile an owner arranged is worse
 *    than an empty one;
 *  - a **custom** report saved against a view the engine has since retired, or a
 *    metric/dimension pair that no longer exists in `REPORT_VIEWS`.
 *
 * Either way the tile used to render as a chart of zeros, which reads as "this
 * branch sold nothing" rather than "this report is obsolete". The grid says
 * which it is instead, and the member can remove it deliberately.
 */
export function savedReportApplicability(
  // Takes either shape a caller has in hand: a `dashboard_widgets` join row
  // (`report_config`) or a `saved_reports` row (`config`).
  report: { config?: ReportConfig | null; report_config?: ReportConfig | null; standard_key: string | null },
  offeredStandardKeys: ReadonlySet<string>,
  offeredViewKeys: ReadonlySet<string>,
): { applicable: true } | { applicable: false; applicable_reason: "standard_report_not_in_trade" | "unknown_view" } {
  // Named `applicable_reason` so a caller can spread the result straight onto a
  // widget row (`{ ...row, ...savedReportApplicability(row, offered) }`) — the
  // shape the API returns is the shape this produces.
  if (report.standard_key && !offeredStandardKeys.has(report.standard_key)) {
    return { applicable: false, applicable_reason: "standard_report_not_in_trade" };
  }
  const config = report.config ?? report.report_config ?? null;
  const view = config && Object.hasOwn(REPORT_VIEWS, config.view) ? REPORT_VIEWS[config.view] : undefined;
  // `REPORT_VIEWS` is the union of all trades. The currently offered view set
  // carries both module and capability requirements, so a saved config from a
  // different/retired trade is not executable merely because its SQL view is
  // still in the union catalogue.
  if (!config || !view || !offeredViewKeys.has(config.view) || validateReportConfig(config).length > 0) {
    return { applicable: false, applicable_reason: "unknown_view" };
  }
  return { applicable: true };
}

export interface DashboardWidgetsResult {
  scope: "personal" | "role-default";
  widgets: DashboardWidgetRow[];
  /** The layout's current revision — echoed back on the next write. See `saveDashboardWidgets`. */
  revision: string;
}

/**
 * A user's personal widget layout, or (if they have none yet) their role's
 * default layout — seeded once for the Owner (see Phase 8 doc, "Dashboard
 * defaults").
 *
 * Each widget also carries `applicable`/`applicable_reason` (issue #819) so the
 * grid can explain an obsolete tile rather than drawing it as an empty chart.
 * The rows themselves are never dropped: the widget is the member's, and the
 * only thing allowed to remove it is the member.
 */
export async function getDashboardWidgets(
  businessId: string,
  userId: string,
  role: Role,
): Promise<DashboardWidgetsResult> {
  const industry = await getBusinessIndustry(businessId);
  const offered = new Set(standardReportsFor(industry).map((r) => r.key));
  const offeredViews = new Set(reportViewsFor(industry).map(({ key }) => key));
  const annotate = (rows: DashboardWidgetRow[]): DashboardWidgetRow[] =>
    rows.map((row) => ({ ...row, ...savedReportApplicability(row, offered, offeredViews) }));

  const personal = await queryWidgets(businessId, "user_id = $2", [businessId, userId]);
  if (personal.length > 0) {
    return { scope: "personal", widgets: annotate(personal), revision: widgetLayoutRevision(personal) };
  }
  let roleDefault = await queryWidgets(businessId, "role = $2", [businessId, role]);
  if (roleDefault.length === 0 && role === "owner") {
    await seedOwnerDashboardDefaults(businessId);
    roleDefault = await queryWidgets(businessId, "role = $2", [businessId, role]);
  }
  return { scope: "role-default", widgets: annotate(roleDefault), revision: widgetLayoutRevision(roleDefault) };
}

/**
 * The Owner's day-to-day picture on first login after this phase ships:
 * today's revenue trend, cash/card reconciliation, what's selling, and who's
 * closing sales — the four things worth a glance without opening a report.
 * Seeded once (lazily, on first dashboard view); the Owner can then
 * rearrange or replace freely, same as any personal layout.
 */
async function seedOwnerDashboardDefaults(businessId: string): Promise<void> {
  const ids = await ensureStandardSavedReports(businessId);
  // Preference order, not fixed positions: the first four this trade actually
  // has are laid into the 2×2 below. «پرفروش‌ترین اقلام» is a menu report, so a
  // jewellery shop skips it and takes the next candidate rather than being
  // seeded a hole where its third tile should be — the old fixed-coordinate
  // list left exactly that gap.
  const candidates: { key: string; chartType: ChartType }[] = [
    { key: "daily_sales_summary", chartType: "bar" },
    { key: "shift_reconciliation", chartType: "bar" },
    { key: "top_selling_items", chartType: "pie" },
    { key: "staff_performance", chartType: "bar" },
    { key: "expenses_by_category", chartType: "pie" },
    { key: "cogs_trend", chartType: "line" },
  ];
  const slots = [
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 0, y: 3 },
    { x: 6, y: 3 },
  ];
  const chosen = candidates.filter((c) => ids.has(c.key)).slice(0, slots.length);
  await saveDashboardWidgets(
    businessId,
    { role: "owner" },
    chosen.map((c, index) => ({
      savedReportId: ids.get(c.key)!,
      chartType: c.chartType,
      x: slots[index].x,
      y: slots[index].y,
      w: 6,
      h: 3,
    })),
  );
}

async function queryWidgets(businessId: string, extraWhere: string, params: unknown[]): Promise<DashboardWidgetRow[]> {
  const { rows } = await query<DashboardWidgetRow>(
    `SELECT dw.id, dw.saved_report_id, dw.chart_type, dw.title, dw.x, dw.y, dw.w, dw.h,
            sr.name AS report_name, sr.config AS report_config, sr.standard_key
       FROM dashboard_widgets dw JOIN saved_reports sr ON sr.id = dw.saved_report_id
      WHERE dw.business_id = $1 AND ${extraWhere}
      ORDER BY dw.y, dw.x`,
    params,
  );
  return rows;
}

export interface WidgetInput {
  savedReportId: string;
  chartType: ChartType;
  title?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A layout's revision: a fingerprint of exactly the rows a client read.
 *
 * Widget writes are whole-layout replacements, so two of them raced — a second
 * tab's drag-save, or the pin button's read-then-replace, silently discarded
 * the other's change because the write was "delete all, insert these" with
 * nothing recording which layout the client had seen (issue #819). There is no
 * `updated_at` on `dashboard_widgets` to compare against, but there does not
 * need to be one: the row set itself is the state, and any change that matters
 * (added, removed, moved, resized, re-titled, re-charted) changes this string.
 */
export function widgetLayoutRevision(widgets: DashboardWidgetRow[]): string {
  const rows = [...widgets]
    .map((w) => [w.id, w.saved_report_id, w.chart_type, w.title ?? "", w.x, w.y, w.w, w.h])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 32);
}

/**
 * Serializes widget writes for one scope (issue #819).
 *
 * `FOR UPDATE` in `lockedWidgets` locks the rows a layout *has*, which is
 * enough when there are some — but two writes into an **empty** layout lock
 * nothing, and that is exactly the state the first pins of a fresh dashboard
 * arrive in. Without this, two simultaneous pins both measured an empty grid
 * and both placed their tile at row 0. The lock is taken for the transaction and
 * released by COMMIT/ROLLBACK, and it is keyed on the *scope*, so two members'
 * personal dashboards never wait on each other.
 */
async function lockWidgetScope(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  businessId: string,
  scope: { userId: string } | { role: Role },
): Promise<void> {
  const key = `${businessId}:${"userId" in scope ? `user:${scope.userId}` : `role:${scope.role}`}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
}

/** A layout read inside a transaction — the revision check's own read. */
async function lockedWidgets(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: DashboardWidgetRow[] }> },
  businessId: string,
  scope: { userId: string } | { role: Role },
): Promise<DashboardWidgetRow[]> {
  const byUser = "userId" in scope;
  const { rows } = await client.query(
    `SELECT dw.id, dw.saved_report_id, dw.chart_type, dw.title, dw.x, dw.y, dw.w, dw.h,
            sr.name AS report_name, sr.config AS report_config, sr.standard_key
       FROM dashboard_widgets dw JOIN saved_reports sr ON sr.id = dw.saved_report_id
      WHERE dw.business_id = $1 AND ${byUser ? "dw.user_id = $2" : "dw.role = $2"}
      ORDER BY dw.y, dw.x
        FOR UPDATE OF dw`,
    [businessId, byUser ? scope.userId : (scope as { role: Role }).role],
  );
  return rows;
}

interface WidgetSavedReportAvailability {
  owned: Set<string>;
  applicable: Set<string>;
}

/**
 * Rechecks widget report ownership and trade applicability while holding the
 * same transaction that changes the layout. The business row and referenced
 * saved-report rows stay locked until commit, so a concurrent industry switch
 * or report edit cannot race the route's earlier user-facing preflight.
 */
async function widgetSavedReportAvailability(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  businessId: string,
  ids: string[],
): Promise<WidgetSavedReportAvailability> {
  if (ids.length === 0) return { owned: new Set(), applicable: new Set() };
  const businessResult = await client.query(
    "SELECT industry FROM businesses WHERE id = $1 FOR SHARE",
    [businessId],
  ) as { rows: { industry: Industry | null }[] };
  const industry = businessResult.rows[0]?.industry;
  if (!industry) return { owned: new Set(), applicable: new Set() };

  const reportResult = await client.query(
    `SELECT id, config, standard_key
       FROM saved_reports
      WHERE business_id = $1 AND id = ANY($2::uuid[])
      FOR SHARE`,
    [businessId, ids],
  ) as { rows: { id: string; config: ReportConfig; standard_key: string | null }[] };
  const offeredStandardKeys = new Set(standardReportsFor(industry).map((report) => report.key));
  const offeredViewKeys = new Set(reportViewsFor(industry).map(({ key }) => key));
  const owned = new Set(reportResult.rows.map((row) => row.id));
  const applicable = new Set(
    reportResult.rows
      .filter((row) => savedReportApplicability(row, offeredStandardKeys, offeredViewKeys).applicable)
      .map((row) => row.id),
  );
  return { owned, applicable };
}

export type WidgetLayoutWrite =
  | { ok: true; revision: string }
  | { ok: false; reason: "layout_changed" | "saved_report_not_applicable" | "unknown_saved_report" };

/** The insert every widget write shares. */
async function insertWidget(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  businessId: string,
  scope: { userId: string } | { role: Role },
  widget: WidgetInput,
): Promise<void> {
  await client.query(
    `INSERT INTO dashboard_widgets (business_id, user_id, role, saved_report_id, chart_type, title, x, y, w, h)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      businessId,
      "userId" in scope ? scope.userId : null,
      "userId" in scope ? null : scope.role,
      widget.savedReportId,
      widget.chartType,
      widget.title ?? null,
      widget.x,
      widget.y,
      widget.w,
      widget.h,
    ],
  );
}

/**
 * Replaces a scope's whole widget layout in one transaction (drag-resize saves
 * send the full grid).
 *
 * `ifRevision` makes the write conditional: the scope's rows are locked, their
 * revision is recomputed, and the write is refused with `layout_changed` when
 * they no longer match what the client read. Without it a stale tab would
 * delete whatever the other tab had just saved. Omit it only where the caller
 * genuinely means "replace whatever is there" (tests, seeding).
 */
export async function saveDashboardWidgets(
  businessId: string,
  scope: { userId: string } | { role: Role },
  widgets: WidgetInput[],
  options: {
    ifRevision?: string;
    /** Historical tiles may be retained only if the transaction sees them in the current layout. */
    preserveInapplicableSavedReportIds?: readonly string[];
  } = {},
): Promise<WidgetLayoutWrite> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockWidgetScope(client, businessId, scope);
    const existing = await lockedWidgets(client, businessId, scope);
    if (options.ifRevision !== undefined && widgetLayoutRevision(existing) !== options.ifRevision) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "layout_changed" };
    }
    const requestedIds = [...new Set(widgets.map((widget) => widget.savedReportId))];
    if (requestedIds.some((id) => !UUID_RE.test(id))) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "unknown_saved_report" };
    }
    const availability = await widgetSavedReportAvailability(client, businessId, requestedIds);
    if (requestedIds.some((id) => !availability.owned.has(id))) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "unknown_saved_report" };
    }
    const existingReportIds = new Set(existing.map((widget) => widget.saved_report_id));
    const requestedIdSet = new Set(requestedIds);
    const preservedIds = new Set(options.preserveInapplicableSavedReportIds ?? []);
    if ([...preservedIds].some((id) => !existingReportIds.has(id) || !requestedIdSet.has(id))) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "saved_report_not_applicable" };
    }
    if (
      requestedIds.some(
        (id) =>
          !availability.applicable.has(id) &&
          (!existingReportIds.has(id) || !preservedIds.has(id)),
      )
    ) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "saved_report_not_applicable" };
    }
    if ("userId" in scope) {
      await client.query("DELETE FROM dashboard_widgets WHERE business_id = $1 AND user_id = $2", [
        businessId,
        scope.userId,
      ]);
    } else {
      await client.query("DELETE FROM dashboard_widgets WHERE business_id = $1 AND role = $2", [
        businessId,
        scope.role,
      ]);
    }
    for (const widget of widgets) {
      await insertWidget(client, businessId, scope, widget);
    }
    const next = await lockedWidgets(client, businessId, scope);
    await client.query("COMMIT");
    return { ok: true, revision: widgetLayoutRevision(next) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Appends one widget to a scope's layout, server-side.
 *
 * The pin button used to read the layout, compute the next free row in the
 * browser and POST the whole array back. Two pins at the same time lost one of
 * them (both read the same layout, both wrote "those plus mine"), and a failed
 * *read* was worse: `response.json()` on a 403 produced `{ error: … }`, the
 * caller's `current.widgets ?? []` made that an empty layout, and the
 * replacement POST deleted every existing pin. Both are fixed by not doing the
 * read-modify-write in the browser at all — the append happens under the same
 * row lock the replace uses, and the position is computed here.
 */
export type WidgetAppendWrite =
  | { ok: true; revision: string; widget: WidgetInput }
  | { ok: false; reason: "unknown_saved_report" | "saved_report_not_applicable" };

export async function appendDashboardWidget(
  businessId: string,
  scope: { userId: string } | { role: Role },
  // No placement: the caller does not know the current layout, so the row is
  // computed here from the locked one (issue #819).
  widget: Omit<WidgetInput, "x" | "y">,
): Promise<WidgetAppendWrite> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockWidgetScope(client, businessId, scope);
    const existing = await lockedWidgets(client, businessId, scope);
    if (!UUID_RE.test(widget.savedReportId)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "unknown_saved_report" };
    }
    const availability = await widgetSavedReportAvailability(client, businessId, [widget.savedReportId]);
    if (!availability.owned.has(widget.savedReportId)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "unknown_saved_report" };
    }
    if (!availability.applicable.has(widget.savedReportId)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "saved_report_not_applicable" };
    }
    const nextY = existing.reduce((maximum, row) => Math.max(maximum, row.y + row.h), 0);
    const placed: WidgetInput = {
      savedReportId: widget.savedReportId,
      chartType: widget.chartType,
      title: widget.title ?? null,
      x: 0,
      y: nextY,
      w: widget.w,
      h: widget.h,
    };
    await insertWidget(client, businessId, scope, placed);
    const next = await lockedWidgets(client, businessId, scope);
    await client.query("COMMIT");
    return { ok: true, revision: widgetLayoutRevision(next), widget: placed };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** validateReportConfig re-exported for API routes that need it alongside the DB helpers above. */
export { validateReportConfig };

// ---------------------------------------------------------------------------
// Phase 14 — consolidated reporting across a business's own branches
// ---------------------------------------------------------------------------
//
// Distinct from the Phase 9 cross-*server* rollup (rollup_daily_summary,
// populated by a remote server's HTTP push): this is one business's own
// branches, all in this same database, queried directly off the Phase 8
// reporting views — the same views every per-branch report already reads, so
// a branch's numbers here can never disagree with its own reports.

export interface BranchReportRow {
  locationId: string;
  locationName: string;
  isActive: boolean;
  orderCount: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  cogs: number;
  wasteCost: number;
}

export interface BusinessOverview {
  from: string | null;
  to: string | null;
  branches: BranchReportRow[];
  /** Sum of every branch above — computed independently, not by adding branches client-side. */
  consolidated: Omit<BranchReportRow, "locationId" | "locationName" | "isActive">;
}

function emptyTotals() {
  return { orderCount: 0, subtotal: 0, discount: 0, tax: 0, total: 0, cogs: 0, wasteCost: 0 };
}

/**
 * Per-branch and business-wide totals for a date range, both derived from the
 * same underlying views so they are guaranteed to reconcile — the exit
 * criterion isn't "we hope these two numbers agree", it's that there is only
 * one query path they could have come from.
 */
export async function getBusinessOverview(
  businessId: string,
  filters: DateRangeFilters = {},
): Promise<BusinessOverview> {
  const { dateFrom, dateTo } = filters;
  const industry = await getBusinessIndustry(businessId);
  const costOfSalesCodes = Array.from(costOfSalesCodesForIndustry(industry ?? "food_service"));

  const [locationsResult, salesResult, cogsResult, wasteResult, consolidatedSales, consolidatedCogs, consolidatedWaste] =
    await Promise.all([
      query<{ id: string; name: string; is_active: boolean }>(
        "SELECT id, name, is_active FROM locations WHERE business_id = $1 ORDER BY created_at",
        [businessId],
      ),
      query<{ location_id: string; order_count: string; subtotal: string; discount: string; tax: string; total: string }>(
        `SELECT location_id, sum(order_count) AS order_count, sum(subtotal) AS subtotal,
                sum(discount) AS discount, sum(tax) AS tax, sum(total) AS total
           FROM v_sales_by_day
          WHERE business_id = $1
            AND ($2::date IS NULL OR sale_date >= $2) AND ($3::date IS NULL OR sale_date <= $3)
          GROUP BY location_id`,
        [businessId, dateFrom ?? null, dateTo ?? null],
      ),
      query<{ location_id: string; cogs: string }>(
        `SELECT location_id, sum(debit) - sum(credit) AS cogs
           FROM v_ledger_by_account
          WHERE business_id = $1 AND account_code = ANY($4::text[])
            AND ($2::date IS NULL OR entry_date >= $2) AND ($3::date IS NULL OR entry_date <= $3)
          GROUP BY location_id`,
        [businessId, dateFrom ?? null, dateTo ?? null, costOfSalesCodes],
      ),
      query<{ location_id: string; cost: string }>(
        `SELECT location_id, sum(cost) AS cost
           FROM v_waste_summary
          WHERE business_id = $1
            AND ($2::date IS NULL OR waste_date >= $2) AND ($3::date IS NULL OR waste_date <= $3)
          GROUP BY location_id`,
        [businessId, dateFrom ?? null, dateTo ?? null],
      ),
      query<{ order_count: string; subtotal: string; discount: string; tax: string; total: string }>(
        `SELECT sum(order_count) AS order_count, sum(subtotal) AS subtotal,
                sum(discount) AS discount, sum(tax) AS tax, sum(total) AS total
           FROM v_sales_by_day
          WHERE business_id = $1
            AND ($2::date IS NULL OR sale_date >= $2) AND ($3::date IS NULL OR sale_date <= $3)`,
        [businessId, dateFrom ?? null, dateTo ?? null],
      ),
      query<{ cogs: string }>(
        `SELECT sum(debit) - sum(credit) AS cogs
           FROM v_ledger_by_account
          WHERE business_id = $1 AND account_code = ANY($4::text[])
            AND ($2::date IS NULL OR entry_date >= $2) AND ($3::date IS NULL OR entry_date <= $3)`,
        [businessId, dateFrom ?? null, dateTo ?? null, costOfSalesCodes],
      ),
      query<{ cost: string }>(
        `SELECT sum(cost) AS cost
           FROM v_waste_summary
          WHERE business_id = $1
            AND ($2::date IS NULL OR waste_date >= $2) AND ($3::date IS NULL OR waste_date <= $3)`,
        [businessId, dateFrom ?? null, dateTo ?? null],
      ),
    ]);

  const salesByLocation = new Map(salesResult.rows.map((r) => [r.location_id, r]));
  const cogsByLocation = new Map(cogsResult.rows.map((r) => [r.location_id, r]));
  const wasteByLocation = new Map(wasteResult.rows.map((r) => [r.location_id, r]));

  const branches: BranchReportRow[] = locationsResult.rows.map((loc) => {
    const sales = salesByLocation.get(loc.id);
    const cogs = cogsByLocation.get(loc.id);
    const waste = wasteByLocation.get(loc.id);
    return {
      locationId: loc.id,
      locationName: loc.name,
      isActive: loc.is_active,
      orderCount: Number(sales?.order_count ?? 0),
      subtotal: Number(sales?.subtotal ?? 0),
      discount: Number(sales?.discount ?? 0),
      tax: Number(sales?.tax ?? 0),
      total: Number(sales?.total ?? 0),
      cogs: Number(cogs?.cogs ?? 0),
      wasteCost: Number(waste?.cost ?? 0),
    };
  });

  const sales = consolidatedSales.rows[0];
  const cogs = consolidatedCogs.rows[0];
  const waste = consolidatedWaste.rows[0];
  const consolidated = sales
    ? {
        orderCount: Number(sales.order_count ?? 0),
        subtotal: Number(sales.subtotal ?? 0),
        discount: Number(sales.discount ?? 0),
        tax: Number(sales.tax ?? 0),
        total: Number(sales.total ?? 0),
        cogs: Number(cogs?.cogs ?? 0),
        wasteCost: Number(waste?.cost ?? 0),
      }
    : emptyTotals();

  return { from: dateFrom ?? null, to: dateTo ?? null, branches, consolidated };
}
