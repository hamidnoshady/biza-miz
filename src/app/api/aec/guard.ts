/**
 * The one guard and error map every `/api/aec/*` route uses, the same shape as
 * `/api/workspace/guard.ts` next door.
 *
 * The permission story is the issue's §24 rule: an AEC action is the platform
 * permission intersected with the member's **project role** where the action is
 * project-scoped. Reading and writing project AEC data therefore goes through
 * `requireProjectCapability` on top of `workspace.view`/`workspace.manage`; the
 * business's operating profile is business configuration and runs on
 * `settings.manage`, the same key the settings screen that edits it is gated by.
 */
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { AecError } from "@/lib/aec-service";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import type { WorkspaceOwner } from "@/lib/workspace";
import { handleWorkspaceError } from "../workspace/guard";

export { PERMISSIONS };

/** Resolves the session behind a permission into the `WorkspaceOwner` the AEC service takes. */
export async function aecOwner(
  permission: Permission,
): Promise<{ owner: WorkspaceOwner; error: null } | { owner: null; error: NextResponse }> {
  const { session, error } = await requirePermission(permission);
  if (error) return { owner: null, error };
  return {
    owner: {
      businessId: session.businessId,
      actorUserId: session.sub,
      actorName: session.fullName ?? "",
    },
    error: null,
  };
}

/**
 * The status each AEC error code deserves.
 *
 * `industry_mismatch` and `role_not_allowed` are 403 rather than 400: the
 * request is well-formed and the caller may understand it perfectly — the
 * business's industry or its chosen operating profile is what refuses it, and
 * the body says exactly which.
 */
const ERROR_STATUS: Record<string, number> = {
  industry_mismatch: 403,
  role_not_allowed: 403,
  invalid_operating_profile: 400,
  invalid_date: 400,
  invalid_coordinate: 400,
  invalid_area: 400,
  invalid_floor_count: 400,
  invalid_progress: 400,
  invalid_reference: 400,
  end_before_start: 400,
  party_not_found: 400,
  user_not_found: 400,
  project_not_found: 404,
  participant_not_found: 404,
  participant_exists: 409,
  // Issue #799 Wave 4 — the estimating domain.
  //
  // `capability_disabled` is 403 for the same reason `industry_mismatch` is:
  // the request is well-formed and the caller may be perfectly entitled to use
  // the product — it is the business's own operating profile that does not
  // include estimating. The body says so, and the settings screen is where the
  // answer is one switch away.
  capability_disabled: 403,
  estimate_not_found: 404,
  estimate_version_not_found: 404,
  approval_not_found: 404,
  estimate_title_required: 400,
  invalid_boq_section: 400,
  invalid_boq_item: 400,
  invalid_quantity: 400,
  invalid_material_rate: 400,
  invalid_labor_rate: 400,
  invalid_equipment_rate: 400,
  invalid_subcontract_rate: 400,
  invalid_waste_percent: 400,
  invalid_overhead_percent: 400,
  invalid_markup_percent: 400,
  boq_total_out_of_range: 400,
  // Both are conflicts with the state the record is in rather than bad input:
  // the caller asked something sensible of a revision that has already moved on.
  version_not_editable: 409,
  invalid_estimate_transition: 409,
  estimate_has_approved_version: 409,
  estimate_empty: 409,
  // Issue #799 Wave 5 — document control (§9 and §12). The split is the same
  // one the estimating codes use: a missing record is a 404, a malformed field
  // is a 400, and everything a *frozen* record refuses is a 409, because the
  // request was reasonable and the state is what says no.
  drawing_not_found: 404,
  revision_not_found: 404,
  transmittal_not_found: 404,
  recipient_not_found: 404,
  document_number_required: 400,
  drawing_title_required: 400,
  transmittal_number_required: 400,
  invalid_document_type: 400,
  invalid_discipline: 400,
  invalid_issue_purpose: 400,
  invalid_revision_code: 400,
  invalid_transmittal_item: 400,
  invalid_recipient: 400,
  document_number_taken: 409,
  revision_code_taken: 409,
  transmittal_number_taken: 409,
  revision_not_editable: 409,
  transmittal_not_editable: 409,
  drawing_has_issued_revisions: 409,
  transmittal_empty: 409,
  transmittal_has_no_recipients: 409,
  transmittal_not_issued: 409,
  recipient_already_acknowledged: 409,
  // Issue #799 Wave 6 — RFIs (§10) and submittals (§11). Same split again: a
  // missing record is a 404, a malformed field a 400, and everything a record
  // refuses *because of where it is in its life cycle* a 409.
  rfi_not_found: 404,
  submittal_not_found: 404,
  submittal_revision_not_found: 404,
  media_not_found: 404,
  document_not_found: 404,
  rfi_number_required: 400,
  rfi_subject_required: 400,
  rfi_question_required: 400,
  rfi_response_required: 400,
  submittal_number_required: 400,
  submittal_title_required: 400,
  submittal_file_required: 400,
  invalid_submittal_type: 400,
  invalid_rfi_status: 400,
  invalid_cost_impact: 400,
  invalid_schedule_impact: 400,
  rfi_number_taken: 409,
  submittal_number_taken: 409,
  rfi_not_editable: 409,
  submittal_not_editable: 409,
  submittal_revision_not_editable: 409,
  submittal_has_submitted_revisions: 409,
  submittal_first_revision_required: 409,
  invalid_rfi_transition: 409,
  invalid_submittal_transition: 409,
  // Issue #799 Wave 7 — site execution (§13) and the QA register (§14). The
  // split is the same one every wave before it uses: a missing record is a 404,
  // a malformed field a 400, and everything a *frozen* day or a closed issue
  // refuses — including a closeout by the person who did the work — a 409,
  // because the request was reasonable and the state says no.
  site_log_not_found: 404,
  site_issue_not_found: 404,
  checklist_not_found: 404,
  invalid_site_log_line: 400,
  invalid_site_issue_kind: 400,
  invalid_site_check: 400,
  invalid_site_issue_result: 400,
  invalid_category: 400,
  invalid_severity: 400,
  site_issue_title_required: 400,
  site_log_work_required: 400,
  invalid_checklist_kind: 400,
  checklist_name_required: 400,
  checklist_item_required: 400,
  site_log_exists: 409,
  site_issue_number_taken: 409,
  checklist_name_taken: 409,
  site_log_not_editable: 409,
  site_issue_not_editable: 409,
  invalid_site_log_transition: 409,
  invalid_site_issue_transition: 409,
  site_issue_resolution_required: 409,
  site_issue_result_required: 409,
  checklist_not_for_kind: 409,
  // §14's four-eyes rule: the person the fix was assigned to cannot sign it off.
  site_issue_verifier_is_assignee: 409,
};

/**
 * Maps a thrown error onto a response; rethrows anything else as a real 500.
 *
 * Every AEC project route sits on top of the workspace module's per-project
 * authorization (`requireProjectCapability`), which refuses with its own
 * `WorkspaceError` — `not_a_project_member` and `insufficient_project_role`
 * are 403s, `project_not_found` a 404. Those codes are not AEC codes, so an
 * AEC-only map would fall through to the `throw` and answer a plain refusal
 * with a 500; the workspace map owns them and is asked here.
 */
export function handleAecError(err: unknown): NextResponse {
  if (err instanceof AecError) {
    return NextResponse.json({ error: err.code }, { status: ERROR_STATUS[err.code] ?? 400 });
  }
  return handleWorkspaceError(err);
}

/** Reads a JSON body, returning `{}` rather than throwing on a malformed one. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}
