import { describe, expect, it } from "vitest";
import { computeBranchOverviewMetrics } from "@/lib/reports";
import { reportsTabsForCapabilities } from "./reports-nav";
import { reportCapabilities } from "@/lib/report-permissions";
import { PERMISSIONS, effectivePermissions } from "@/lib/permissions";

describe("Branch Overview Reports Tab & Navigation", () => {
  it("includes the branches tab only for a member holding the business-wide capability", () => {
    // The tab used to be filtered by a hard-coded role list on the *screen*
    // while the route behind it was guarded by reports.view (issue #819). Both
    // now read the same capability.
    const owner = reportCapabilities(effectivePermissions("owner", {}));
    expect(reportsTabsForCapabilities(owner).some((t) => t.key === "branches")).toBe(true);

    for (const role of ["admin", "manager", "accountant"] as const) {
      const capabilities = reportCapabilities(effectivePermissions(role, {}));
      expect(capabilities.canViewBusinessWide, role).toBe(false);
      expect(reportsTabsForCapabilities(capabilities).some((t) => t.key === "branches")).toBe(false);
    }
  });

  it("stays closed to a per-member grant, because the capability is owner-reserved", () => {
    const granted = reportCapabilities(
      effectivePermissions("manager", { granted: [PERMISSIONS.reportsBusinessWide] }),
    );
    expect(granted.canViewBusinessWide).toBe(false);
    expect(reportsTabsForCapabilities(granted).some((t) => t.key === "branches")).toBe(false);
  });
});

describe("Branch Overview Metric Calculations", () => {
  it("calculates revenue share, margins, and ticket size across branches", () => {
    const branch1 = {
      orderCount: 100,
      total: 20_000_000,
      cogs: 8_000_000,
    };
    const branch2 = {
      orderCount: 50,
      total: 10_000_000,
      cogs: 5_000_000,
    };
    const consolidatedTotal = 30_000_000;

    const m1 = computeBranchOverviewMetrics(branch1, consolidatedTotal);
    expect(m1.grossProfit).toBe(12_000_000);
    expect(m1.grossMarginPct).toBe(60);
    expect(m1.avgTicket).toBe(200_000);
    expect(m1.revenueSharePct).toBeCloseTo(66.67, 1);

    const m2 = computeBranchOverviewMetrics(branch2, consolidatedTotal);
    expect(m2.grossProfit).toBe(5_000_000);
    expect(m2.grossMarginPct).toBe(50);
    expect(m2.avgTicket).toBe(200_000);
    expect(m2.revenueSharePct).toBeCloseTo(33.33, 1);
  });

  it("handles branch with 0 orders and 0 revenue gracefully without NaN or Infinity", () => {
    const branchEmpty = {
      orderCount: 0,
      total: 0,
      cogs: 0,
    };
    const m = computeBranchOverviewMetrics(branchEmpty, 0);

    expect(m.grossProfit).toBe(0);
    expect(m.grossMarginPct).toBe(0);
    expect(m.avgTicket).toBe(0);
    expect(m.revenueSharePct).toBe(0);
    expect(Number.isNaN(m.grossMarginPct)).toBe(false);
    expect(Number.isFinite(m.avgTicket)).toBe(true);
  });
});
