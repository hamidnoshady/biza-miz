/**
 * Issue #902 §6 — the delivery half of the messaging console.
 *
 * The fleet screen answers "is this account provisioned and funded?"; it does
 * not answer "are messages actually arriving?". Those are different failures —
 * a child can be `active`, funded and still have every send rejected — and the
 * operator only discovers it from this report.
 *
 * Two rules shape it:
 *
 *   1. **Acceptance is not delivery.** `sent` is what the provider accepted;
 *      `delivered` is what it later confirmed. Mixing them would hide a carrier
 *      problem behind a green number, so both are reported and the health rule
 *      is computed from the attempts that had an outcome.
 *   2. **The tenant never sees this.** Rows carry business names and provider
 *      error codes; the report is Superadmin-only, served from
 *      `/api/platform/sms/accounts` and rendered in the console card.
 */
import { query, withoutTenantScope } from "./db";

export type DeliveryHealth = "healthy" | "degraded" | "attention" | "idle";

export interface DeliveryReportRow {
  businessId: string;
  businessName: string | null;
  /** Accepted by the provider. */
  sent: number;
  /** Confirmed delivered afterwards. */
  delivered: number;
  failed: number;
  /** Still queued or in flight — not yet an outcome. */
  pending: number;
  lastAttemptAt: string | null;
}

/**
 * A first-party verdict for one business's recent sends.
 *
 * The thresholds are deliberately coarse — this is an operator's triage aid,
 * not an SLA — and `idle` is distinct from `healthy`: no attempts means no
 * evidence, and a report that calls silence "healthy" trains the operator to
 * ignore it.
 */
export function deliveryHealth(row: {
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
}): DeliveryHealth {
  const decided = row.sent + row.delivered + row.failed;
  if (decided === 0) return row.pending > 0 ? "degraded" : "idle";
  if (row.failed > 0 && row.failed / decided >= 0.1) return "attention";
  if (row.failed > 0 || row.pending > 0) return "degraded";
  return "healthy";
}

/** The window the console shows, and the most it will list. */
export const DELIVERY_REPORT_DEFAULT_HOURS = 24;
export const DELIVERY_REPORT_LIMIT = 50;

/**
 * Per-business delivery counts over a window, worst first.
 *
 * Ordered by failures then name so an operator's next question is at the top of
 * the list, exactly like the reconciliation view.
 */
export async function getDeliveryReport(input: {
  sinceHours?: number;
  limit?: number;
} = {}): Promise<DeliveryReportRow[]> {
  const hours = Math.min(Math.max(1, Math.trunc(input.sinceHours ?? DELIVERY_REPORT_DEFAULT_HOURS)), 24 * 30);
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? DELIVERY_REPORT_LIMIT)), 200);

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      business_id: string;
      business_name: string | null;
      sent: string | number;
      delivered: string | number;
      failed: string | number;
      pending: string | number;
      last_attempt_at: Date | null;
    }>(
      `SELECT o.business_id,
              b.name AS business_name,
              count(*) FILTER (WHERE o.status = 'sent')      AS sent,
              count(*) FILTER (WHERE o.status = 'delivered') AS delivered,
              count(*) FILTER (WHERE o.status = 'failed')    AS failed,
              count(*) FILTER (WHERE o.status IN ('queued', 'sending')) AS pending,
              max(o.last_attempt_at) AS last_attempt_at
         FROM message_outbox o
         JOIN businesses b ON b.id = o.business_id
        WHERE o.created_at >= now() - ($1::int * interval '1 hour')
        GROUP BY o.business_id, b.name
        ORDER BY count(*) FILTER (WHERE o.status = 'failed') DESC,
                 max(o.last_attempt_at) DESC NULLS LAST
        LIMIT $2`,
      [hours, limit],
    );

    return rows.map((row) => {
      const lastAttempt = row.last_attempt_at;
      return {
        businessId: row.business_id,
        businessName: row.business_name,
        sent: Number(row.sent) || 0,
        delivered: Number(row.delivered) || 0,
        failed: Number(row.failed) || 0,
        pending: Number(row.pending) || 0,
        lastAttemptAt:
          lastAttempt instanceof Date ? lastAttempt.toISOString() : (lastAttempt ?? null),
      };
    });
  });
}
