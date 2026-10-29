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
