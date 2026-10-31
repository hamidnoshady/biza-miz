/**
 * The one guard and error map every `/api/crm/proposals*` route uses, the same
 * shape as `brief-guard.ts` next door.
 *
 * These routes sit in the CRM door rather than the agency one, for the reason
 * decision 39 gives: `/api/agency/guard.ts` resolves its owner through
 * `workspaceOwner`, which applies the workspace *projects* service gate and
 * project membership. A proposal is written during sales, usually before any
 * project exists — §B's own stage list puts «proposal/quote» two steps ahead of
 * «kickoff» — so gating it on the projects service would make it unusable in
 * exactly the moment it is needed, and invisible to a sales-only member who has
 * the CRM and not the workspace.
 *
 * So: `crm.view` to read, `crm.manage` to write and to move an offer along its
 * chain, `crm.delete` to delete one. Nothing here is industry-gated — the
 * permission is the gate, and a tenant whose members hold it may use it.
 *
 * `accept` and `decline` are on `crm.manage` and not on a stronger permission,
 * which follows the brief's `confirm` rather than §D's change-request `approve`.
 * A proposal's decision is the **client's**, and the agency member is the scribe
 * recording it; §D's `approve` is an internal determination about money that
 * moves, which is a different power. Nothing here posts an entry and nothing here
 * becomes a receivable — an accepted proposal is an agreement that money will
 * become due, and §D's registers own the moment it does.
 */
import { NextResponse } from "next/server";
import {
  AGENCY_PROPOSAL_ERROR_CODES,
  AgencyProposalError,
  type AgencyProposalActor,
  type AgencyProposalErrorCode,
} from "@/lib/agency-proposal-service";

/**
 * The status each refusal deserves, and the split every register in this product
 * uses: a record that does not exist is a 404, a malformed field is a 400, and
 * anything a record refuses *because of where it is in its life cycle* is a 409 —
 * the request was reasonable and the state is what says no.
 *
 * `lines_required`, `decider_required` and `proposal_lapsed` sit on the 409 side
 * for that reason. Nothing is malformed about asking to send an offer, or to
 * accept one; the offer's own emptiness, its missing stakeholder and its expiry
 * date are what refuse.
 *
 * `invalid_discount` is on the 400 side even though it compares the header against
 * the sum of its lines: a discount past the subtotal is a figure the member typed
 * wrong, not a state the record happens to be in.
 *
 * The map is exhaustive over `AgencyProposalErrorCode`, so adding a refusal to the
 * service without deciding its status is a compile error rather than a silent 400.
 */
export const AGENCY_PROPOSAL_ERROR_STATUS: Record<AgencyProposalErrorCode, number> = {
  proposal_not_found: 404,
  client_required: 400,
  title_required: 400,
  invalid_line: 400,
  invalid_discount: 400,
  invalid_date: 400,
  invalid_reference: 400,
  text_too_long: 400,
  invalid_action: 400,
  lines_required: 409,
  decider_required: 409,
  invalid_transition: 409,
  proposal_frozen: 409,
  proposal_lapsed: 409,
  proposal_not_deletable: 409,
};

/** The actor a tenant route passes down, from the session it already verified. */
export function proposalActor(session: {
  sub: string;
  fullName?: string | null;
}): AgencyProposalActor {
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
 * Returning null rather than a blanket 500 is §E's rule, and it holds: a route
 * rethrows what this does not recognise, so an unexpected error still reaches the
 * platform's own handler and log instead of being laundered into a generic
 * message.
 *
 * Migration 0276's trigger and CHECKs raise `23514`, `23503` and `23505` *as
 * domain rules* — a reference into another tenant, a brief priced for a different
 * client, a stakeholder with no edge to this one, a number that lost a race — so
 * they are refusals this feature means rather than accidents, and answering them
 * is more useful than a 500. That is also where §A's separation rule reaches the
 * member: the trigger owns it, and this is what translates it.
 */
export function proposalErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AgencyProposalError) {
    const status = AGENCY_PROPOSAL_ERROR_STATUS[err.code] ?? 400;
    return NextResponse.json({ error: err.code }, { status });
  }
  const state = sqlStateOf(err);
  if (state === "23505") {
    return NextResponse.json(
      { error: "proposal_refused", message: messageOf(err) },
      { status: 409 },
    );
  }
  if (state === "23514" || state === "23503") {
    return NextResponse.json(
      { error: "proposal_refused", message: messageOf(err) },
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
export async function readProposalBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every code the service can throw, re-exported so a test can pin the map. */
export { AGENCY_PROPOSAL_ERROR_CODES, AgencyProposalError };
export type { AgencyProposalErrorCode };
