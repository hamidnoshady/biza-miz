/**
 * Phase G — the one guard + error mapping every `/api/workspace/*` route uses.
 *
 * Without this each of the ten route files would re-implement the same four
 * lines (permission check, owner construction, WorkspaceError → status, unknown
 * → rethrow), and the fourth one would be the one that quietly returned 500 for
 * a validation error.
 *
 * Note what this file does NOT do: it never invents authorization. It calls
 * `requirePermission` from `@/lib/auth`, the same gate the rest of the product
 * uses, so `api-guards.test.ts` sees a real guard in every route that imports
 * it and a member's per-member overrides apply exactly as they do everywhere
 * else.
 */
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { WorkspaceError, type WorkspaceOwner } from "@/lib/workspace";
import { workspaceAccessFlags } from "@/lib/workspace-shared";

export { PERMISSIONS };

/**
 * Resolves the session behind a workspace permission and shapes it into the
 * `WorkspaceOwner` every service function takes — including its access
 * flags, read from the member's CURRENT effective permissions (not the
 * token's), so a revoked `workspace.admin` stops reaching every project on
 * the next request.
 *
 * The platform permission only opens the area. Which projects the member
 * reaches is decided by the service from these flags and their project role.
 */
export async function workspaceOwner(
  permission: Permission,
): Promise<{ owner: WorkspaceOwner; error: null } | { owner: null; error: NextResponse }> {
  const { session, membership, error } = await requirePermission(permission);
  if (error) return { owner: null, error };
  return {
    owner: {
      businessId: session.businessId,
      actorUserId: session.sub,
      actorName: session.fullName ?? "",
      access: workspaceAccessFlags(membership.permissions),
    },
    error: null,
  };
}

/**
 * The status each service error code deserves. Anything absent is a bug in the
 * service, not a client error, so it falls through to the rethrow in
 * `handleWorkspaceError` and surfaces as a 500 with a stack trace rather than
 * being silently dressed up as a 400.
 */
const ERROR_STATUS: Record<string, number> = {
  project_not_found: 404,
  task_not_found: 404,
  contract_not_found: 404,
  document_not_found: 404,
  approval_not_found: 404,
  party_not_found: 400,
  user_not_found: 400,
  template_not_found: 404,
  subject_not_found: 404,
  phase_not_found: 404,
  media_not_found: 400,
  journal_entry_not_found: 400,
  insufficient_project_role: 403,
  not_the_approver: 403,
  not_the_requester: 403,
  self_approval_forbidden: 403,
  last_owner_cannot_be_removed: 409,
  transfer_ownership_first: 409,
  phase_not_in_project: 400,
  task_project_mismatch: 400,
  contract_project_mismatch: 400,
  journal_entry_project_mismatch: 400,
  approval_project_mismatch: 400,
  invalid_position: 400,
  invalid_time: 400,
  dependency_cycle: 409,
  dependency_across_projects: 400,
  end_before_start: 400,
  project_name_required: 400,
  task_title_required: 400,
  contract_title_required: 400,
  document_title_required: 400,
  event_title_required: 400,
  event_date_required: 400,
  phase_name_required: 400,
  checklist_title_required: 400,
  comment_required: 400,
  template_name_required: 400,
  template_needs_phases: 400,
  subject_required: 400,
  invalid_project_status: 400,
  invalid_task_status: 400,
  invalid_phase_status: 400,
  invalid_priority: 400,
  invalid_contract_type: 400,
  invalid_contract_status: 400,
  invalid_document_status: 400,
  invalid_approval_subject: 400,
  invalid_event_kind: 400,
  invalid_workspace_role: 400,
  invalid_date: 400,
  invalid_project_budget: 400,
  invalid_contract_value: 400,
  invalid_reminder_days: 400,
};

/** Maps a thrown `WorkspaceError` onto a response; rethrows anything else. */
export function handleWorkspaceError(err: unknown): NextResponse {
  if (err instanceof WorkspaceError) {
    return NextResponse.json({ error: err.code }, { status: ERROR_STATUS[err.code] ?? 400 });
  }
  throw err;
}

/** Reads a JSON body, returning `{}` rather than throwing on a malformed one. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}
