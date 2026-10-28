/**
 * Issue #903 §7 and definition-of-done item 10 — fair settlement for managed
 * backup.
 *
 * The behaviour being replaced is small and wrong: `/api/backup/run` calls
 * `chargeForFeature("backup")` *before* the work, so a run that fails on a full
 * disk, an unreachable database or an empty scope still debits a nonrefundable
 * wallet charge. The epic's rule is the opposite — reserve/settle/refund, or
 * charge only after a verified, billable success.
 *
 * Two commercial facts are separated here, because conflating them is how
 * tenants get double-billed:
 *
 *  1. **A use charge** for producing a backup, priced per plan. It settles once
 *     per *logical* backup, not once per destination — a Hybrid business that
 *     mirrors one operation to local disk and managed S3 pays for one operation.
 *  2. **A storage charge** measured in byte-days of *managed cloud* bytes only.
 *     Local-only copies carry no cloud storage fee (there is no cloud byte), and
 *     the local half of a mirror is not billed again.
 *
 * `backup.storage_byte_day` already exists in the billing catalog with
 * `aggregation: byte_time` / `billingPeriodBehavior: high_water`; this module
 * computes the quantity that meter receives. It deliberately does NOT introduce
 * a wallet, a price table or a second commercial authority.
 *
 * Pure functions only: the route/service passes in the price it resolved, and
 * the tests in `backup-billing-settlement.test.ts` hold the policy.
 */

/** The one storage meter the platform already declares for backup retention. */
export const BACKUP_STORAGE_METER_KEY = "backup.storage_byte_day" as const;

export type BackupRunOutcome = "success" | "failed" | "skipped" | "cancelled";
export type BackupDestination = "local" | "cloud";

export interface UseChargeDecision {
  action: "charge" | "none";
  /** Whole Rial, the platform's storage unit. */
  amountRial: number;
  reason:
    | "verified_success"
    | "not_verified"
    | "failed_attempt"
    | "cancelled_attempt"
    | "not_priced"
    | "already_settled";
  /** Stable key the ledger/usage writer deduplicates on. */
  idempotencyKey: string | null;
}

/**
 * Whether a produced backup may be charged for.
 *
 * `verified` is not a formality: a file that was written but never checked
 * (checksum + manifest signature + scratch validation) is not a backup yet, so
 * charging for it would sell a promise the platform has not established.
 */
export function backupUseChargeDecision(input: {
  businessId: string;
  artifactIds: string[];
  outcome: BackupRunOutcome;
  verified: boolean;
  destinations: BackupDestination[];
  priceRial: number | null;
  alreadySettled?: boolean;
}): UseChargeDecision {
  const base = { amountRial: 0 } as const;
  if (input.outcome === "failed") return { ...base, action: "none", reason: "failed_attempt", idempotencyKey: null };
  if (input.outcome === "cancelled") {
    return { ...base, action: "none", reason: "cancelled_attempt", idempotencyKey: null };
  }
  if (input.outcome !== "success") {
    return { ...base, action: "none", reason: "cancelled_attempt", idempotencyKey: null };
  }
  if (!input.verified) return { ...base, action: "none", reason: "not_verified", idempotencyKey: null };
  if (input.artifactIds.length === 0) {
    // A "successful" run that produced no artifact is an empty attempt.
    return { ...base, action: "none", reason: "not_verified", idempotencyKey: null };
  }
  if (input.priceRial === null || input.priceRial <= 0) {
    return { ...base, action: "none", reason: "not_priced", idempotencyKey: null };
  }
  if (input.alreadySettled) {
    return { ...base, action: "none", reason: "already_settled", idempotencyKey: null };
  }
  return {
    action: "charge",
    amountRial: Math.round(input.priceRial),
    reason: "verified_success",
    // One logical operation per business and artifact set — a local+cloud mirror
    // shares this key on purpose.
    idempotencyKey: settlementKey(input.businessId, [...input.artifactIds].sort(), "use"),
  };
}

/** Deterministic settlement identity, so a retried request cannot double-charge. */
export function settlementKey(
  businessId: string,
  artifactIds: string[],
  kind: "use" | "storage" | "refund",
): string {
  // Sorted here as well as by callers: the key is the ledger's dedupe identity,
  // so it must not depend on the order a caller happened to collect rows in.
  return ["backup-settlement-v1", kind, businessId, ...[...artifactIds].sort()].join(":");
}

/**
 * A pre-charge that happened before this policy existed, reconciled after the
 * fact: a failed or unverified attempt had its use charge refunded exactly once.
 * Successful attempts need no refund, so callers can run this unconditionally.
 */
export function legacyPrechargeReconciliation(input: {
  businessId: string;
  artifactIds: string[];
  charged: boolean;
  outcome: BackupRunOutcome;
  verified: boolean;
}): { refund: boolean; amountIsUnknown: true; idempotencyKey: string | null; reason: string } {
  const shouldRefund =
    input.charged && (input.outcome !== "success" || !input.verified);
  return {
    refund: shouldRefund,
    amountIsUnknown: true,
    idempotencyKey: shouldRefund
      ? settlementKey(input.businessId, [...input.artifactIds].sort(), "refund")
      : null,
    reason: shouldRefund ? "failed_or_unverified_attempt" : "no_refund_needed",
  };
}

export interface StorageSample {
  at: Date;
  /** Managed cloud bytes retained at that instant. Local bytes never appear here. */
  cloudBytes: number;
}

/**
 * Time-weighted byte-days: the integral of retained cloud bytes over the
 * window, divided by 24h. This is the quantity `backup.storage_byte_day`
 * expects. Samples must describe the *same* business; callers scope them.
 *
 * A partial window (the business joined mid-period, or the last sample is old)
 * is integrated only over the time actually observed, so a new tenant is not
 * charged for storage it never had.
 */
export function cloudStorageByteDays(samples: StorageSample[], window: { from: Date; to: Date }): number {
  if (samples.length === 0) return 0;
  const ordered = [...samples]
    .filter((sample) => sample.cloudBytes >= 0)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (ordered.length === 0) return 0;

  const from = window.from.getTime();
  const to = window.to.getTime();
  if (to <= from) return 0;

  let byteMilliseconds = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const start = Math.max(ordered[index].at.getTime(), from);
    const nextStart = index + 1 < ordered.length ? ordered[index + 1].at.getTime() : to;
    const end = Math.min(nextStart, to);
    if (end > start) byteMilliseconds += ordered[index].cloudBytes * (end - start);
  }
  // No observed time inside the window means nothing retained during it.
  return Math.ceil(byteMilliseconds / (24 * 60 * 60 * 1000));
}

export interface StorageChargeDecision {
  billableBytes: number;
  includedBytes: number;
  overageBytes: number;
  byteDays: number;
  meterKey: typeof BACKUP_STORAGE_METER_KEY;
  /** Local-only storage is never billable as cloud storage. */
  reason: "cloud_storage" | "no_cloud_bytes";
  idempotencyKey: string;
}

/**
 * What the metered storage charge covers for one artifact set. `includedBytes`
 * comes from the plan's allowance; overage is the remainder. The meter still
 * receives the full retained quantity (allowances are applied by the billing
 * runtime), but the overage is reported so the business-facing copy can say
 * "within your plan" vs "above it" without a second calculation.
 */
export function backupStorageDecision(input: {
  businessId: string;
  artifactIds: string[];
  destinations: BackupDestination[];
  cloudBytes: number;
  includedBytes: number;
  byteDays: number;
}): StorageChargeDecision {
  const cloudRetained = input.destinations.includes("cloud") ? Math.max(0, input.cloudBytes) : 0;
  const includedBytes = Math.max(0, input.includedBytes);
  const overageBytes = Math.max(0, cloudRetained - includedBytes);
  const byteDays = cloudRetained === 0 ? 0 : Math.max(0, Math.ceil(input.byteDays));
  return {
    billableBytes: cloudRetained,
    includedBytes,
    overageBytes,
    byteDays,
    meterKey: BACKUP_STORAGE_METER_KEY,
    reason: cloudRetained === 0 ? "no_cloud_bytes" : "cloud_storage",
    idempotencyKey: settlementKey(input.businessId, [...input.artifactIds].sort(), "storage"),
  };
}

/**
 * A mirror produces two rows and one billable storage event. This collapses the
 * pair by artifact id so a caller that lists rows (rather than logical backups)
 * cannot bill the same backup twice.
 */
export function uniqueArtifactIds(rows: { artifactId: string; destination: BackupDestination }[]): string[] {
  return [...new Set(rows.map((row) => row.artifactId))].sort();
}
