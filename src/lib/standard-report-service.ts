/** Shared dispatch only: calculations remain in the authoritative report services. */
import type { Industry } from "./industries";
import { reportShape, type StandardReportDef } from "./reports";
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
  locationId?: string;
}

/** Caller must authorize the definition against standardReportsFor(industry). */
export async function runStandardReport(
  businessId: string, industry: Industry | null, def: StandardReportDef, options: StandardReportOptions,
) {
  const { locationId, compare, dateTo, previousAsOfDate } = options;
  switch (def.key) {
    case "profit_and_loss":
      return compare
        ? { comparison: await getProfitAndLossComparison(businessId, options, locationId) }
        : { report: await getProfitAndLoss(businessId, options, locationId) };
    case "balance_sheet":
      return compare
        ? { comparison: await getBalanceSheetComparison(businessId, dateTo, previousAsOfDate, locationId) }
        : { report: await getBalanceSheet(businessId, dateTo, locationId) };
    case "cash_flow":
      return compare
        ? { comparison: await getCashFlowComparison(businessId, options, locationId) }
        : { report: await getCashFlow(businessId, options, locationId) };
    case "food_cost_variance":
      if (options.detailPage !== undefined) return getFoodCostVariancePage(businessId, options, locationId, options.detailPage);
      return { report: await getFoodCostVariance(businessId, options, locationId) };
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
  return { rows: await runStandardReportRows(def.key, businessId, options, locationId) };
}
