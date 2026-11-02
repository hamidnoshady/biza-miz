/**
 * Issue #902 §6 (plan §9 item 2) — delivery and latency, per campaign.
 *
 * §6c gave the console a fleet-level delivery card: "are messages arriving, and
 * for whom". It deliberately answered the *fleet* question. The questions it
 * cannot answer are the ones a business actually asks — *did my campaign
 * arrive, and if it was slow, was it slow because of us or because of the
 * carrier?* — and answering them needs a different grouping and a second clock.
 *
 * Three rules shape this module:
 *
 *   1. **Two latencies, never one.** A message waits in the outbox (queue) and
 *      then waits on the provider (send). A single "latency" number would make
 *      a backed-up drain look like a slow carrier, and the two have opposite
 *      fixes. `queueLatency` is derivable from `0134`; `sendLatency` comes from
 *      the `0268` column the drain now writes.
 *   2. **Percentiles, not averages.** One 90-second retry moves an average
 *      enough to hide a healthy fleet, and an average of two rows is not a
 *      measurement. p50 answers "is it fine", p95 answers "is anyone hurting".
 *   3. **A tenant may read their own campaigns, and nothing else.** The report
 *      carries no provider name, no provider error string and no wholesale
 *      cost — `error` is internal diagnostics and stays in the platform query.
 *      What a tenant sees is the shape `tenantCampaignDelivery()` returns.
 */
import { query, withTenant, withoutTenantScope } from "./db";
import { deliveryHealth, type DeliveryHealth } from "./delivery-health";
import { latencyStats, type LatencyStats } from "./latency-stats";

// Both rules are pure modules now (the Superadmin card and the delivery trend
// import them directly); these re-exports keep the existing call sites intact.
export { latencyStats };
export type { LatencyStats };

export interface CampaignDeliveryRow {
  campaignId: string;
  /** Only present on the platform report; a tenant already knows its own name. */
  businessId?: string;
  businessName?: string | null;
  campaignName: string | null;
  channel: "sms" | "email";
  /** Accepted by the provider. */
  sent: number;
  /** Confirmed delivered afterwards. */
  delivered: number;
  failed: number;
  /** Still queued or in flight — not yet an outcome. */
  pending: number;
  /** Milliseconds between enqueue and the provider's acceptance. */
  queueLatency: LatencyStats | null;
  /** Milliseconds the provider took to answer the last attempt. */
  sendLatency: LatencyStats | null;
  lastAttemptAt: string | null;
  health: DeliveryHealth;
}

/** The window the screens show, and the most rows they list. */
export const CAMPAIGN_DELIVERY_DEFAULT_HOURS = 24 * 7;
export const CAMPAIGN_DELIVERY_LIMIT = 25;

const HOURS_CEILING = 24 * 90;

type ReportRow = {
  campaign_id: string;
  campaign_name: string | null;
  channel: string | null;
  business_id?: string;
  business_name?: string | null;
  sent: string | number;
  delivered: string | number;
  failed: string | number;
  pending: string | number;
  queue_ms: (string | number | null)[];
  send_ms: (string | number | null)[];
  last_attempt_at: Date | null;
};

/** The aggregate query. Both scopes share it; only the WHERE clause differs. */
const AGGREGATE_SELECT = `
  SELECT o.campaign_id,
         c.name AS campaign_name,
         c.channel,
         count(*) FILTER (WHERE o.status = 'sent')      AS sent,
         count(*) FILTER (WHERE o.status = 'delivered') AS delivered,
         count(*) FILTER (WHERE o.status = 'failed')    AS failed,
         count(*) FILTER (WHERE o.status IN ('queued', 'sending')) AS pending,
         array_agg(EXTRACT(EPOCH FROM (o.sent_at - o.created_at)) * 1000)
           FILTER (WHERE o.sent_at IS NOT NULL)        AS queue_ms,
         array_agg(o.send_latency_ms)
           FILTER (WHERE o.send_latency_ms IS NOT NULL) AS send_ms,
         max(o.last_attempt_at) AS last_attempt_at
    FROM message_outbox o
    JOIN message_campaigns c ON c.id = o.campaign_id`;

/**
 * `array_agg` of a `numeric` comes back as strings (pg keeps numeric precision
 * rather than losing it to a JS float), so the two latency columns are coerced
 * here rather than at every read.
 */
function numericArray(values: readonly (string | number | null)[] | null | undefined) {
  return (values ?? []).map((value) => {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  });
}

function toRow(row: ReportRow): CampaignDeliveryRow {
  const sent = Number(row.sent) || 0;
  const delivered = Number(row.delivered) || 0;
  const failed = Number(row.failed) || 0;
  const pending = Number(row.pending) || 0;
  const lastAttempt = row.last_attempt_at;
  return {
    campaignId: row.campaign_id,
    ...(row.business_id ? { businessId: row.business_id } : {}),
    ...(row.business_name !== undefined ? { businessName: row.business_name } : {}),
    campaignName: row.campaign_name,
    channel: row.channel === "email" ? "email" : "sms",
    sent,
    delivered,
    failed,
    pending,
    queueLatency: latencyStats(numericArray(row.queue_ms)),
    sendLatency: latencyStats(numericArray(row.send_ms)),
    lastAttemptAt: lastAttempt instanceof Date ? lastAttempt.toISOString() : (lastAttempt ?? null),
    health: deliveryHealth({ sent, delivered, failed, pending }),
  };
}

function clampWindow(input: { sinceHours?: number; limit?: number }): { hours: number; limit: number } {
  return {
    hours: Math.min(
      Math.max(1, Math.trunc(input.sinceHours ?? CAMPAIGN_DELIVERY_DEFAULT_HOURS)),
      HOURS_CEILING,
    ),
    limit: Math.min(Math.max(1, Math.trunc(input.limit ?? CAMPAIGN_DELIVERY_LIMIT)), 100),
  };
}

/**
 * Every business's campaigns, worst first — the Superadmin view.
 *
 * Platform-only because it names businesses and reads across tenants; the
 * tenant's copy is `tenantCampaignDelivery` below.
 */
export async function getCampaignDeliveryReport(
  input: { sinceHours?: number; limit?: number } = {},
): Promise<CampaignDeliveryRow[]> {
  const { hours, limit } = clampWindow(input);

  return withoutTenantScope("platform", async () => {
    const result = await query<ReportRow>(
      `SELECT o.campaign_id,
              c.name AS campaign_name,
              c.channel,
              o.business_id,
              b.name AS business_name,
              count(*) FILTER (WHERE o.status = 'sent')      AS sent,
              count(*) FILTER (WHERE o.status = 'delivered') AS delivered,
              count(*) FILTER (WHERE o.status = 'failed')    AS failed,
              count(*) FILTER (WHERE o.status IN ('queued', 'sending')) AS pending,
              array_agg(EXTRACT(EPOCH FROM (o.sent_at - o.created_at)) * 1000)
                FILTER (WHERE o.sent_at IS NOT NULL)        AS queue_ms,
              array_agg(o.send_latency_ms)
                FILTER (WHERE o.send_latency_ms IS NOT NULL) AS send_ms,
              max(o.last_attempt_at) AS last_attempt_at
         FROM message_outbox o
         JOIN message_campaigns c ON c.id = o.campaign_id
         JOIN businesses b ON b.id = o.business_id
        WHERE o.created_at >= now() - ($1::int * interval '1 hour')
        GROUP BY o.campaign_id, c.name, c.channel, o.business_id, b.name
        ORDER BY count(*) FILTER (WHERE o.status = 'failed') DESC,
                 max(o.last_attempt_at) DESC NULLS LAST
        LIMIT $2`,
      [hours, limit],
    );
    return result.rows.map(toRow);
  });
}

/**
 * One business's own campaigns — what a tenant may see.
 *
 * Scoped twice: the caller names the business AND the query runs inside
 * `withTenant`, so a lost session scope can only ever return nothing rather
 * than someone else's campaign.
 */
export async function tenantCampaignDelivery(
  businessId: string,
  input: { sinceHours?: number; limit?: number } = {},
): Promise<CampaignDeliveryRow[]> {
  const { hours, limit } = clampWindow(input);

  return withTenant(businessId, async () => {
    const { rows } = await query<ReportRow>(
      `${AGGREGATE_SELECT}
        WHERE o.business_id = $1
          AND o.created_at >= now() - ($2::int * interval '1 hour')
        GROUP BY o.campaign_id, c.name, c.channel
        ORDER BY max(o.last_attempt_at) DESC NULLS LAST
        LIMIT $3`,
      [businessId, hours, limit],
    );
    return rows.map(toRow);
  });
}
