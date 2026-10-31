/**
 * The one guard and error map every `/api/crm/briefs*` route uses, the same shape
 * as `/api/media/review-guard.ts` and `/api/agency/guard.ts`.
 *
 * These routes sit in the CRM door rather than the agency one, and the difference
 * is the point. `/api/agency/guard.ts` resolves its owner through
 * `workspaceOwner`, which applies the workspace *projects* service gate and
 * project membership — right for a billing schedule, which lives inside a
 * project. A client brief is written during sales, usually before any project
 * exists, so gating it on the projects service would make it unusable in exactly
 * the moment §A's pipeline stage «بریف کارفرما» describes, and invisible to a
 * sales-only member who has the CRM and not the workspace.
 *
 * So: `crm.view` to read, `crm.manage` to write and to move a brief along its
 * chain, `crm.delete` to delete one. Nothing here is industry-gated — the
 * permission is the gate, and a tenant whose members hold it may use it, which is
 * §E's decision 32 applied again.
 */
import { NextResponse } from "next/server";
import {
  AGENCY_BRIEF_ERROR_CODES,
  AgencyBriefError,
  type AgencyBriefActor,
  type AgencyBriefErrorCode,
} from "@/lib/agency-brief-service";

/**
 * The status each refusal deserves, and the split every register in this product
 * uses: a record that does not exist is a 404, a malformed field is a 400, and
 * anything a record refuses *because of where it is in its life cycle* is a 409 —
 * the request was reasonable and the state is what says no.
 *
 * `objective_required` and `confirmer_required` sit on the 409 side for that
 * reason. Nothing is malformed about asking to send an empty brief; the brief's
 * own emptiness is what refuses.
 *
 * The map is exhaustive over `AgencyBriefErrorCode`, so adding a refusal to the
 * service without deciding its status is a compile error rather than a silent
 * 400.
 */
export const AGENCY_BRIEF_ERROR_STATUS: Record<AgencyBriefErrorCode, number> = {
  brief_not_found: 404,
  client_required: 400,
  title_required: 400,
  invalid_channel: 400,
  invalid_deliverable: 400,
  invalid_budget: 400,
  invalid_date: 400,
  invalid_period: 400,
  text_too_long: 400,
  invalid_action: 400,
  objective_required: 409,
  confirmer_required: 409,
  invalid_transition: 409,
  brief_frozen: 409,
  brief_not_deletable: 409,
};

/** The actor a tenant route passes down, from the session it already verified. */
export function briefActor(session: { sub: string; fullName?: string | null }): AgencyBriefActor {
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
 * This departs from §E in one place, deliberately. Migration 0274's trigger and
 * CHECKs raise `23514`, `23503` and `23505` *as domain rules* — a reference into
 * another tenant, an approver who is not this client's contact, a number that lost
 * a race — so they are refusals this feature means rather than accidents, and
 * answering them is more useful than a 500. Nothing in §E raises a deliberate
 * SQLSTATE, which is why its guard can rethrow everything unknown.
 */
export function briefErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AgencyBriefError) {
    const status = AGENCY_BRIEF_ERROR_STATUS[err.code] ?? 400;
    return NextResponse.json({ error: err.code }, { status });
  }
  const state = sqlStateOf(err);
  if (state === "23505") {
    return NextResponse.json(
      { error: "brief_refused", message: messageOf(err) },
      { status: 409 },
    );
  }
  if (state === "23514" || state === "23503") {
    return NextResponse.json(
      { error: "brief_refused", message: messageOf(err) },
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
export async function readBriefBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every code the service can throw, re-exported so a test can pin the map. */
export { AGENCY_BRIEF_ERROR_CODES, AgencyBriefError };
export type { AgencyBriefErrorCode };
