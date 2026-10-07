import { describe, expect, it } from "vitest";
import {
  depreciableBase,
  depreciationForPeriod,
  depreciationPeriodOfDate,
  monthlyDepreciation,
  parseDepreciationPeriodKey,
  planDepreciation,
  reconcileFixedAssetRegister,
  validateFixedAsset,
} from "./depreciation";

describe("depreciableBase", () => {
  it("is cost minus salvage value", () => {
    expect(depreciableBase({ cost: 120_000_000, salvageValue: 20_000_000, usefulLifeMonths: 60 })).toBe(100_000_000);
  });

  it("is the full cost when there's no salvage value", () => {
    expect(depreciableBase({ cost: 60_000_000, salvageValue: 0, usefulLifeMonths: 24 })).toBe(60_000_000);
  });
});

describe("monthlyDepreciation", () => {
  it("spreads the depreciable base evenly over the useful life", () => {
    expect(monthlyDepreciation({ cost: 120_000_000, salvageValue: 0, usefulLifeMonths: 60 })).toBe(2_000_000);
  });

  it("rounds to the nearest whole Rial", () => {
    // 100/3 = 33.333...
    expect(monthlyDepreciation({ cost: 100, salvageValue: 0, usefulLifeMonths: 3 })).toBe(33);
  });
});

describe("depreciationForPeriod", () => {
  const asset = { cost: 100_000, salvageValue: 10_000, usefulLifeMonths: 9 };
  // depreciableBase = 90_000, monthlyDepreciation = 10_000

  it("is the regular monthly amount when nothing's accumulated yet", () => {
    expect(depreciationForPeriod(asset, 0, 0)).toBe(10_000);
  });

  it("is the regular monthly amount mid-schedule, even if less than what remains", () => {
    // period index 5 of 9 (periodsPostedSoFar=4) — not the final period yet.
    expect(depreciationForPeriod(asset, 40_000, 4)).toBe(10_000);
  });

  it("absorbs whatever's left of the depreciable base on the final scheduled period, even if that's more than the regular monthly amount", () => {
    // periodsPostedSoFar=8 -> this would be period 9 of 9, the final one.
    expect(depreciationForPeriod(asset, 75_000, 8)).toBe(15_000);
  });

  it("is zero once fully depreciated", () => {
    expect(depreciationForPeriod(asset, 90_000, 9)).toBe(0);
  });

  it("is zero if somehow over-depreciated (defensive, shouldn't happen)", () => {
    expect(depreciationForPeriod(asset, 95_000, 9)).toBe(0);
  });

  it("rounding: three periods of a 100,000-over-3-months asset sum to exactly the depreciable base", () => {
    const roundingAsset = { cost: 100_000, salvageValue: 0, usefulLifeMonths: 3 };
    const p1 = depreciationForPeriod(roundingAsset, 0, 0);
    const p2 = depreciationForPeriod(roundingAsset, p1, 1);
    const p3 = depreciationForPeriod(roundingAsset, p1 + p2, 2);
    expect(p1).toBe(33_333);
    expect(p2).toBe(33_333);
    expect(p3).toBe(33_334); // absorbs the rounding remainder on the final period
    expect(p1 + p2 + p3).toBe(100_000);
  });
});

describe("validateFixedAsset", () => {
  const VALID = {
    name: "یخچال صنعتی",
    acquisitionDate: "2025-01-15",
    cost: 100_000_000,
    salvageValue: 10_000_000,
    usefulLifeMonths: 60,
  };

  it("accepts a well-formed asset", () => {
    expect(validateFixedAsset(VALID)).toEqual([]);
  });

  it("rejects an empty name", () => {
    expect(validateFixedAsset({ ...VALID, name: "  " }).length).toBeGreaterThan(0);
  });

  it("rejects a missing or invalid acquisition date", () => {
    expect(validateFixedAsset({ ...VALID, acquisitionDate: "" }).length).toBeGreaterThan(0);
    expect(validateFixedAsset({ ...VALID, acquisitionDate: "not-a-date" }).length).toBeGreaterThan(0);
  });

  it("rejects a non-positive cost", () => {
    expect(validateFixedAsset({ ...VALID, cost: 0 }).length).toBeGreaterThan(0);
    expect(validateFixedAsset({ ...VALID, cost: -1 }).length).toBeGreaterThan(0);
  });

  it("rejects a negative salvage value", () => {
    expect(validateFixedAsset({ ...VALID, salvageValue: -1 }).length).toBeGreaterThan(0);
  });

  it("rejects a salvage value that isn't less than cost", () => {
    expect(validateFixedAsset({ ...VALID, salvageValue: VALID.cost }).length).toBeGreaterThan(0);
    expect(validateFixedAsset({ ...VALID, salvageValue: VALID.cost + 1 }).length).toBeGreaterThan(0);
  });

  it("rejects a non-positive or fractional useful life", () => {
    expect(validateFixedAsset({ ...VALID, usefulLifeMonths: 0 }).length).toBeGreaterThan(0);
    expect(validateFixedAsset({ ...VALID, usefulLifeMonths: 12.5 }).length).toBeGreaterThan(0);
  });
});

describe("canonical depreciation periods", () => {
  it("keys a date by its Jalali month, bound to the month's Gregorian start and end", () => {
    // 1405/07/15 is 2026-10-07.
    expect(depreciationPeriodOfDate("2026-10-07")).toEqual({
      key: "1405-07",
      jy: 1405,
      jm: 7,
      startsOn: "2026-09-23",
      endsOn: "2026-10-22",
      label: "مهر 1405",
    });
  });

  it("parses only a real YYYY-MM key", () => {
    expect(parseDepreciationPeriodKey("1405-12")?.endsOn).toBe("2027-03-20");
    expect(parseDepreciationPeriodKey("1405/07")).toBeNull();
    expect(parseDepreciationPeriodKey("1405-13")).toBeNull();
    expect(parseDepreciationPeriodKey("p1")).toBeNull();
  });
});

describe("planDepreciation", () => {
  const asset = { cost: 120_000_000, salvageValue: 0, usefulLifeMonths: 60, inServiceDate: "2026-04-01" };
  const base = { asset, postedPeriodKeys: [] as string[], accumulatedSoFar: 0, today: "2026-10-07" };

  it("dates a past month at its last day and a current month at today", () => {
    expect(planDepreciation({ ...base, periodKey: "1405-02" })).toMatchObject({
      ok: true,
      entryDate: "2026-05-21",
      amount: 2_000_000,
    });
    expect(planDepreciation(base)).toMatchObject({ ok: true, entryDate: "2026-10-07" });
  });

  it("refuses the same month however it was asked for", () => {
    const posted = { ...base, postedPeriodKeys: ["1405-02"], accumulatedSoFar: 2_000_000 };
    expect(planDepreciation({ ...posted, periodKey: "1405-02" })).toEqual({ ok: false, error: "period_already_depreciated" });
    expect(planDepreciation({ ...posted, entryDate: "2026-05-01" })).toEqual({ ok: false, error: "period_already_depreciated" });
  });

  it("refuses a month before the in-service month and a month not yet started", () => {
    expect(planDepreciation({ ...base, periodKey: "1404-12" })).toEqual({ ok: false, error: "period_before_in_service" });
    expect(planDepreciation({ ...base, periodKey: "1405-08" })).toEqual({ ok: false, error: "period_in_future" });
  });

  it("allows the in-service month itself", () => {
    // 2026-04-01 is 1405/01/12.
    expect(planDepreciation({ ...base, periodKey: "1405-01" }).ok).toBe(true);
  });

  it("refuses a document date outside its month", () => {
    expect(planDepreciation({ ...base, periodKey: "1405-02", entryDate: "2026-06-01" })).toEqual({
      ok: false,
      error: "entry_date_outside_period",
    });
    expect(planDepreciation({ ...base, entryDate: "2026-02-31" })).toEqual({ ok: false, error: "invalid_entry_date" });
  });

  it("caps at cost minus salvage and then refuses", () => {
    const small = { cost: 100_000, salvageValue: 10_000, usefulLifeMonths: 3, inServiceDate: "2026-04-01" };
    expect(
      planDepreciation({ ...base, asset: small, postedPeriodKeys: ["1405-01", "1405-02"], accumulatedSoFar: 60_000, periodKey: "1405-03" }),
    ).toMatchObject({ ok: true, amount: 30_000 });
    expect(
      planDepreciation({
        ...base,
        asset: small,
        postedPeriodKeys: ["1405-01", "1405-02", "1405-03"],
        accumulatedSoFar: 90_000,
        periodKey: "1405-04",
      }),
    ).toEqual({ ok: false, error: "fully_depreciated" });
  });
});

describe("validateFixedAsset in-service date", () => {
  const valid = { name: "x", acquisitionDate: "2026-04-01", cost: 10, salvageValue: 0, usefulLifeMonths: 1 };
  it("refuses an in-service date before the purchase", () => {
    expect(validateFixedAsset({ ...valid, inServiceDate: "2026-03-01" })).toEqual(["تاریخ بهره‌برداری نمی‌تواند پیش از تاریخ خرید باشد."]);
    expect(validateFixedAsset({ ...valid, inServiceDate: "2026-05-01" })).toEqual([]);
  });
});

describe("reconcileFixedAssetRegister", () => {
  it("is reconciled only when cost and accumulated both agree", () => {
    const input = {
      registerCost: 100n,
      registerAccumulated: 10n,
      ledgerCost: 100n,
      ledgerAccumulated: 10n,
      unlinkedCount: 0,
      unlinkedCost: 0n,
    };
    expect(reconcileFixedAssetRegister(input).status).toBe("reconciled");
    const off = reconcileFixedAssetRegister({ ...input, ledgerCost: 0n });
    expect(off).toMatchObject({ status: "difference", costDifference: "-100" });
  });
});
