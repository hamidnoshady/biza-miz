/**
 * Unit tests for the plan allowance's pure half (migration 0168 + issue #791).
 */
import { describe, expect, it } from "vitest";
import {
  AI_BILLING_TIME_ZONE,
  currentPeriodMonth,
  periodMonthFor,
  resolveEffectivePlanAllowance,
  tehranMonthWindow,
} from "./ai-plan-allowance";

describe("periodMonthFor", () => {
  it("formats the Tehran calendar month as YYYY-MM", () => {
    expect(periodMonthFor(new Date("2025-06-15T10:00:00Z"))).toBe("2025-06");
  });

  it("flips the month at the Tehran midnight, not UTC's", () => {
    expect(periodMonthFor(new Date("2025-08-31T19:30:00Z"))).toBe("2025-08");
    expect(periodMonthFor(new Date("2025-08-31T20:30:01Z"))).toBe("2025-09");
    expect(periodMonthFor(new Date("2025-08-31T20:29:59Z"))).toBe("2025-08");
  });

  it("keeps the last evening of a Tehran month in that month", () => {
    expect(periodMonthFor(new Date("2024-12-31T19:00:00Z"))).toBe("2024-12");
    expect(periodMonthFor(new Date("2024-12-31T20:30:00Z"))).toBe("2025-01");
  });

  it("uses the billing calendar by default and supports an explicit zone", () => {
    expect(AI_BILLING_TIME_ZONE).toBe("Asia/Tehran");
    const moment = new Date("2025-06-30T16:00:00Z");
    expect(periodMonthFor(moment)).toBe("2025-06");
    expect(periodMonthFor(moment, "Australia/Sydney")).toBe("2025-07");
  });

  it("keys the current period in the same calendar", () => {
    expect(currentPeriodMonth()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it("computes the exact UTC start and end of a Tehran calendar month", () => {
    const win = tehranMonthWindow(new Date("2025-09-01T00:00:00Z"));
    expect(win.periodMonth).toBe("2025-09");
    // 2025-09-01 00:00 Asia/Tehran (+03:30) is 2025-08-31T20:30:00.000Z
    expect(win.startUtc.toISOString()).toBe("2025-08-31T20:30:00.000Z");
    expect(win.nextStartUtc.toISOString()).toBe("2025-09-30T20:30:00.000Z");
  });
});

describe("resolveEffectivePlanAllowance", () => {
  it("uses the current configured plan credit for first use, mid-month cap increases, and decreases", () => {
    // First use in month
    const first = resolveEffectivePlanAllowance({
      configuredCreditRial: 500_000,
      grantedRial: null,
      usedRial: 0,
      subscriptionCarrying: true,
      periodMonth: "2026-10",
    });
    expect(first.effectiveCreditRial).toBe(500_000);
    expect(first.remainingRial).toBe(500_000);

    // Mid-month cap increase from 500k to 800k after 200k used
    const increased = resolveEffectivePlanAllowance({
      configuredCreditRial: 800_000,
      grantedRial: 500_000,
      usedRial: 200_000,
      subscriptionCarrying: true,
      periodMonth: "2026-10",
    });
    expect(increased.effectiveCreditRial).toBe(800_000);
    expect(increased.remainingRial).toBe(600_000);

    // Mid-month cap decrease from 500k to 150k after 200k used -> remaining clamped to 0
    const decreased = resolveEffectivePlanAllowance({
      configuredCreditRial: 150_000,
      grantedRial: 500_000,
      usedRial: 200_000,
      subscriptionCarrying: true,
      periodMonth: "2026-10",
    });
    expect(decreased.effectiveCreditRial).toBe(150_000);
    expect(decreased.remainingRial).toBe(0);

    // Lapsed subscription -> effective allowance is 0
    const lapsed = resolveEffectivePlanAllowance({
      configuredCreditRial: 500_000,
      grantedRial: 500_000,
      usedRial: 100_000,
      subscriptionCarrying: false,
      periodMonth: "2026-10",
    });
    expect(lapsed.effectiveCreditRial).toBe(0);
    expect(lapsed.remainingRial).toBe(0);
  });
});
