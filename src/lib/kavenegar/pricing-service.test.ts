import { describe, expect, it, vi } from "vitest";
import {
  MIN_PROVIDER_TRANSFER_RIAL,
  NO_FUNDING,
  isFundingWindowOpen,
  planFunding,
  refillTriggerMessages,
  quoteSmsPrice,
  readMasterBalanceRial,
  roundToProviderMinimum,
  tariffBucketFor,
  type FundingPolicy,
  type ProviderTariff,
} from "./pricing-service";
import type { KavenegarManagementClient } from "./rest";

const tariff: ProviderTariff = {
  farsiRialPerSegment: 900,
  englishRialPerSegment: 2_070,
  pricingName: "wholesale-a",
  planId: 12,
};

const policy: FundingPolicy = {
  strategy: "jit",
  bufferMessages: 100,
  watermarkMessages: 0,
  windowStartHour: 0,
  windowEndHour: 0,
  globalDailyCapRial: null,
  childCapRial: 500_000,
  dailyCapRial: 200_000,
  masterFloorRial: 1_000_000,
  transactionalReserveRial: 0,
  fundingPurpose: "marketing",
};

describe("wholesale → retail quoting", () => {
  it("charges the retail rate per segment and reports the provider cost", () => {
    const quote = quoteSmsPrice({ body: "کد ورود 1234", retailRialPerSegment: 1_500, tariff });
    expect(quote.bucket).toBe("persian");
    expect(quote.segments).toBe(1);
    expect(quote.retailRial).toBe(1_500);
    expect(quote.wholesaleRial).toBe(900);
    expect(quote.marginRial).toBe(600);
    expect(quote.marginBps).toBe(4_000);
    expect(quote.belowCost).toBe(false);
  });

  it("prices a Latin-only body at the dearer English wholesale rate", () => {
    const quote = quoteSmsPrice({ body: "Your code is 1234", retailRialPerSegment: 1_500, tariff });
    expect(quote.bucket).toBe("english");
    expect(quote.wholesaleRial).toBe(2_070);
    // Retail is per segment regardless of script, so this is a loss.
    expect(quote.marginRial).toBe(-570);
    expect(quote.belowCost).toBe(true);
  });

  it("treats one non-Latin character as Persian — the provider's own rule", () => {
    expect(tariffBucketFor("hello ۱۲۳")).toBe("persian");
    expect(tariffBucketFor("hello 123")).toBe("english");
  });

  it("multiplies by the segment count the provider bills", () => {
    const body = "ا".repeat(140); // 70 first + 67 next ⇒ 3 segments
    const quote = quoteSmsPrice({ body, retailRialPerSegment: 1_000, tariff });
    expect(quote.segments).toBe(3);
    expect(quote.retailRial).toBe(3_000);
    expect(quote.wholesaleRial).toBe(2_700);
  });

  it("never invents a margin when the wholesale tariff is unknown", () => {
    const quote = quoteSmsPrice({
      body: "سلام",
      retailRialPerSegment: 1_000,
      tariff: { ...tariff, farsiRialPerSegment: null },
    });
    expect(quote.retailRial).toBe(1_000);
    expect(quote.wholesaleRial).toBeNull();
    expect(quote.marginRial).toBeNull();
    expect(quote.marginBps).toBeNull();
    expect(quote.belowCost).toBe(false);
  });
});

describe("JIT funding decision", () => {
  const base = {
    policy,
    tariff,
    childBalanceRial: 0,
    hourOfDay: 12,
    masterBalanceRial: 5_000_000,
    transferredTodayRial: 0,
    unresolvedTransferRial: 0,
  };

  it("funds the buffer, planning on the dearer English segment", () => {
    // No daily cap, so the target itself is what is transferred: 100 messages ×
    // 2,070 Rial, rounded down to a whole 1,000.
    const decision = planFunding({ ...base, policy: { ...policy, dailyCapRial: null } });
    expect(decision.action).toBe("transfer");
    expect(decision.action === "transfer" && decision.amountRial).toBe(207_000);
    expect(decision.targetBalanceRial).toBe(207_000);

    // With the 200,000 daily cap in force, the cap is what binds.
    const capped = planFunding(base);
    expect(capped.action === "transfer" && capped.amountRial).toBe(200_000);
  });

  it("does nothing when automatic funding is off", () => {
    const decision = planFunding({ ...base, policy: { ...policy, bufferMessages: 0 } });
    expect(decision).toMatchObject({ action: "none", reason: "automatic_top_up_off" });
  });

  it("does nothing while a transfer's outcome is unknown", () => {
    const decision = planFunding({ ...base, unresolvedTransferRial: 50_000 });
    expect(decision).toMatchObject({ action: "none", reason: "unresolved_transfer" });
  });

  it("refuses to guess without a tariff", () => {
    const decision = planFunding({
      ...base,
      tariff: { ...tariff, farsiRialPerSegment: null, englishRialPerSegment: null },
    });
    expect(decision).toMatchObject({ action: "none", reason: "tariff_unknown" });
  });

  it("is healthy when the child already holds the target", () => {
    const decision = planFunding({ ...base, childBalanceRial: 250_000 });
    expect(decision).toMatchObject({ action: "none", reason: "healthy" });
  });

  it("never exceeds the per-child ceiling", () => {
    const decision = planFunding({
      ...base,
      childBalanceRial: 400_000,
      hourOfDay: 12,
      policy: { ...policy, bufferMessages: 1_000, childCapRial: 450_000 },
    });
    expect(decision.action === "transfer" && decision.amountRial).toBe(50_000);
  });

  it("stops at the daily cap", () => {
    const decision = planFunding({
      ...base,
      transferredTodayRial: 195_000,
      hourOfDay: 12,
      policy: { ...policy, bufferMessages: 1_000, childCapRial: null },
    });
    expect(decision.action === "transfer" && decision.amountRial).toBe(5_000);
  });

  it("reports the daily cap when it is used up", () => {
    const decision = planFunding({
      ...base,
      transferredTodayRial: 200_000,
      hourOfDay: 12,
      policy: { ...policy, bufferMessages: 1_000 },
    });
    expect(decision).toMatchObject({ action: "none", reason: "daily_cap_reached" });
  });

  it("keeps the master floor", () => {
    const decision = planFunding({
      ...base,
      masterBalanceRial: 1_010_000,
      hourOfDay: 12,
      policy: { ...policy, bufferMessages: 1_000, childCapRial: null, dailyCapRial: null },
    });
    expect(decision.action === "transfer" && decision.amountRial).toBe(10_000);
  });

  it("refuses to fund through the floor when the master balance is unknown", () => {
    const decision = planFunding({ ...base, masterBalanceRial: null });
    expect(decision).toMatchObject({ action: "none", reason: "master_balance_unknown" });
    // ...and allows it when the operator has not asked for a floor.
    const noFloor = planFunding({
      ...base,
      masterBalanceRial: null,
      hourOfDay: 12,
      policy: { ...NO_FUNDING, bufferMessages: 10 },
    });
    expect(noFloor.action).toBe("transfer");
  });

  it("never asks the provider for less than its 1,000 Rial minimum", () => {
    const decision = planFunding({
      ...base,
      // Target 2,070,000; the shortfall is 500 Rial, below what the provider
      // will accept, so nothing is attempted this pass.
      childBalanceRial: 2_069_500,
      hourOfDay: 12,
      policy: { ...NO_FUNDING, bufferMessages: 1_000 },
    });
    expect(decision).toMatchObject({ action: "none", reason: "below_provider_minimum" });
    expect(roundToProviderMinimum(999)).toBe(0);
    expect(roundToProviderMinimum(1_999)).toBe(1_000);
    expect(MIN_PROVIDER_TRANSFER_RIAL).toBe(1_000);
  });

  it("does not claw credit back when the child holds more than the target", () => {
    const decision = planFunding({ ...base, childBalanceRial: 900_000 });
    expect(decision).toMatchObject({ action: "none", reason: "healthy" });
  });
});

describe("funding strategies (issue #902 §3)", () => {
  const funded = (overrides: Partial<FundingPolicy> = {}): FundingPolicy => ({
    ...policy,
    ...overrides,
  });
  const decide = (input: {
    policy: FundingPolicy;
    childBalanceRial: number;
    hourOfDay?: number;
    transferredTodayRial?: number;
    transferredTodayAllChildrenRial?: number;
    masterBalanceRial?: number | null;
  }) =>
    planFunding({
      policy: input.policy,
      tariff,
      childBalanceRial: input.childBalanceRial,
      hourOfDay: input.hourOfDay ?? 12,
      masterBalanceRial: input.masterBalanceRial === undefined ? 10_000_000 : input.masterBalanceRial,
      transferredTodayRial: input.transferredTodayRial ?? 0,
      transferredTodayAllChildrenRial: input.transferredTodayAllChildrenRial ?? 0,
      unresolvedTransferRial: 0,
    });

  it("jit tops up to the buffer as soon as the child is under it", () => {
    // Target 100 messages × the dearer segment (2,070) = 207,000.
    const decision = decide({ policy: funded(), childBalanceRial: 200_000 });
    expect(decision.action).toBe("transfer");
    // The child is only 7,000 short, and the provider minimum rounds it down.
    expect(decision.action === "transfer" && decision.amountRial).toBe(7_000);
  });

  it("low_watermark waits for the trigger, then refills to the whole buffer", () => {
    const strategy = funded({ strategy: "low_watermark", watermarkMessages: 20 });
    // 30 messages left: above the 20-message trigger ⇒ nothing to do, even
    // though the child is far below the 100-message target.
    expect(decide({ policy: strategy, childBalanceRial: 30 * 2_070 })).toMatchObject({
      action: "none",
      reason: "healthy",
    });
    // 10 messages left: below the trigger ⇒ refill all the way to the target.
    const refill = decide({ policy: strategy, childBalanceRial: 10 * 2_070 });
    expect(refill.action).toBe("transfer");
    // 90 messages × 2,070 = 186,300 → rounded DOWN to the provider's 1,000.
    expect(refill.action === "transfer" && refill.amountRial).toBe(186_000);
  });

  it("clamps a watermark that is at or above the target", () => {
    // A watermark of 0 or ≥ the buffer means plain JIT; it must never make the
    // platform fund above the buffer the operator chose.
    expect(refillTriggerMessages({ strategy: "low_watermark", bufferMessages: 100, watermarkMessages: 0 })).toBe(100);
    expect(refillTriggerMessages({ strategy: "low_watermark", bufferMessages: 100, watermarkMessages: 250 })).toBe(100);
    expect(refillTriggerMessages({ strategy: "low_watermark", bufferMessages: 100, watermarkMessages: 25 })).toBe(25);
    expect(refillTriggerMessages({ strategy: "jit", bufferMessages: 100, watermarkMessages: 25 })).toBe(100);
  });

  it("scheduled only funds inside its UTC window, including a window that wraps midnight", () => {
    const overnight = funded({ strategy: "scheduled", windowStartHour: 22, windowEndHour: 3 });
    expect(isFundingWindowOpen({ ...overnight, hourOfDay: 23 })).toBe(true);
    expect(isFundingWindowOpen({ ...overnight, hourOfDay: 2 })).toBe(true);
    expect(isFundingWindowOpen({ ...overnight, hourOfDay: 12 })).toBe(false);
    expect(decide({ policy: overnight, childBalanceRial: 0, hourOfDay: 12 })).toMatchObject({
      action: "none",
      reason: "outside_funding_window",
    });
    expect(decide({ policy: overnight, childBalanceRial: 0, hourOfDay: 23 }).action).toBe("transfer");

    // A window the operator never set is "always", not "never": a strategy
    // selected by accident must not silently stop funding the fleet.
    const unset = funded({ strategy: "scheduled", windowStartHour: 0, windowEndHour: 0 });
    expect(isFundingWindowOpen({ ...unset, hourOfDay: 5 })).toBe(true);
  });

  it("manual never plans a transfer, whatever the balance", () => {
    expect(decide({ policy: funded({ strategy: "manual" }), childBalanceRial: 0 })).toMatchObject({
      action: "none",
      reason: "automatic_top_up_off",
    });
  });

  it("the fleet-wide daily ceiling stops one tenant from draining the master", () => {
    const capped = funded({ globalDailyCapRial: 100_000 });
    // Room left today is 20,000; the child needs more, so only the room moves.
    const decision = decide({
      policy: capped,
      childBalanceRial: 0,
      transferredTodayAllChildrenRial: 80_000,
    });
    expect(decision.action === "transfer" && decision.amountRial).toBe(20_000);
    expect(
      decide({ policy: capped, childBalanceRial: 0, transferredTodayAllChildrenRial: 100_000 }),
    ).toMatchObject({ action: "none", reason: "global_daily_cap_reached" });
  });

  it("keeps the per-child cap and the master floor ahead of the new strategy rules", () => {
    const childCapped = funded({ childCapRial: 50_000 });
    expect(decide({ policy: childCapped, childBalanceRial: 0 }).action === "transfer").toBe(true);
    expect(decide({ policy: childCapped, childBalanceRial: 50_000 })).toMatchObject({
      action: "none",
      reason: "child_cap_reached",
    });
    expect(decide({ policy: funded(), childBalanceRial: 0, masterBalanceRial: 1_000_000 })).toMatchObject({
      action: "none",
      reason: "master_floor",
    });
  });
});

describe("the transactional reserve (issue #902 #3, DoD #9)", () => {
  const decide = (policy: FundingPolicy, masterBalanceRial: number | null) =>
    planFunding({
      policy,
      tariff,
      childBalanceRial: 0,
      hourOfDay: 12,
      masterBalanceRial,
      transferredTodayRial: 0,
      transferredTodayAllChildrenRial: 0,
      unresolvedTransferRial: 0,
    });
  // Floor 1,000,000 and reserve 500,000 of a 1,400,000 master: 400,000 is
  // spendable for marketing, 900,000 for transactional traffic.
  const reserved = (overrides: Partial<FundingPolicy> = {}): FundingPolicy => ({
    ...policy,
    strategy: "jit",
    bufferMessages: 100,
    childCapRial: null,
    dailyCapRial: null,
    masterFloorRial: 1_000_000,
    transactionalReserveRial: 500_000,
    fundingPurpose: "marketing",
    ...overrides,
  });

  it("clamps marketing to what the reserve leaves, not to the target", () => {
    // Master 1,600,000 − 1,000,000 floor = 600,000 spendable; the 500,000
    // reserve leaves 100,000 for marketing, which is less than the child's
    // 207,000 target — so the reserve, not the target, is what binds.
    const decision = decide(reserved(), 1_600_000);
    expect(decision.action).toBe("transfer");
    expect(decision.action === "transfer" && decision.amountRial).toBe(100_000);
  });

  it("stops marketing at the reserve with its own reason, because the money is not missing", () => {
    expect(decide(reserved(), 1_150_000)).toMatchObject({
      action: "none",
      reason: "transactional_reserve",
    });
  });

  it("lets transactional funding spend the same slice in full", () => {
    // Same master, same fleets: the target is reachable once the reserve is
    // this fleet's own money.
    expect(decide(reserved({ fundingPurpose: "transactional" }), 1_600_000)).toMatchObject({
      action: "transfer",
      amountRial: 207_000,
    });
  });

  it("keeps the floor itself ahead of the reserve", () => {
    // At or under the floor nothing is spendable by anyone: the reserve is a
    // slice above the floor, not a second floor.
    for (const fundingPurpose of ["marketing", "transactional"] as const) {
      expect(decide(reserved({ fundingPurpose }), 1_000_000)).toMatchObject({
        action: "none",
        reason: "master_floor",
      });
    }
  });

  it("is inert until an operator sets it, so a default fleet behaves exactly as before", () => {
    expect(decide(reserved({ transactionalReserveRial: 0 }), 1_150_000)).toMatchObject({
      action: "transfer",
      amountRial: 150_000,
    });
    // And an unknown master balance is still refused rather than funded blindly.
    expect(decide(reserved(), null)).toMatchObject({
      action: "none",
      reason: "master_balance_unknown",
    });
  });
});

describe("the master's balance comes from the provider (issue #902 §3, plan §9 item 4)", () => {
  function client(info: () => Promise<{ remainCreditRial: number | null }>) {
    return { fetchAccountInfo: info } as unknown as KavenegarManagementClient;
  }

  it("returns the figure the provider reports", async () => {
    expect(await readMasterBalanceRial(client(async () => ({ remainCreditRial: 4_200_000 })))).toBe(
      4_200_000,
    );
  });

  it("keeps a genuine zero a zero, which the floor then respects", async () => {
    expect(await readMasterBalanceRial(client(async () => ({ remainCreditRial: 0 })))).toBe(0);
  });

  it("turns a provider failure into 'unknown' rather than an exception", async () => {
    // A funding pass must not become an incident because the balance read
    // timed out. `null` already means something honest downstream: with a floor
    // configured the plan refuses to move money, and the pass raises
    // `master_balance_unknown` for the operator.
    const read = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await readMasterBalanceRial(
          client(async () => {
            throw new Error("provider: timeout");
          }),
        ),
      ).toBeNull();
      // Logged for the operator...
      expect(read).toHaveBeenCalled();
      // ...and the message is the reason, never a credential.
      expect(JSON.stringify(read.mock.calls)).not.toContain("MASTER");
    } finally {
      read.mockRestore();
    }
  });
});

describe("an approved campaign is a funding trigger of its own (issue #902 §9 item 1)", () => {
  const base = {
    policy: { ...policy, childCapRial: null, dailyCapRial: null },
    tariff,
    childBalanceRial: 0,
    hourOfDay: 12,
    masterBalanceRial: 50_000_000,
    transferredTodayRial: 0,
    unresolvedTransferRial: 0,
  };

  it("raises the target above the standing buffer when the queue is bigger than it", () => {
    // The buffer asks for 100 messages ≈ 207,000 Rial. A 500-recipient campaign
    // owes 500 × 2,070 = 1,035,000. The standing order would fund a fifth of it
    // and the tail would die on the provider's credit error.
    const decision = planFunding({ ...base, pendingDemandRial: 1_035_000 });
    expect(decision).toMatchObject({
      action: "transfer",
      amountRial: 1_035_000,
      reason: "campaign_demand",
      targetBalanceRial: 1_035_000,
    });
  });

  it("triggers even when the balance already satisfies the buffer", () => {
    // 250,000 is comfortably above the 207,000 buffer, and still not enough for
    // the queued campaign. Before this trigger the child was "healthy" here.
    const withQueue = planFunding({
      ...base,
      childBalanceRial: 250_000,
      pendingDemandRial: 1_035_000,
    });
    expect(withQueue.action).toBe("transfer");
    expect(withQueue.action === "transfer" && withQueue.amountRial).toBe(785_000);

    expect(planFunding({ ...base, childBalanceRial: 250_000 })).toMatchObject({
      action: "none",
      reason: "healthy",
    });
  });

  it("keeps the buffer in charge once the queue is smaller than it", () => {
    // Demand below the buffer must not shrink the target: a small campaign is
    // not a reason to let the standing order lapse.
    const decision = planFunding({ ...base, pendingDemandRial: 20_700 });
    expect(decision).toMatchObject({
      action: "transfer",
      amountRial: 207_000,
      reason: "top_up",
      targetBalanceRial: 207_000,
    });
  });

  it("still respects caps, the floor and the reserve — demand is not a bypass", () => {
    // The campaign wants 1,035,000, the per-child ceiling allows 300,000.
    expect(
      planFunding({
        ...base,
        policy: { ...policy, childCapRial: 300_000, dailyCapRial: null },
        pendingDemandRial: 1_035_000,
      }),
    ).toMatchObject({ action: "transfer", amountRial: 300_000 });

    // The master has 1,500,000 with a 1,000,000 floor: 500,000 is spendable.
    expect(
      planFunding({ ...base, masterBalanceRial: 1_500_000, pendingDemandRial: 1_035_000 }),
    ).toMatchObject({ action: "transfer", amountRial: 500_000 });

    // A marketing fleet may not spend the 400,000 held for transactional traffic.
    expect(
      planFunding({
        ...base,
        policy: { ...policy, childCapRial: null, dailyCapRial: null, transactionalReserveRial: 400_000 },
        masterBalanceRial: 1_500_000,
        pendingDemandRial: 1_035_000,
      }),
    ).toMatchObject({ action: "transfer", amountRial: 100_000 });
  });

  it("moves low_watermark's trigger to the queue, so a draining campaign is not paced", () => {
    // A watermark of 50 messages would normally wait until the child fell below
    // ~103,500 Rial. A queued campaign makes that wait dangerous, so the trigger
    // rises to the demand while the target does too.
    const strategy = { ...policy, strategy: "low_watermark" as const, watermarkMessages: 50 };

    const idle = planFunding({ ...base, policy: strategy, childBalanceRial: 150_000 });
    expect(idle).toMatchObject({ action: "none", reason: "healthy" });

    const draining = planFunding({
      ...base,
      policy: strategy,
      childBalanceRial: 150_000,
      pendingDemandRial: 1_035_000,
    });
    expect(draining).toMatchObject({ action: "transfer", reason: "campaign_demand" });

    // And above demand it is still healthy — the queue is a floor on the
    // trigger, not an instruction to fund forever.
    expect(
      planFunding({
        ...base,
        policy: strategy,
        childBalanceRial: 1_200_000,
        pendingDemandRial: 1_035_000,
      }),
    ).toMatchObject({ action: "none", reason: "healthy" });
  });
});
