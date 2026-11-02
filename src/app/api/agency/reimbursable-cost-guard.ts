/**
 * The error map for `/api/agency/reimbursable-costs/**`, exhaustive over the codes
 * `agency-reimbursable-cost-service.ts` can throw.
 *
 * ## Why a guard of its own rather than a branch in `agency/guard.ts`
 *
 * The shared agency guard maps `AgencyCommercialError` and delegates the rest to the
 * workspace module, because a milestone and a change request are workspace documents
 * whose refusals are workspace refusals. A reimbursable cost is not: it is an
 * accounting record that happens to be industry-gated, it posts to the ledger, and it
 * is written on `finance.expenses_manage` rather than `workspace.manage` — the same key
 * an ordinary expense uses, because the difference between them is which account the
 * money lands in and not whether the act is accounting work.
 *
 * So this guard owns the cost's own twelve codes, and the routes compose it with the
 * shared one:
 *
 *     const response = costErrorResponse(err);
 *     if (response) return response;
 *     return handleAgencyError(err);
 *
 * That composition is deliberate and load-bearing. `MissingLedgerAccountError` is what
 * the posting rule throws when a tenant's chart no longer carries 1270 or 5197, and
 * `handleAgencyError` already answers it with a 409 in the words the rest of the
 * product uses; a cost-only map would answer it with a 500. Neither handler swallows
 * what it does not recognise, so an unexpected error still reaches the platform's own
 * log instead of being laundered into a generic message.
 */
import { NextResponse } from "next/server";
import {
  AGENCY_REIMBURSABLE_COST_ERROR_CODES,
  AgencyReimbursableCostError,
  type AgencyReimbursableCostErrorCode,
} from "@/lib/agency-reimbursable-cost-service";

/**
 * The status each refusal deserves.
 *
 * The split is the one every register in this product uses: a record that does not
 * exist is a 404, a malformed field is a 400, and anything a record refuses *because
 * of where it is in its life cycle* is a 409 — the request was reasonable and the
 * state is what says no. `cost_posted` is the only 409 here and it is exactly that
 * case: the ledger already carries the figure, so the correction is a reversal and a
 * new record rather than an edit.
 *
 * `not_agency` is a 403 for the reason the shared agency guard gives
 * `industry_mismatch`: the request is well-formed and the caller may understand it
 * perfectly, and it is the business's own industry that refuses.
 */
export const REIMBURSABLE_COST_ERROR_STATUS: Record<AgencyReimbursableCostErrorCode, number> = {
  cost_not_found: 404,
  not_agency: 403,
  client_required: 400,
  description_required: 400,
  amount_required: 400,
  invalid_amount: 400,
  date_required: 400,
  invalid_date: 400,
  invalid_presentation: 400,
  invalid_settlement: 400,
  text_too_long: 400,
  cost_posted: 409,
};

/** The SQLSTATE on an error, read off the shape rather than by importing `pg`. */
function sqlStateOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function messageOf(err: unknown): string | undefined {
  return err instanceof Error && err.message ? err.message : undefined;
}

/**
 * Map a refusal to a response, or null when it is not one — in which case the route
 * hands the error to `handleAgencyError`, which owns the workspace and ledger codes.
 *
 * 0280's trigger raises `23514` as a *domain rule*: a client or a project from
 * another tenant. The FK proves a uuid exists and only that trigger proves it is this
 * business's, so the refusal is a fact this feature means rather than an accident, and
 * it is translated here rather than surfacing as a 500.
 */
export function costErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AgencyReimbursableCostError) {
    const status = REIMBURSABLE_COST_ERROR_STATUS[err.code] ?? 400;
    return NextResponse.json({ error: err.code }, { status });
  }
  const state = sqlStateOf(err);
  if (state === "23505") {
    // A cost number that lost a race for the same series position. Retrying the
    // identical request is the answer, so it is a collision and not a malformed one.
    return NextResponse.json({ error: "cost_refused", message: messageOf(err) }, { status: 409 });
  }
  if (state === "23514" || state === "23503") {
    return NextResponse.json({ error: "cost_refused", message: messageOf(err) }, { status: 400 });
  }
  return null;
}

/**
 * Parse a JSON body, or null.
 *
 * A malformed body is a 400 rather than a thrown exception: a member posting from a
 * stale tab is told their request was wrong, not that the server broke.
 */
export async function readCostBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The actor a tenant route passes down, from the session it already verified. */
export function costActor(session: { sub: string; fullName?: string | null }): {
  userId: string;
  name: string;
} {
  return { userId: session.sub, name: session.fullName ?? "" };
}

export { AGENCY_REIMBURSABLE_COST_ERROR_CODES, AgencyReimbursableCostError };
export type { AgencyReimbursableCostErrorCode };
