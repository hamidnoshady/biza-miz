import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
  getPool: vi.fn(),
}));
vi.mock("./db", () => database);

import {
  getBalanceSheet,
  getProfitAndLoss,
  runCustomReportQuery,
  runStandardReportRows,
} from "./reports-service";
import type { ReportConfig } from "./reports";
import type { ReportScope } from "./report-scope";

const NO_SCOPE = undefined as unknown as ReportScope;
const CONFIG: ReportConfig = {
  view: "v_sales_by_day",
  metric: "total",
  aggregation: "sum",
  dimension: "day",
};

beforeEach(() => vi.clearAllMocks());

describe("report service entry points require an explicit scope", () => {
  it("refuses a custom query when the caller omitted scope", async () => {
    await expect(runCustomReportQuery("biz-a", CONFIG, NO_SCOPE)).rejects.toThrow(/missing_report_scope/);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("refuses a standard row report when the caller omitted scope", async () => {
    await expect(runStandardReportRows("daily_sales_summary", "biz-a", NO_SCOPE)).rejects.toThrow(
      /missing_report_scope/,
    );
    expect(database.query).not.toHaveBeenCalled();
  });

  it("refuses financial statements when the caller omitted scope", async () => {
    await expect(getProfitAndLoss("biz-a", {}, NO_SCOPE)).rejects.toThrow(/missing_report_scope/);
    await expect(getBalanceSheet("biz-a", "2026-01-31", NO_SCOPE)).rejects.toThrow(/missing_report_scope/);
    expect(database.query).not.toHaveBeenCalled();
  });
});
