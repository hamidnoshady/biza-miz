import { describe, expect, it } from "vitest";
import { pageReportDetails } from "./report-detail-page";
describe("structured report detail pagination", () => {
  it("bounds detail, preserves authoritative rollups, and clamps past the end", () => {
    const report = { rows: Array.from({ length: 103 }, (_, id) => ({ id })), totals: { revenue: 1000000 }, totalCount: 103 };
    const second = pageReportDetails(report, 2);
    expect(second.report.rows).toEqual(report.rows.slice(50, 100));
    expect(second.report.totals).toBe(report.totals);
    expect(second.report.totalCount).toBe(103);
    expect(second.pagination).toEqual({ page: 2, pageSize: 50, total: 103, pages: 3 });
    expect(pageReportDetails(report, 999).report.rows).toEqual(report.rows.slice(100));
    expect(report.rows).toHaveLength(103);
  });
  it("does not flatten or truncate accounting statement sections", () => {
    const report = { revenue: Array(60).fill({ amount: 100000 }), expenses: [], totalRevenue: 6000000 };
    expect(pageReportDetails(report)).toEqual({ report, pagination: null });
  });
});
