import { describe, expect, it } from "vitest";
import { reconcileProviderBalance, reconciliationBucketEnd } from "./reconciliation-service";

const base = {
  creditTransferredRial: 500_000,
  providerCostRial: 120_000,
  retailChargedRial: 200_000,
  toleranceRial: 1_000,
};

describe("wholesale balance reconciliation", () => {
  it("agrees when the provider balance equals funded minus spent", () => {
    const result = reconcileProviderBalance({ ...base, providerBalanceRial: 380_000 });
    expect(result.state).toBe("ok");
    expect(result.expectedBalanceRial).toBe(380_000);
    expect(result.deltaRial).toBe(0);
    expect(result.detail.marginRial).toBe(80_000);
  });

  it("reports drift in both directions, keeping the sign", () => {
    const under = reconcileProviderBalance({ ...base, providerBalanceRial: 300_000 });
    expect(under.state).toBe("drift");
    expect(under.deltaRial).toBe(-80_000);

    const over = reconcileProviderBalance({ ...base, providerBalanceRial: 400_000 });
    expect(over.state).toBe("drift");
    expect(over.deltaRial).toBe(20_000);
  });

  it("treats a difference inside the tolerance as rounding, not drift", () => {
    const result = reconcileProviderBalance({ ...base, providerBalanceRial: 380_999 });
    expect(result.state).toBe("ok");
    expect(result.deltaRial).toBe(999);
  });

  it("is incomplete — not drift — when the provider read failed", () => {
    const result = reconcileProviderBalance({ ...base, providerBalanceRial: null });
    expect(result.state).toBe("incomplete");
    expect(result.deltaRial).toBeNull();
    expect(result.expectedBalanceRial).toBe(380_000);
  });

  it("flags an expected balance below zero: we spent credit we never funded", () => {
    const result = reconcileProviderBalance({
      ...base,
      creditTransferredRial: 100_000,
      providerBalanceRial: 0,
    });
    expect(result.detail.negative).toBe(true);
    expect(result.expectedBalanceRial).toBe(-20_000);
    expect(result.state).toBe("drift");
  });

  it("buckets runs by the hour so two passes cannot duplicate one", () => {
    expect(reconciliationBucketEnd(new Date("2026-03-04T10:37:12.000Z")).toISOString()).toBe(
      "2026-03-04T11:00:00.000Z",
    );
    expect(reconciliationBucketEnd(new Date("2026-03-04T10:01:00.000Z")).toISOString()).toBe(
      "2026-03-04T11:00:00.000Z",
    );
    // Exactly on the hour: the current hour is the bucket, not the next one.
    expect(reconciliationBucketEnd(new Date("2026-03-04T10:00:00.000Z")).toISOString()).toBe(
      "2026-03-04T10:00:00.000Z",
    );
  });
});
