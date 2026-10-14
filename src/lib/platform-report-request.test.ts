import { describe, expect, it } from "vitest";
import { parseReportOptions, parseReportQuery } from "./platform-report-request";
import { buildReportQuery, standardReportsFor, reportViewsFor } from "./reports";
import { branchScope } from "./report-scope";
import { platformCan } from "./platform-admin";
const valid = { view: "v_sales_by_day", metric: "total", dimension: "day", aggregation: "sum" };
describe("platform reporting wire boundary", () => {
  it.each([null, [], {}, { ...valid, businessId: "other" }, { ...valid, sql: "select * from users" },
    { ...valid, view: "orders" }, { ...valid, view: "__proto__" }, { ...valid, view: "constructor" },
    { ...valid, dimension: "day; DROP TABLE orders" }, { ...valid, limit: 1001 },
    { ...valid, filters: { equals: { business_id: "other" } } },
    { ...valid, filters: { locationId: "other" } },
    { ...valid, sort: { by: "metric", dir: "desc; SELECT 1" } },
  ])("rejects malformed or scope-injecting payload %j", (body) => expect(() => parseReportQuery(body)).toThrow());
  it("bounds an otherwise unlimited query and retains parameterized filters", () => {
    const parsed = parseReportQuery(valid);
    expect(parsed.limit).toBe(1000);
    const query = buildReportQuery(parsed, "business-a", branchScope("branch-a"));
    expect(query.params).toEqual(["business-a", "branch-a", 1000]);
    expect(query.sql).not.toContain("business-a");
  });
  it.each(["dateFrom=2026-02-30", "dateFrom=2026-03-02&dateTo=2026-03-01", "businessId=other", "locationId=invalid", "previousAsOfDate=2026-04-01&dateTo=2026-03-01"])("rejects filters %s", (s) => expect(() => parseReportOptions(new URLSearchParams(s))).toThrow());
  it("keeps ISO dates on the wire", () => expect(parseReportOptions(new URLSearchParams("dateFrom=2026-03-21&dateTo=2026-04-01"))).toEqual({ dateFrom: "2026-03-21", dateTo: "2026-04-01", compare: false }));
  it.each(["support", "engineer", "owner"] as const)("grants dedicated report reads to %s", (role) => expect(platformCan(role, "business.reports.read")).toBe(true));
  it.each(["jewelry", "watch", "accessories", "cosmetics", "wholesale", "tools_fittings", "haberdashery"] as const)("keeps food-only reports out of %s", (industry) => {
    expect(standardReportsFor(industry).some((r) => r.key === "food_cost_variance")).toBe(false);
    expect(reportViewsFor(industry).some((r) => r.key === "v_table_turnover")).toBe(false);
  });
});
