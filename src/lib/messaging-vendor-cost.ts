/**
 * Issue #902 §4 — the wholesale half of the commercial ledger.
 *
 * `message_outbox.provider_cost_rial` has recorded what the supplier charged
 * for each accepted send since the managed-account work landed, and the margin
 * report reads it. What was missing is the step that turns that column into a
 * *ledgered* fact: until now nothing wrote it to `billing_vendor_cost_events`,
 * the one table where every other integration states "this is what the platform
 * actually paid". The consequences were concrete:
 *
 *   - margin was computable but not auditable against finance;
 *   - a supplier tariff change could not be reconciled after the fact;
 *   - a retail price change had no evidence base to justify it;
 *   - and reconciliation compared retail credit against a number that lived
 *     only inside the messaging tables.
 *
 * Three rules keep this safe:
 *
 *   1. **One event per send.** `billing_vendor_cost_events` has a unique
 *      `(provider, source_reference)` in migration 0177, and the reference is
 *      derived from the outbox row id, so a retried drain or a backfill racing
 *      a drain cannot post the same cost twice.
 *   2. **An unknown cost posts nothing.** Newer adapters return
 *      `providerCostRial`; older ones (and the legacy SMTP path) do not. A null
 *      is *unknown*, not zero — inventing a zero would silently declare every
 *      unreported send free and inflate margin. The margin report keeps
 *      counting those rows as `unreported` instead.
 *   3. **Wholesale never reaches a tenant.** This module writes the internal
 *      cost side only. Tenant-visible pricing stays in
 *      `billing_price_versions` through the Billing rates console; nothing here
 *      changes what a business is charged, and no provider name is serialised
 *      into a tenant payload.
 */
import { query, withTenant, withoutTenantScope } from "./db";
import { recordVendorCost } from "./billing/runtime";

/** A vendor cost is only recordable when the adapter actually reported one. */
export function hasReportedVendorCost(costRial: number | null | undefined): costRial is number {
  return typeof costRial === "number" && Number.isSafeInteger(costRial) && costRial >= 0;
}

/**
 * The `source_reference` for a send. Prefixed so the row is recognisable in the
 * finance table, and stable across retries because it carries the outbox id.
 */
export function vendorCostReference(outboxId: string): string {
  return `message_outbox:${outboxId}`;
}

/** The meter whose wholesale cost this send contributes to, if any. */
export function vendorCostMeter(channel: string): string | null {
  if (channel === "sms") return "messaging.sms_segment";
  if (channel === "email") return "messaging.email_send";
  return null;
}

export interface SendVendorCostInput {
  businessId: string;
  outboxId: string;
  channel: string;
  /** The adapter's internal provider key (`kavenegar`, `smtp`, …). */
  provider: string | null | undefined;
  /** Null/undefined means the adapter did not report a cost. */
  costRial: number | null | undefined;
  occurredAt?: string | null;
  /**
   * Extra internal evidence (retail charged, price version, segment count).
   * Merged into the event's `metadata`; never rendered to a tenant.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Post one accepted send's wholesale cost. Returns whether a new event was
 * written; a replay returns false and changes nothing.
 *
 * Called from inside the business's tenant scope by the drain, and from
 * `withTenant` by the backfill, so the row's `business_id` is always the scope
 * that owns it.
 */
export async function recordSendVendorCost(input: SendVendorCostInput): Promise<boolean> {
  const meterKey = vendorCostMeter(input.channel);
  if (!meterKey) return false;
  if (!input.provider) return false;
  if (!hasReportedVendorCost(input.costRial)) return false;
  const { inserted } = await recordVendorCost({
    businessId: input.businessId,
    meterKey,
    provider: input.provider,
    sourceReference: vendorCostReference(input.outboxId),
    amountRial: input.costRial,
    occurredAt: input.occurredAt ?? undefined,
    metadata: { channel: input.channel, source: "message_outbox", ...input.metadata },
    // §0 / DoD #3: this is supplier cost by definition. Migration 0262's
    // RESTRICTIVE policy makes it unreadable through a tenant connection, so a
    // provider name and a wholesale tariff can never surface in a tenant view,
    // export or sync — even though the row still belongs to that business for
    // finance and reset purposes.
    tenantVisible: false,
  });
  return inserted;
}

/** Rows examined per backfill pass. Bounded so a tick never becomes a scan. */
export const VENDOR_COST_BACKFILL_LIMIT = 200;

type BackfillRow = {
  id: string;
  business_id: string;
  provider_cost_rial: string | number;
  channel: string;
  sent_at: string | null;
} & Record<string, unknown>;

/**
 * Post the wholesale cost of sends that were accepted before this module
 * existed (or while a billing write failed).
 *
 * The selection is driven by the absence of the event, not by a timestamp, so
 * the pass is self-healing and idempotent: it simply has nothing left to do
 * once every reported send has an event. Rows whose cost is null are skipped —
 * they stay `unreported` in the margin report, which is the honest answer.
 */
export async function backfillSendVendorCosts(input: {
  providers: { sms: string; email: string };
  limit?: number;
}): Promise<{ scanned: number; recorded: number }> {
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? VENDOR_COST_BACKFILL_LIMIT)),
    VENDOR_COST_BACKFILL_LIMIT,
  );

  const rows = await withoutTenantScope("message-vendor-cost-backfill", async () => {
    const { rows: found } = await query<BackfillRow>(
      `SELECT o.id,
              o.business_id,
              o.provider_cost_rial,
              r.channel,
              o.sent_at
         FROM message_outbox o
         JOIN message_recipients r ON r.id = o.recipient_id
        WHERE o.status IN ('sent', 'delivered')
          AND o.provider_cost_rial IS NOT NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM billing_vendor_cost_events v
                 WHERE v.business_id = o.business_id
                   AND v.source_reference = 'message_outbox:' || o.id::text
              )
        ORDER BY o.sent_at DESC NULLS LAST, o.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return found;
  });

  let recorded = 0;
  for (const row of rows) {
    const costRial = Number(row.provider_cost_rial);
    const provider = row.channel === "sms" ? input.providers.sms : input.providers.email;
    try {
      const inserted = await withTenant(row.business_id, () =>
        recordSendVendorCost({
          businessId: row.business_id,
          outboxId: row.id,
          channel: row.channel,
          provider,
          costRial,
          occurredAt: row.sent_at,
        }),
      );
      if (inserted) recorded += 1;
    } catch (error) {
      // One bad row must not stop the sweep; it is retried on the next tick.
      console.error(
        `vendor cost backfill failed for outbox ${row.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { scanned: rows.length, recorded };
}
