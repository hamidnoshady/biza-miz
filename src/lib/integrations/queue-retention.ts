/**
 * Issue #1077 — how long finished WP/Woo queue rows are kept.
 *
 * Nothing used to delete from `integration_outbox_events` or
 * `integration_webhook_events`. The inbox grows by one row per webhook
 * delivery, each carrying the full order payload (customer data included), so
 * the table only ever got bigger. The policy, agreed with the owner:
 *
 *   - finished rows are kept 90 days (a quarter of reconciliation plus a
 *     month): outbox `sent` / `skipped`, inbox `processed` / `duplicate`;
 *   - unresolved failures are kept 180 days, because someone may still ask
 *     "why did this order never arrive": outbox `dead`, inbox `failed`;
 *   - everything else is never touched: `pending`, `processing`, `deferred`,
 *     `failed` (still retrying) and `needs_review` are live work or a human
 *     decision, whatever their age.
 *
 * It is a plain DELETE, not an archive: `integration_audit_log` is append-only
 * and is the permanent record. Each sweep writes one payload-free summary row
 * per connection (counts and cutoffs only), so "rows were removed" is itself
 * recorded.
 *
 * Deleting a delivered outbox row cannot cause a re-push: the scheduled diff
 * compares against the mapping's `lastPushedPayload`, never against the old
 * event. Deleting an inbox row re-opens its `delivery_id` for dedup, which is
 * safe because 90 days is far beyond any WooCommerce or plugin retry window.
 */
import { query, withoutTenantScope, withTenant } from "../db";
import { writeIntegrationAudit } from "./audit";
import {
  QUEUE_DEAD_RETENTION_DAYS,
  QUEUE_DONE_RETENTION_DAYS,
  retentionCutoffs,
} from "./queue-retention-policy";

export { QUEUE_RETENTION_TICK_INTERVAL_MS } from "./queue-retention-policy";

/** Rows deleted per statement, so a first sweep over a huge backlog never holds a long lock. */
export const QUEUE_RETENTION_BATCH = 1000;
/** Batches per table per business per sweep; the rest is left for the next tick. */
export const QUEUE_RETENTION_MAX_BATCHES = 50;

export interface RetentionCounts {
  outboxDone: number;
  outboxDead: number;
  inboxDone: number;
  inboxFailed: number;
}

function emptyCounts(): RetentionCounts {
  return { outboxDone: 0, outboxDead: 0, inboxDone: 0, inboxFailed: 0 };
}

/**
 * Delete in batches until a short batch comes back (or the batch cap is hit),
 * tallying deleted rows per connection. The statement lists its statuses
 * literally: the sweep must never be able to name a live status.
 */
async function deleteInBatches(
  sql: string,
  cutoff: Date,
  tally: (connectionId: string) => void,
): Promise<void> {
  for (let batch = 0; batch < QUEUE_RETENTION_MAX_BATCHES; batch += 1) {
    const { rows } = await query<{ connection_id: string }>(sql, [cutoff.toISOString(), QUEUE_RETENTION_BATCH]);
    for (const row of rows) tally(row.connection_id);
    if (rows.length < QUEUE_RETENTION_BATCH) return;
  }
}

/** One business's sweep; call inside `withTenant`. Returns counts per connection. */
export async function sweepQueueRetention(
  businessId: string,
  now: Date = new Date(),
): Promise<Map<string, RetentionCounts>> {
  const { doneBefore, deadBefore } = retentionCutoffs(now);
  const perConnection = new Map<string, RetentionCounts>();
  const counts = (connectionId: string): RetentionCounts => {
    let entry = perConnection.get(connectionId);
    if (!entry) {
      entry = emptyCounts();
      perConnection.set(connectionId, entry);
    }
    return entry;
  };

  await deleteInBatches(
    `DELETE FROM integration_outbox_events
      WHERE id IN (
        SELECT id FROM integration_outbox_events
         WHERE status IN ('sent', 'skipped') AND updated_at < $1
         LIMIT $2)
      RETURNING connection_id`,
    doneBefore,
    (id) => (counts(id).outboxDone += 1),
  );
  await deleteInBatches(
    `DELETE FROM integration_outbox_events
      WHERE id IN (
        SELECT id FROM integration_outbox_events
         WHERE status = 'dead' AND updated_at < $1
         LIMIT $2)
      RETURNING connection_id`,
    deadBefore,
    (id) => (counts(id).outboxDead += 1),
  );
  await deleteInBatches(
    `DELETE FROM integration_webhook_events
      WHERE id IN (
        SELECT id FROM integration_webhook_events
         WHERE status IN ('processed', 'duplicate') AND COALESCE(processed_at, created_at) < $1
         LIMIT $2)
      RETURNING connection_id`,
    doneBefore,
    (id) => (counts(id).inboxDone += 1),
  );
  await deleteInBatches(
    `DELETE FROM integration_webhook_events
      WHERE id IN (
        SELECT id FROM integration_webhook_events
         WHERE status = 'failed' AND COALESCE(processed_at, created_at) < $1
         LIMIT $2)
      RETURNING connection_id`,
    deadBefore,
    (id) => (counts(id).inboxFailed += 1),
  );

  for (const [connectionId, entry] of perConnection) {
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "queue.retention_sweep",
      payload: {
        ...entry,
        doneRetentionDays: QUEUE_DONE_RETENTION_DAYS,
        deadRetentionDays: QUEUE_DEAD_RETENTION_DAYS,
        doneBefore: doneBefore.toISOString(),
        deadBefore: deadBefore.toISOString(),
      },
    });
  }
  return perConnection;
}

/**
 * The background tick: enumerate businesses that have a connection (any
 * status, so a paused or disconnected store is swept too) under the platform
 * bypass, then sweep each one inside `withTenant`. One business failing never
 * stops the next.
 */
export async function runQueueRetentionTick(now: Date = new Date()): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string }>(`SELECT DISTINCT business_id FROM integration_connections`),
  );
  for (const { business_id } of rows) {
    try {
      await withTenant(business_id, () => sweepQueueRetention(business_id, now));
    } catch (err) {
      console.error("queue_retention_sweep_failed", {
        businessId: business_id,
        error: (err as Error).message,
      });
    }
  }
}
