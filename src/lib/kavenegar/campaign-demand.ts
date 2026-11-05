/**
 * Issue #902 §9 item 1 — a campaign with an approved audience is a funding reason
 * of its own.
 *
 * Funding was sized by the *policy*: "keep 100 messages of credit on every
 * child". That is a standing order, and it is right for a steady trickle. It is
 * wrong for the thing this platform is actually used for: a business approves an
 * audience of 500 and sends it. The pool then needs 500 messages' worth of
 * provider credit and the standing order is still asking for 100 — so the drain
 * runs out mid-campaign, the provider refuses the tail with its credit error,
 * and every one of those recipients is marked `failed` for a reason the business
 * never chose and cannot see.
 *
 * The missing trigger is the **work already queued**: an approved campaign has
 * its recipients materialized in `message_recipients` and its sends queued in
 * `message_outbox` (that pair *is* the approval — nothing is enqueued for an
 * audience nobody approved). So the demand is a query, not a forecast:
 *
 *   pending segments = Σ segments(body) over `sms` outbox rows still
 *                      `queued` or `sending` for this business
 *   demand rial      = pending segments × the child's wholesale rate
 *
 * Two deliberate choices:
 *
 * - **Segments, not messages.** Billing does not charge per recipient, it
 *   charges per 70-character segment (`smsSegmentCount`), so a one-line SMS and
 *   a three-segment notification are not one unit of credit. The SQL below
 *   builds its arithmetic from the same two constants the billing module uses,
 *   so the two cannot drift.
 * - **The dearest script's rate**, like the buffer: a fleet is planned on its
 *   English (≈2.3× dearer) segment price, because under-funding is the failure
 *   mode and over-funding is not — the child keeps the credit either way.
 *
 * This is additive, never a replacement: the funding target becomes
 * `max(buffer, pending demand)`, so a campaign raises the target while it is
 * queued and the standing order takes over again the moment it has drained.
 * Nothing here is a second wallet, a reservation or a provider concept — it is
 * the number the planner was missing.
 */
import {
  SMS_FIRST_SEGMENT_CHARS,
  SMS_NEXT_SEGMENT_CHARS,
} from "../messaging-billing-pure";

/** Outbox states that still owe the provider a call. */
export const PENDING_OUTBOX_STATES = ["queued", "sending"] as const;

export interface CampaignDemand {
  /** Queued segments — the unit the provider bills. */
  segments: number;
  /** Queued recipients (segments ��� messages). */
  messages: number;
  /** Distinct approved campaigns with work in the queue. */
  campaigns: number;
  /** `segments × perSegmentRial`, floored. */
  estimatedWholesaleRial: number;
}

export const EMPTY_CAMPAIGN_DEMAND: CampaignDemand = {
  segments: 0,
  messages: 0,
  campaigns: 0,
  estimatedWholesaleRial: 0,
};

/**
 * Price a set of already-aggregated counts.
 *
 * Kept separate from the query so the arithmetic can be tested without a
 * database — and so a caller that has its own counts (a test, a backfill, a
 * future forecast) can reuse the same rule instead of re-deriving it.
 */
export function priceCampaignDemand(input: {
  segments: number;
  messages: number;
  campaigns: number;
  perSegmentRial: number;
}): CampaignDemand {
  const segments = Math.max(0, Math.trunc(input.segments) || 0);
  const perSegment = Math.max(0, Math.trunc(input.perSegmentRial) || 0);
  return {
    segments,
    messages: Math.max(0, Math.trunc(input.messages) || 0),
    campaigns: Math.max(0, Math.trunc(input.campaigns) || 0),
    estimatedWholesaleRial: segments * perSegment,
  };
}

/**
 * The segment-count expression, as SQL, for one body column.
 *
 * Built from `SMS_FIRST_SEGMENT_CHARS`/`SMS_NEXT_SEGMENT_CHARS` rather than
 * literals: the retail charge and the funding target are then guaranteed to
 * count segments identically, and changing the billing rule moves both.
 */
export const SMS_SEGMENTS_SQL = `CASE
            WHEN LENGTH($BODY$) <= ${SMS_FIRST_SEGMENT_CHARS} THEN 1
            ELSE 1 + CEIL(
              (LENGTH($BODY$) - ${SMS_FIRST_SEGMENT_CHARS})::numeric / ${SMS_NEXT_SEGMENT_CHARS}
            )
          END`;

/** The expression for a named body column, e.g. `smsSegmentsSql("r.body")`. */
export function smsSegmentsSql(column: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) {
    throw new Error(`smsSegmentsSql: refusing a non-column reference: ${column}`);
  }
  return SMS_SEGMENTS_SQL.replaceAll("$BODY$", column);
}
