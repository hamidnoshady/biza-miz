/**
 * ESH-193 / #1378 — the canonical resolver's acceptance matrix, pure half.
 *
 * Every case here is a money rule, not an implementation detail: the three
 * commercial models, published/free/unpublished prices, inclusion and discount
 * precedence, allowance overage, provider cost, prepaid service coverage,
 * ambiguous overlap, staleness, the billing calendar and the lifecycle.
 */
import { describe, expect, it } from "vitest";
import {
  addCalendarMonths,
  monthWindow,
  monthWindowAt,
  periodMonthFor,
  wholeDaysBetween,
} from "./calendar";
import { benefitId, parseBenefitId, validateBenefitIdentity } from "./identities";
import {
  COMMERCIAL_MODEL_PRECEDENCE,
  chargeStaleness,
  pricedRial,
  resolveCommercialCharge,
  snapshotCharge,
  type ChargeRequest,
  type PlanBenefit,
  type PublishedPrice,
} from "./precedence";
import {
  activeTermAt,
  monthlyPeriodsIn,
  serviceTermPeriod,
  splitSegmentByCoverage,
  termStatusAt,
  termsOverlap,
  type PrepaidServiceTerm,
} from "./prepaid";
import { quotePlanTransition } from "./proration";
import {
  cancellationEffect,
  decideRenewal,
  reactivationPlan,
} from "./lifecycle";

const AT = "2026-11-20T10:00:00.000Z";
const MONTH = "2026-11";

function price(amount: number, unitSize = 1, version = 1): PublishedPrice {
  return {
    unitAmountRial: amount,
    unitSize,
    priceVersion: { id: `pv-${version}`, version },
  };
}

function serviceIdentity(
  kind: "setup_once" | "enabled_time",
  serviceKey = "accounting",
  capabilityKey = "services.activation",
) {
  return {
    kind,
    capabilityKey,
    service: { kind: "app" as const, key: serviceKey },
  };
}

function request(overrides: Partial<ChargeRequest> & Pick<ChargeRequest, "identity" | "quantity">): ChargeRequest {
  return {
    price: null,
    at: AT,
    policyVersion: 0,
    ...overrides,
  };
}

function benefit(
  identity: ReturnType<typeof serviceIdentity>,
  inclusion: PlanBenefit["inclusion"],
  extra: Partial<PlanBenefit> = {},
): PlanBenefit {
  return {
    benefitId: benefitId(identity),
    inclusion,
    approved: true,
    policyVersion: 1,
    ...extra,
  };
}

describe("benefit identity", () => {
  it("round-trips every kind without using a display label", () => {
    const ids = [
      benefitId({ kind: "setup_once", capabilityKey: "services.activation", service: { kind: "app", key: "crm" } }),
      benefitId({ kind: "enabled_time", capabilityKey: "services.activation", service: { kind: "agent", key: "sales-agent" } }),
      benefitId({ kind: "metered_usage", capabilityKey: "ai.chat", meterKey: "ai.credit" }),
      benefitId({ kind: "provider_cost", capabilityKey: "media.image_enhance", meterKey: "media.image_enhance" }),
      benefitId({ kind: "access", capabilityKey: "accounting.orders" }),
    ];
    for (const id of ids) expect(parseBenefitId(id), id).not.toBeNull();
    expect(parseBenefitId(ids[0]!)).toMatchObject({
      kind: "setup_once",
      capabilityKey: "services.activation",
      service: { kind: "app", key: "crm" },
    });
  });

  it("rejects a malformed identity instead of pricing it", () => {
    expect(parseBenefitId("setup crm")).toBeNull();
    expect(parseBenefitId("service:app/accounting")).toBeNull();
    expect(
      validateBenefitIdentity({ kind: "setup_once", capabilityKey: "services.activation" }),
    ).toBe("missing_target");
    expect(
      validateBenefitIdentity({ kind: "metered_usage", capabilityKey: "ai.chat" }),
    ).toBe("missing_target");
    expect(
      validateBenefitIdentity({
        kind: "access",
        capabilityKey: "accounting.orders",
        service: { kind: "app", key: "accounting" },
        meterKey: "ai.credit",
      }),
    ).toBe("ambiguous_target");
  });

  it("is stable across a rename: the id comes from the registry, not the label", () => {
    const a = benefitId({ kind: "metered_usage", capabilityKey: "growth.messaging.sms", meterKey: "messaging.sms_segment" });
    const b = benefitId({ kind: "metered_usage", capabilityKey: "growth.messaging.sms", meterKey: "messaging.sms_segment" });
    expect(a).toBe(b);
    expect(a).not.toContain("پیامک");
  });
});

describe("pricedRial", () => {
  it("prices whole units exactly and rounds up per unit", () => {
    expect(pricedRial(3, price(1_000))).toBe(3_000);
    expect(pricedRial(1, price(1_000, 3))).toBe(334);
    expect(pricedRial(1, price(1_000, 3), "floor")).toBe(333);
    expect(pricedRial(0, price(1_000))).toBe(0);
    expect(pricedRial(5, price(0))).toBe(0);
  });

  it("refuses an invalid quantity rather than rounding it", () => {
    expect(() => pricedRial(-1, price(100))).toThrow(/invalid_quantity/);
    expect(() => pricedRial(1, price(100, 0))).toThrow(/invalid_price/);
  });
});

describe("commercial models", () => {
  it("subscription-only: an approved inclusion zeroes the service tariff", () => {
    const identity = serviceIdentity("setup_once");
    const resolved = resolveCommercialCharge({
      model: "subscription",
      requests: [
        request({
          identity,
          quantity: 1,
          price: price(500_000),
          planBenefit: benefit(identity, "included"),
        }),
      ],
      walletBalanceRial: 10_000,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.totals.grossRial).toBe(500_000);
    expect(resolved.totals.inclusionRial).toBe(500_000);
    expect(resolved.totals.netRial).toBe(0);
    expect(resolved.walletRequirementRial).toBe(0);
    expect(resolved.lines[0]!.explanation.code).toBe("plan_included");
    expect(resolved.lines[0]!.activatesService).toBe(false);
  });

  it("PAYG: a published tariff is charged with no inclusion", () => {
    const resolved = resolveCommercialCharge({
      model: "payg",
      requests: [request({ identity: serviceIdentity("setup_once"), quantity: 1, price: price(500_000) })],
      walletBalanceRial: 900_000,
    });
    expect(resolved.totals.netRial).toBe(500_000);
    expect(resolved.shortfallRial).toBe(0);
    expect(resolved.lines[0]!.explanation.code).toBe("published_tariff");
  });

  it("hybrid: included setup, discounted rental and metered usage are distinct lines", () => {
    const setup = serviceIdentity("setup_once");
    const rental = serviceIdentity("enabled_time");
    const usage = {
      kind: "metered_usage" as const,
      capabilityKey: "ai.chat",
      meterKey: "ai.credit",
      unit: "rial",
    };
    const resolved = resolveCommercialCharge({
      model: "hybrid",
      requests: [
        request({ identity: setup, quantity: 1, price: price(400_000), planBenefit: benefit(setup, "included") }),
        request({
          identity: rental,
          quantity: 3_600,
          price: price(360_000, 3600),
          planBenefit: benefit(rental, "discounted", { discountBasisPoints: 2_000 }),
        }),
        request({
          identity: usage,
          quantity: 120_000,
          price: price(1),
          allowance: { includedQuantity: 100_000, usedQuantity: 0, overageEnabled: true, hardLimit: null, resetPeriod: "month" },
        }),
      ],
    });
    expect(resolved.ok).toBe(true);
    const [setupLine, rentalLine, usageLine] = resolved.lines;
    expect(setupLine!.netRial).toBe(0);
    expect(rentalLine!.grossRial).toBe(360_000);
    expect(rentalLine!.discountRial).toBe(72_000);
    expect(rentalLine!.netRial).toBe(288_000);
    expect(usageLine!.includedQuantity).toBe(100_000);
    expect(usageLine!.chargeableQuantity).toBe(20_000);
    expect(usageLine!.netRial).toBe(20_000);
    expect(usageLine!.explanation.code).toBe("allowance_overage");
    expect(resolved.totals.netRial).toBe(308_000);
  });
});

describe("price states", () => {
  it("distinguishes a published zero price (free) from a missing price (refused)", () => {
    const identity = serviceIdentity("setup_once");
    const free = resolveCommercialCharge({
      requests: [request({ identity, quantity: 1, price: price(0) })],
    });
    expect(free.ok).toBe(true);
    expect(free.lines[0]!.priceState).toBe("free");
    expect(free.lines[0]!.explanation.code).toBe("published_free");
    expect(free.totals.netRial).toBe(0);

    const missing = resolveCommercialCharge({
      requests: [request({ identity, quantity: 1, price: null })],
    });
    expect(missing.ok).toBe(false);
    expect(missing.refusals).toEqual([
      { benefitId: benefitId(identity), kind: "setup_once", code: "no_published_price" },
    ]);
    expect(missing.lines).toEqual([]);
  });

  it("an approved inclusion may make an unpublished service free, never a missing one", () => {
    const identity = serviceIdentity("setup_once");
    const resolved = resolveCommercialCharge({
      requests: [request({ identity, quantity: 1, price: null, planBenefit: benefit(identity, "included") })],
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.lines[0]!.netRial).toBe(0);
  });

  it("ignores an unapproved inclusion and charges the published tariff", () => {
    const identity = serviceIdentity("setup_once");
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 1,
          price: price(250_000),
          planBenefit: { ...benefit(identity, "included"), approved: false },
        }),
      ],
    });
    expect(resolved.totals.netRial).toBe(250_000);
    expect(resolved.lines[0]!.explanationNote?.code).toBe("unapproved_benefit_ignored");
  });

  it("ignores a plan row that names a different benefit identity", () => {
    const identity = serviceIdentity("setup_once");
    const other = serviceIdentity("enabled_time");
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 1,
          price: price(250_000),
          planBenefit: { ...benefit(other, "included") },
        }),
      ],
    });
    expect(resolved.totals.netRial).toBe(250_000);
    expect(resolved.lines[0]!.explanationNote?.code).toBe("benefit_identity_mismatch");
  });

  it("charges an included tariff only when the explicit policy permits it", () => {
    const identity = serviceIdentity("enabled_time");
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 3_600,
          price: price(100_000, 3600),
          planBenefit: benefit(identity, "included", { chargesTariffWhenIncluded: true }),
        }),
      ],
    });
    expect(resolved.totals.netRial).toBe(100_000);
    expect(resolved.lines[0]!.explanation.code).toBe("plan_included_tariff_permitted");
  });
});

describe("allowances", () => {
  const identity = {
    kind: "metered_usage" as const,
    capabilityKey: "growth.messaging.sms",
    meterKey: "messaging.sms_segment",
    unit: "segment",
  };

  it("charges nothing while the included quantity lasts", () => {
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 50,
          price: price(2_000),
          allowance: { includedQuantity: 100, usedQuantity: 0, overageEnabled: true, hardLimit: null, resetPeriod: "month" },
        }),
      ],
    });
    expect(resolved.totals.netRial).toBe(0);
    expect(resolved.lines[0]!.includedQuantity).toBe(50);
    expect(resolved.lines[0]!.explanation.code).toBe("allowance_included");
  });

  it("prices only the overage and records the allowance value", () => {
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 40,
          price: price(2_000),
          allowance: { includedQuantity: 100, usedQuantity: 90, overageEnabled: true, hardLimit: null, resetPeriod: "month" },
        }),
      ],
    });
    expect(resolved.lines[0]!.includedQuantity).toBe(10);
    expect(resolved.lines[0]!.chargeableQuantity).toBe(30);
    expect(resolved.lines[0]!.allowanceRial).toBe(20_000);
    expect(resolved.totals.netRial).toBe(60_000);
  });

  it("refuses overage when it is disabled or the hard limit is crossed", () => {
    const disabled = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 10,
          price: price(2_000),
          allowance: { includedQuantity: 5, usedQuantity: 5, overageEnabled: false, hardLimit: null, resetPeriod: "month" },
        }),
      ],
    });
    expect(disabled.refusals[0]!.code).toBe("overage_disabled");

    const capped = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 10,
          price: price(2_000),
          allowance: { includedQuantity: 5, usedQuantity: 100, overageEnabled: true, hardLimit: 105, resetPeriod: "month" },
        }),
      ],
    });
    expect(capped.refusals[0]!.code).toBe("allowance_hard_limit");
  });
});

describe("prepaid service coverage", () => {
  it("does not rent enabled time the paid term already covers", () => {
    const identity = serviceIdentity("enabled_time");
    const term: PrepaidServiceTerm = {
      termMonths: 3,
      periodStart: "2026-10-20T10:00:00.000Z",
      periodEnd: "2027-01-20T10:00:00.000Z",
      priceRial: 5_000_000,
      priceVersion: 2,
      status: "active",
    };
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 3_600,
          price: price(360_000, 3600),
          coverage: { start: term.periodStart, end: term.periodEnd },
        }),
      ],
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.lines[0]!.coveredByPrepaidTerm).toBe(true);
    expect(resolved.lines[0]!.explanation.code).toBe("prepaid_term_coverage");
    expect(resolved.totals.netRial).toBe(0);
  });

  it("does not treat coverage as a duplicate charge", () => {
    const identity = serviceIdentity("enabled_time");
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 3_600,
          price: price(360_000, 3600),
          coverage: { start: "2026-10-20T10:00:00.000Z", end: "2027-01-20T10:00:00.000Z" },
        }),
      ],
    });
    expect(resolved.refusals).toEqual([]);
  });

  it("applies an approved inclusion to a prepaid term purchase instead of charging the offer again", () => {
    const identity = serviceIdentity("enabled_time");
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 1,
          price: price(5_000_000),
          planBenefit: benefit(identity, "included"),
          mode: "prepaid_term",
          coverage: { start: AT, end: "2027-02-20T10:00:00.000Z" },
        }),
      ],
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.totals.netRial).toBe(0);
    expect(resolved.lines[0]!.explanation.code).toBe("plan_included");
  });

  it("charges a prepaid term at its published offer once when nothing includes it", () => {
    const identity = serviceIdentity("enabled_time");
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 1,
          price: price(5_000_000),
          mode: "prepaid_term",
          coverage: { start: AT, end: "2027-02-20T10:00:00.000Z" },
        }),
      ],
    });
    expect(resolved.totals.netRial).toBe(5_000_000);
    expect(resolved.lines[0]!.explanation.code).toBe("prepaid_term_purchase");
  });
});

describe("overlap rejection", () => {
  it("refuses the same benefit twice in the same period", () => {
    const identity = serviceIdentity("enabled_time");
    const resolved = resolveCommercialCharge({
      requests: [
        request({ identity, quantity: 3_600, price: price(100_000) }),
        request({ identity, quantity: 3_600, price: price(100_000) }),
      ],
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.refusals[0]!.code).toBe("ambiguous_overlap");
    expect(resolved.lines).toHaveLength(1);
  });

  it("allows the same setup benefit in a different period (a new month has no effect on 'once')", () => {
    const identity = serviceIdentity("setup_once");
    const resolved = resolveCommercialCharge({
      requests: [request({ identity, quantity: 1, price: price(10_000) })],
    });
    expect(resolved.lines[0]!.periodKey).toBe("once");
  });

  it("refuses a metered quantity and an overage view of the same meter", () => {
    const metered = { kind: "metered_usage" as const, capabilityKey: "ai.chat", meterKey: "ai.credit" };
    const overage = { kind: "allowance_overage" as const, capabilityKey: "ai.chat", meterKey: "ai.credit" };
    const resolved = resolveCommercialCharge({
      requests: [
        request({ identity: metered, quantity: 10, price: price(1) }),
        request({
          identity: overage,
          quantity: 10,
          price: price(1),
          allowance: { includedQuantity: 5, usedQuantity: 5, overageEnabled: true, hardLimit: null, resetPeriod: "month" },
        }),
      ],
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.refusals.some((r) => r.code === "incompatible_overlap")).toBe(true);
  });
});

describe("managed provider cost", () => {
  const identity = {
    kind: "provider_cost" as const,
    capabilityKey: "media.image_enhance",
    meterKey: "media.image_enhance",
  };

  it("absorbs the cost without charging the tenant", () => {
    const resolved = resolveCommercialCharge({
      requests: [
        request({
          identity,
          quantity: 1,
          price: null,
          providerCostRial: 40_000,
          providerCostPolicy: "absorbed",
        }),
      ],
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.totals.netRial).toBe(0);
    expect(resolved.lines[0]!.explanation.code).toBe("provider_cost_absorbed");
  });

  it("passes the published customer tariff through, and the cost when nothing is published", () => {
    const published = resolveCommercialCharge({
      requests: [
        request({ identity, quantity: 1, price: price(75_000), providerCostRial: 40_000, providerCostPolicy: "pass_through" }),
      ],
    });
    expect(published.totals.netRial).toBe(75_000);

    const costOnly = resolveCommercialCharge({
      requests: [
        request({ identity, quantity: 1, price: null, providerCostRial: 40_000, providerCostPolicy: "pass_through" }),
      ],
    });
    expect(costOnly.ok).toBe(true);
    expect(costOnly.totals.netRial).toBe(40_000);

    const unknown = resolveCommercialCharge({
      requests: [request({ identity, quantity: 1, price: null, providerCostRial: 0, providerCostPolicy: "pass_through" })],
    });
    expect(unknown.refusals[0]!.code).toBe("no_published_price");
  });
});

describe("staleness", () => {
  const identity = serviceIdentity("setup_once");
  const storedCharge = () =>
    resolveCommercialCharge({ requests: [request({ identity, quantity: 1, price: price(100_000) })] });

  it("stays payable when nothing moved", () => {
    const stored = snapshotCharge(storedCharge());
    expect(chargeStaleness(stored, storedCharge())).toBeNull();
  });

  it("refuses a changed price version, a changed amount, a changed policy and an expired quote", () => {
    const stored = snapshotCharge(storedCharge());
    expect(chargeStaleness(stored, storedCharge(), new Date(AT), "2026-11-20T09:00:00.000Z")).toBe("expired");

    const reversioned = resolveCommercialCharge({
      requests: [request({ identity, quantity: 1, price: price(100_000, 1, 2) })],
    });
    expect(chargeStaleness(stored, reversioned)).toBe("price_version_changed");

    const repriced = resolveCommercialCharge({
      requests: [request({ identity, quantity: 1, price: price(120_000) })],
    });
    expect(chargeStaleness(stored, repriced)).toBe("amount_changed");

    const repolicy = resolveCommercialCharge({
      requests: [request({ identity, quantity: 1, price: price(100_000), policyVersion: 2 })],
    });
    expect(chargeStaleness(stored, repolicy)).toBe("policy_version_changed");
  });

  it("documents the precedence as fixed order", () => {
    // Issue #1579: an authorized complimentary grant is explicit commercial
    // authority and is resolved before prepaid coverage or any plan benefit.
    expect(COMMERCIAL_MODEL_PRECEDENCE[0]).toBe("complimentary_grant_waiver");
    expect(COMMERCIAL_MODEL_PRECEDENCE[1]).toBe("prepaid_term_coverage");
    expect(COMMERCIAL_MODEL_PRECEDENCE.at(-1)).toBe("no_implicit_activation");
  });
});

describe("billing calendar", () => {
  it("clamps calendar months at a month end and a leap year", () => {
    expect(addCalendarMonths("2026-01-31T00:00:00.000Z", 1)).toBe("2026-02-28T00:00:00.000Z");
    expect(addCalendarMonths("2028-01-31T00:00:00.000Z", 1)).toBe("2028-02-29T00:00:00.000Z");
    expect(addCalendarMonths("2026-11-20T10:00:00.000Z", 12)).toBe("2027-11-20T10:00:00.000Z");
  });

  it("flips the period month at Tehran midnight, not UTC midnight", () => {
    expect(periodMonthFor(new Date("2026-11-20T20:29:59.000Z"))).toBe("2026-11");
    expect(periodMonthFor(new Date("2026-11-20T20:30:00.000Z"))).toBe("2026-11-21".slice(0, 7));
    // The local month boundary is 21:00Z on the last day (UTC+3:30).
    expect(periodMonthFor(new Date("2026-11-30T20:29:59.000Z"))).toBe("2026-11");
    expect(periodMonthFor(new Date("2026-11-30T20:30:00.000Z"))).toBe("2026-12");
  });

  it("returns an exact [start, next) window and a positive day count", () => {
    const window = monthWindow(new Date("2026-11-20T10:00:00.000Z"));
    expect(window.periodMonth).toBe("2026-11");
    expect(window.startUtc.toISOString()).toBe("2026-10-31T20:30:00.000Z");
    expect(window.nextStartUtc.toISOString()).toBe("2026-11-30T20:30:00.000Z");
    expect(monthWindowAt(AT).periodMonth).toBe(MONTH);
    expect(wholeDaysBetween("2026-11-01T00:00:00.000Z", "2026-11-11T00:00:00.000Z")).toBe(10);
  });
});

describe("prepaid terms", () => {
  it("buys exact calendar months from the start instant", () => {
    expect(serviceTermPeriod(AT, 1).end).toBe("2026-12-20T10:00:00.000Z");
    expect(serviceTermPeriod(AT, 3).end).toBe("2027-02-20T10:00:00.000Z");
  });

  it("derives expiry from the window so a missed job cannot extend coverage", () => {
    const term: PrepaidServiceTerm = {
      termMonths: 1,
      periodStart: AT,
      periodEnd: "2026-12-20T10:00:00.000Z",
      priceRial: 1_000_000,
      priceVersion: 1,
      status: "active",
    };
    expect(activeTermAt([term], AT)).not.toBeNull();
    expect(activeTermAt([term], "2026-12-20T10:00:00.000Z")).toBeNull();
    expect(termStatusAt(term, "2026-12-21T00:00:00.000Z")).toBe("expired");
  });

  it("splits a settlement segment into exactly the covered and uncovered seconds", () => {
    const coverage = { start: "2026-11-20T10:10:00.000Z", end: "2026-11-20T10:20:00.000Z" };
    const split = splitSegmentByCoverage(
      { start: "2026-11-20T10:00:00.000Z", end: "2026-11-20T10:30:00.000Z" },
      coverage,
    );
    expect(split.coveredSeconds).toBe(600);
    expect(split.uncoveredSeconds).toBe(1_200);
    expect(split.coveredRanges).toHaveLength(1);
    expect(split.uncoveredRanges).toHaveLength(2);
    expect(split.coveredSeconds + split.uncoveredSeconds).toBe(1_800);
  });

  it("resets a monthly allowance every month of a 12-month term, never up front", () => {
    const periods = monthlyPeriodsIn(AT, serviceTermPeriod(AT, 12).end);
    // A 12-month term that starts mid-month touches 13 calendar months: the
    // allowance is a calendar-month fact, exactly as it is outside a term. The
    // first and last are partial; nothing grants a year up front.
    expect(periods).toHaveLength(13);
    expect(periods[0]!.start).toBe(AT);
    expect(periods[0]!.end).toBe("2026-11-30T20:30:00.000Z");
    expect(periods.at(-1)!.end).toBe(serviceTermPeriod(AT, 12).end);
    expect(new Set(periods.map((p) => p.periodMonth)).size).toBe(13);
    const monthsOfCoverage = periods.reduce(
      (sum, p) => sum + (Date.parse(p.end) - Date.parse(p.start)),
      0,
    );
    expect(monthsOfCoverage).toBe(Date.parse(serviceTermPeriod(AT, 12).end) - Date.parse(AT));
  });

  it("detects overlapping paid terms", () => {
    expect(
      termsOverlap(
        { start: AT, end: "2027-02-20T10:00:00.000Z" },
        { start: "2027-01-20T10:00:00.000Z", end: "2027-04-20T10:00:00.000Z" },
      ),
    ).toBe(true);
    expect(
      termsOverlap(
        { start: AT, end: "2026-12-20T10:00:00.000Z" },
        { start: "2026-12-20T10:00:00.000Z", end: "2027-03-20T10:00:00.000Z" },
      ),
    ).toBe(false);
  });
});

describe("plan transitions", () => {
  const input = {
    kind: "upgrade" as const,
    at: "2026-11-10T00:00:00.000Z",
    current: {
      planKey: "basic",
      termMonths: 1,
      periodStart: "2026-11-01T00:00:00.000Z",
      periodEnd: "2026-12-01T00:00:00.000Z",
      paidRial: 3_000_000,
    },
    target: { planKey: "pro", monthlyPriceRial: 6_000_000 },
  };

  it("waits for the boundary under the neutral policy, with no overlap", () => {
    const quote = quotePlanTransition({ ...input, policy: "none" });
    expect(quote.ok).toBe(true);
    expect(quote.explanation).toBe("at_period_end");
    expect(quote.creditRial).toBe(0);
    expect(quote.effectiveAt).toBe(input.current.periodEnd);
    expect(quote.newPeriod.start).toBe(input.current.periodEnd);
    expect(Date.parse(quote.newPeriod.start)).toBeGreaterThanOrEqual(Date.parse(input.current.periodEnd));
  });

  it("credits only the unserved days under the daily policy and never reprices the past", () => {
    const quote = quotePlanTransition({ ...input, policy: "daily" });
    expect(quote.ok).toBe(true);
    expect(quote.explanation).toBe("immediate_prorated");
    expect(quote.remainingDays).toBe(21);
    expect(quote.periodDays).toBe(30);
    expect(quote.creditRial).toBe(2_100_000);
    expect(quote.chargeRial).toBe(4_200_000);
    expect(quote.netRial).toBe(2_100_000);
    expect(quote.newPeriod.start).toBe(input.at);
    expect(quote.newPeriod.end).toBe(input.current.periodEnd);
  });

  it("refuses a retroactive or same-plan transition", () => {
    expect(quotePlanTransition({ ...input, policy: "daily", at: "2026-10-01T00:00:00.000Z" }).refusal).toBe(
      "retroactive_transition",
    );
    expect(
      quotePlanTransition({ ...input, policy: "daily", target: { planKey: "basic", monthlyPriceRial: 3_000_000 } }).refusal,
    ).toBe("same_plan");
  });
});

describe("lifecycle", () => {
  const base = {
    status: "active" as const,
    termMonths: 3 as const,
    currentPeriodEnd: "2026-12-01T00:00:00.000Z",
    autoRenew: true,
    cancelAtPeriodEnd: false,
    renewalAmountRial: 9_000_000,
    walletBalanceRial: 10_000_000,
    graceEnd: "2026-12-08T00:00:00.000Z",
    now: "2026-12-01T00:00:00.000Z",
  };

  it("waits until the boundary before doing anything", () => {
    const decision = decideRenewal({ ...base, now: "2026-11-01T00:00:00.000Z" });
    expect(decision.code).toBe("not_due");
    expect(decision.termMonths).toBe(3);
  });

  it("never renews a cancelled term and keeps access to the paid boundary", () => {
    const decision = decideRenewal({ ...base, cancelAtPeriodEnd: true });
    expect(decision.code).toBe("cancel_at_period_end");
    expect(decision.accessUntil).toBe(base.currentPeriodEnd);
    expect(decision.amountRial).toBe(base.renewalAmountRial);
  });

  it("does not renew when auto-renew is off", () => {
    expect(decideRenewal({ ...base, autoRenew: false }).code).toBe("auto_renew_disabled");
  });

  it("renews the same term only", () => {
    const decision = decideRenewal(base);
    expect(decision.code).toBe("renew_same_term");
    expect(decision.termMonths).toBe(3);
    expect(decision.shortfallRial).toBe(0);
  });

  it("uses grace, then lapses — never a shorter term and never debt", () => {
    const inGrace = decideRenewal({ ...base, walletBalanceRial: 1_000 });
    expect(inGrace.code).toBe("grace_period");
    expect(inGrace.shortfallRial).toBe(8_999_000);
    expect(inGrace.termMonths).toBe(3);

    const lapsed = decideRenewal({
      ...base,
      walletBalanceRial: 1_000,
      now: "2026-12-09T00:00:00.000Z",
      status: "past_due",
    });
    expect(lapsed.code).toBe("lapse");
    expect(lapsed.termMonths).toBe(3);
  });

  it("preserves paid access on cancellation and starts reactivation in the future", () => {
    const effect = cancellationEffect({ currentPeriodEnd: base.currentPeriodEnd, now: base.now });
    expect(effect.accessUntil).toBe(base.currentPeriodEnd);
    expect(effect.nextChargeAt).toBeNull();

    const plan = reactivationPlan({
      now: "2026-12-05T00:00:00.000Z",
      prevPeriodEnd: base.currentPeriodEnd,
      termMonths: 3,
      lapsed: true,
    });
    expect(plan.periodStart).toBe("2026-12-05T00:00:00.000Z");
    expect(Date.parse(plan.periodStart)).toBeGreaterThanOrEqual(Date.parse("2026-12-05T00:00:00.000Z"));
    expect(plan.termMonths).toBe(3);
    expect(plan.closesLapsedPeriod).toBe(true);
  });
});
