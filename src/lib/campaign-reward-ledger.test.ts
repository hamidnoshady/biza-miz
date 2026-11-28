import { describe, expect, it } from "vitest";
import {
  budgetAllows,
  clipToCustomerCap,
  deriveRewardStatus,
  pendingRial,
  planRedemption,
  planTenderRestore,
  remainingRial,
  restorableTenderRial,
  spendableRial,
  type RewardPosition,
} from "./campaign-reward-ledger";

const NOW = new Date("2026-11-27T10:00:00.000Z");

function position(patch: Partial<RewardPosition> = {}): RewardPosition {
  return {
    earnedRial: 100_000,
    redeemedRial: 0,
    reversedRial: 0,
    expiredRial: 0,
    unrecoveredRial: 0,
    availableAt: "2026-11-20T00:00:00.000Z",
    expiresAt: "2027-05-20T00:00:00.000Z",
    ...patch,
  };
}

describe("remaining and spendable", () => {
  it("subtracts every way value leaves a position", () => {
    expect(remainingRial(position({ redeemedRial: 10_000, reversedRial: 5_000, expiredRial: 1_000 }))).toBe(84_000);
  });

  it("never goes negative even when the rows disagree", () => {
    expect(remainingRial(position({ redeemedRial: 200_000 }))).toBe(0);
  });

  it("treats a held reward as a promise, not money", () => {
    const held = position({ availableAt: "2026-12-01T00:00:00.000Z" });
    expect(remainingRial(held)).toBe(100_000);
    expect(spendableRial(held, NOW)).toBe(0);
    expect(pendingRial(held, NOW)).toBe(100_000);
  });

  it("stops counting value whose validity ended", () => {
    const lapsed = position({ expiresAt: "2026-11-01T00:00:00.000Z" });
    expect(spendableRial(lapsed, NOW)).toBe(0);
  });
});

describe("deriveRewardStatus", () => {
  it("is pending before the hold and available after it", () => {
    expect(deriveRewardStatus(position({ availableAt: "2026-12-01T00:00:00.000Z" }), NOW)).toBe("pending");
    expect(deriveRewardStatus(position(), NOW)).toBe("available");
  });

  it("is partially_redeemed once some value was spent", () => {
    expect(deriveRewardStatus(position({ redeemedRial: 10_000 }), NOW)).toBe("partially_redeemed");
  });

  it("distinguishes a fully redeemed position from a reversed one", () => {
    expect(deriveRewardStatus(position({ redeemedRial: 100_000 }), NOW)).toBe("redeemed");
    expect(deriveRewardStatus(position({ reversedRial: 100_000 }), NOW)).toBe("reversed");
    expect(deriveRewardStatus(position({ expiredRial: 100_000 }), NOW)).toBe("expired");
  });

  it("reports expiry when a remaining balance is past its window", () => {
    expect(deriveRewardStatus(position({ expiresAt: "2026-11-01T00:00:00.000Z" }), NOW)).toBe("expired");
  });
});

describe("planRedemption", () => {
  const lot = (id: string, patch: Partial<RewardPosition> = {}) => ({ entitlementId: id, ...position(patch) });

  it("spends the soonest-expiring reward first", () => {
    const result = planRedemption(
      [
        lot("late", { earnedRial: 50_000, expiresAt: "2027-06-01T00:00:00.000Z" }),
        lot("early", { earnedRial: 50_000, expiresAt: "2027-01-01T00:00:00.000Z" }),
      ],
      60_000,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.allocations).toEqual([
      { entitlementId: "early", amountRial: 50_000 },
      { entitlementId: "late", amountRial: 10_000 },
    ]);
    expect(result.plan.leftoverRial).toBe(40_000);
  });

  it("refuses when the spendable balance is short, and says how much there was", () => {
    const result = planRedemption([lot("a", { earnedRial: 20_000 })], 25_000, NOW);
    expect(result).toEqual({ ok: false, reason: "insufficient", availableRial: 20_000 });
  });

  it("ignores held and expired positions when covering a payout", () => {
    const result = planRedemption(
      [
        lot("held", { availableAt: "2026-12-01T00:00:00.000Z" }),
        lot("expired", { expiresAt: "2026-11-01T00:00:00.000Z" }),
        lot("live", { earnedRial: 30_000 }),
      ],
      30_000,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.allocations).toEqual([{ entitlementId: "live", amountRial: 30_000 }]);
  });

  it("rejects a non-positive or non-integer amount", () => {
    expect(planRedemption([lot("a")], 0, NOW)).toMatchObject({ ok: false, reason: "invalid_amount" });
    expect(planRedemption([lot("a")], 1.5, NOW)).toMatchObject({ ok: false, reason: "invalid_amount" });
  });
});

describe("restoring a till tender after a refund", () => {
  it("never gives back more reward than the bill was refunded or than it spent", () => {
    expect(restorableTenderRial(50_000, 20_000)).toBe(20_000);
    expect(restorableTenderRial(50_000, 80_000)).toBe(50_000);
    expect(restorableTenderRial(50_000, 0)).toBe(0);
    // A row that disagrees with itself must not produce negative value.
    expect(restorableTenderRial(-1, 10)).toBe(0);
    expect(restorableTenderRial(10, -5)).toBe(0);
  });

  it("returns value to the longest-lived lots first", () => {
    // Spending was soonest-expiry-first, so the restore walks the other way.
    const plan = planTenderRestore(
      [
        { entitlementId: "soon", amountRial: 10_000 },
        { entitlementId: "later", amountRial: 20_000 },
        { entitlementId: "latest", amountRial: 5_000 },
      ],
      12_000,
    );
    expect(plan).toEqual([
      { entitlementId: "latest", amountRial: 5_000 },
      { entitlementId: "later", amountRial: 7_000 },
    ]);
  });

  it("cannot restore more than the lots gave, and stops when covered", () => {
    const consumed = [{ entitlementId: "only", amountRial: 4_000 }];
    expect(planTenderRestore(consumed, 9_000)).toEqual([{ entitlementId: "only", amountRial: 4_000 }]);
    expect(planTenderRestore(consumed, 0)).toEqual([]);
    expect(planTenderRestore([], 1_000)).toEqual([]);
  });
});

describe("budget and cap", () => {
  it("refuses a reward that does not fit the budget whole", () => {
    expect(budgetAllows(900_000, 1_000_000, 100_000)).toBe(true);
    expect(budgetAllows(950_000, 1_000_000, 100_000)).toBe(false);
  });

  it("clips a reward to the customer's remaining cap", () => {
    expect(clipToCustomerCap(200_000, 170_000, 50_000)).toBe(30_000);
    expect(clipToCustomerCap(200_000, 200_000, 50_000)).toBe(0);
    expect(clipToCustomerCap(null, 999_999, 50_000)).toBe(50_000);
  });
});
