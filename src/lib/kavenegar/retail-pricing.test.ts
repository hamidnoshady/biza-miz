import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETAIL_PRICE_VERSION,
  applyBps,
  discountIsActive,
  parseRetailPriceVersionInput,
  quoteRetailBatch,
  quoteRetailCharge,
  remainingFreeAllowance,
  resolveRetailTerms,
  type RetailPriceVersion,
} from "./retail-pricing";

function version(overrides: Partial<RetailPriceVersion> = {}): RetailPriceVersion {
  return { ...DEFAULT_RETAIL_PRICE_VERSION, version: 7, id: "11111111-1111-4111-8111-111111111111", ...overrides };
}

const BUSINESS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUSINESS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function quote(smsVersion: RetailPriceVersion, extra: Partial<Parameters<typeof quoteRetailCharge>[0]> = {}) {
  return quoteRetailCharge({
    channel: "sms",
    unitPriceRial: 1_000,
    quantity: 2,
    businessId: BUSINESS_A,
    monthlySegments: 0,
    freeAllowanceRemaining: 0,
    version: smsVersion,
    at: new Date("2026-10-27T10:00:00.000Z"),
    ...extra,
  });
}

describe("retail pricing — the default is the pre-§4 bill, exactly", () => {
  it("charges base rate × units when nothing is published", () => {
    const priced = quote(DEFAULT_RETAIL_PRICE_VERSION);
    expect(priced.totalRial).toBe(2_000);
    expect(priced.baseRial).toBe(2_000);
    expect(priced.markupRial).toBe(0);
    expect(priced.priceVersion).toBe(0);
    expect(priced.priceVersionId).toBeNull();
  });

  it("treats quantity below one as one unit rather than zero", () => {
    expect(quote(version(), { quantity: 0 }).totalRial).toBe(1_000);
  });

  it("never produces a negative or fractional Rial", () => {
    const priced = quote(version({ markupBps: 1_250 }), { unitPriceRial: 333, quantity: 3 });
    for (const value of [priced.baseRial, priced.markupRial, priced.taxRial, priced.totalRial]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("retail pricing — markup, surcharge, tax", () => {
  it("floors the percentage markup instead of rounding up", () => {
    // 3 × 333 = 999; 12.5% = 124.875 → 124
    const priced = quote(version({ markupBps: 1_250 }), { unitPriceRial: 333, quantity: 3 });
    expect(priced.baseRial).toBe(999);
    expect(priced.markupRial).toBe(124);
    expect(priced.totalRial).toBe(1_123);
  });

  it("charges the fixed surcharge once per message, not per segment", () => {
    const priced = quote(version({ fixedSurchargeRial: 500 }), { quantity: 4 });
    expect(priced.surchargeRial).toBe(500);
    expect(priced.totalRial).toBe(4_500);
  });

  it("computes tax on the discounted amount, floored", () => {
    const priced = quote(
      version({ markupBps: 2_000, discountBps: 1_000, taxBps: 900, discountUntil: null }),
      { quantity: 1 },
    );
    // base 1000, markup 200 → gross 1200, discount 120 → taxable 1080, tax 97
    expect(priced.discountRial).toBe(120);
    expect(priced.taxRial).toBe(97);
    expect(priced.totalRial).toBe(1_177);
  });

  it("applyBps is the single rounding rule and clamps junk to zero", () => {
    expect(applyBps(999, 1_250)).toBe(124);
    expect(applyBps(0, 5_000)).toBe(0);
    expect(applyBps(-10, 5_000)).toBe(0);
    expect(applyBps(1_000, -5)).toBe(0);
  });
});

describe("retail pricing — promotions", () => {
  const promo = version({ discountBps: 2_500, discountUntil: "2026-11-01T00:00:00.000Z" });

  it("honours the promotion while its window is open", () => {
    expect(discountIsActive(promo, new Date("2026-10-27T10:00:00.000Z"))).toBe(true);
    expect(quote(promo).discountRial).toBe(500);
  });

  it("stops at the boundary and ignores an unparseable end date", () => {
    expect(discountIsActive(promo, new Date("2026-11-01T00:00:00.000Z"))).toBe(false);
    expect(discountIsActive(version({ discountBps: 2_500, discountUntil: "not a date" }), new Date())).toBe(false);
  });

  it("a discount with no end date never expires", () => {
    expect(discountIsActive(version({ discountBps: 100 }), new Date("2030-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("never discounts more than the gross charge", () => {
    const priced = quote(version({ discountBps: 10_000 }));
    expect(priced.discountRial).toBe(2_000);
    expect(priced.totalRial).toBe(0);
  });
});

describe("retail pricing — volume slabs", () => {
  const slabbish = version({
    markupBps: 3_000,
    fixedSurchargeRial: 200,
    slabs: [
      { minMonthlySegments: 0, markupBps: 3_000, fixedSurchargeRial: 200 },
      { minMonthlySegments: 1_000, markupBps: 1_500, fixedSurchargeRial: 100 },
      { minMonthlySegments: 10_000, markupBps: 500, fixedSurchargeRial: 0 },
    ],
  });

  it("picks the highest tier whose floor is reached, inclusively", () => {
    expect(resolveRetailTerms(slabbish, { businessId: BUSINESS_A, channel: "sms", monthlySegments: 999 }).markupBps).toBe(3_000);
    const atBoundary = resolveRetailTerms(slabbish, { businessId: BUSINESS_A, channel: "sms", monthlySegments: 1_000 });
    expect(atBoundary.markupBps).toBe(1_500);
    expect(atBoundary.slabMinMonthlySegments).toBe(1_000);
    expect(resolveRetailTerms(slabbish, { businessId: BUSINESS_A, channel: "sms", monthlySegments: 250_000 }).markupBps).toBe(500);
  });

  it("keeps the version price when there is no tier to reach", () => {
    const noMatch = resolveRetailTerms(
      version({ markupBps: 1_000, slabs: [{ minMonthlySegments: 5_000, markupBps: 100, fixedSurchargeRial: 0 }] }),
      { businessId: BUSINESS_A, channel: "sms", monthlySegments: 10 },
    );
    expect(noMatch.markupBps).toBe(1_000);
    expect(noMatch.slabMinMonthlySegments).toBeNull();
  });

  it("reprices the whole message from the tier, not just the marginal units", () => {
    const priced = quote(slabbish, { monthlySegments: 10_000, quantity: 2 });
    expect(priced.markupRial).toBe(100); // 2000 × 5%
    expect(priced.surchargeRial).toBe(0);
    expect(priced.totalRial).toBe(2_100);
  });
});

describe("retail pricing — exceptions", () => {
  const withOverrides = version({
    markupBps: 2_000,
    fixedSurchargeRial: 300,
    overrides: [
      { scope: "channel", businessId: null, channel: "email", markupBps: 5_000, fixedSurchargeRial: null },
      { scope: "business", businessId: BUSINESS_A, markupBps: 1_000, fixedSurchargeRial: null },
      { scope: "business_channel", businessId: BUSINESS_A, channel: "sms", markupBps: 0, fixedSurchargeRial: 900 },
    ],
  });

  it("applies channel → business → business_channel, narrowest last", () => {
    const email = resolveRetailTerms(withOverrides, { businessId: BUSINESS_B, channel: "email", monthlySegments: 0 });
    expect(email.markupBps).toBe(5_000);
    expect(email.fixedSurchargeRial).toBe(300); // unset field keeps the version price

    const smsA = resolveRetailTerms(withOverrides, { businessId: BUSINESS_A, channel: "sms", monthlySegments: 0 });
    expect(smsA.markupBps).toBe(0);
    expect(smsA.fixedSurchargeRial).toBe(900);
    expect(smsA.appliedOverrides).toEqual(["business", "business_channel"]);
  });

  it("leaves every other business on the version price", () => {
    const other = quote(
      withOverrides,
      { businessId: BUSINESS_B, channel: "sms", quantity: 1 },
    );
    expect(other.markupRial).toBe(200);
    expect(other.surchargeRial).toBe(300);
  });

  it("an override beats a volume tier", () => {
    const priced = quote(
      version({
        markupBps: 3_000,
        slabs: [{ minMonthlySegments: 0, markupBps: 3_000, fixedSurchargeRial: 0 }],
        overrides: [{ scope: "business", businessId: BUSINESS_A, channel: null, markupBps: 800, fixedSurchargeRial: null }],
      }),
      { monthlySegments: 50_000, quantity: 1 },
    );
    expect(priced.markupRial).toBe(80);
  });
});

describe("retail pricing — free monthly allowance", () => {
  const allowance = version({ freeAllowanceSegments: 5 });

  it("charges nothing at all for a fully covered message", () => {
    const priced = quote(version({ freeAllowanceSegments: 5, fixedSurchargeRial: 400 }), {
      quantity: 2,
      freeAllowanceRemaining: 5,
    });
    expect(priced.freeUnits).toBe(2);
    expect(priced.billableUnits).toBe(0);
    expect(priced.totalRial).toBe(0);
    expect(priced.surchargeRial).toBe(0);
  });

  it("charges the remaining segments of a partially covered message", () => {
    const priced = quote(version({ fixedSurchargeRial: 400 }), {
      quantity: 4,
      freeAllowanceRemaining: 1,
    });
    expect(priced.freeUnits).toBe(1);
    expect(priced.billableUnits).toBe(3);
    expect(priced.surchargeRial).toBe(400);
    expect(priced.totalRial).toBe(3_400);
  });

  it("does not cover email, which is not billed in segments", () => {
    const priced = quote(version(), { channel: "email", unitPriceRial: 5_000, quantity: 1, freeAllowanceRemaining: 10 });
    expect(priced.freeUnits).toBe(0);
    expect(priced.totalRial).toBe(5_000);
  });

  it("computes the remaining allowance without going negative", () => {
    expect(remainingFreeAllowance(allowance, 2)).toBe(3);
    expect(remainingFreeAllowance(allowance, 9)).toBe(0);
  });
});

describe("retail pricing — batching", () => {
  it("consumes the allowance in order and the total equals the sum of parts", () => {
    const batch = quoteRetailBatch({
      businessId: BUSINESS_A,
      // 10 a month, 4 already used → 6 left for this batch of 7 segments.
      monthlySegments: 4,
      version: version({ freeAllowanceSegments: 10 }),
      messages: [
        { channel: "sms", unitPriceRial: 1_000, quantity: 2 },
        { channel: "sms", unitPriceRial: 1_000, quantity: 3 },
        { channel: "sms", unitPriceRial: 1_000, quantity: 2 },
      ],
    });
    expect(batch.quotes.map((q) => q.freeUnits)).toEqual([2, 3, 1]);
    expect(batch.freeUnitsUsed).toBe(6);
    expect(batch.quotes.map((q) => q.totalRial)).toEqual([0, 0, 1_000]);
    expect(batch.totalRial).toBe(1_000);
    expect(batch.totalRial).toBe(batch.quotes.reduce((sum, q) => sum + q.totalRial, 0));
  });

  it("prices an empty batch at zero", () => {
    const batch = quoteRetailBatch({
      businessId: BUSINESS_A,
      monthlySegments: 0,
      version: version(),
      messages: [],
    });
    expect(batch.totalRial).toBe(0);
  });
});

describe("retail pricing — publish validation", () => {
  it("accepts a complete policy and normalises it", () => {
    const parsed = parseRetailPriceVersionInput({
      markupBps: "1,250".replace(",", ""),
      fixedSurchargeRial: 200,
      taxBps: 900,
      discountBps: 500,
      freeAllowanceSegments: 10,
      failedSendPolicy: "charge",
      note: "  launching  ", 
      slabs: [{ minMonthlySegments: 1_000, markupBps: 1_000, fixedSurchargeRial: 100 }],
      overrides: [{ scope: "channel", channel: "sms", markupBps: 1_500, fixedSurchargeRial: 50 }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.markupBps).toBe(1_250);
    expect(parsed.value.failedSendPolicy).toBe("charge");
    expect(parsed.value.slabs).toHaveLength(1);
    expect(parsed.value.overrides[0].businessId).toBeNull();
  });

  it("defaults to a refund policy and no discount when the route omits them", () => {
    const parsed = parseRetailPriceVersionInput({ markupBps: 500 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.failedSendPolicy).toBe("refund");
    expect(parsed.value.discountUntil).toBeNull();
  });

  it("rejects rather than clamping a bad price", () => {
    const cases: unknown[] = [
      { markupBps: -1 },
      { markupBps: 100_001 },
      { markupBps: 12.5 },
      { fixedSurchargeRial: "abc" },
      { taxBps: 10_001 },
      { freeAllowanceSegments: -5 },
      { failedSendPolicy: "maybe" },
      { discountUntil: "whenever" },
      { slabs: [{ minMonthlySegments: 10, markupBps: 1 }, { minMonthlySegments: 10, markupBps: 2 }] },
      { overrides: [{ scope: "channel", channel: "pigeon", markupBps: 5 }] },
      { overrides: [{ scope: "business", markupBps: 5 }] },
      { overrides: [{ scope: "business", businessId: "not-a-uuid", markupBps: 5 }] },
      { overrides: [{ scope: "channel", channel: "sms" }] },
      { overrides: [{ scope: "planet", markupBps: 1 }] },
    ];
    for (const body of cases) {
      expect(parseRetailPriceVersionInput(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("accepts Persian digits from a Persian keyboard", () => {
    const parsed = parseRetailPriceVersionInput({ markupBps: "۱۲۵۰" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.markupBps).toBe(1_250);
  });
});
