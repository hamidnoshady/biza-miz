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
beforeEach(() => vi.clearAllMocks());
describe("shared standard report dispatch", () => {
  it.each([
    ["profit_and_loss", "getProfitAndLoss"], ["balance_sheet", "getBalanceSheet"], ["cash_flow", "getCashFlow"], ["food_cost_variance", "getFoodCostVariance"],
  ])("retains the structured %s payload", async (key, service) => {
    expect(await runStandardReport("a", "food_service", STANDARD_REPORTS.find((r) => r.key === key)!, { dateFrom: "2026-01-01", dateTo: "2026-01-31", locationId: "branch" })).toEqual({ report: { marker: service } });
    expect(services[service].mock.calls[0]).toContain("a");
    expect(services[service].mock.calls[0]).toContain("branch");
  });
  it.each([["profit_and_loss", "getProfitAndLossComparison"], ["balance_sheet", "getBalanceSheetComparison"], ["cash_flow", "getCashFlowComparison"]])("uses the authoritative %s comparison", async (key, service) => {
    expect(await runStandardReport("a", "food_service", STANDARD_REPORTS.find((r) => r.key === key)!, { compare: true, dateFrom: "2026-01-01", dateTo: "2026-01-31", previousAsOfDate: "2025-12-31" })).toEqual({ comparison: { marker: service } });
  });
  it("passes the resolved tenant and branch into trade services", async () => {
    await runStandardReport("a", "jewelry", STANDARD_REPORTS.find((r) => r.key === "weight_reconciliation")!, { locationId: "branch-a" });
    expect(trade).toHaveBeenCalledWith("weight_reconciliation", expect.objectContaining({ businessId: "a", industry: "jewelry", locationId: "branch-a" }));
  });
  it("uses the service's SQL page without loading the legacy full list", async () => {
    const result = await runStandardReport("a", "jewelry", STANDARD_REPORTS.find((r) => r.key === "consignor_statements")!, { detailPage: 2 });
    expect(tradePage).toHaveBeenCalledWith("consignor_statements", expect.objectContaining({ businessId: "a" }), 2);
    expect(trade).not.toHaveBeenCalled(); expect(result).toHaveProperty("pagination.page", 2);
  });
  it("pages food-cost detail through the authoritative SQL source", async () => {
    await runStandardReport("a", "food_service", STANDARD_REPORTS.find((r) => r.key === "food_cost_variance")!, { detailPage: 2 });
    expect(services.getFoodCostVariancePage).toHaveBeenCalledWith("a", { detailPage: 2 }, undefined, 2);
    expect(services.getFoodCostVariance).not.toHaveBeenCalled();
  });

});
