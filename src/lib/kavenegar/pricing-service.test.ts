import { describe, expect, it } from "vitest";
import {
  MIN_PROVIDER_TRANSFER_RIAL,
  NO_FUNDING,
  planFunding,
  quoteSmsPrice,
  roundToProviderMinimum,
  tariffBucketFor,
  type FundingPolicy,
  type ProviderTariff,
} from "./pricing-service";

const tariff: ProviderTariff = {
  farsiRialPerSegment: 900,
  englishRialPerSegment: 2_070,
  pricingName: "wholesale-a",
  planId: 12,
};

const policy: FundingPolicy = {
  bufferMessages: 100,
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
      policy: { ...policy, bufferMessages: 1_000, childCapRial: 450_000 },
    });
    expect(decision.action === "transfer" && decision.amountRial).toBe(50_000);
  });

  it("stops at the daily cap", () => {
    const decision = planFunding({
      ...base,
      transferredTodayRial: 195_000,
      policy: { ...policy, bufferMessages: 1_000, childCapRial: null },
    });
    expect(decision.action === "transfer" && decision.amountRial).toBe(5_000);
  });

  it("reports the daily cap when it is used up", () => {
    const decision = planFunding({
      ...base,
      transferredTodayRial: 200_000,
      policy: { ...policy, bufferMessages: 1_000 },
    });
    expect(decision).toMatchObject({ action: "none", reason: "daily_cap_reached" });
  });

  it("keeps the master floor", () => {
    const decision = planFunding({
      ...base,
      masterBalanceRial: 1_010_000,
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
