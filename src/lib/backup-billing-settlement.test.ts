import { describe, expect, it } from "vitest";
import {
  backupStorageDecision,
  backupUseChargeDecision,
  cloudStorageByteDays,
  legacyPrechargeReconciliation,
  settlementKey,
  uniqueArtifactIds,
} from "./backup-billing-settlement";

const BUSINESS = "biz-a";
const ARTIFACT = "artifact-1";

function useCharge(overrides: Partial<Parameters<typeof backupUseChargeDecision>[0]> = {}) {
  return backupUseChargeDecision({
    businessId: BUSINESS,
    artifactIds: [ARTIFACT],
    outcome: "success",
    verified: true,
    destinations: ["local"],
    priceRial: 5_000,
    ...overrides,
  });
}

describe("backupUseChargeDecision", () => {
  it("charges once for a verified success", () => {
    const decision = useCharge();
    expect(decision.action).toBe("charge");
    expect(decision.amountRial).toBe(5_000);
    expect(decision.reason).toBe("verified_success");
    expect(decision.idempotencyKey).toBe(settlementKey(BUSINESS, [ARTIFACT], "use"));
  });

  it("never charges a failed, cancelled, unverified or empty attempt", () => {
    expect(useCharge({ outcome: "failed" })).toMatchObject({ action: "none", reason: "failed_attempt" });
    expect(useCharge({ outcome: "cancelled" })).toMatchObject({ action: "none", reason: "cancelled_attempt" });
    expect(useCharge({ verified: false })).toMatchObject({ action: "none", reason: "not_verified" });
    expect(useCharge({ artifactIds: [] })).toMatchObject({ action: "none", reason: "not_verified" });
    expect(useCharge({ priceRial: null })).toMatchObject({ action: "none", reason: "not_priced" });
    expect(useCharge({ priceRial: 0 })).toMatchObject({ action: "none", reason: "not_priced" });
    expect(useCharge({ alreadySettled: true })).toMatchObject({ action: "none", reason: "already_settled" });
  });

  it("does not charge twice for the two destinations of one mirror", () => {
    const local = useCharge({ destinations: ["local"] });
    const mirror = useCharge({ destinations: ["local", "cloud"] });
    const reversed = useCharge({ destinations: ["cloud", "local"] });
    expect(mirror.idempotencyKey).toBe(local.idempotencyKey);
    expect(reversed.idempotencyKey).toBe(local.idempotencyKey);
  });

  it("keeps the settlement key stable regardless of artifact ordering", () => {
    expect(settlementKey(BUSINESS, ["a", "b"], "use")).toBe(settlementKey(BUSINESS, ["b", "a"], "use"));
  });
});

describe("legacyPrechargeReconciliation", () => {
  it("refunds a pre-charge only when the attempt failed or was unverified", () => {
    expect(
      legacyPrechargeReconciliation({
        businessId: BUSINESS,
        artifactIds: [ARTIFACT],
        charged: true,
        outcome: "failed",
        verified: false,
      }),
    ).toMatchObject({ refund: true, reason: "failed_or_unverified_attempt" });
    expect(
      legacyPrechargeReconciliation({
        businessId: BUSINESS,
        artifactIds: [ARTIFACT],
        charged: true,
        outcome: "success",
        verified: false,
      }).refund,
    ).toBe(true);
    expect(
      legacyPrechargeReconciliation({
        businessId: BUSINESS,
        artifactIds: [ARTIFACT],
        charged: true,
        outcome: "success",
        verified: true,
      }),
    ).toMatchObject({ refund: false, idempotencyKey: null });
    expect(
      legacyPrechargeReconciliation({
        businessId: BUSINESS,
        artifactIds: [ARTIFACT],
        charged: false,
        outcome: "failed",
        verified: false,
      }).refund,
    ).toBe(false);
  });
});

describe("cloudStorageByteDays", () => {
  const day = (iso: string) => new Date(`2026-10-${iso}T00:00:00Z`);

  it("integrates retained bytes over time", () => {
    const samples = [
      { at: day("01"), cloudBytes: 1_000 },
      { at: day("03"), cloudBytes: 4_000 },
    ];
    // 1000 B for 2 days + 4000 B for 1 day = 2000 + 4000 byte-days.
    expect(cloudStorageByteDays(samples, { from: day("01"), to: day("04") })).toBe(6_000);
  });

  it("counts only the observed part of a partial window", () => {
    const samples = [{ at: day("03"), cloudBytes: 2_400 }];
    expect(cloudStorageByteDays(samples, { from: day("01"), to: day("04") })).toBe(2_400);
  });

  it("returns zero for no samples, an empty window or zero bytes", () => {
    expect(cloudStorageByteDays([], { from: day("01"), to: day("04") })).toBe(0);
    expect(cloudStorageByteDays([{ at: day("02"), cloudBytes: 100 }], { from: day("04"), to: day("04") })).toBe(0);
    expect(cloudStorageByteDays([{ at: day("01"), cloudBytes: 0 }], { from: day("01"), to: day("05") })).toBe(0);
  });

  it("carries a pre-window sample forward until a newer sample supersedes it", () => {
    const samples = [
      { at: day("01"), cloudBytes: 10_000 },
      { at: day("04"), cloudBytes: 500 },
    ];
    // 10 000 B held from the window start (day 03) to day 04, then 500 B for two
    // more days: 10 000 + 1 000 byte-days. The partial window is never extended
    // backwards, but the value observed before it still describes retained bytes.
    expect(cloudStorageByteDays(samples, { from: day("03"), to: day("06") })).toBe(11_000);
  });
});

describe("backupStorageDecision", () => {
  it("bills no cloud storage for a local-only backup", () => {
    const decision = backupStorageDecision({
      businessId: BUSINESS,
      artifactIds: [ARTIFACT],
      destinations: ["local"],
      cloudBytes: 0,
      includedBytes: 1_000,
      byteDays: 30,
    });
    expect(decision).toMatchObject({ billableBytes: 0, byteDays: 0, reason: "no_cloud_bytes" });
  });

  it("counts cloud bytes once and reports overage above the plan allowance", () => {
    const decision = backupStorageDecision({
      businessId: BUSINESS,
      artifactIds: [ARTIFACT],
      destinations: ["local", "cloud"],
      cloudBytes: 5_000,
      includedBytes: 2_000,
      byteDays: 90.2,
    });
    expect(decision).toMatchObject({
      billableBytes: 5_000,
      includedBytes: 2_000,
      overageBytes: 3_000,
      byteDays: 91,
      meterKey: "backup.storage_byte_day",
      reason: "cloud_storage",
    });
  });

  it("collapses mirrored rows to one billable artifact", () => {
    expect(
      uniqueArtifactIds([
        { artifactId: "a", destination: "local" },
        { artifactId: "a", destination: "cloud" },
        { artifactId: "b", destination: "cloud" },
      ]),
    ).toEqual(["a", "b"]);
  });
});
