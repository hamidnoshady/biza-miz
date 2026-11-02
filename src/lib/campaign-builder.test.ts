import { describe, expect, it } from "vitest";
import {
  EXCLUSION_REASONS,
  formatPercentBps,
  parseCampaignDefinition,
  rewardForSale,
  simulateCampaign,
  summarizeCampaign,
  type CampaignDefinition,
  type SimulationSale,
} from "./campaign-builder";

const valid = {
  trigger: { type: "pos_sale_settled", minNetPaidRial: 10_000_000, locationIds: null },
  reward: { type: "cashback", mode: "percent", percentBps: 500, basis: "net_paid", maxPerOrderRial: 1_000_000, holdDays: 7 },
  limits: { totalBudgetRial: 5_000_000, perCustomerCapRial: null },
};

function definition(patch: { trigger?: object; reward?: object; limits?: object } = {}): CampaignDefinition {
  const parsed = parseCampaignDefinition({
    trigger: { ...valid.trigger, ...patch.trigger },
    reward: { ...valid.reward, ...patch.reward },
    limits: { ...valid.limits, ...patch.limits },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.definition;
}

function sale(id: string, patch: Partial<SimulationSale> = {}): SimulationSale {
  return {
    orderId: id,
    locationId: "loc-1",
    customerId: "cust-1",
    status: "completed",
    closedAt: "2026-10-01T10:00:00.000Z",
    totalRial: 20_000_000,
    taxRial: 0,
    netPaidRial: 20_000_000,
    ...patch,
  };
}

const NOW = new Date("2026-10-20T00:00:00.000Z");

describe("parseCampaignDefinition", () => {
  it("accepts a valid percent cashback campaign and normalises optional fields to null", () => {
    const parsed = parseCampaignDefinition({
      trigger: { type: "pos_sale_settled", minNetPaidRial: 0 },
      reward: { type: "cashback", mode: "percent", percentBps: 500, basis: "net_paid", holdDays: 0 },
      limits: { totalBudgetRial: 1 },
    });
    expect(parsed).toEqual({
      ok: true,
      definition: {
        trigger: { type: "pos_sale_settled", minNetPaidRial: 0, locationIds: null },
        reward: { type: "cashback", mode: "percent", percentBps: 500, basis: "net_paid", maxPerOrderRial: null, holdDays: 0 },
        limits: { totalBudgetRial: 1, perCustomerCapRial: null },
      },
    });
  });

  it("de-duplicates and sorts the branch list so equal campaigns have equal documents", () => {
    const d = definition({ trigger: { locationIds: ["b", "a", "b"] } });
    expect(d.trigger.locationIds).toEqual(["a", "b"]);
  });

  it("rejects anything that is not an object, naming a single document-level problem", () => {
    for (const input of [null, undefined, "x", 4, []]) {
      const parsed = parseCampaignDefinition(input);
      expect(parsed.ok).toBe(false);
    }
  });

  it("reports every problem at once, each with its path", () => {
    const parsed = parseCampaignDefinition({
      trigger: { type: "pos_sale_settled", minNetPaidRial: -1, locationIds: [] },
      reward: { type: "cashback", mode: "percent", percentBps: 0, basis: "gross", holdDays: 400 },
      limits: { totalBudgetRial: 0 },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const paths = parsed.problems.map((p) => p.path).sort();
    expect(paths).toEqual([
      "limits.totalBudgetRial",
      "reward.basis",
      "reward.holdDays",
      "reward.percentBps",
      "trigger.locationIds",
      "trigger.minNetPaidRial",
    ]);
  });

  it("refuses a trigger or reward type this slice does not support", () => {
    const trigger = parseCampaignDefinition({ ...valid, trigger: { type: "birthday" } });
    const reward = parseCampaignDefinition({ ...valid, reward: { type: "points" } });
    expect(trigger.ok === false && trigger.problems[0].code).toBe("trigger_unsupported");
    expect(reward.ok === false && reward.problems[0].code).toBe("reward_unsupported");
  });

  it("rejects unknown fields instead of storing a free-form tail", () => {
    const parsed = parseCampaignDefinition({ ...valid, script: "x", reward: { ...valid.reward, note: "y" } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.map((p) => p.code)).toEqual(["unknown_field", "unknown_field"]);
  });

  it("requires a hard budget — no budget is not an unlimited budget", () => {
    const parsed = parseCampaignDefinition({ ...valid, limits: {} });
    expect(parsed.ok === false && parsed.problems.map((p) => p.code)).toEqual(["budget_required"]);
  });

  it("rejects non-integer and unsafe money rather than rounding it", () => {
    for (const bad of [1.5, Number.MAX_SAFE_INTEGER + 1, "100", NaN]) {
      expect(parseCampaignDefinition({ ...valid, limits: { totalBudgetRial: bad } }).ok).toBe(false);
    }
  });

  it("rejects a campaign that can never pay", () => {
    const fixed = { type: "cashback", mode: "fixed", fixedRial: 600_000, basis: "net_paid", maxPerOrderRial: null, holdDays: 0 };
    const overBudget = parseCampaignDefinition({ ...valid, reward: fixed, limits: { totalBudgetRial: 500_000 } });
    expect(overBudget.ok === false && overBudget.problems.map((p) => p.code)).toEqual(["reward_exceeds_budget"]);

    const overCap = parseCampaignDefinition({ ...valid, reward: fixed, limits: { totalBudgetRial: 5_000_000, perCustomerCapRial: 500_000 } });
    expect(overCap.ok === false && overCap.problems.map((p) => p.code)).toEqual(["reward_exceeds_customer_cap"]);

    const capBelowFixed = parseCampaignDefinition({ ...valid, reward: { ...fixed, maxPerOrderRial: 100_000 } });
    expect(capBelowFixed.ok === false && capBelowFixed.problems.map((p) => p.code)).toEqual(["max_below_fixed"]);
  });

  it("keeps the mode's own field and refuses the other mode's", () => {
    const parsed = parseCampaignDefinition({ ...valid, reward: { ...valid.reward, fixedRial: 5 } });
    expect(parsed.ok === false && parsed.problems.map((p) => p.path)).toEqual(["reward.fixedRial"]);
  });
});

describe("summarizeCampaign", () => {
  const fmt = (rial: number) => `${rial} ریال`;

  it("states trigger, reward, hold and limits in words using the caller's money formatter", () => {
    const lines = summarizeCampaign(definition({ limits: { perCustomerCapRial: 2_000_000 } }), fmt);
    expect(lines).toEqual([
      "وقتی فروشی در صندوق تسویه شود و مبلغ خالص پرداخت‌شده‌اش دست‌کم 10000000 ریال باشد (در همهٔ شعبه‌ها)",
      "۵ درصد از مبلغ خالص پرداخت‌شده به‌عنوان بازگشت وجه برای مشتری ذخیره می‌شود",
      "پاداش هر سفارش حداکثر 1000000 ریال است",
      "پاداش پس از ۷ روز نگهداری (مهلت مرجوعی) قابل استفاده می‌شود",
      "بودجهٔ کل کمپین 5000000 ریال است و با تمام‌شدنش پاداش جدیدی صادر نمی‌شود",
      "هر مشتری در مجموع حداکثر 2000000 ریال پاداش می‌گیرد",
    ]);
  });

  it("omits the minimum and the per-order cap when there are none, and says when the reward is immediate", () => {
    const lines = summarizeCampaign(
      definition({ trigger: { minNetPaidRial: 0, locationIds: ["a"] }, reward: { maxPerOrderRial: null, holdDays: 0 } }),
      fmt,
    );
    expect(lines[0]).toBe("وقتی فروشی در صندوق تسویه شود (در ۱ شعبهٔ انتخاب‌شده)");
    expect(lines).toContain("پاداش بلافاصله قابل استفاده است");
    expect(lines.some((line) => line.includes("حداکثر") && line.includes("سفارش"))).toBe(false);
  });

  it("formats fractional percentages", () => {
    expect(formatPercentBps(500)).toBe("۵");
    expect(formatPercentBps(250)).toBe("۲٫۵");
    expect(formatPercentBps(1)).toBe("۰٫۰۱");
  });
});

describe("rewardForSale", () => {
  const percent = definition().reward;

  it("floors a percentage in integer arithmetic", () => {
    expect(rewardForSale(definition({ reward: { percentBps: 333, maxPerOrderRial: null } }).reward, sale("a", { netPaidRial: 10_001, totalRial: 10_001 }))).toBe(333);
  });

  it("applies the per-order ceiling", () => {
    expect(rewardForSale(percent, sale("a", { netPaidRial: 100_000_000, totalRial: 100_000_000 }))).toBe(1_000_000);
  });

  it("removes the tax share of what was paid when the basis excludes tax", () => {
    const reward = definition({ reward: { basis: "net_paid_excl_tax", percentBps: 1000, maxPerOrderRial: null } }).reward;
    // 10 % tax inside 11 000 000: a fully paid sale has 1 000 000 of tax.
    expect(rewardForSale(reward, sale("a", { totalRial: 11_000_000, taxRial: 1_000_000, netPaidRial: 11_000_000 }))).toBe(1_000_000);
    // Half paid: half the tax comes off, 5 500 000 - 500 000 = 5 000 000 → 10 %.
    expect(rewardForSale(reward, sale("a", { totalRial: 11_000_000, taxRial: 1_000_000, netPaidRial: 5_500_000 }))).toBe(500_000);
  });

  it("never goes negative or above the paid amount when payments exceed the total", () => {
    const reward = definition({ reward: { basis: "net_paid_excl_tax", percentBps: 10_000, maxPerOrderRial: null } }).reward;
    expect(rewardForSale(reward, sale("a", { totalRial: 1_000, taxRial: 100, netPaidRial: 5_000 }))).toBe(4_900);
  });

  it("is exact beyond double precision", () => {
    const reward = definition({ reward: { percentBps: 10_000, maxPerOrderRial: null }, limits: { totalBudgetRial: Number.MAX_SAFE_INTEGER } }).reward;
    expect(rewardForSale(reward, sale("a", { netPaidRial: Number.MAX_SAFE_INTEGER, totalRial: Number.MAX_SAFE_INTEGER }))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("simulateCampaign", () => {
  it("is a dry run by construction", () => {
    const result = simulateCampaign(definition(), [sale("a")], NOW);
    expect(result.dryRun).toBe(true);
    expect(result.ledgerEffect).toBe("none");
  });

  it("rewards a settled sale exactly once and reports the exposure", () => {
    const result = simulateCampaign(definition(), [sale("a")], NOW);
    expect(result).toMatchObject({
      salesConsidered: 1,
      rewardedSales: 1,
      rewardedCustomers: 1,
      exposureRial: 1_000_000,
      budgetRemainingRial: 4_000_000,
      largestRewardRial: 1_000_000,
    });
    expect(result.outcomes).toEqual([
      { orderId: "a", closedAt: "2026-10-01T10:00:00.000Z", rewardRial: 1_000_000, reason: null, clippedByCustomerCap: false },
    ]);
  });

  it("names why each non-qualifying sale earned nothing", () => {
    const result = simulateCampaign(
      definition({ trigger: { locationIds: ["loc-1"] } }),
      [
        sale("voided", { status: "voided" }),
        sale("open", { status: "other" }),
        sale("elsewhere", { locationId: "loc-2" }),
        sale("anon", { customerId: null }),
        sale("unpaid", { netPaidRial: 0 }),
        sale("refunded", { netPaidRial: -500 }),
        sale("small", { totalRial: 9_999_999, netPaidRial: 9_999_999 }),
        sale("ok"),
      ],
      NOW,
    );
    const reasons = Object.fromEntries(result.outcomes.map((o) => [o.orderId, o.reason]));
    expect(reasons).toEqual({
      voided: "voided",
      open: "not_completed",
      elsewhere: "out_of_scope_branch",
      anon: "no_customer",
      unpaid: "not_settled",
      refunded: "not_settled",
      small: "below_minimum",
      ok: null,
    });
    expect(result.excluded.voided).toBe(1);
    expect(result.rewardedSales).toBe(1);
    expect(Object.keys(result.excluded).sort()).toEqual([...EXCLUSION_REASONS].sort());
  });

  it("reports a sale whose reward rounds to zero as no_reward", () => {
    const result = simulateCampaign(
      definition({ trigger: { minNetPaidRial: 0 }, reward: { percentBps: 1 } }),
      [sale("tiny", { totalRial: 100, netPaidRial: 100 })],
      NOW,
    );
    expect(result.outcomes[0].reason).toBe("no_reward");
  });

  it("blocks a reward that does not fit the remaining budget whole, and lets a smaller one still fit", () => {
    const d = definition({ reward: { maxPerOrderRial: null }, limits: { totalBudgetRial: 1_500_000 } });
    const result = simulateCampaign(
      d,
      [
        sale("a", { closedAt: "2026-10-01T00:00:00.000Z", customerId: "c1" }), // 1 000 000
        sale("b", { closedAt: "2026-10-02T00:00:00.000Z", customerId: "c2" }), // 1 000 000 > 500 000 left
        sale("c", { closedAt: "2026-10-03T00:00:00.000Z", customerId: "c3", totalRial: 10_000_000, netPaidRial: 10_000_000 }), // 500 000 fits exactly
      ],
      NOW,
    );
    expect(result.outcomes.map((o) => [o.orderId, o.rewardRial, o.reason])).toEqual([
      ["a", 1_000_000, null],
      ["b", 0, "budget_exhausted"],
      ["c", 500_000, null],
    ]);
    expect(result.budgetExhaustedAtOrderId).toBe("b");
    expect(result.exposureRial).toBe(1_500_000);
    expect(result.budgetRemainingRial).toBe(0);
  });

  it("spends the budget oldest sale first regardless of input order", () => {
    const d = definition({ limits: { totalBudgetRial: 1_000_000 } });
    const result = simulateCampaign(
      d,
      [sale("late", { closedAt: "2026-10-05T00:00:00.000Z" }), sale("early", { closedAt: "2026-10-01T00:00:00.000Z", customerId: "c2" })],
      NOW,
    );
    expect(result.outcomes.map((o) => o.orderId)).toEqual(["early", "late"]);
    expect(result.outcomes[1].reason).toBe("budget_exhausted");
  });

  it("clips at the per-customer cap and then turns that customer away", () => {
    const d = definition({ limits: { perCustomerCapRial: 1_500_000 } });
    const result = simulateCampaign(
      d,
      [
        sale("a", { closedAt: "2026-10-01T00:00:00.000Z" }),
        sale("b", { closedAt: "2026-10-02T00:00:00.000Z" }),
        sale("c", { closedAt: "2026-10-03T00:00:00.000Z" }),
        sale("other", { closedAt: "2026-10-04T00:00:00.000Z", customerId: "c2" }),
      ],
      NOW,
    );
    expect(result.outcomes.map((o) => [o.orderId, o.rewardRial, o.reason, o.clippedByCustomerCap])).toEqual([
      ["a", 1_000_000, null, false],
      ["b", 500_000, null, true],
      ["c", 0, "customer_cap_reached", false],
      ["other", 1_000_000, null, false],
    ]);
    expect(result.rewardedCustomers).toBe(2);
  });

  it("splits exposure into available and pending by the return hold", () => {
    const result = simulateCampaign(
      definition({ reward: { holdDays: 7 } }),
      [
        sale("old", { closedAt: "2026-10-01T00:00:00.000Z", customerId: "c1" }),
        sale("recent", { closedAt: "2026-10-18T00:00:00.000Z", customerId: "c2" }),
      ],
      NOW,
    );
    expect(result.availableRial).toBe(1_000_000);
    expect(result.pendingRial).toBe(1_000_000);
    expect(result.availableRial + result.pendingRial).toBe(result.exposureRial);
  });

  it("never lets total exposure exceed the budget", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      sale(`o${String(i).padStart(2, "0")}`, { customerId: `c${i}`, closedAt: `2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z` }),
    );
    const result = simulateCampaign(definition(), many, NOW);
    expect(result.exposureRial).toBeLessThanOrEqual(result.budgetRial);
    expect(result.rewardedSales).toBe(5);
    expect(result.excluded.budget_exhausted).toBe(45);
  });

  it("returns an empty, well-formed result for no sales", () => {
    const result = simulateCampaign(definition(), [], NOW);
    expect(result).toMatchObject({ salesConsidered: 0, exposureRial: 0, budgetRemainingRial: 5_000_000, budgetExhaustedAtOrderId: null });
  });
});
