/**
 * Issue #903 §7 — the scheduled billing jobs for managed backups.
 *
 * Four jobs, one rule between them: **a job is idempotent by construction**, not
 * by remembering that it ran. Each writes a usage event whose id is derived from
 * what it is about (business, artifact set, window, kind), so a retried job is a
 * duplicate the ledger drops rather than a second charge. Each also takes a
 * distributed lock, so two scheduler instances waking at the same minute produce
 * one run and one `busy`, not two of each.
 *
 * ```text
 * sample   every tick   retained managed-cloud bytes per business, one row per
 *                       sampling instant (the evidence for the quantity billed)
 * byte-day daily        integrate those samples over the *completed* UTC day and
 *                       emit `backup.storage_byte_day`
 * overage  daily        the same window, reported per business as
 *                       "included / over / total" for the pricing screens
 * refunds  daily        reconcile pre-charges made before this policy: a failed
 *                       or never-verified attempt is refunded exactly once
 * margin   on demand    revenue (catalog price × emitted quantity) minus the
 *                       provider cost estimate, per business and in total
 * ```
 *
 * What it refuses to do: bill a Local profile (no managed bytes exist), bill a
 * storage window twice, charge for an unverified artifact, or invent a price.
 * A missing catalog price is reported as `not_priced`, never as free.
 */
import { getPool, query, withoutTenantScope } from "./db";
import { postWalletEntryTx } from "./wallet-service";
import { LOCK_KEYS, withDistributedLock } from "./db-locks";
import { appendUsageEvent } from "./billing/runtime";
import {
  BACKUP_STORAGE_METER_KEY,
  backupStorageDecision,
  legacyPrechargeReconciliation,
  settlementKey,
  uniqueArtifactIds,
} from "./backup-billing-settlement";
import {
  emitBackupStorageUsage,
  listStoredArtifactRows,
  recordStorageSample,
  storageIncludedBytes,
  storageByteDays,
} from "./tenant-backup-artifacts-service";

/** Managed cloud is sampled at most this often; the meter integrates the rest. */
export const STORAGE_SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
/** Provider cost assumption used by the margin report, in Rial per GB-month. */
export const DEFAULT_PROVIDER_COST_RIAL_PER_GB_MONTH = 0;
const BYTES_PER_GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The completed UTC day that ends at `now` — what a nightly job settles. */
export function completedUtcDay(now: Date): { from: Date; to: Date } {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(end - DAY_MS), to: new Date(end) };
}

/**
 * The window a byte-day settlement is for. Deterministic from the clock alone,
 * so a job that ran at 00:05 and a retry at 03:00 agree on the same window.
 */
export function settlementWindow(now: Date): { from: Date; to: Date } {
  return completedUtcDay(now);
}

export interface StorageSettlementResult {
  businessId: string;
  status: string;
  byteDays: number;
  overageBytes: number;
  includedBytes: number;
}

/**
 * Emit one business's byte-day event, after computing the same overage the
 * tenant is shown. Returns `skipped` for a business with no managed bytes —
 * "you have nothing in the cloud" must never produce a zero-quantity event.
 */
export async function settleBusinessStorage(
  businessId: string,
  window: { from: Date; to: Date },
): Promise<StorageSettlementResult> {
  const rows = await listStoredArtifactRows(businessId);
  const cloudRows = rows.filter((row) => row.destination === "cloud" && row.state !== "failed");
  const includedBytes = await storageIncludedBytes(businessId);
  const cloudBytes = cloudRows.reduce((total, row) => total + (row.storedBytes ?? 0), 0);
  const byteDays = await storageByteDays(businessId, window);
  const decision = backupStorageDecision({
    businessId,
    artifactIds: uniqueArtifactIds(
      cloudRows.map((row) => ({ artifactId: row.artifactId, destination: row.destination })),
    ),
    destinations: ["cloud"],
    cloudBytes,
    includedBytes,
    byteDays,
  });

  const emitted = await emitBackupStorageUsage(businessId, window);
  return {
    businessId,
    status: emitted.status,
    byteDays: decision.byteDays,
    overageBytes: decision.overageBytes,
    includedBytes: decision.includedBytes,
  };
}

/**
 * The nightly job: sample, then settle every business with managed bytes.
 * One lock for the whole fleet, keyed by the window, so a second instance is a
 * no-op rather than a duplicate pass.
 */
export async function runBackupStorageBillingJob(
  now: Date = new Date(),
): Promise<{ ran: boolean; settled: StorageSettlementResult[] }> {
  const window = settlementWindow(now);
  const lock = await withDistributedLock(LOCK_KEYS.backupBillingStorage(window.from.toISOString()), async () => {
    const ids = await listBillableBusinessIds();
    const settled: StorageSettlementResult[] = [];
    for (const businessId of ids) {
      try {
        await recordStorageSample(businessId, now);
        const result = await settleBusinessStorage(businessId, window);
        settled.push(result);
      } catch (error) {
        console.error(
          `backup billing: storage settlement failed for ${businessId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return settled;
  });
  if (!lock.ok) return { ran: false, settled: [] };
  return { ran: true, settled: lock.value };
}

/** Every business that currently holds a managed cloud artifact. */
async function listBillableBusinessIds(): Promise<string[]> {
  const rows = await withoutTenantScope("backup-billing", async () => {
    const result = await query<{ business_id: string }>(
      `SELECT DISTINCT business_id FROM tenant_backup_artifacts
        WHERE destination = 'cloud' AND state IN ('ready', 'verifying')`,
    );
    return result.rows;
  });
  return rows.map((row) => row.business_id);
}

/**
 * The hourly sampling job. It exists separately from the nightly settlement so a
 * business that grows from 1 MB to 900 GB during the day is *observed*; the
 * night's integral is only as good as its samples.
 */
export async function runBackupStorageSampleJob(
  now: Date = new Date(),
): Promise<{ sampled: number }> {
  const ids = await listBillableBusinessIds();
  let sampled = 0;
  for (const businessId of ids) {
    try {
      await recordStorageSample(businessId, now);
      sampled += 1;
    } catch (error) {
      console.error(
        `backup billing: storage sample failed for ${businessId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { sampled };
}

export interface RefundOutcome {
  businessId: string;
  refunds: number;
  /** Charges that matched no successful run and no failed run: left for a human. */
  needsReview: number;
}

interface LegacyChargeRow extends Record<string, unknown> {
  ledger_id: string;
  business_id: string;
  amount_rial: string;
  run_id: string | null;
  run_status: string | null;
  run_artifact: string | null;
}

/**
 * Reconcile the pre-charges the old "charge when the run starts" path took.
 *
 * Matching is deterministic: the charge carries the `runId` it paid for in its
 * ledger metadata, so a refund is decided by looking that run up — never by
 * guessing from timestamps. A run that failed, was cancelled, or produced no
 * artifact is refunded once; the `wallet_ledger_refund_once` unique index (0267)
 * makes the second attempt a database error rather than a second credit.
 *
 * A charge whose run cannot be found at all is counted as `needs_review` and
 * left alone: refunding a charge we cannot explain, or keeping one we cannot
 * justify, are both decisions for a person.
 */
export async function runBackupLegacyRefundJob(now: Date = new Date()): Promise<RefundOutcome[]> {
  const lock = await withDistributedLock(LOCK_KEYS.backupBillingRefund(now.toISOString().slice(0, 10)), async () => {
    const charges = await withoutTenantScope("backup-billing", async () => {
      const result = await query<LegacyChargeRow>(
        `SELECT l.id AS ledger_id,
                l.business_id,
                l.amount_rial::text AS amount_rial,
                l.metadata->>'runId' AS run_id,
                r.status AS run_status,
                r.artifact AS run_artifact
           FROM wallet_ledger l
           LEFT JOIN backup_runs r
                  ON r.id::text = l.metadata->>'runId' AND r.business_id = l.business_id
          WHERE l.kind = 'feature_charge'
            AND l.direction = 'debit'
            AND l.feature_key = 'backup'
            AND l.metadata ? 'runId'
            AND NOT EXISTS (
                  SELECT 1 FROM wallet_ledger refund
                   WHERE refund.kind = 'refund'
                     AND refund.metadata->>'refundOf' = l.id::text
                )
          ORDER BY l.created_at ASC
          LIMIT 200`,
      );
      return result.rows;
    });

    const byBusiness = new Map<string, { refunds: number; needsReview: number }>();
    for (const charge of charges) {
      const bucket = byBusiness.get(charge.business_id) ?? { refunds: 0, needsReview: 0 };
      if (!charge.run_status) {
        bucket.needsReview += 1;
        byBusiness.set(charge.business_id, bucket);
        continue;
      }
      const succeeded = charge.run_status === "success" && charge.run_artifact !== null;
      if (succeeded) continue;

      const decision = legacyPrechargeReconciliation({
        businessId: charge.business_id,
        artifactIds: [charge.run_id ?? charge.ledger_id],
        charged: true,
        outcome: charge.run_status === "success" ? "success" : "failed",
        // A successful run with no artifact is an empty attempt; either way the
        // pre-charge was for work that produced nothing usable.
        verified: succeeded,
      });
      if (!decision.refund) continue;

      const amountRial = Number(charge.amount_rial);
      if (!Number.isSafeInteger(amountRial) || amountRial <= 0) {
        bucket.needsReview += 1;
        byBusiness.set(charge.business_id, bucket);
        continue;
      }

      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await postWalletEntryTx(client, {
          businessId: charge.business_id,
          kind: "refund",
          direction: "credit",
          amountRial,
          featureKey: "backup",
          note: "بازگشت وجه پشتیبان‌گیری ناموفق",
          metadata: {
            refundOf: charge.ledger_id,
            runId: charge.run_id,
            reason: decision.reason,
            settlement: decision.idempotencyKey,
          },
        });
        await client.query("COMMIT");
        bucket.refunds += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        // A duplicate refund (unique index) is not a failure: it means another
        // instance already settled this charge.
        if (!(error instanceof Error && /duplicate key|unique/i.test(error.message))) {
          console.error(
            `backup billing: refund failed for ledger ${charge.ledger_id}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        client.release();
      }
      byBusiness.set(charge.business_id, bucket);
    }

    return [...byBusiness.entries()].map(([businessId, bucket]) => ({ businessId, ...bucket }));
  });
  return lock.ok ? lock.value : [];
}

// ---------------------------------------------------------------------------
// Margin
// ---------------------------------------------------------------------------

export interface MarginLine {
  businessId: string;
  byteDays: number;
  revenueRial: number;
  costRial: number;
  marginRial: number;
  /** Null when revenue is zero: a percentage of nothing means nothing. */
  marginPercent: number | null;
  /** True when the meter event exists but no catalog price was found. */
  notPriced: boolean;
}

export interface MarginReport {
  from: string;
  to: string;
  lines: MarginLine[];
  totals: { byteDays: number; revenueRial: number; costRial: number; marginRial: number; marginPercent: number | null };
  assumptions: { providerCostRialPerGbMonth: number; priced: boolean };
}

/**
 * Pure margin arithmetic, so the pricing screens and the job agree.
 *
 * Revenue comes from the catalog price actually charged; cost is the provider
 * assumption over the same quantity. `not_priced` is carried per line rather
 * than silently counting as 100% margin — an unpriced meter is a policy gap, and
 * a report that hides it would flatter the business.
 */
export function computeBackupMargin(input: {
  from: Date;
  to: Date;
  providerCostRialPerGbMonth: number;
  lines: { businessId: string; byteDays: number; revenueRial: number | null }[];
}): MarginReport {
  // One GB-month is `daysInMonth` GB-days, so a byte-day costs
  // price ÷ (bytesPerGb × daysInMonth). Costing against the month the window
  // starts in keeps a 30- and a 31-day month from pricing differently for the
  // same retention.
  const denominator = BYTES_PER_GB * daysPerMonth(input.from);
  const lines: MarginLine[] = input.lines.map((line) => {
    const revenueRial = Math.max(0, Math.round(line.revenueRial ?? 0));
    const costRial = Math.round(
      (Math.max(0, line.byteDays) * input.providerCostRialPerGbMonth) / denominator,
    );
    const marginRial = revenueRial - costRial;
    return {
      businessId: line.businessId,
      byteDays: line.byteDays,
      revenueRial,
      costRial,
      marginRial,
      marginPercent: revenueRial > 0 ? Math.round((marginRial / revenueRial) * 1000) / 10 : null,
      notPriced: line.revenueRial === null,
    };
  });
  const totals = lines.reduce(
    (acc, line) => ({
      byteDays: acc.byteDays + line.byteDays,
      revenueRial: acc.revenueRial + line.revenueRial,
      costRial: acc.costRial + line.costRial,
      marginRial: acc.marginRial + line.marginRial,
    }),
    { byteDays: 0, revenueRial: 0, costRial: 0, marginRial: 0 },
  );
  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    lines,
    totals: {
      ...totals,
      marginPercent: totals.revenueRial > 0 ? Math.round((totals.marginRial / totals.revenueRial) * 1000) / 10 : null,
    },
    assumptions: {
      providerCostRialPerGbMonth: input.providerCostRialPerGbMonth,
      priced: lines.every((line) => !line.notPriced),
    },
  };
}

function daysPerMonth(from: Date): number {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
}

/** The stored-margin report for a window, from the usage the ledger recorded. */
export async function backupMarginReport(input: {
  from: Date;
  to: Date;
  providerCostRialPerGbMonth?: number;
}): Promise<MarginReport> {
  const providerCost = input.providerCostRialPerGbMonth ?? DEFAULT_PROVIDER_COST_RIAL_PER_GB_MONTH;
  const rows = await withoutTenantScope("backup-billing", async () => {
    const result = await query<{ business_id: string; byte_days: string; revenue: string | null }>(
      `SELECT u.business_id,
              COALESCE(SUM(u.quantity), 0)::text AS byte_days,
              SUM(u.amount_rial)::text AS revenue
         FROM usage_events u
        WHERE u.meter_key = $3
          AND u.occurred_at >= $1 AND u.occurred_at < $2
        GROUP BY u.business_id
        ORDER BY u.business_id`,
      [input.from, input.to, BACKUP_STORAGE_METER_KEY],
    );
    return result.rows;
  });
  return computeBackupMargin({
    from: input.from,
    to: input.to,
    providerCostRialPerGbMonth: providerCost,
    lines: rows.map((row) => ({
      businessId: row.business_id,
      byteDays: Number(row.byte_days),
      revenueRial: row.revenue === null ? null : Number(row.revenue),
    })),
  });
}

/** Deterministic id for the storage settlement of a window (for the ledger view). */
export function storageSettlementId(businessId: string, artifactId: string, from: Date): string {
  return `${settlementKey(businessId, [artifactId], "storage")}:${from.toISOString()}`;
}
