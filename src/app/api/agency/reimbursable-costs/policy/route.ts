import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  AGENCY_PASS_THROUGH_PRESENTATION_HINTS,
  AGENCY_PASS_THROUGH_PRESENTATION_LABELS,
  AGENCY_PASS_THROUGH_PRESENTATIONS,
  AGENCY_DEFAULT_PRESENTATION,
} from "@/lib/agency-reimbursable-cost";
import { loadAgencyCostPolicy, saveAgencyCostPolicy } from "@/lib/agency-reimbursable-cost-service";
import { handleAgencyError } from "../../guard";
import { costActor, costErrorResponse } from "../../reimbursable-cost-guard";

/**
 * GET/PUT /api/agency/reimbursable-costs/policy — §D's *business-level* choice of
 * gross-versus-net presentation (issue #1128).
 *
 * §D requires that gross versus net "must follow chosen business accounting policy
 * and must not be inferred solely from spend". Wave 10 stored the choice per cost row
 * and left the business with no place to state it once, so every row was a fresh
 * decision and the default was the software's. This is where the business chooses.
 *
 * **Why it lives under the register and not under `/api/settings/`, beside
 * `agency-profile`.** The profile rides `settings.manage` because it is business-wide
 * configuration that reorders a list and, in its own words, decides "nothing else".
 * This decides which of two accounts money lands in — 1270, a claim on the client, or
 * 5197, the agency's own cost of sale — so it rides the permissions of the register it
 * governs: `ledger.view` to read, `finance.expenses_manage` to change, exactly as
 * decision 61 set them. Putting it under `/api/settings/` would hand the office's
 * accountant a 403 on the policy that governs the rows they record, which is the
 * failure decision 61 exists to prevent. `/api/ledger/settings` states the same rule
 * from the other side: editable surfaces live where they are owned, rather than
 * forking a second editor over one table.
 *
 * GET answers with the labels and hints inline, unlike the profile route which leaves
 * them to the form. The difference is deliberate: those two words decide a posting,
 * and a screen that renders the choice from its own copy of the vocabulary can drift
 * from the one the ledger uses. Here the API is the only source, so the words a member
 * reads are the words the code acted on.
 *
 * PUT replaces the policy. It is **not retroactive** and cannot be — 0280's trigger
 * freezes `presentation` on any cost whose entry has landed, so a policy change reaches
 * only costs recorded afterwards. Correcting a cost recorded under the wrong treatment
 * is a reversal and a new record, not a policy reaching backwards into the ledger.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  try {
    const policy = await loadAgencyCostPolicy(session.businessId);
    return NextResponse.json({
      policy,
      // What a member chooses between, in the register's own words, with the account
      // each one lands in named — because the choice is a posting and not a label.
      options: AGENCY_PASS_THROUGH_PRESENTATIONS.map((key) => ({
        value: key,
        label: AGENCY_PASS_THROUGH_PRESENTATION_LABELS[key],
        hint: AGENCY_PASS_THROUGH_PRESENTATION_HINTS[key],
      })),
      // Named separately so a screen can tell «this is what you chose» from «this is
      // what happens while you have not chosen», which `policy.stored` already says
      // but a default rendered on its own does not.
      fallback: AGENCY_DEFAULT_PRESENTATION,
    });
  } catch (err) {
    const handled = costErrorResponse(err);
    if (handled) return handled;
    return handleAgencyError(err);
  }
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeExpensesManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const actor = costActor(session);
    const policy = await saveAgencyCostPolicy(
      {
        businessId: session.businessId,
        locationId: session.locationId ?? null,
        userId: actor.userId,
        name: actor.name,
      },
      body,
    );
    // The saved state, in the same shape the read gives, so the form never has to
    // re-fetch to learn whether its choice took.
    return NextResponse.json({ policy });
  } catch (err) {
    const handled = costErrorResponse(err);
    if (handled) return handled;
    return handleAgencyError(err);
  }
});
