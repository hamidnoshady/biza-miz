/**
 * The decisions «گزارش‌های آماده» makes before it renders anything: how a
 * report's own config combines with the date range the user picked, which
 * shapes accept which controls, and what a failed read should say.
 *
 * These live in a plain `.ts` module rather than inside the section component
 * because they are the part worth pinning with tests — the vitest config only
 * collects `src/**\/*.test.ts`, and the config merge below is the one piece of
 * this screen that can silently return *the wrong report* rather than an
 * obviously broken one.
 */

/**
 * Mirrors `ReportShape` in src/lib/reports.ts — the server tells us which view
 * renders the payload.
 *
 * Deliberately a copy rather than an import: `@/lib/reports` reaches
 * `./rollup`, which imports `node:crypto`, and this module is loaded by a
 * client component. A `ReportShape` the server doesn't know would land in the
 * `default` arm of `TradeReportBody` and say so on screen.
 */
export type ReportShape =
  | "rows"
  | "profit_and_loss"
  | "balance_sheet"
  | "cash_flow"
  | "food_cost_variance"
  | "weight_reconciliation"
  | "consignor_statements"
  | "layaway_book"
  | "warranty"
  | "repairs"
  | "variant_sales"
  | "brand_sales"
  | "near_expiry"
  | "low_stock"
  | "dead_stock"
  // Issue #839 §14 — the dealership's own report payloads.
  | "vehicle_inventory"
  | "vehicle_sales"
  | "vehicle_reservations";

/**
 * A standard report's chart config, as the API hands it over.
 *
 * `filters.equals` is spelled out because of the bug `configWithRange` exists
 * to prevent: the type used to be `Record<string, unknown>`, so overwriting
 * `filters` wholesale type-checked perfectly while dropping the narrowing that
 * makes a report itself.
 */
export interface ReportChartConfig extends Record<string, unknown> {
  view?: string;
  /** Top-N reports carry one; the table says so rather than implying it read everything. */
  limit?: number;
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    /**
     * The report's *own* narrowing — «روند بهای تمام‌شده کالا» is the ledger
     * view filtered to `account_code: "5100"`.
     */
    equals?: Record<string, unknown>;
  };
}

/**
 * Merges the picked date range into a report's own config without dropping the
 * filters the report was defined with.
 *
 * The bug this replaces was a one-line spread: `{...config, filters: {dateFrom,
 * dateTo}}` overwrote `filters` wholesale, and «روند بهای تمام‌شده کالا» is
 * `v_ledger_by_account` narrowed by `equals: {account_code: "5100"}` — so the
 * report that is supposed to plot cost of goods sold plotted *every debit in
 * the ledger*, silently, as a plausible-looking curve nobody could tell was
 * wrong. The date keys are omitted rather than set to `undefined` so
 * `JSON.stringify` doesn't ship `"filters":{}` for a report that had a real
 * filter.
 */
export function configWithRange(
  config: ReportChartConfig | null,
  dateFrom: string,
  dateTo: string,
): ReportChartConfig {
  const { filters, ...rest } = config ?? {};
  const merged = {
    ...filters,
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };
  // A report with no filters at all keeps `filters` absent — `validateReportConfig`
  // accepts either, and an empty object in the payload reads like a filter was lost.
  return Object.keys(merged).length > 0 ? { ...rest, filters: merged } : { ...rest };
}

/**
 * Why a report could not be read, in the words the person looking at it needs.
 *
 * Every failure used to say «خواندن این گزارش ممکن نشد.» — including the two
 * that are not faults at all but instructions: a 403 means this account's role
 * may not open the report, and a 404 means the report does not belong to this
 * business's trade. Telling an accountant to "try again" for a permission
 * problem is the kind of dead end that ends in a support call.
 */
export function errorMessage(status: number): string {
  if (status === 401) return "نشست شما منقضی شده است. دوباره وارد شوید.";
  if (status === 403) return "شما به این گزارش دسترسی ندارید.";
  if (status === 404) return "این گزارش برای کسب‌وکار شما تعریف نشده است.";
  if (status === 400) return "درخواست این گزارش معتبر نبود. بازهٔ تاریخ را بررسی کنید.";
  if (status >= 500) return "خطای سرور هنگام ساخت گزارش. کمی بعد دوباره تلاش کنید.";
  return "خواندن این گزارش ممکن نشد.";
}

/** Reports rendered as a structured document rather than a dimension/measure table. */
export const DOCUMENT_SHAPES = new Set<ReportShape>([
  "profit_and_loss",
  "balance_sheet",
  "cash_flow",
  "food_cost_variance",
  "weight_reconciliation",
  "consignor_statements",
  "layaway_book",
  "warranty",
  "repairs",
  "variant_sales",
  "brand_sales",
  "near_expiry",
  "low_stock",
  "dead_stock",
]);

/**
 * Which reports accept `?compare=1`. Food-cost variance is deliberately absent:
 * it is a period total against the ledger, not a per-account rollup, and its
 * "worst item" ranking has no obvious side-by-side presentation. The trade
 * reports are absent for the same kind of reason — a warranty register is a
 * register, not a period figure.
 */
export const COMPARABLE_SHAPES = new Set<ReportShape>(["profit_and_loss", "balance_sheet", "cash_flow"]);

/** Reports with nothing period-shaped to bound: a stock level or a register is "as of now". */
export const UNDATED_SHAPES = new Set<ReportShape>([
  "weight_reconciliation",
  "consignor_statements",
  "layaway_book",
  "near_expiry",
  "low_stock",
  "dead_stock",
]);

/**
 * Point-in-time statements: only an as-of date means anything to them, so they
 * get one clearly-named field instead of a range whose start silently does
 * nothing to the figures. The warranty register belongs here too — its API
 * lists open+returned items up to a cutoff (`until`), and ignores `dateFrom`.
 */
export const SNAPSHOT_SHAPES = new Set<ReportShape>(["balance_sheet", "warranty"]);

/** The export API only knows these kinds; everything else has no export path yet. */
export const EXPORT_KIND_BY_SHAPE: Partial<Record<ReportShape, "pnl" | "balance_sheet" | "cash_flow">> = {
  profit_and_loss: "pnl",
  balance_sheet: "balance_sheet",
  cash_flow: "cash_flow",
};

/**
 * Whether a comparison can actually be computed for what the user has picked.
 *
 * The period statements mirror the selected range backwards and need both of
 * its ends; a balance sheet needs an explicit earlier as-of date, which it
 * collects *after* the box is ticked. Ticking a box that then returns
 * `previous: null` and draws nothing is the failure this prevents.
 */
export function comparisonReady(shape: ReportShape, dateFrom: string, dateTo: string): boolean {
  if (!COMPARABLE_SHAPES.has(shape)) return false;
  if (SNAPSHOT_SHAPES.has(shape)) return true;
  return Boolean(dateFrom && dateTo);
}

/**
 * A range the user can see is wrong. A snapshot's `dateFrom` is its comparison
 * date, which is *supposed* to be earlier than the as-of date, so the check
 * does not apply there.
 */
export function isInvalidRange(shape: ReportShape, dateFrom: string, dateTo: string): boolean {
  if (SNAPSHOT_SHAPES.has(shape)) return false;
  return Boolean(dateFrom && dateTo && dateFrom > dateTo);
}
