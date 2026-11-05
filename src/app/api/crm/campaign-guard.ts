/**
 * The one guard and error map every `/api/crm/campaigns*` route uses, the same
 * shape as `proposal-guard.ts` and `brief-guard.ts` next door.
 *
 * ## Why these are client *campaigns* under the CRM door
 *
 * The name collides with two other records in this product, and the collision is
 * the reason this file exists separately rather than joining one of them.
 * `/api/growth/campaign-builder` is #901's retail cashback automation — trigger
 * `pos_sale_settled`, reward `cashback` — where the party is the shopper earning
 * money back. `message_campaigns` is an SMS broadcast with its own credit ledger.
 * Neither is an agency's media plan for a client, and 0278's header records why
 * giving either of them a client column would have made one field mean two things
 * in two trades.
 *
 * The door follows the client rather than the app: a campaign belongs to a client
 * relationship, is counted per brand on that client's organisation card, and is
 * written by the same members who write that client's briefs and proposals. So
 * `crm.view` to read, `crm.manage` to write and to move it through its lifecycle,
 * `crm.delete` to delete one. Nothing here is industry-gated — the permission is
 * the gate — and nothing here posts an entry or becomes a receivable: media spend
 * is §D's business, and this record only reports what was spent.
 */
import { NextResponse } from "next/server";
import {
  AGENCY_CAMPAIGN_ERROR_CODES,
  AgencyCampaignError,
  type AgencyCampaignErrorCode,
} from "@/lib/agency-campaign-service";

/**
 * The status each refusal deserves.
 *
 * Exhaustive over `AgencyCampaignErrorCode`, so adding a refusal to the service
 * without deciding its status is a compile error rather than a silent 400. See the
 * service's own docblock for the split: 404 for a record that is not there, 400 for
 * a field typed wrong, 409 for a record that refuses because of where it is in its
 * life cycle.
 */
export const AGENCY_CAMPAIGN_ERROR_STATUS: Record<AgencyCampaignErrorCode, number> = {
  campaign_not_found: 404,
  client_required: 400,
  title_required: 400,
  text_too_long: 400,
  invalid_channel: 400,
  too_many_channels: 400,
  invalid_date: 400,
  window_reversed: 400,
  invalid_metric: 400,
  clicks_exceed_impressions: 400,
  invalid_metrics_source: 400,
  invalid_reference: 400,
  invalid_action: 400,
  invalid_transition: 409,
  campaign_closed: 409,
  start_date_required: 409,
  end_date_required: 409,
  campaign_not_deletable: 409,
};

/** The actor a tenant route passes down, from the session it already verified. */
export function campaignActor(session: {
  sub: string;
  fullName?: string | null;
}): { userId: string; name: string } {
  return { userId: session.sub, name: session.fullName ?? "" };
}

/**
 * The SQLSTATE on an error, if it has one that looks like a SQLSTATE.
 *
 * Read off the shape rather than by importing `pg`'s error class: this module is
 * imported by route files, and a driver import here would only serve an
 * `instanceof`.
 */
function sqlStateOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function messageOf(err: unknown): string | undefined {
  return err instanceof Error && err.message ? err.message : undefined;
}

/**
 * Map a refusal to a response, or null when it is not one.
 *
 * Returning null rather than a blanket 500 is §E's rule and it holds: a route
 * rethrows what this does not recognise, so an unexpected error still reaches the
 * platform's own handler and log instead of being laundered into a generic message.
 *
 * 0278's trigger raises `23514` *as a domain rule* — a client from another tenant,
 * or one brand's campaign carrying another brand's brief or proposal — so it is a
 * refusal this feature means rather than an accident. That is where §A's
 * "multiple brands … without exposing another client's information" reaches the
 * member: the trigger owns the rule and this is what translates it.
 */
export function campaignErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AgencyCampaignError) {
    const status = AGENCY_CAMPAIGN_ERROR_STATUS[err.code] ?? 400;
    return NextResponse.json({ error: err.code }, { status });
  }
  const state = sqlStateOf(err);
  if (state === "23505") {
    // A campaign number that lost a race for the same series position.
    return NextResponse.json(
      { error: "campaign_refused", message: messageOf(err) },
      { status: 409 },
    );
  }
  if (state === "23514" || state === "23503") {
    return NextResponse.json(
      { error: "campaign_refused", message: messageOf(err) },
      { status: 400 },
    );
  }
  return null;
}

/**
 * Parse a JSON body, or null.
 *
 * A malformed body is a 400 and not a thrown exception: a member posting from a
 * stale tab should be told their request was wrong, not that the server broke.
 */
export async function readCampaignBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every code the service can throw, re-exported so a test can pin the map. */
export { AGENCY_CAMPAIGN_ERROR_CODES, AgencyCampaignError };
export type { AgencyCampaignErrorCode };
