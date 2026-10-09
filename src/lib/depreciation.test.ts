import { describe, expect, it } from "vitest";
import {
  addMonthsToPeriodKey,
  depreciableBase,
  depreciationPeriodOfDate,
  disposalOutcome,
  monthlyDepreciation,
  parseDepreciationPeriodKey,
  planDepreciation,
  reconcileFixedAssetRegister,
  scheduleEndPeriodKey,
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

  it("shifts a period key by whole months, carrying the year", () => {
    expect(addMonthsToPeriodKey("1405-01", 2)).toBe("1405-03");
    expect(addMonthsToPeriodKey("1405-01", -1)).toBe("1404-12");
    expect(addMonthsToPeriodKey("1405-12", 1)).toBe("1406-01");
    expect(addMonthsToPeriodKey("1405-07", 0)).toBe("1405-07");
  });

  it("ends a schedule at the in-service month plus the life, minus one", () => {
    // In service 1405-01-12 (2026-04-01), 12 months → ends 1405-12.
    expect(scheduleEndPeriodKey("2026-04-01", 12)).toBe("1405-12");
    expect(scheduleEndPeriodKey("2026-04-01", 1)).toBe("1405-01");
    expect(scheduleEndPeriodKey("not-a-date", 12)).toBeNull();
  });
});

describe("planDepreciation", () => {
  // In service 2026-04-01 = 1405-01-12; a 60-month schedule ends 1409-12.
  const schedule = { cost: 120_000_000, salvageValue: 0, usefulLifeMonths: 60, inServiceDate: "2026-04-01" };
  const base = {
    schedule,
    finalSalvageValue: 0,
    finalUsefulLifeMonths: 60,
    postedPeriodKeys: [] as string[],
    accumulatedSoFar: 0,
    today: "2026-10-07",
  };

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

  it("refuses a document dated in the future, even inside the current month", () => {
    // 1405-07 runs 2026-09-23..2026-10-22 and today is 2026-10-07: 2026-10-15
    // is inside the month but ahead of the business's today.
    expect(planDepreciation({ ...base, periodKey: "1405-07", entryDate: "2026-10-15" })).toEqual({
      ok: false,
      error: "entry_date_in_future",
    });
    // The same month at today — or any past day inside it — is fine.
    expect(planDepreciation({ ...base, periodKey: "1405-07", entryDate: "2026-10-07" })).toMatchObject({
      ok: true,
      entryDate: "2026-10-07",
    });
    expect(planDepreciation({ ...base, periodKey: "1405-07", entryDate: "2026-09-25" })).toMatchObject({
      ok: true,
      entryDate: "2026-09-25",
    });
  });

  it("refuses a month beyond the useful-life schedule — the schedule is a calendar, not a row count", () => {
    // A two-month life from 1405-01 ends at 1405-02; a much later month is
    // not a "missing scheduled month", it is beyond the schedule.
    const short = { ...base, schedule: { ...schedule, usefulLifeMonths: 2 }, finalUsefulLifeMonths: 2 };
    expect(planDepreciation({ ...short, periodKey: "1405-02" }).ok).toBe(true);
    // 1405-06 has started (2026-08-23) — it is refused by the SCHEDULE, not
    // by the calendar.
    expect(planDepreciation({ ...short, periodKey: "1405-06" })).toEqual({ ok: false, error: "period_beyond_schedule" });
    // Extending the life re-opens months from the change's effective month
    // forward: the service resolves the governing schedule for 1405-09 to the
    // EXTENSION (12 months, span to 1405-12), so the month is eligible again.
    const extended = {
      ...short,
      schedule: { ...schedule, usefulLifeMonths: 12 },
      finalUsefulLifeMonths: 12,
      today: "2027-06-01",
    };
    expect(planDepreciation({ ...extended, periodKey: "1405-09" }).ok).toBe(true);
    // The months the original 2-month schedule never covered stay closed to
    // it: with the original still governing (no change effective by then),
    // they are beyond the schedule.
    expect(planDepreciation({ ...short, today: "2027-06-01", periodKey: "1405-09" })).toEqual({
      ok: false,
      error: "period_beyond_schedule",
    });
  });

  it("refuses a month beyond the FINAL schedule even when the governing schedule was longer", () => {
    // The governing (original) schedule runs to 1409-12, but the final
    // estimate shortened the life: past the final end, nothing is postable.
    const shortened = { ...base, finalUsefulLifeMonths: 4 };
    expect(planDepreciation({ ...shortened, periodKey: "1405-04" }).ok).toBe(true);
    expect(planDepreciation({ ...shortened, periodKey: "1405-05" })).toEqual({ ok: false, error: "period_beyond_schedule" });
  });

  it("charges the governing schedule's rate for a pre-change month, capped by what is genuinely left", () => {
    // The original schedule (rate 2,000,000) governs 1405-02; a later change
    // (final: salvage 20,000,000, life 30) bounds the lifetime total. The
    // catch-up month is charged the ORIGINAL rate, never re-priced.
    const revised = { ...base, finalSalvageValue: 20_000_000, finalUsefulLifeMonths: 30 };
    expect(planDepreciation({ ...revised, periodKey: "1405-02" })).toMatchObject({ ok: true, amount: 2_000_000 });
    // …and never more than what remains of the lifetime base.
    const nearlyDone = { ...revised, accumulatedSoFar: 99_500_000, postedPeriodKeys: ["1405-01"] };
    expect(planDepreciation({ ...nearlyDone, periodKey: "1405-02" })).toMatchObject({ ok: true, amount: 500_000 });
  });

  it("absorbs the remainder on the last open month of the final schedule, landing exactly on cost − final salvage", () => {
    // 100,000 over 3 months: 33,333 + 33,333 + 33,334.
    const small = {
      schedule: { cost: 100_000, salvageValue: 0, usefulLifeMonths: 3, inServiceDate: "2026-04-01" },
      finalSalvageValue: 0,
      finalUsefulLifeMonths: 3,
      postedPeriodKeys: [] as string[],
      accumulatedSoFar: 0,
      today: "2026-10-07",
    };
    const p1 = planDepreciation({ ...small, periodKey: "1405-01" }) as { ok: true; amount: number };
    const p2 = planDepreciation({
      ...small,
      periodKey: "1405-02",
      postedPeriodKeys: ["1405-01"],
      accumulatedSoFar: p1.amount,
    }) as { ok: true; amount: number };
    // 1405-03 is past today's month — re-anchor today so the final month is
    // merely past, not future.
    const p3 = planDepreciation({
      ...small,
      today: "2026-07-01",
      periodKey: "1405-03",
      postedPeriodKeys: ["1405-01", "1405-02"],
      accumulatedSoFar: p1.amount + p2.amount,
    }) as { ok: true; amount: number };
    expect(p1.amount).toBe(33_333);
    expect(p2.amount).toBe(33_333);
    expect(p3.amount).toBe(33_334); // the last open month absorbs the rounding
    expect(p1.amount + p2.amount + p3.amount).toBe(100_000);
  });

  it("treats a reversed posting as never posted — the live history is the only truth", () => {
    // 1405-01 was posted and reversed: it is absent from the live facts, so
    // re-posting it charges the full rate again (not a stale schedule's
    // leftover), and the total still lands exactly.
    const schedule1200 = { cost: 1_200, salvageValue: 0, usefulLifeMonths: 12, inServiceDate: "2026-04-01" };
    const rev = {
      schedule: schedule1200,
      finalSalvageValue: 0,
      finalUsefulLifeMonths: 12,
      postedPeriodKeys: [] as string[],
      accumulatedSoFar: 0,
      today: "2026-10-07",
    };
    // The revision that a change would have frozen is irrelevant here: with
    // the posting reversed, the month is simply open again at its rate.
    expect(planDepreciation({ ...rev, periodKey: "1405-01" })).toMatchObject({ ok: true, amount: 100 });
  });

  it("refuses once the lifetime base is consumed, whatever the schedule counts", () => {
    const done = { ...base, accumulatedSoFar: 120_000_000, postedPeriodKeys: ["1405-01"] };
    expect(planDepreciation({ ...done, periodKey: "1405-02" })).toEqual({ ok: false, error: "fully_depreciated" });
  });
});

describe("disposalOutcome", () => {
  it("splits proceeds around the net book value into gain or loss", () => {
    expect(disposalOutcome({ cost: 100, accumulatedDepreciation: 40, proceeds: 70 })).toEqual({
      netBookValue: 60,
      gain: 10,
      loss: 0,
    });
    expect(disposalOutcome({ cost: 100, accumulatedDepreciation: 40, proceeds: 20 })).toEqual({
      netBookValue: 60,
      gain: 0,
      loss: 40,
    });
  });

  it("never reports a negative net book value", () => {
    expect(disposalOutcome({ cost: 100, accumulatedDepreciation: 130, proceeds: 0 }).netBookValue).toBe(0);
  });
});

describe("reconcileFixedAssetRegister", () => {
  it("is reconciled only when both sides agree exactly", () => {
    const base = {
      registerCost: 100n,
      ledgerCost: 100n,
      registerAccumulated: 40n,
      ledgerAccumulated: 40n,
      unlinkedCount: 0,
      unlinkedCost: 0n,
    };
    expect(reconcileFixedAssetRegister(base).status).toBe("reconciled");
    expect(reconcileFixedAssetRegister({ ...base, ledgerCost: 90n }).status).toBe("difference");
    expect(reconcileFixedAssetRegister({ ...base, ledgerAccumulated: 41n }).status).toBe("difference");
  });
});
