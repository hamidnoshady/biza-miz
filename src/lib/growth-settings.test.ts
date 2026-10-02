import { describe, expect, it } from "vitest";
import { discountBudgetUsage, GROWTH_SETTINGS_DEFAULTS, parseGrowthSettingsInput } from "./growth-settings";

describe("parseGrowthSettingsInput", () => {
  it("accepts a partial update and leaves unnamed keys out", () => {
    expect(parseGrowthSettingsInput({ attributionWindowDays: 14 })).toEqual({ ok: true, value: { attributionWindowDays: 14 } });
    expect(parseGrowthSettingsInput({ discountBudgetRial: 50_000_000 })).toEqual({ ok: true, value: { discountBudgetRial: 50_000_000 } });
  });

  it("treats null as «no limit»", () => {
    expect(parseGrowthSettingsInput({ attributionWindowDays: null, discountBudgetRial: null })).toEqual({
      ok: true,
      value: { attributionWindowDays: null, discountBudgetRial: null },
    });
  });

  it("rejects out-of-range, fractional and non-numeric values with every reason at once", () => {
    const result = parseGrowthSettingsInput({ attributionWindowDays: 0, discountBudgetRial: -5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
    expect(parseGrowthSettingsInput({ attributionWindowDays: 366 }).ok).toBe(false);
    expect(parseGrowthSettingsInput({ attributionWindowDays: 7.5 }).ok).toBe(false);
    expect(parseGrowthSettingsInput({ discountBudgetRial: "1000" }).ok).toBe(false);
    expect(parseGrowthSettingsInput({ discountBudgetRial: 1.5 }).ok).toBe(false);
  });

  it("refuses a body that is not an object, and ignores keys it does not know", () => {
    expect(parseGrowthSettingsInput(null).ok).toBe(false);
    expect(parseGrowthSettingsInput([1]).ok).toBe(false);
    expect(parseGrowthSettingsInput({ unknown: 1 })).toEqual({ ok: true, value: {} });
  });

  it("defaults to no window and no budget, so an untouched business sees the same reports as before", () => {
    expect(GROWTH_SETTINGS_DEFAULTS).toEqual({ attributionWindowDays: null, discountBudgetRial: null });
  });
});

describe("discountBudgetUsage", () => {
  it("says nothing without a budget", () => {
    expect(discountBudgetUsage(1_000, null)).toBeNull();
  });

  it("reports the share used and whether it went over", () => {
    expect(discountBudgetUsage(25_000, 100_000)).toEqual({ percent: 25, exceeded: false });
    expect(discountBudgetUsage(100_000, 100_000)).toEqual({ percent: 100, exceeded: false });
    expect(discountBudgetUsage(150_000, 100_000)).toEqual({ percent: 150, exceeded: true });
  });
});
