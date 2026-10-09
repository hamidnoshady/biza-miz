import { describe, expect, it } from "vitest";
import {
  BUSINESS_WIDE_PERMISSION,
  BUSINESS_WIDE_SCOPE,
  CONSOLIDATED_STANDARD_REPORTS,
  branchScope,
  decideReportScope,
  isConsolidatedStandardReport,
  parseReportScope,
  reportScopeLocationId,
} from "./report-scope";

describe("report scope is explicit", () => {
  it("binds an ordinary report to the branch it was authorized for", () => {
    const scope = branchScope("loc-b");
    expect(scope).toEqual({ mode: "branch", locationId: "loc-b" });
    expect(reportScopeLocationId(scope)).toBe("loc-b");
  });

  it("lets only the explicit consolidated scope omit a branch predicate", () => {
    expect(BUSINESS_WIDE_SCOPE).toEqual({ mode: "business-wide" });
    expect(reportScopeLocationId(BUSINESS_WIDE_SCOPE)).toBeUndefined();
    expect(BUSINESS_WIDE_PERMISSION).toBe("reports.business_wide");
  });

  it.each([undefined, null, {}, { mode: "branch" }, { mode: "branch", locationId: "" }])(
    "refuses an absent or malformed scope instead of widening (%j)",
    (scope) => {
      expect(() => reportScopeLocationId(scope as never)).toThrow(/missing_report_scope/);
    },
  );

  it("defaults to branch scope even when the caller also holds the elevated capability", () => {
    expect(
      decideReportScope({ requested: undefined, hasBusinessWide: true, hasAccessibleBranch: true }),
    ).toEqual({ ok: true, mode: "branch" });
  });

  it("does not turn a missing or revoked branch assignment into consolidated access", () => {
    expect(
      decideReportScope({ requested: undefined, hasBusinessWide: true, hasAccessibleBranch: false }),
    ).toEqual({ ok: false, reason: "no_accessible_branch" });
    expect(
      decideReportScope({ requested: "branch", hasBusinessWide: true, hasAccessibleBranch: false }),
    ).toEqual({ ok: false, reason: "no_accessible_branch" });
  });

  it("requires the separate business-wide capability only when that scope is requested", () => {
    expect(
      decideReportScope({ requested: "business-wide", hasBusinessWide: false, hasAccessibleBranch: true }),
    ).toEqual({ ok: false, reason: "business_wide_forbidden" });
    expect(
      decideReportScope({ requested: "business-wide", hasBusinessWide: true, hasAccessibleBranch: false }),
    ).toEqual({ ok: true, mode: "business-wide" });
  });

  it("centralizes which standard reports have a consolidated form", () => {
    expect(CONSOLIDATED_STANDARD_REPORTS).toEqual([
      "profit_and_loss",
      "balance_sheet",
      "cash_flow",
      "food_cost_variance",
    ]);
    for (const key of CONSOLIDATED_STANDARD_REPORTS) expect(isConsolidatedStandardReport(key)).toBe(true);
    expect(isConsolidatedStandardReport("daily_sales_summary")).toBe(false);
  });

  it("parses only the two scope values served by the API", () => {
    expect(parseReportScope(undefined)).toBeUndefined();
    expect(parseReportScope("branch")).toBe("branch");
    expect(parseReportScope("business-wide")).toBe("business-wide");
    expect(parseReportScope("everything")).toBeNull();
  });
});
