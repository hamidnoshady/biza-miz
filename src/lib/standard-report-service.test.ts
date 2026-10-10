import { beforeEach, describe, expect, it, vi } from "vitest";
const services = vi.hoisted(() => Object.fromEntries([
  "getProfitAndLoss", "getProfitAndLossComparison", "getBalanceSheet", "getBalanceSheetComparison", "getCashFlow", "getCashFlowComparison", "getFoodCostVariance", "getFoodCostVariancePage", "runStandardReportRows",
].map((key) => [key, vi.fn(async () => ({ marker: key }))])));
const tradePage = vi.hoisted(() => vi.fn(async () => ({ report: { rows: [] }, pagination: { page: 2, total: 100, pageSize: 50, pages: 2 } })));
const trade = vi.hoisted(() => vi.fn(async () => ({ rows: [] })));
vi.mock("./reports-service", () => services);
vi.mock("./trade-reports-service", () => ({ runTradeReport: trade, runTradeReportPage: tradePage }));
import { runStandardReport } from "./standard-report-service";
import { STANDARD_REPORTS } from "./reports";
import { branchScope, BUSINESS_WIDE_SCOPE } from "./report-scope";
beforeEach(() => vi.clearAllMocks());
const BRANCH = "branch";
const def = (key: string) => STANDARD_REPORTS.find((r) => r.key === key)!;
describe("shared standard report dispatch", () => {
  it.each([
    ["profit_and_loss", "getProfitAndLoss"], ["balance_sheet", "getBalanceSheet"], ["cash_flow", "getCashFlow"], ["food_cost_variance", "getFoodCostVariance"],
  ])("retains the structured %s payload", async (key, service) => {
    expect(await runStandardReport("a", "food_service", def(key), { dateFrom: "2026-01-01", dateTo: "2026-01-31", scope: branchScope(BRANCH) })).toEqual({ report: { marker: service } });
    expect(services[service].mock.calls[0]).toContain("a");
    // The branch reaches the authoritative service on every one of the four
    // statements (issue #819). It used to reach only the ones a caller
    // remembered to pass it to, which is how P&L/Balance Sheet/Cash Flow read
    // the whole business through `/api/reports/standard/[key]`.
    expect(services[service].mock.calls[0]).toContainEqual(branchScope(BRANCH));
  });
  it.each([
    ["profit_and_loss"], ["balance_sheet"], ["cash_flow"], ["food_cost_variance"],
  ])("reads the whole business for %s only when the consolidated scope is explicit", async (key) => {
    const service = {
      profit_and_loss: "getProfitAndLoss",
      balance_sheet: "getBalanceSheet",
      cash_flow: "getCashFlow",
      food_cost_variance: "getFoodCostVariance",
    }[key] as "getProfitAndLoss" | "getBalanceSheet" | "getCashFlow" | "getFoodCostVariance";
    await runStandardReport("a", "food_service", def(key), { scope: BUSINESS_WIDE_SCOPE });
    const call = services[service].mock.calls[0];
    // `undefined` here means "every branch" — and it is reachable only by
    // handing this dispatcher a scope that says so.
    expect(call).not.toContain(BRANCH);
    expect(call).toContainEqual(BUSINESS_WIDE_SCOPE);
  });
  it("refuses a call with no scope instead of reading every branch", async () => {
    // Required at the type level, and `reportScopeLocationId` throws for the
    // callers the type system cannot see — the old optional `locationId` made
    // "no scope" and "every branch" the same input.
    await expect(
      runStandardReport("a", "food_service", def("profit_and_loss"), {} as never),
    ).rejects.toThrow(/missing_report_scope/);
    expect(services.getProfitAndLoss).not.toHaveBeenCalled();
  });
  it.each([["profit_and_loss", "getProfitAndLossComparison"], ["balance_sheet", "getBalanceSheetComparison"], ["cash_flow", "getCashFlowComparison"]])("uses the authoritative %s comparison", async (key, service) => {
    expect(await runStandardReport("a", "food_service", def(key), { compare: true, dateFrom: "2026-01-01", dateTo: "2026-01-31", previousAsOfDate: "2025-12-31", scope: branchScope(BRANCH) })).toEqual({ comparison: { marker: service } });
    expect(services[service].mock.calls[0]).toContainEqual(branchScope(BRANCH));
  });
  it("passes the resolved tenant and branch into trade services", async () => {
    await runStandardReport("a", "jewelry", def("weight_reconciliation"), { scope: branchScope("branch-a") });
    expect(trade).toHaveBeenCalledWith("weight_reconciliation", expect.objectContaining({ businessId: "a", industry: "jewelry", locationId: "branch-a" }));
  });
  it("pages a trade report without a branch only for the consolidated scope", async () => {
    await runStandardReport("a", "jewelry", def("consignor_statements"), { scope: BUSINESS_WIDE_SCOPE, detailPage: 2 });
    expect(tradePage).toHaveBeenCalledWith("consignor_statements", expect.objectContaining({ businessId: "a", locationId: null }), 2);
  });
  it("uses the service's SQL page without loading the legacy full list", async () => {
    const result = await runStandardReport("a", "jewelry", def("consignor_statements"), { scope: branchScope("branch-a"), detailPage: 2 });
    expect(tradePage).toHaveBeenCalledWith("consignor_statements", expect.objectContaining({ businessId: "a" }), 2);
    expect(trade).not.toHaveBeenCalled(); expect(result).toHaveProperty("pagination.page", 2);
  });
  it("pages food-cost detail through the authoritative SQL source", async () => {
    await runStandardReport("a", "food_service", def("food_cost_variance"), { scope: branchScope(BRANCH), detailPage: 2 });
    expect(services.getFoodCostVariancePage).toHaveBeenCalledWith(
      "a",
      { scope: branchScope(BRANCH), detailPage: 2 },
      branchScope(BRANCH),
      2,
    );
    expect(services.getFoodCostVariance).not.toHaveBeenCalled();
  });
  it("dumps a row report scoped to its own branch", async () => {
    await runStandardReport("a", "food_service", def("daily_sales_summary"), { scope: branchScope(BRANCH), dateFrom: "2026-01-01" });
    expect(services.runStandardReportRows).toHaveBeenCalledWith(
      "daily_sales_summary",
      "a",
      branchScope(BRANCH),
      expect.objectContaining({ dateFrom: "2026-01-01" }),
    );
  });
});
