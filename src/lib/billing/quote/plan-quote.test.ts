/**
 * ESH-193 / #1378 — golden quotes for the canonical quote contract.
 *
 * The numbers here are the acceptance fixtures the issue asks for (1/3/12
 * months, recurring vs one-off add-ons, term discount, tax after discount,
 * month-end periods and stale-quote rejection), at integer Rial.
 */
import { describe, expect, it } from "vitest";
import { formatMoney } from "../../money";
import {
  PLAN_TERM_MONTHS,
  addCalendarMonths,
  buildPlanQuote,
  isPlanTermMonths,
  isQuoteStale,
  planBasePriceVersion,
  renderQuoteExplanation,
  type PlanQuoteRequest,
} from "./plan-quote";

const BASE_VERSION = { id: "pv-plan-1", version: 1 };

function request(overrides: Partial<PlanQuoteRequest> = {}): PlanQuoteRequest {
  return {
    planKey: "pro",
    termMonths: 1,
    monthlyBaseRial: 1_000_000,
    basePriceVersion: BASE_VERSION,
    termDiscountRate: 0,
    taxRate: 0,
    issuedAt: "2026-01-31T10:00:00.000Z",
    ...overrides,
  };
}

describe("terms", () => {
  it("sells exactly 1, 3 and 12 calendar months", () => {
    expect([...PLAN_TERM_MONTHS]).toEqual([1, 3, 12]);
    for (const term of PLAN_TERM_MONTHS) expect(isPlanTermMonths(term)).toBe(true);
    expect(isPlanTermMonths(6)).toBe(false);
    expect(isPlanTermMonths("3")).toBe(false);
  });

  it("counts months on the calendar, clamping month-end", () => {
    // Jan 31 + 1 month is Feb 28, never Mar 3.
    expect(addCalendarMonths("2026-01-31T10:00:00.000Z", 1)).toBe("2026-02-28T10:00:00.000Z");
    expect(addCalendarMonths("2026-03-31T10:00:00.000Z", 3)).toBe("2026-06-30T10:00:00.000Z");
    expect(addCalendarMonths("2026-01-31T10:00:00.000Z", 12)).toBe("2027-01-31T10:00:00.000Z");
  });

  it("keeps the term inside a leap year", () => {
    expect(addCalendarMonths("2028-01-31T00:00:00.000Z", 1)).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("buildPlanQuote", () => {
  it("charges one month with no discount for a 1-month term", () => {
    const quote = buildPlanQuote(request());
    expect(quote.totals).toEqual({
      grossRial: 1_000_000,
      discountRial: 0,
      couponDiscountRial: 0,
      taxRial: 0,
      netRial: 1_000_000,
    });
    expect(quote.lines.map((line) => line.kind)).toEqual(["plan_base"]);
    expect(quote.period).toEqual({
      start: "2026-01-31T10:00:00.000Z",
      end: "2026-02-28T10:00:00.000Z",
    });
  });

  it("multiplies the recurring base across the term, before discount and tax", () => {
    const quote = buildPlanQuote(
      request({ termMonths: 3, termDiscountRate: 0.05, taxRate: 0.09 }),
    );
    // 3 × 1,000,000 gross; 5% = 150,000; 9% tax on 2,850,000 = 256,500.
    expect(quote.totals).toEqual({
      grossRial: 3_000_000,
      discountRial: 150_000,
      couponDiscountRial: 0,
      taxRial: 256_500,
      netRial: 3_106_500,
    });
    expect(quote.period.end).toBe("2026-04-30T10:00:00.000Z");
  });

  it("applies the 12-month rate to the recurring total only", () => {
    const quote = buildPlanQuote(
      request({ termMonths: 12, termDiscountRate: 0.15 }),
    );
    expect(quote.totals.discountRial).toBe(1_800_000);
    expect(quote.totals.netRial).toBe(10_200_000);
  });

  it("multiplies monthly add-ons by the term and charges one-off add-ons once", () => {
    const quote = buildPlanQuote(
      request({
        termMonths: 3,
        termDiscountRate: 0.05,
        recurringAddOns: [{ key: "extra_branch", amountRial: 200_000 }],
        oneOffAddOns: [{ key: "setup", amountRial: 500_000, priceVersion: { id: "pv-setup", version: 1 } }],
      }),
    );
    // Recurring gross = (1,000,000 + 200,000) × 3 = 3,600,000; discount 180,000.
    // One-off 500,000 is not discounted and not multiplied.
    expect(quote.lines.find((line) => line.key === "extra_branch")).toMatchObject({
      quantity: 3,
      grossRial: 600_000,
      discountRial: 0,
      priceVersion: null,
    });
    expect(quote.lines.find((line) => line.key === "setup")).toMatchObject({
      quantity: 1,
      grossRial: 500_000,
      priceVersion: { id: "pv-setup", version: 1 },
    });
    expect(quote.totals.grossRial).toBe(4_100_000);
    expect(quote.totals.discountRial).toBe(180_000);
    expect(quote.totals.netRial).toBe(3_920_000);
  });

  it("never applies a discount when the configured rate is zero — no built-in promo", () => {
    const quote = buildPlanQuote(request({ termMonths: 12, termDiscountRate: 0 }));
    expect(quote.totals.discountRial).toBe(0);
    expect(quote.lines.some((line) => line.kind === "term_discount")).toBe(false);
  });

  it("cites the price version on the base line", () => {
    const quote = buildPlanQuote(request({ termMonths: 3, termDiscountRate: 0.05 }));
    expect(planBasePriceVersion(quote)).toEqual(BASE_VERSION);
  });

  it("refuses a term it does not sell", () => {
    expect(() => buildPlanQuote(request({ termMonths: 6 as 3 }))).toThrow("invalid_quote_term");
  });

  it("refuses a bad rate or amount instead of quoting a wrong total", () => {
    expect(() => buildPlanQuote(request({ termDiscountRate: 1.5 }))).toThrow(
      "invalid_quote_discount_rate",
    );
    expect(() => buildPlanQuote(request({ taxRate: -0.1 }))).toThrow("invalid_quote_tax_rate");
    expect(() => buildPlanQuote(request({ monthlyBaseRial: 1.5 }))).toThrow(
      "invalid_quote_base_price",
    );
    expect(() =>
      buildPlanQuote(request({ recurringAddOns: [{ key: "x", amountRial: -1 }] })),
    ).toThrow("invalid_quote_addon_price");
  });
});

describe("explanation", () => {
  it("renders in the business's own unit and Persian digits", () => {
    const quote = buildPlanQuote(request({ termMonths: 3, termDiscountRate: 0.05 }));
    const toman = renderQuoteExplanation(quote, (rial) => formatMoney(rial, "toman"));
    expect(toman).toContain("تومان");
    expect(toman).not.toContain("ریال");
    expect(toman).not.toMatch(/[0-9]/);
    expect(toman).toContain("۳");

    // The unit is the formatter's choice, not this module's: a Rial business
    // renders the same facts with «ریال».
    const rial = renderQuoteExplanation(quote, (value) => formatMoney(value, "rial"));
    expect(rial).toContain("ریال");
  });

  it("mentions a discount or tax line only when there is one", () => {
    const plain = renderQuoteExplanation(buildPlanQuote(request()), (value) => String(value));
    expect(plain).not.toContain("تخفیف");
    expect(plain).not.toContain("مالیات");
    expect(plain).toContain("مبلغ دوره");

    const discounted = renderQuoteExplanation(
      buildPlanQuote(request({ termMonths: 3, termDiscountRate: 0.05, taxRate: 0.09 })),
      (value) => String(value),
    );
    expect(discounted).toContain("پیش از تخفیف");
    expect(discounted).toContain("مالیات");
  });
});

describe("coupon", () => {
  it("takes a percentage of the post-term-discount recurring total, before tax", () => {
    const quote = buildPlanQuote(
      request({
        termMonths: 3,
        termDiscountRate: 0.05,
        taxRate: 0.09,
        coupon: { kind: "percent", value: 1_000, code: "LAUNCH10" },
      }),
    );
    // 3,000,000 − 5% = 2,850,000; 10% = 285,000; tax on 2,565,000 = 230,850.
    expect(quote.totals.couponDiscountRial).toBe(285_000);
    expect(quote.totals.netRial).toBe(2_795_850);
    expect(quote.lines.find((line) => line.kind === "coupon_discount")).toMatchObject({
      key: "coupon:LAUNCH10",
      netRial: -285_000,
    });
  });

  it("clamps a fixed coupon to the discounted recurring total", () => {
    const quote = buildPlanQuote(
      request({
        termMonths: 3,
        termDiscountRate: 0.05,
        coupon: { kind: "fixed", value: 5_000_000, code: "BIG" },
      }),
    );
    expect(quote.totals.couponDiscountRial).toBe(2_850_000);
    expect(quote.totals.netRial).toBe(0);
  });

  it("never discounts a one-off add-on", () => {
    const quote = buildPlanQuote(
      request({
        termMonths: 1,
        oneOffAddOns: [{ key: "setup", amountRial: 1_000_000 }],
        coupon: { kind: "percent", value: 1_000, code: "LAUNCH10" },
      }),
    );
    expect(quote.totals.couponDiscountRial).toBe(100_000);
    expect(quote.totals.netRial).toBe(1_900_000);
  });

  it("refuses a malformed coupon instead of quoting a silent zero", () => {
    expect(() =>
      buildPlanQuote(request({ coupon: { kind: "percent", value: 10_001, code: "X" } })),
    ).toThrow("invalid_quote_coupon");
    expect(() =>
      buildPlanQuote(request({ coupon: { kind: "fixed", value: 0, code: "X" } })),
    ).toThrow("invalid_quote_coupon");
  });

  it("names the coupon discount in the rendered sentence", () => {
    const quote = buildPlanQuote(
      request({ termMonths: 3, coupon: { kind: "fixed", value: 250_000, code: "X" } }),
    );
    const text = renderQuoteExplanation(quote, (value) => String(value));
    expect(text).toContain("250000 تخفیف کد");
  });
});

describe("plan base lookup", () => {
  it("finds the base line by kind, not by position", () => {
    const quote = buildPlanQuote(request());
    const baseLine = quote.lines[0];
    const moved = {
      ...quote,
      // A future trial/proration line ahead of the base must not change which
      // price version staleness compares against.
      lines: [{ ...baseLine, kind: "recurring_addon" as const, key: "future_trial" }, ...quote.lines],
    };
    expect(planBasePriceVersion(moved)).toEqual(BASE_VERSION);
    expect(
      isQuoteStale(
        moved,
        {
          planKey: "pro",
          termMonths: 1,
          netRial: quote.totals.netRial,
          basePriceVersionId: BASE_VERSION.id,
          basePriceVersion: BASE_VERSION.version,
        },
        new Date(quote.issuedAt),
      ),
    ).toBe(false);
  });
});

describe("staleness", () => {
  const now = new Date("2026-01-31T10:05:00.000Z");

  it("is current while versions, term, total and expiry agree", () => {
    const quote = buildPlanQuote(request({ issuedAt: now.toISOString() }));
    expect(
      isQuoteStale(
        quote,
        {
          planKey: "pro",
          termMonths: 1,
          netRial: quote.totals.netRial,
          basePriceVersionId: BASE_VERSION.id,
          basePriceVersion: BASE_VERSION.version,
        },
        now,
      ),
    ).toBe(false);
  });

  it("is stale once the plan is re-priced", () => {
    const quote = buildPlanQuote(request({ issuedAt: now.toISOString() }));
    expect(
      isQuoteStale(
        quote,
        {
          planKey: "pro",
          termMonths: 1,
          netRial: quote.totals.netRial,
          basePriceVersionId: "pv-plan-2",
          basePriceVersion: 2,
        },
        now,
      ),
    ).toBe(true);
    // Same version id but a different priced total is equally stale.
    expect(
      isQuoteStale(
        quote,
        {
          planKey: "pro",
          termMonths: 1,
          netRial: quote.totals.netRial + 1,
          basePriceVersionId: BASE_VERSION.id,
          basePriceVersion: BASE_VERSION.version,
        },
        now,
      ),
    ).toBe(true);
  });

  it("is stale after its validity window", () => {
    const quote = buildPlanQuote(
      request({ issuedAt: now.toISOString(), validityMinutes: 15 }),
    );
    expect(
      isQuoteStale(
        quote,
        {
          planKey: "pro",
          termMonths: 1,
          netRial: quote.totals.netRial,
          basePriceVersionId: BASE_VERSION.id,
          basePriceVersion: BASE_VERSION.version,
        },
        // Issued 10:05, valid 15 minutes → stale one second after 10:20.
        new Date("2026-01-31T10:20:01.000Z"),
      ),
    ).toBe(true);
  });

});
