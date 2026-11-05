import { describe, expect, it } from "vitest";
import {
  completedUtcDay,
  computeBackupMargin,
  MARGIN_DEFAULT_WINDOW_DAYS,
  resolveMarginWindow,
  settlementWindow,
} from "./tenant-backup-billing-jobs";

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

describe("resolveMarginWindow", () => {
  const now = new Date("2026-11-02T09:00:00.000Z");

  it("defaults to the last thirty days ending now", () => {
    const window = resolveMarginWindow({}, now);
    expect(window).toEqual({
      ok: true,
      from: new Date(now.getTime() - MARGIN_DEFAULT_WINDOW_DAYS * 86_400_000),
      to: now,
    });
  });

  it("treats a date-only end bound as the end of that day", () => {
    // "1 to 31 October" means the 31st is included, so the exclusive bound is the
    // first of November — the off-by-one an operator would otherwise report as a
    // missing day of revenue.
    const window = resolveMarginWindow({ from: "2026-10-01", to: "2026-10-31" }, now);
    expect(window).toEqual({
      ok: true,
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
    });
  });

  it("accepts full timestamps unchanged", () => {
    const window = resolveMarginWindow(
      { from: "2026-10-01T12:00:00.000Z", to: "2026-10-02T12:00:00.000Z" },
      now,
    );
    expect(window).toEqual({
      ok: true,
      from: new Date("2026-10-01T12:00:00.000Z"),
      to: new Date("2026-10-02T12:00:00.000Z"),
    });
  });

  it("reads a single date-only day as that whole day", () => {
    // from = to = 2026-10-01 is "the first of October", not an empty range: the
    // end bound is exclusive, so the day itself is included.
    expect(resolveMarginWindow({ from: "2026-10-01", to: "2026-10-01" }, now)).toEqual({
      ok: true,
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-10-02T00:00:00.000Z"),
    });
  });

  it("refuses an inverted or unreadable range instead of widening it", () => {
    for (const input of [
      { from: "2026-10-31", to: "2026-10-01" },
      { from: "2026-10-01T12:00:00.000Z", to: "2026-10-01T12:00:00.000Z" },
      { from: "yesterday" },
      { to: "not-a-date" },
    ]) {
      expect(resolveMarginWindow(input, now)).toEqual({ ok: false, error: "invalid_window" });
    }
  });

  it("caps the window so one report cannot scan the meter's whole life", () => {
    expect(resolveMarginWindow({ from: "2024-01-01", to: "2026-01-01" }, now)).toEqual({
      ok: false,
      error: "window_too_long",
    });
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

  it("reports how much of a partly priced line the revenue does not cover", () => {
    // A line with some unrated events has revenue, so it is not `notPriced` — but
    // its quantity is larger than what was billed, and that gap is stated rather
    // than hidden.
    const report = computeBackupMargin({
      from,
      to,
      providerCostRialPerGbMonth: 0,
      lines: [{ businessId: "b1", byteDays: 350, revenueRial: 5_000, unpricedByteDays: 250 }],
    });
    expect(report.lines[0].notPriced).toBe(false);
    expect(report.lines[0].unpricedByteDays).toBe(250);
    const fullyPriced = computeBackupMargin({
      from,
      to,
      providerCostRialPerGbMonth: 0,
      lines: [{ businessId: "b1", byteDays: 40, revenueRial: 900 }],
    });
    expect(fullyPriced.lines[0].unpricedByteDays).toBe(0);
  });

  it("carries the business name through without inventing one", () => {
    // The console shows the name it was given; a line without one stays
    // unnamed rather than being labelled with a uuid or a guess.
    const report = computeBackupMargin({
      from,
      to,
      providerCostRialPerGbMonth: 0,
      lines: [
        { businessId: "b1", businessName: "فروشگاه الف", byteDays: 10, revenueRial: 100 },
        { businessId: "b2", byteDays: 20, revenueRial: 300 },
      ],
    });
    expect(report.lines[0].businessName).toBe("فروشگاه الف");
    expect(report.lines[1].businessName).toBeNull();
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
