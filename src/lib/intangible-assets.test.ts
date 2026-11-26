import { describe, expect, it } from "vitest";
import { depreciationPeriod } from "./depreciation";
import {
  AMORTIZATION_REFUSAL_LABELS,
  INTANGIBLE_USEFUL_LIFE_MAX_MONTHS,
  impairmentCharge,
  intangibleDisposalOutcome,
  intrinsicCarryingAmount,
  planAmortization,
  projectAmortization,
  reconcileIntangibleRegister,
  reversibleImpairment,
  validateIntangibleAsset,
} from "./intangible-assets";

/** A finite licence that started in Farvardin 1404, cost 1,000,000 residual 100,000. */
const inService = depreciationPeriod(1404, 1).startsOn;
const today = "2026-11-26";
const asset = {
  cost: 1_000_000,
  residualValue: 100_000,
  usefulLifeMonths: 3,
  availableForUseDate: inService,
};

function plan(periodKey: string, posted: { periodKey: string; amount: number }[] = []) {
  return planAmortization({
    usefulLifeType: "finite",
    asset,
    postedPeriodKeys: posted.map((p) => p.periodKey),
    accumulatedSoFar: posted.reduce((sum, p) => sum + p.amount, 0),
    postedPostings: posted,
    periodKey,
    today,
  });
}

describe("validateIntangibleAsset", () => {
  const valid = {
    name: "لایسنس نرم‌افزار حسابداری",
    assetClass: "software",
    acquisitionDate: "2025-04-01",
    cost: 500_000_000,
    directlyAttributableCost: 0,
    usefulLifeType: "finite",
    usefulLifeMonths: 60,
    residualValue: 0,
    capitalizationPolicyNote: "خرید perpetual با مجوز استفادهٔ پنج‌ساله",
  };

  it("accepts an explicit, documented capitalization", () => {
    expect(validateIntangibleAsset(valid)).toEqual([]);
  });

  it("refuses a registration with no capitalization policy note", () => {
    expect(validateIntangibleAsset({ ...valid, capitalizationPolicyNote: "  " })).toContain(
      "یادداشت سیاست سرمایه‌ای‌سازی (مبنای شناسایی دارایی) الزامی است.",
    );
  });

  it("refuses an indefinite life that also carries months", () => {
    expect(
      validateIntangibleAsset({ ...valid, usefulLifeType: "indefinite", usefulLifeMonths: 12 }),
    ).toContain("دارایی با عمر نامحدود نباید عمر مفید ماهانه داشته باشد.");
  });

  it("requires months for a finite life and rejects an absurd life", () => {
    expect(validateIntangibleAsset({ ...valid, usefulLifeMonths: null })[0]).toMatch(/عمر مفید/);
    expect(
      validateIntangibleAsset({ ...valid, usefulLifeMonths: INTANGIBLE_USEFUL_LIFE_MAX_MONTHS + 1 }),
    ).toContain(
      `عمر مفید دارایی با عمر محدود باید عدد صحیح بین ۱ تا ${INTANGIBLE_USEFUL_LIFE_MAX_MONTHS} ماه باشد.`,
    );
  });

  it("keeps the directly attributable cost below the total capitalized cost", () => {
    expect(validateIntangibleAsset({ ...valid, directlyAttributableCost: 500_000_000 })).toContain(
      "هزینه‌های مستقیم قابل انتساب باید کمتر از بهای تمام‌شدهٔ کل باشد.",
    );
  });

  it("rejects a loose date and a residual at or above cost", () => {
    const errors = validateIntangibleAsset({
      ...valid,
      acquisitionDate: "April 1, 2025",
      residualValue: 500_000_000,
    });
    expect(errors).toContain("تاریخ تحصیل معتبر نیست.");
    expect(errors).toContain("ارزش باقی‌مانده باید کمتر از بهای تمام‌شده باشد.");
  });
});

describe("planAmortization", () => {
  it("spreads the amortizable base over the life and lands exactly on the residual", () => {
    const months = [
      plan("1404-01"),
      plan("1404-02", [{ periodKey: "1404-01", amount: 300_000 }]),
      plan("1404-03", [
        { periodKey: "1404-01", amount: 300_000 },
        { periodKey: "1404-02", amount: 300_000 },
      ]),
    ];
    for (const m of months) expect(m.ok).toBe(true);
    expect(months.map((m) => (m.ok ? m.amount : null))).toEqual([300_000, 300_000, 300_000]);
  });

  it("absorbs rounding in the final month so the schedule never overshoots", () => {
    const uneven = { ...asset, cost: 1_000_000, residualValue: 0, usefulLifeMonths: 3 };
    const first = planAmortization({
      usefulLifeType: "finite",
      asset: uneven,
      postedPeriodKeys: [],
      accumulatedSoFar: 0,
      postedPostings: [],
      periodKey: "1404-01",
      today,
    });
    const second = planAmortization({
      usefulLifeType: "finite",
      asset: uneven,
      postedPeriodKeys: ["1404-01"],
      accumulatedSoFar: 333_333,
      postedPostings: [{ periodKey: "1404-01", amount: 333_333 }],
      periodKey: "1404-02",
      today,
    });
    const third = planAmortization({
      usefulLifeType: "finite",
      asset: uneven,
      postedPeriodKeys: ["1404-01", "1404-02"],
      accumulatedSoFar: 666_666,
      postedPostings: [
        { periodKey: "1404-01", amount: 333_333 },
        { periodKey: "1404-02", amount: 333_333 },
      ],
      periodKey: "1404-03",
      today,
    });
    expect(first.ok && first.amount).toBe(333_333);
    expect(second.ok && second.amount).toBe(333_333);
    expect(third.ok && third.amount).toBe(333_334);
  });

  it("refuses an indefinite-life asset instead of inventing a charge", () => {
    const result = planAmortization({
      usefulLifeType: "indefinite",
      asset: { ...asset, usefulLifeMonths: 0 },
      postedPeriodKeys: [],
      accumulatedSoFar: 0,
      postedPostings: [],
      periodKey: "1404-01",
      today,
    });
    expect(result).toEqual({ ok: false, error: "indefinite_life_not_amortized" });
    expect(AMORTIZATION_REFUSAL_LABELS.indefinite_life_not_amortized).toBeTruthy();
  });

  it("refuses a month already posted, a month before service, and a future month", () => {
    expect(plan("1404-01", [{ periodKey: "1404-01", amount: 300_000 }])).toEqual({
      ok: false,
      error: "period_already_amortized",
    });
    expect(plan("1403-12")).toEqual({ ok: false, error: "period_before_in_service" });
    // A month that has not started yet is refused as such — its schedule has
    // to be long enough that it is not simply "past the end" instead.
    const future = planAmortization({
      usefulLifeType: "finite",
      asset: { ...asset, usefulLifeMonths: 600 },
      postedPeriodKeys: [],
      accumulatedSoFar: 0,
      postedPostings: [],
      periodKey: "1406-01",
      today,
    });
    expect(future).toEqual({ ok: false, error: "period_in_future" });
  });

  it("refuses a month past the end of the schedule", () => {
    expect(plan("1404-04")).toEqual({ ok: false, error: "period_beyond_schedule" });
  });
});

describe("projectAmortization", () => {
  it("marks posted months from history and projects the rest, totalling cost − residual", () => {
    const { rows, totals } = projectAmortization({
      usefulLifeType: "finite",
      asset,
      livePostings: [{ periodKey: "1404-01", amount: 300_000, entryId: "e1", journalEntryId: "j1" }],
      todayPeriodKey: "1404-02",
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ periodKey: "1404-01", status: "posted", amortization: 300_000 });
    expect(rows[1]).toMatchObject({ periodKey: "1404-02", status: "forecast", amortization: 300_000 });
    expect(totals.postedAmortization).toBe(300_000);
    expect(totals.accumulated).toBe(900_000);
    expect(totals.closingCarrying).toBe(100_000);
  });

  it("returns no schedule at all for an indefinite-life asset", () => {
    const { rows, totals } = projectAmortization({
      usefulLifeType: "indefinite",
      asset: { ...asset, usefulLifeMonths: 0 },
      livePostings: [],
      todayPeriodKey: "1404-02",
    });
    expect(rows).toEqual([]);
    expect(totals.accumulated).toBe(0);
  });
});

describe("impairment", () => {
  it("charges the excess of carrying amount over the recoverable amount", () => {
    expect(impairmentCharge({ carryingAmount: 800_000, recoverableAmount: 500_000 })).toBe(300_000);
    expect(impairmentCharge({ carryingAmount: 800_000, recoverableAmount: 800_000 })).toBeNull();
    expect(impairmentCharge({ carryingAmount: 800_000, recoverableAmount: -1 })).toBeNull();
  });

  it("reverses no more than the outstanding impairment", () => {
    expect(reversibleImpairment({ outstandingImpairment: 300_000, requestedAmount: 500_000 })).toBe(300_000);
    expect(reversibleImpairment({ outstandingImpairment: 300_000, requestedAmount: 100_000 })).toBe(100_000);
    expect(reversibleImpairment({ outstandingImpairment: 0, requestedAmount: 100_000 })).toBeNull();
    expect(reversibleImpairment({ outstandingImpairment: 300_000, requestedAmount: 0 })).toBeNull();
  });

  it("derives carrying amount from cost less both accumulations", () => {
    expect(
      intrinsicCarryingAmount({ cost: 1_000_000, accumulatedAmortization: 300_000, accumulatedImpairment: 100_000 }),
    ).toBe(600_000);
    expect(
      intrinsicCarryingAmount({ cost: 1_000_000, accumulatedAmortization: 900_000, accumulatedImpairment: 300_000 }),
    ).toBe(0);
  });
});

describe("disposal", () => {
  it("computes gain and loss against carrying amount, not against amortization alone", () => {
    const sale = intangibleDisposalOutcome({
      cost: 1_000_000,
      accumulatedAmortization: 200_000,
      accumulatedImpairment: 100_000,
      proceeds: 900_000,
    });
    expect(sale).toEqual({ netBookValue: 700_000, gain: 200_000, loss: 0 });
    const loss = intangibleDisposalOutcome({
      cost: 1_000_000,
      accumulatedAmortization: 200_000,
      accumulatedImpairment: 100_000,
      proceeds: 500_000,
    });
    expect(loss).toEqual({ netBookValue: 700_000, gain: 0, loss: 200_000 });
  });
});

describe("reconcileIntangibleRegister", () => {
  it("reports reconciled only when every difference is zero", () => {
    const ok = reconcileIntangibleRegister({
      registerCost: 1_000_000n,
      registerAccumulatedAmortization: 200_000n,
      registerAccumulatedImpairment: 50_000n,
      ledgerCost: 1_000_000n,
      ledgerAccumulatedAmortization: 200_000n,
      ledgerAccumulatedImpairment: 50_000n,
      unmappedCount: 0,
    });
    expect(ok.status).toBe("reconciled");
    const drift = reconcileIntangibleRegister({
      registerCost: 1_000_000n,
      registerAccumulatedAmortization: 200_000n,
      registerAccumulatedImpairment: 50_000n,
      ledgerCost: 1_000_000n,
      ledgerAccumulatedAmortization: 200_000n,
      ledgerAccumulatedImpairment: 60_000n,
      unmappedCount: 1,
    });
    expect(drift.status).toBe("difference");
    expect(drift.impairmentDifference).toBe("10000");
    expect(drift.unmappedCount).toBe(1);
  });
});
