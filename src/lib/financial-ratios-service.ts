/**
 * «تحلیل مالی» — the calculation service.
 *
 * Everything here reads the SAME journal lines the trial balance, P&L, balance
 * sheet and cash-flow statement read (`journal_lines` joined to
 * `journal_entries` and `accounts`, with the carry-forward snapshots excluded),
 * under the same required `ReportScope` policy (issue #819) and the same
 * optional accounting-dimension filter as the dimension reports (issue #868).
 * No balance is copied, cached or stored, so a new posting or a reclassified
 * account changes the next calculation with no invalidation step.
 *
 * The service decides which accounts make up each documented input; the pure
 * catalogue (`financial-ratios.ts`) decides what the ratio means and when it is
 * unavailable. Keeping that line sharp is what lets the acceptance test compare
 * these inputs to `getProfitAndLoss` and `getBalanceSheet` figure by figure.
 *
 * ## Account mapping (the one reviewed exception)
 *
 * The seeded charts have no interest-expense account, so there is no default
 * classification for it. Rather than guess from a code block or a name, the
 * business names the account once (stored as a setting) and the report uses it.
 * Until then interest coverage is `unavailable` with
 * `interest_expense_not_classified` — never a made-up zero.
 */
import type { Industry } from "./industries";
import { query } from "./db";
import { addDays } from "./rollup";
import { getBusinessIndustry } from "./industry-guard";
import { classifyAccounts, isUsableLiquidity, type AccountRole } from "./account-classification";
import { costOfSalesCodesForIndustry, isNonCurrentCode, type AccountType } from "./coa-template";
import { dimensionLinePredicate } from "./accounting-dimension-reports";
import type { DimensionFilter } from "./accounting-dimensions";
import { notCarryForwardSnapshotSql } from "./carry-forward-exclusion";
import { reportScopeLocationId, type ReportScope } from "./report-scope";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { previousPeriodRange } from "./reports";
import { formatJalali } from "./jalali";
import {
  FINANCIAL_RATIO_CATALOGUE_VERSION,
  FINANCIAL_RATIO_TREND_KEYS,
  RATIO_INPUT_LABELS,
  RATIO_INPUT_UNITS,
  RATIO_SOURCE_LABELS,
  compareFinancialRatios,
  computeFinancialRatios,
  groupFinancialRatios,
  periodDayCount,
  type FinancialRatioInputSet,
  type FinancialRatioResult,
  type RatioGroupReport,
  type RatioInputKey,
  type RatioKey,
  type RatioReasonCode,
  type RatioSourceReport,
} from "./financial-ratios";

/** Which accounts a business has reviewed as its interest-expense accounts. */
export interface FinancialRatioMapping {
  interestExpenseAccountCodes: string[];
}

export const EMPTY_RATIO_MAPPING: FinancialRatioMapping = { interestExpenseAccountCodes: [] };

const MAX_MAPPED_ACCOUNTS = 10;
const ACCOUNT_CODE_RE = /^\d{1,12}$/;

/** Normalizes a stored or submitted mapping; anything malformed falls back to "not mapped". */
export function normalizeFinancialRatioMapping(value: unknown): FinancialRatioMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_RATIO_MAPPING;
  const raw = (value as { interestExpenseAccountCodes?: unknown }).interestExpenseAccountCodes;
  if (!Array.isArray(raw)) return EMPTY_RATIO_MAPPING;
  const codes = [...new Set(raw.filter((code): code is string => typeof code === "string" && ACCOUNT_CODE_RE.test(code)))];
  return { interestExpenseAccountCodes: codes.slice(0, MAX_MAPPED_ACCOUNTS) };
}

export async function getFinancialRatioMapping(businessId: string): Promise<FinancialRatioMapping> {
  const stored = await getSetting<unknown>(businessId, SETTING_KEYS.financialRatioMapping);
  return normalizeFinancialRatioMapping(stored);
}

/**
 * Saves the reviewed interest-expense mapping. A code must exist in this
 * business's chart as an expense account, so a typo cannot silently leave the
 * ratio unavailable for a reason the person cannot see.
 */
export async function setFinancialRatioMapping(
  businessId: string,
  input: unknown,
): Promise<FinancialRatioMapping> {
  const normalized = normalizeFinancialRatioMapping(input);
  if (normalized.interestExpenseAccountCodes.length > 0) {
    const { rows } = await query<{ code: string }>(
      `SELECT code FROM accounts WHERE business_id = $1 AND type = 'expense' AND code = ANY($2::text[])`,
      [businessId, normalized.interestExpenseAccountCodes],
    );
    const known = new Set(rows.map((row) => row.code));
    const unknown = normalized.interestExpenseAccountCodes.filter((code) => !known.has(code));
    if (unknown.length > 0) {
      const error = new Error("unknown_interest_account");
      (error as Error & { codes?: string[] }).codes = unknown;
      throw error;
    }
  }
  await setSetting(businessId, SETTING_KEYS.financialRatioMapping, normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// Ledger reads
// ---------------------------------------------------------------------------

interface AccountSumRow extends Record<string, unknown> {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: AccountType;
  debit: string;
  credit: string;
}

interface AccountSum {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  debit: number;
  credit: number;
}

interface ChartAccount {
  id: string;
  code: string;
  parentId: string | null;
  type: AccountType;
}

interface ReadOptions {
  dateFrom?: string;
  dateTo?: string;
  scope: ReportScope;
  dimension: DimensionFilter | null;
}

/**
 * Per-account debit/credit sums for a period or as of a date, from the same
 * lines the statements read. The branch predicate comes from the authorized
 * scope; the dimension predicate is the shared one, bound as a parameter.
 */
async function readAccountSums(
  businessId: string,
  options: ReadOptions,
): Promise<Map<string, AccountSum>> {
  const locationId = reportScopeLocationId(options.scope);
  const params: unknown[] = [businessId];
  const where = ["je.business_id = $1", "a.business_id = $1", notCarryForwardSnapshotSql("je")];
  if (options.dateFrom) {
    params.push(options.dateFrom);
    where.push(`je.entry_date >= $${params.length}`);
  }
  if (options.dateTo) {
    params.push(options.dateTo);
    where.push(`je.entry_date <= $${params.length}`);
  }
  if (locationId) {
    params.push(locationId);
    where.push(`je.location_id = $${params.length}`);
  }
  where.push(
    dimensionLinePredicate(options.dimension, (value) => {
      params.push(value);
      return `$${params.length}`;
    }),
  );
  const { rows } = await query<AccountSumRow>(
    `SELECT a.id AS account_id, a.code AS account_code, a.name AS account_name,
            a.type::text AS account_type,
            COALESCE(SUM(jl.debit), 0)::text AS debit,
            COALESCE(SUM(jl.credit), 0)::text AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE ${where.join(" AND ")}
      GROUP BY a.id, a.code, a.name, a.type`,
    params,
  );
  return new Map(
    rows.map((row) => [
      row.account_id,
      {
        id: row.account_id,
        code: row.account_code,
        name: row.account_name,
        type: row.account_type,
        debit: Number(row.debit),
        credit: Number(row.credit),
      },
    ]),
  );
}

async function readChart(businessId: string): Promise<ChartAccount[]> {
  const { rows } = await query<{ id: string; code: string; parent_id: string | null; type: AccountType }>(
    `SELECT id, code, parent_id, type::text AS type FROM accounts WHERE business_id = $1`,
    [businessId],
  );
  return rows.map((row) => ({ id: row.id, code: row.code, parentId: row.parent_id, type: row.type }));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface FinancialRatioAccountLine {
  code: string;
  name: string;
  amount: number;
}

export interface FinancialRatioInputDetail {
  key: RatioInputKey;
  label: string;
  unit: "money" | "days";
  value: number | null;
  accounts: FinancialRatioAccountLine[];
}

interface BuiltInputs {
  set: FinancialRatioInputSet;
  sources: Map<RatioInputKey, FinancialRatioAccountLine[]>;
  /** At least one journal line contributed to the period or the closing balance. */
  hasActivity: boolean;
}

function signed(accountType: AccountType, debit: number, credit: number): number {
  return accountType === "asset" || accountType === "expense" ? debit - credit : credit - debit;
}

function isInventoryCode(code: string): boolean {
  const numeric = Number.parseInt(code, 10);
  return Number.isFinite(numeric) && numeric >= 1300 && numeric <= 1399;
}

/** Only the accounts the business named count; a broader prefix is never assumed. */
function matchesMappedCode(code: string, mapped: readonly string[]): boolean {
  return mapped.includes(code);
}

interface RatioContextBase {
  scope: ReportScope;
  dimension: DimensionFilter | null;
  roles: Map<string, AccountRole | null>;
  industry: Industry | null;
  interestCodes: string[];
}

interface BuildContext extends RatioContextBase {
  period: Map<string, AccountSum>;
  asOf: Map<string, AccountSum>;
  opening: Map<string, AccountSum>;
  periodDays: number | null;
}

function buildRatioInputs(context: BuildContext): BuiltInputs {
  const sources = new Map<RatioInputKey, FinancialRatioAccountLine[]>();
  const record = (key: RatioInputKey, line: FinancialRatioAccountLine) => {
    const list = sources.get(key) ?? [];
    list.push(line);
    sources.set(key, list);
  };

  const sum = (
    rows: Map<string, AccountSum>,
    predicate: (row: AccountSum) => boolean,
  ): number => {
    let total = 0;
    for (const row of rows.values()) {
      if (!predicate(row)) continue;
      total += signed(row.type, row.debit, row.credit);
    }
    return total;
  };

  const collect = (
    key: RatioInputKey,
    rows: Map<string, AccountSum>,
    predicate: (row: AccountSum) => boolean,
  ): number => {
    let total = 0;
    for (const row of rows.values()) {
      if (!predicate(row)) continue;
      const amount = signed(row.type, row.debit, row.credit);
      total += amount;
      record(key, { code: row.code, name: row.name, amount });
    }
    return total;
  };

  const roleOf = (row: AccountSum) => context.roles.get(row.id) ?? null;
  const isLiquid = (row: AccountSum) => row.type === "asset" && isUsableLiquidity(roleOf(row));
  const isTradeReceivable = (row: AccountSum) => row.type === "asset" && roleOf(row) === "trade_receivable";
  const isTradePayable = (row: AccountSum) => row.type === "liability" && roleOf(row) === "trade_payable";
  const isInventory = (row: AccountSum) => row.type === "asset" && isInventoryCode(row.code);

  const retainedEarnings = (rows: Map<string, AccountSum>): number => {
    let total = 0;
    for (const row of rows.values()) {
      if (row.type === "revenue") total += signed(row.type, row.debit, row.credit);
      else if (row.type === "expense") total -= signed(row.type, row.debit, row.credit);
    }
    return total;
  };

  const equityBalance = (rows: Map<string, AccountSum>): number =>
    sum(rows, (row) => row.type === "equity") + retainedEarnings(rows);

  const costOfSalesCodes = new Set(costOfSalesCodesForIndustry(context.industry ?? "food_service"));

  const cashAndEquivalents = collect("cashAndEquivalents", context.asOf, isLiquid);
  const tradeReceivables = collect("tradeReceivables", context.asOf, isTradeReceivable);
  const tradePayables = collect("tradePayables", context.asOf, isTradePayable);
  const inventory = collect("inventory", context.asOf, isInventory);
  const currentAssets = collect(
    "currentAssets",
    context.asOf,
    (row) => row.type === "asset" && !isNonCurrentCode("asset", row.code),
  );
  const currentLiabilities = collect(
    "currentLiabilities",
    context.asOf,
    (row) => row.type === "liability" && !isNonCurrentCode("liability", row.code),
  );
  const totalAssets = collect("totalAssets", context.asOf, (row) => row.type === "asset");
  const totalLiabilities = collect("totalLiabilities", context.asOf, (row) => row.type === "liability");
  const equityAccounts = collect("totalEquity", context.asOf, (row) => row.type === "equity");
  const retainedAsOf = retainedEarnings(context.asOf);
  if (retainedAsOf !== 0) {
    record("totalEquity", {
      code: "",
      name: "سود انباشتهٔ ثبت‌نشده در حساب‌های سرمایه",
      amount: retainedAsOf,
    });
  }
  const totalEquity = equityAccounts + retainedAsOf;

  const openingTotalAssets = collect("openingTotalAssets", context.opening, (row) => row.type === "asset");
  const openingEquityAccounts = collect("openingTotalEquity", context.opening, (row) => row.type === "equity");
  const openingRetained = retainedEarnings(context.opening);
  if (openingRetained !== 0) {
    record("openingTotalEquity", {
      code: "",
      name: "سود انباشتهٔ ابتدای دوره",
      amount: openingRetained,
    });
  }
  const openingTotalEquity = openingEquityAccounts + openingRetained;
  const openingInventory = collect("openingInventory", context.opening, isInventory);
  const openingTradeReceivables = collect("openingTradeReceivables", context.opening, isTradeReceivable);
  const openingTradePayables = collect("openingTradePayables", context.opening, isTradePayable);

  const netRevenue = collect("netRevenue", context.period, (row) => row.type === "revenue");
  const totalExpenses = sum(context.period, (row) => row.type === "expense");
  const costOfSales = collect(
    "costOfSales",
    context.period,
    (row) => row.type === "expense" && costOfSalesCodes.has(row.code),
  );
  const grossProfit = netRevenue - costOfSales;

  let interestExpense: number | null = null;
  if (context.interestCodes.length > 0) {
    interestExpense = collect(
      "interestExpense",
      context.period,
      (row) => row.type === "expense" && matchesMappedCode(row.code, context.interestCodes),
    );
  }

  const operatingExpenses = totalExpenses - costOfSales - (interestExpense ?? 0);
  const operatingProfit = grossProfit - operatingExpenses;
  const netIncome = netRevenue - totalExpenses;

  const values: FinancialRatioInputSet["values"] = {
    cashAndEquivalents,
    tradeReceivables,
    tradePayables,
    inventory,
    currentAssets,
    currentLiabilities,
    totalAssets,
    totalLiabilities,
    totalEquity,
    netRevenue,
    costOfSales,
    grossProfit,
    operatingExpenses,
    operatingProfit,
    interestExpense,
    netIncome,
    periodDays: context.periodDays,
    openingTotalAssets: context.opening.size > 0 ? openingTotalAssets : null,
    openingTotalEquity: context.opening.size > 0 ? openingTotalEquity : null,
    openingInventory: context.opening.size > 0 ? openingInventory : null,
    openingTradeReceivables: context.opening.size > 0 ? openingTradeReceivables : null,
    openingTradePayables: context.opening.size > 0 ? openingTradePayables : null,
  };

  const reasons: FinancialRatioInputSet["reasons"] = {};
  if (context.interestCodes.length === 0) {
    reasons.interestExpense = "interest_expense_not_classified";
  }

  return {
    set: { values, reasons },
    sources,
    hasActivity: context.period.size > 0 || context.asOf.size > 0,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface FinancialRatioTrendPoint {
  dateFrom: string;
  dateTo: string;
  label: string;
  values: Partial<Record<RatioKey, number | null>>;
}

export interface FinancialRatioTrend {
  periods: number;
  keys: RatioKey[];
  points: FinancialRatioTrendPoint[];
}

export interface FinancialRatiosChecks {
  /** No period activity and no balance at the period end: the report has nothing to analyse. */
  hasLedgerActivity: boolean;
  /** Assets = liabilities + equity on the same filtered lines. Not asserted under a dimension filter. */
  balanceSheetBalanced: boolean | null;
  totalAssets: number;
  totalLiabilitiesAndEquity: number;
  /** Opening balances existed, so average-balance ratios could be computed. */
  openingComparativesAvailable: boolean;
}

export interface FinancialRatiosReport {
  catalogueVersion: string;
  generatedAt: string;
  scope: "branch" | "business-wide";
  period: { dateFrom: string; dateTo: string; days: number | null };
  comparisonPeriod: { dateFrom: string; dateTo: string } | null;
  dimension: DimensionFilter | null;
  groups: (Omit<RatioGroupReport, "ratios"> & {
    ratios: (FinancialRatioResult & {
      previous: FinancialRatioResult | null;
      change: number | null;
      changePct: number | null;
      direction: "up" | "down" | "flat" | null;
    })[];
  })[];
  inputs: FinancialRatioInputDetail[];
  checks: FinancialRatiosChecks;
  warnings: string[];
  mapping: FinancialRatioMapping;
  trend: FinancialRatioTrend | null;
  sourceLabels: Record<RatioSourceReport, string>;
}

export interface FinancialRatiosOptions {
  dateFrom: string;
  dateTo: string;
  scope: ReportScope;
  dimension?: DimensionFilter | null;
  compare?: boolean;
  /** Rolling same-length periods for the trend chart. 0 disables it; capped at 12. */
  trendPeriods?: number;
}

const INPUT_ORDER: readonly RatioInputKey[] = [
  "netRevenue",
  "costOfSales",
  "grossProfit",
  "operatingExpenses",
  "operatingProfit",
  "interestExpense",
  "netIncome",
  "periodDays",
  "cashAndEquivalents",
  "tradeReceivables",
  "inventory",
  "currentAssets",
  "currentLiabilities",
  "totalAssets",
  "totalLiabilities",
  "totalEquity",
  "openingTotalAssets",
  "openingTotalEquity",
  "openingInventory",
  "openingTradeReceivables",
  "openingTradePayables",
  "tradePayables",
];

async function buildInputsForWindow(
  businessId: string,
  context: RatioContextBase & { dateFrom: string; dateTo: string },
): Promise<BuiltInputs> {
  const [period, asOf, opening] = await Promise.all([
    readAccountSums(businessId, {
      dateFrom: context.dateFrom,
      dateTo: context.dateTo,
      scope: context.scope,
      dimension: context.dimension,
    }),
    readAccountSums(businessId, {
      dateTo: context.dateTo,
      scope: context.scope,
      dimension: context.dimension,
    }),
    readAccountSums(businessId, {
      dateTo: addDays(context.dateFrom, -1),
      scope: context.scope,
      dimension: context.dimension,
    }),
  ]);
  return buildRatioInputs({
    period,
    asOf,
    opening,
    scope: context.scope,
    dimension: context.dimension,
    roles: context.roles,
    industry: context.industry,
    periodDays: periodDayCount(context.dateFrom, context.dateTo),
    interestCodes: context.interestCodes,
  });
}

export async function getFinancialRatios(
  businessId: string,
  options: FinancialRatiosOptions,
): Promise<FinancialRatiosReport> {
  const dimension = options.dimension ?? null;
  const [industry, chart, mapping] = await Promise.all([
    getBusinessIndustry(businessId),
    readChart(businessId),
    getFinancialRatioMapping(businessId),
  ]);
  const roles = classifyAccounts(
    chart.map((account) => ({
      id: account.id,
      code: account.code,
      parentId: account.parentId,
      type: account.type,
    })),
  );
  const base: RatioContextBase = {
    scope: options.scope,
    dimension,
    roles,
    industry,
    interestCodes: mapping.interestExpenseAccountCodes,
  };

  const built = await buildInputsForWindow(businessId, {
    ...base,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
  });
  const ratios = computeFinancialRatios(built.set);

  let previous: FinancialRatioResult[] | null = null;
  let comparisonPeriod: { dateFrom: string; dateTo: string } | null = null;
  if (options.compare) {
    comparisonPeriod = previousPeriodRange(options.dateFrom, options.dateTo);
    const previousBuilt = await buildInputsForWindow(businessId, { ...base, ...comparisonPeriod });
    previous = computeFinancialRatios(previousBuilt.set);
  }
  const compared = compareFinancialRatios(ratios, previous);
  const groups: (Omit<RatioGroupReport, "ratios"> & {
    ratios: ReturnType<typeof compareFinancialRatios>[number][];
  })[] = groupFinancialRatios(compared).map((group) => ({
    ...group,
    ratios: compared.filter((ratio) => ratio.group === group.key),
  }));

  const values = built.set.values;
  const totalAssets = values.totalAssets ?? 0;
  const totalLiabilities = values.totalLiabilities ?? 0;
  const totalEquity = values.totalEquity ?? 0;
  const openingComparativesAvailable = ["openingTotalAssets", "openingTotalEquity", "openingInventory"].some(
    (key) => typeof values[key as RatioInputKey] === "number",
  );
  const currentRatio = compared.find((ratio) => ratio.key === "current_ratio");
  const checks: FinancialRatiosChecks = {
    hasLedgerActivity: built.hasActivity,
    // Under a dimension filter the filtered lines are not a balanced trial
    // balance (an entry's asset line may carry no value while its revenue line
    // does), so asserting a balance there would be a false alarm.
    balanceSheetBalanced: dimension ? null : totalAssets === totalLiabilities + totalEquity,
    totalAssets,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    openingComparativesAvailable,
  };

  const warnings: string[] = [];
  if (!checks.hasLedgerActivity) {
    warnings.push("در بازهٔ انتخابی هیچ سند یا مانده‌ای در دفتر ثبت نشده است؛ نسبت‌ها بر دادهٔ واقعی تکیه ندارند.");
  }
  if (checks.balanceSheetBalanced === false) {
    warnings.push(
      "جمع دارایی‌ها با جمع بدهی‌ها و حقوق صاحبان سرمایه برابر نیست؛ پیش از تکیه بر نسبت‌های اهرمی، ترازنامه را بررسی کنید.",
    );
  }
  if (mapping.interestExpenseAccountCodes.length === 0) {
    warnings.push(
      "حساب هزینهٔ بهره در تنظیمات تحلیل مالی تعیین نشده است؛ نسبت پوشش بهره محاسبه نمی‌شود و اگر هزینهٔ مالی دارید، حاشیهٔ عملیاتی آن را در خود دارد.",
    );
  }
  if (!openingComparativesAvailable) {
    warnings.push(
      "ماندهٔ ابتدای دوره در دفتر موجود نیست؛ نسبت‌های میانگین‌محور (بازده دارایی‌ها، بازده سرمایه، گردش موجودی و مطالبات) ناموجود گزارش می‌شوند.",
    );
  }
  if (dimension) {
    warnings.push(
      "فیلتر بُعد حسابداری اعمال شده است؛ ارقام همان سطرهای دارای این بُعد هستند و لزوماً با ترازنامهٔ کامل دوره برابر نیستند.",
    );
  }
  if (currentRatio?.status === "unavailable" && currentRatio.reason === "zero_denominator") {
    warnings.push("بدهی جاری در پایان دوره صفر است؛ نسبت‌های نقدینگی تعریف نشده‌اند.");
  }

  const trendPeriods = Math.max(0, Math.min(12, Math.floor(options.trendPeriods ?? 0)));
  let trend: FinancialRatioTrend | null = null;
  if (trendPeriods > 1) {
    trend = await buildTrend(businessId, options.dateFrom, options.dateTo, trendPeriods, base);
  }

  const inputDetails: FinancialRatioInputDetail[] = INPUT_ORDER.filter(
    (key) => Object.prototype.hasOwnProperty.call(values, key),
  ).map((key) => ({
    key,
    label: RATIO_INPUT_LABELS[key],
    unit: RATIO_INPUT_UNITS[key],
    value: values[key] ?? null,
    accounts: (built.sources.get(key) ?? []).sort((a, b) => a.code.localeCompare(b.code)),
  }));

  return {
    catalogueVersion: FINANCIAL_RATIO_CATALOGUE_VERSION,
    generatedAt: new Date().toISOString(),
    scope: options.scope.mode,
    period: {
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      days: periodDayCount(options.dateFrom, options.dateTo),
    },
    comparisonPeriod,
    dimension,
    groups,
    inputs: inputDetails,
    checks,
    warnings,
    mapping,
    trend,
    sourceLabels: RATIO_SOURCE_LABELS,
  };
}

/**
 * A rolling trend of the same period length, ending at the selected period.
 * Every point is computed by the same input builder as the headline report, so
 * the last point always equals the current-period ratios. The points are whole
 * equal-length periods rather than calendar months because Jalali months do not
 * line up with the storage calendar; comparing like with like is the point.
 */
async function buildTrend(
  businessId: string,
  dateFrom: string,
  dateTo: string,
  periods: number,
  context: RatioContextBase,
): Promise<FinancialRatioTrend> {
  const ranges: { dateFrom: string; dateTo: string }[] = [];
  let currentFrom = dateFrom;
  let currentTo = dateTo;
  for (let index = 0; index < periods; index++) {
    ranges.unshift({ dateFrom: currentFrom, dateTo: currentTo });
    const previous = previousPeriodRange(currentFrom, currentTo);
    currentFrom = previous.dateFrom;
    currentTo = previous.dateTo;
  }

  const points: FinancialRatioTrendPoint[] = [];
  for (const range of ranges) {
    const built = await buildInputsForWindow(businessId, { ...context, ...range });
    const ratios = computeFinancialRatios(built.set);
    const values: Partial<Record<RatioKey, number | null>> = {};
    for (const key of FINANCIAL_RATIO_TREND_KEYS) {
      values[key] = ratios.find((ratio) => ratio.key === key)?.value ?? null;
    }
    points.push({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      label: formatJalali(range.dateTo),
      values,
    });
  }

  return { periods, keys: [...FINANCIAL_RATIO_TREND_KEYS], points };
}

/** A warning list for the export's header — the same sentences the screen shows. */
export function ratioWarningSummary(report: FinancialRatiosReport): string {
  return report.warnings.join(" ");
}

/** The trend keys that carry a percent unit, so the screen formats their points correctly. */
export function trendUnit(key: RatioKey): "ratio" | "percent" {
  return key.endsWith("_margin") || key === "return_on_assets" || key === "return_on_equity"
    ? "percent"
    : "ratio";
}

/** Re-exported so callers do not reach into the pure module for the reason vocabulary. */
export type { RatioReasonCode };
