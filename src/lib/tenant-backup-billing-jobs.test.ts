import { describe, expect, it } from "vitest";
import { completedUtcDay, computeBackupMargin, settlementWindow } from "./tenant-backup-billing-jobs";

const GB = 1024 ** 3;

describe("completedUtcDay", () => {
  it("returns the day that ended at midnight UTC, not the one in progress", () => {
    const now = new Date("2026-10-28T00:05:00.000Z");
    const window = completedUtcDay(now);
    expect(window.to.toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(window.from.toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });

  it("is stable across the whole day, so a retry settles the same window", () => {
    const morning = settlementWindow(new Date("2026-10-28T06:00:00.000Z"));
    const evening = settlementWindow(new Date("2026-10-28T23:59:59.000Z"));
    expect(morning).toEqual(evening);
  });

  it("handles a month boundary without arithmetic on local time", () => {
    const window = completedUtcDay(new Date("2026-11-01T00:10:00.000Z"));
    expect(window.from.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("computeBackupMargin", () => {
  const from = new Date("2026-10-01T00:00:00.000Z");
  const to = new Date("2026-11-01T00:00:00.000Z");

  it("subtracts the provider cost from the priced revenue", () => {
    // October has 31 days: one GB-month of retention is 31 GB-days.
    const report = computeBackupMargin({
      from,
      to,
      providerCostRialPerGbMonth: 310_000,
      lines: [{ businessId: "b1", byteDays: 31 * GB, revenueRial: 1_000_000 }],
    });
    expect(report.lines[0].costRial).toBe(310_000);
    expect(report.lines[0].marginRial).toBe(690_000);
    expect(report.lines[0].marginPercent).toBe(69);
    expect(report.lines[0].notPriced).toBe(false);
  });

  it("marks an unpriced line instead of pretending it is pure profit", () => {
    const report = computeBackupMargin({
      from,
      to,
      providerCostRialPerGbMonth: 0,
      lines: [{ businessId: "b1", byteDays: 5, revenueRial: null }],
    });
    expect(report.lines[0].notPriced).toBe(true);
    expect(report.lines[0].revenueRial).toBe(0);
    expect(report.lines[0].marginPercent).toBeNull();
    expect(report.assumptions.priced).toBe(false);
  });

  it("totals the lines and reports a null percentage when nothing was billed", () => {
    const report = computeBackupMargin({
      from,
      to,
      providerCostRialPerGbMonth: 0,
      lines: [
        { businessId: "b1", byteDays: 10, revenueRial: 100 },
        { businessId: "b2", byteDays: 20, revenueRial: 300 },
      ],
    });
    expect(report.totals).toEqual({
      byteDays: 30,
      revenueRial: 400,
      costRial: 0,
      marginRial: 400,
      marginPercent: 100,
    });
    const empty = computeBackupMargin({ from, to, providerCostRialPerGbMonth: 0, lines: [] });
    expect(empty.totals.marginPercent).toBeNull();
  });

  it("never reports a negative revenue for a correction line", () => {
    const report = computeBackupMargin({
      from,
      to,
      providerCostRialPerGbMonth: 0,
      lines: [{ businessId: "b1", byteDays: 0, revenueRial: -500 }],
    });
    expect(report.lines[0].revenueRial).toBe(0);
  });
});
