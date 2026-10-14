/**
 * Shared dispatch only: calculations remain in the authoritative report
 * services.
 *
 * The scope is a required option (issue #819) rather than an optional
 * `locationId`. This dispatcher is the single place the four ledger statements
 * are reached from the reporting surface, and it used to receive
 * `locationId?: string` — so the difference between "the caller resolved a
 * branch" and "the caller passed nothing" was invisible at the call site, and
 * one caller (the standard-report route's `LEDGER_WIDE_REPORTS` exception)
 * relied on it to read the whole business. Now the caller must hand over a
 * scope it obtained from `authorizedReportScope`, and the consolidated form has
 * to be spelled out.
 */
import type { Industry } from "./industries";
import { reportShape, type StandardReportDef } from "./reports";
import { reportScopeLocationId, type ReportScope } from "./report-scope";
import {
  getProfitAndLoss, getProfitAndLossComparison, getBalanceSheet, getBalanceSheetComparison,
  getCashFlow, getCashFlowComparison, getFoodCostVariance, getFoodCostVariancePage, runStandardReportRows,
  type DateRangeFilters,
} from "./reports-service";
import { runTradeReport, runTradeReportPage } from "./trade-reports-service";

export interface StandardReportOptions extends DateRangeFilters {
  /** Internal read option; existing tenant callers retain full-detail payloads. */
  detailPage?: number;
  compare?: boolean;
  previousAsOfDate?: string;
  /** The authorized scope. Required — see the file comment. */
  scope: ReportScope;
}

/** Caller must authorize the definition against standardReportsFor(industry). */
export async function runStandardReport(
  businessId: string, industry: Industry | null, def: StandardReportDef, options: StandardReportOptions,
) {
  const { compare, dateTo, previousAsOfDate } = options;
  const locationId = reportScopeLocationId(options.scope);
  switch (def.key) {
    case "profit_and_loss":
      return compare
        ? { comparison: await getProfitAndLossComparison(businessId, options, options.scope) }
        : { report: await getProfitAndLoss(businessId, options, options.scope) };
    case "balance_sheet":
      return compare
        ? { comparison: await getBalanceSheetComparison(businessId, dateTo, previousAsOfDate, options.scope) }
        : { report: await getBalanceSheet(businessId, dateTo, options.scope) };
    case "cash_flow":
      return compare
        ? { comparison: await getCashFlowComparison(businessId, options, options.scope) }
        : { report: await getCashFlow(businessId, options, options.scope) };
    case "food_cost_variance":
      if (options.detailPage !== undefined) return getFoodCostVariancePage(businessId, options, options.scope, options.detailPage);
      return { report: await getFoodCostVariance(businessId, options, options.scope) };
  }
  if (reportShape(def) !== "rows") {
    if (options.detailPage !== undefined) {
      const paged = await runTradeReportPage(def.key, {
        businessId, industry: industry ?? "food_service", locationId: locationId ?? null, filters: options,
      }, options.detailPage);
      if (paged) return paged;
    }
    const report = await runTradeReport(def.key, {
      businessId, industry: industry ?? "food_service", locationId: locationId ?? null, filters: options,
    });
    if (report) return { report };
  }
  return { rows: await runStandardReportRows(def.key, businessId, options.scope, options) };
}
