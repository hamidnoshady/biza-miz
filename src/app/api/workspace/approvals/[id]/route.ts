import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { decideApproval } from "@/lib/workspace";
import type { WorkspaceApprovalDecision } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../guard";

const DECISIONS: readonly WorkspaceApprovalDecision[] = [
  "approved", "rejected", "changes_requested", "cancelled",
];

/**
 * POST — decide a pending approval: approve, reject, request changes, or
 * (the requester) withdraw it.
 *
 * Deciding is `workspace.approve`; withdrawing your own request is ordinary
 * `workspace.manage` work. Beyond the permission, the service enforces who
 * may decide THIS request (`approvalDecisionError`): only the named approver
 * (or an administrator), never the requester, and for an unassigned request
 * a manager of the subject's project.
 *
 * The decision propagates to the subject inside the service: approving a
 * contract activates it, rejecting or requesting changes returns it to draft.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const body = await readBody(request);
    const decision = String(body.decision ?? "") as WorkspaceApprovalDecision;
    if (!DECISIONS.includes(decision)) {
      return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
    }
    const { owner, error } = await workspaceOwner(
      decision === "cancelled" ? PERMISSIONS.workspaceManage : PERMISSIONS.workspaceApprove,
    );
    if (error) return error;
    const { id } = await context.params;
    try {
      const approval = await decideApproval(owner, id, decision, String(body.note ?? ""));
      // Null means somebody else already decided it.
      if (!approval) return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
      return NextResponse.json({ approval });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
