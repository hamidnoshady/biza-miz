import { describe, expect, it } from "vitest";
import {
  addMonthsToPeriodKey,
  depreciableBase,
  depreciationCharge,
  depreciationPeriodOfDate,
  disposalOutcome,
  monthlyDepreciation,
  monthsBetweenPeriodKeys,
  normaliseDepreciationMethod,
  parseDepreciationPeriodKey,
  planDepreciation,
  projectDepreciationSchedule,
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

// ---------------------------------------------------------------------------
// Depreciation methods and projected schedules — issue #1325.
// ---------------------------------------------------------------------------

describe("normaliseDepreciationMethod", () => {
  it("defaults every legacy shape to straight-line with no parameters", () => {
    expect(normaliseDepreciationMethod({})).toEqual({
      ok: true,
      config: {
        method: "straight_line",
        decliningBalanceRateBps: null,
        decliningBalanceSwitchPolicy: "none",
        totalCapacityUnits: null,
        capacityUnitLabel: null,
      },
    });
  });

  it("requires a positive annual rate for declining-balance and a positive capacity for units-of-production", () => {
    expect(normaliseDepreciationMethod({ method: "declining_balance" }).ok).toBe(false);
    expect(normaliseDepreciationMethod({ method: "declining_balance", decliningBalanceRateBps: 0 }).ok).toBe(false);
    expect(normaliseDepreciationMethod({ method: "units_of_production" }).ok).toBe(false);
    expect(normaliseDepreciationMethod({ method: "units_of_production", totalCapacityUnits: -1 }).ok).toBe(false);
    expect(normaliseDepreciationMethod({ method: "average" }).ok).toBe(false);
  });

  it("clears parameters that do not belong to the selected method", () => {
    const result = normaliseDepreciationMethod({
      method: "straight_line",
      decliningBalanceRateBps: 2500,
      totalCapacityUnits: 1000,
    });
    expect(result).toMatchObject({
      ok: true,
      config: { method: "straight_line", decliningBalanceRateBps: null, totalCapacityUnits: null },
    });
  });
});

describe("monthsBetweenPeriodKeys", () => {
  it("counts calendar months across Jalali year boundaries", () => {
    expect(monthsBetweenPeriodKeys("1405-01", "1405-12")).toBe(11);
    expect(monthsBetweenPeriodKeys("1405-12", "1406-01")).toBe(1);
    expect(monthsBetweenPeriodKeys("1405-03", "1405-01")).toBe(-2);
  });
});

describe("depreciationCharge (declining balance)", () => {
  const base = {
    cost: 1_200_000,
    salvageValue: 0,
    usefulLifeMonths: 12,
    method: "declining_balance" as const,
    decliningBalanceRateBps: 2500,
    decliningBalanceSwitchPolicy: "none" as const,
    inServiceDate: "2026-04-01",
    periodKey: "1405-01",
    openingAccumulated: 0,
    finalSalvageValue: 0,
  };

  it("charges the annual rate on the opening carrying amount, one twelfth per month", () => {
    // 1,200,000 × 25% ÷ 12 = 25,000.
    expect(depreciationCharge(base)).toBe(25_000);
  });

  it("never charges against a carrying amount already at the residual floor", () => {
    expect(depreciationCharge({ ...base, cost: 100, openingAccumulated: 100 })).toBe(0);
  });

  it("switches to straight-line when that charge is larger, and not otherwise", () => {
    // Late in a 12-month schedule (2 months left): opening carrying 200.
    // Declining: 200 × 100% ÷ 12 = 16.67 → 17. Straight line: 200 ÷ 2 = 100.
    const late = {
      ...base,
      cost: 1200,
      decliningBalanceRateBps: 10_000,
      openingAccumulated: 1000,
      periodKey: "1405-11",
    };
    expect(depreciationCharge({ ...late, decliningBalanceSwitchPolicy: "none" })).toBe(17);
    expect(depreciationCharge({ ...late, decliningBalanceSwitchPolicy: "straight_line" })).toBe(100);
  });
});

describe("planDepreciation — declining balance", () => {
  const schedule = {
    cost: 1_200_000,
    salvageValue: 0,
    usefulLifeMonths: 12,
    inServiceDate: "2026-04-01",
    method: "declining_balance" as const,
    decliningBalanceRateBps: 2500,
    decliningBalanceSwitchPolicy: "none" as const,
  };
  const base = {
    schedule,
    finalSalvageValue: 0,
    finalUsefulLifeMonths: 12,
    postedPeriodKeys: [] as string[],
    accumulatedSoFar: 0,
    today: "2026-04-20",
  };

  it("prices the first month from the opening carrying amount", () => {
    expect(planDepreciation({ ...base, periodKey: "1405-01" })).toMatchObject({ ok: true, amount: 25_000 });
  });

  it("prices a catch-up month from the live postings before it, not from today's total", () => {
    const posted = {
      ...base,
      postedPeriodKeys: ["1405-01"],
      accumulatedSoFar: 25_000,
      postedPostings: [{ periodKey: "1405-01", amount: 25_000 }],
      today: "2026-06-20",
    };
    // Opening carrying 1,175,000 → 1,175,000 × 25% ÷ 12 = 24,479.17 → 24,479.
    expect(planDepreciation({ ...posted, periodKey: "1405-02" })).toMatchObject({ ok: true, amount: 24_479 });
  });

  it("stops at the lifetime cap and never goes below the residual value", () => {
    const almostDone = {
      ...base,
      postedPeriodKeys: ["1405-01"],
      accumulatedSoFar: 1_199_900,
      postedPostings: [{ periodKey: "1405-01", amount: 1_199_900 }],
      today: "2026-06-20",
    };
    const capped = planDepreciation({ ...almostDone, periodKey: "1405-02" });
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.amount).toBeGreaterThan(0);
      expect(capped.amount).toBeLessThanOrEqual(100);
    }
    expect(
      planDepreciation({
        ...base,
        postedPeriodKeys: ["1405-01", "1405-02"],
        accumulatedSoFar: 1_200_000,
        postedPostings: [
          { periodKey: "1405-01", amount: 1_199_900 },
          { periodKey: "1405-02", amount: 100 },
        ],
        periodKey: "1405-03",
        today: "2026-07-01",
      }),
    ).toEqual({ ok: false, error: "fully_depreciated" });
  });
});

describe("planDepreciation — units of production", () => {
  const schedule = {
    cost: 100,
    salvageValue: 0,
    usefulLifeMonths: 3,
    inServiceDate: "2026-04-01",
    method: "units_of_production" as const,
    totalCapacityUnits: 3,
  };
  const base = {
    schedule,
    finalSalvageValue: 0,
    finalUsefulLifeMonths: 3,
    postedPeriodKeys: [] as string[],
    accumulatedSoFar: 0,
    today: "2026-07-01",
  };

  it("charges actual production at the approved per-unit rate", () => {
    expect(planDepreciation({ ...base, periodKey: "1405-01", unitsProduced: 1 })).toMatchObject({
      ok: true,
      amount: 33,
    });
  });

  it("absorbs the rounding remainder in the month that reaches capacity", () => {
    const third = {
      ...base,
      postedPeriodKeys: ["1405-01", "1405-02"],
      accumulatedSoFar: 66,
      postedPostings: [
        { periodKey: "1405-01", amount: 33, unitsProduced: 1 },
        { periodKey: "1405-02", amount: 33, unitsProduced: 1 },
      ],
    };
    expect(planDepreciation({ ...third, periodKey: "1405-03", unitsProduced: 1 })).toMatchObject({
      ok: true,
      amount: 34,
    });
  });

  it("refuses missing capacity, missing units, zero production and over-capacity production", () => {
    expect(planDepreciation({ ...base, periodKey: "1405-01", unitsProduced: 1, schedule: { ...schedule, totalCapacityUnits: null } })).toEqual({
      ok: false,
      error: "capacity_required",
    });
    expect(planDepreciation({ ...base, periodKey: "1405-01" })).toEqual({
      ok: false,
      error: "production_units_required",
    });
    expect(planDepreciation({ ...base, periodKey: "1405-01", unitsProduced: 0 })).toEqual({
      ok: false,
      error: "fully_depreciated",
    });
    expect(planDepreciation({ ...base, periodKey: "1405-01", unitsProduced: 4 })).toEqual({
      ok: false,
      error: "production_exceeds_capacity",
    });
  });
});

describe("projectDepreciationSchedule", () => {
  it("separates posted months from forecasts, chains carrying amounts and lands exactly", () => {
    const { rows, totals } = projectDepreciationSchedule({
      asset: { cost: 100, salvageValue: 0, usefulLifeMonths: 3, inServiceDate: "2026-04-01" },
      livePostings: [{ periodKey: "1405-01", amount: 33 }],
      todayPeriodKey: "1405-01",
    });
    expect(rows.map((r) => r.status)).toEqual(["posted", "forecast", "forecast"]);
    expect(rows.map((r) => r.depreciation)).toEqual([33, 33, 34]);
    expect(rows.map((r) => r.openingCarrying)).toEqual([100, 67, 34]);
    expect(rows.map((r) => r.closingCarrying)).toEqual([67, 34, 0]);
    expect(totals.postedDepreciation).toBe(33);
    expect(totals.forecastDepreciation).toBe(67);
    expect(totals.accumulated).toBe(100);
    expect(totals.remainingDepreciableBase).toBe(0);
    expect(totals.closingCarrying).toBe(0);
  });

  it("honours a forecast horizon inside the schedule", () => {
    const { rows } = projectDepreciationSchedule({
      asset: { cost: 1200, salvageValue: 0, usefulLifeMonths: 12, inServiceDate: "2026-04-01" },
      livePostings: [],
      todayPeriodKey: "1405-01",
      throughPeriodKey: "1405-03",
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "forecast")).toBe(true);
  });

  it("forecasts declining balance without ever passing the residual floor", () => {
    const { rows, totals } = projectDepreciationSchedule({
      asset: {
        cost: 1200,
        salvageValue: 200,
        usefulLifeMonths: 12,
        inServiceDate: "2026-04-01",
        method: "declining_balance",
        decliningBalanceRateBps: 5000,
        decliningBalanceSwitchPolicy: "straight_line",
      },
      livePostings: [],
      todayPeriodKey: "1405-01",
    });
    expect(rows).toHaveLength(12);
    expect(totals.accumulated).toBe(1000);
    expect(totals.closingCarrying).toBe(200);
    expect(rows.every((r) => r.closingCarrying >= 200)).toBe(true);
  });

  it("prices a units-of-production forecast from the production plan and closes at capacity", () => {
    const { rows, totals } = projectDepreciationSchedule({
      asset: {
        cost: 100,
        salvageValue: 0,
        usefulLifeMonths: 3,
        inServiceDate: "2026-04-01",
        method: "units_of_production",
        totalCapacityUnits: 3,
      },
      livePostings: [],
      projectedUnits: { "1405-01": 1, "1405-02": 1, "1405-03": 1 },
      todayPeriodKey: "1405-01",
    });
    expect(rows.map((r) => r.depreciation)).toEqual([33, 33, 34]);
    expect(rows.map((r) => r.unitsProduced)).toEqual([1, 1, 1]);
    expect(totals.accumulated).toBe(100);
  });
});
