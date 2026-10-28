/**
 * The one guard and error map every `/api/agency/*` route uses, the same shape
 * as `/api/aec/guard.ts` and `/api/workspace/guard.ts` next door.
 *
 * The permission story is §24's rule, and it is a *split* rather than one key:
 * writing a billing schedule is `workspace.manage`, while agreeing or refusing
 * somebody else's figure and issuing an invoice are determinations on
 * `workspace.approve`. Which act is which is not decided here — it is stated
 * once in `agency-commercial.ts`'s action catalogue and read from it, so a
 * route cannot drift from the register it serves.
 *
 * Issuing an invoice is one act with two halves: it is a determination *and* a
 * money movement, so its route demands `workspace.approve` plus the same pair
 * the invoice screen itself is gated on (`canUsePos` = `orders.create` &&
 * `payments.take`). Without the second half, a project manager who may not take
 * payments could take them through the workspace door instead.
 *
 * The owner resolver is the workspace's own, deliberately: these registers live
 * inside My Workspace projects, so a tenant whose workspace *projects* service
 * is deactivated must not be able to write a billing schedule through a
 * different path. Building on `aecOwner` instead would have skipped that gate,
 * because the AEC guard resolves a permission without one.
 */
import { NextResponse } from "next/server";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { AgencyCommercialError } from "@/lib/agency-commercial-service";
import {
  RetailInvoiceError,
  RetailRequestConflictError,
} from "@/lib/retail-invoice-service";
import type { Permission } from "@/lib/permissions";
import type { WorkspaceOwner } from "@/lib/workspace";
import {
  handleWorkspaceError,
  PERMISSIONS,
  readBody,
  workspaceOwner,
} from "../workspace/guard";

export { PERMISSIONS, readBody };

/**
 * The session behind a permission, shaped as the `WorkspaceOwner` the agency
 * service takes — with the workspace's service-activation gate applied to
 * mutating requests, for the reason given above.
 */
export async function agencyOwner(
  permission: Permission,
  request?: Request,
): Promise<{ owner: WorkspaceOwner; error: null } | { owner: null; error: NextResponse }> {
  return workspaceOwner(permission, request);
}

/**
 * The status each refusal deserves.
 *
 * The split is the one every register in this product uses: a record that does
 * not exist is a 404, a malformed field is a 400, and anything a record refuses
 * *because of where it is in its life cycle* is a 409 — the request was
 * reasonable and the state is what says no. `industry_mismatch` is a 403 for
 * the reason the AEC guard gives: the request is well-formed and the caller may
 * understand it perfectly, and it is the business's own industry that refuses.
 */
const ERROR_STATUS: Record<string, number> = {
  industry_mismatch: 403,
  // Missing records.
  milestone_not_found: 404,
  change_request_not_found: 404,
  approval_not_found: 404,
  // Malformed fields.
  title_required: 400,
  description_required: 400,
  due_date_required: 400,
  invalid_milestone_kind: 400,
  invalid_milestone_amount: 400,
  invalid_revenue_code: 400,
  invalid_date: 400,
  invalid_period: 400,
  invalid_hours: 400,
  invalid_billing_base: 400,
  invalid_schedule_impact: 400,
  invalid_milestone_action: 400,
  invalid_change_request_action: 400,
  invalid_change_request_amount: 400,
  // Refused by the state the record is in.
  milestone_not_editable: 409,
  change_request_not_editable: 409,
  invalid_milestone_transition: 409,
  invalid_change_request_transition: 409,
  change_request_amount_required: 409,
  approval_already_pending: 409,
  schedule_exists: 409,
  // An hourly engagement lays out no schedule, because it bills a period once
  // that period's hours are known. The request was reasonable; the shape says no.
  schedule_empty: 409,
  schedule_over_allocated: 409,
  // A percentage of a contract with no value is not "this milestone is free":
  // it is a refusal with a reason, and the reason is the missing value.
  contract_value_required: 409,
  customer_required: 409,
  location_required: 409,
};

/**
 * Maps a thrown error onto a response; rethrows anything else as a real 500.
 *
 * Invoicing a milestone leaves this module and enters the invoice service, so
 * three of its refusals can reach a route here. Each keeps the Persian sentence
 * it was raised with: an operator who cannot bill a milestone needs the reason
 * in the words the rest of the product uses, not a code to look up.
 *
 * Everything else that is not an agency code belongs to the workspace module —
 * `insufficient_project_role` is a 403 and `project_not_found` a 404, because a
 * project's existence is not disclosed to a non-member — and an agency-only map
 * would answer those plain refusals with a 500.
 */
export function handleAgencyError(err: unknown): NextResponse {
  if (err instanceof AgencyCommercialError) {
    return NextResponse.json({ error: err.code }, { status: ERROR_STATUS[err.code] ?? 400 });
  }
  if (err instanceof RetailRequestConflictError) {
    return NextResponse.json({ error: "request_conflict" }, { status: 409 });
  }
  if (err instanceof RetailInvoiceError) {
    return NextResponse.json({ error: "invoice_failed", message: err.message }, { status: 400 });
  }
  if (err instanceof MissingLedgerAccountError) {
    return NextResponse.json(
      { error: "missing_ledger_account", message: err.message },
      { status: 409 },
    );
  }
  return handleWorkspaceError(err);
}
