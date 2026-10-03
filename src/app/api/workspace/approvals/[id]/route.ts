import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { decideEstimateApproval } from "@/lib/aec-boq-service";
import { decideSubmittalApproval } from "@/lib/aec-rfi-service";
import { approvalSubjectType, decideApproval } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../guard";

/**
 * POST — decide a pending approval. Gated on `workspace.approve`, which no
 * role below manager holds by preset.
 *
 * The decision propagates to the subject inside the service: approving a
 * contract activates it, rejecting a document marks it rejected. An approval
 * that changed nothing would be a comment.
 *
 * Issue #799 §7 — a BOQ revision is one of those subjects, and its propagation
 * lives with the estimating module (`decideEstimateApproval`), which owns the
 * revision's status, the budget connection and the history. This route only
 * decides WHOSE code runs, so an approval filed against a revision has one
 * implementation of "approved" whether it is decided here or on the BOQ screen.
 *
 * §11's submittal revision (Wave 6) is the same arrangement with the document
 * module (`decideSubmittalApproval`): an approval queued for a submission maps
 * onto the revision's own decision, so the queue and the submittal screen record
 * one decision, not two.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceApprove);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    const decision = String(body.decision ?? "");
    if (decision !== "approved" && decision !== "rejected" && decision !== "cancelled") {
      return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
    }
    const note = String(body.note ?? "");
    try {
      const subjectType = await approvalSubjectType(owner.businessId, id);
      if (subjectType === "estimate_version") {
        const result = await decideEstimateApproval(owner, id, decision, note);
        if (!result.applied) {
          return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
        }
        return NextResponse.json({ approval: null, estimateVersionId: result.versionId });
      }
      if (subjectType === "submittal_revision") {
        const result = await decideSubmittalApproval(owner, id, decision, note);
        if (!result.applied) {
          return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
        }
        return NextResponse.json({ approval: null, submittalRevisionId: result.revisionId });
      }
      const approval = await decideApproval(owner, id, decision, note);
      // Null means "no pending approval with this id" — either it never
      // existed for this business, or somebody else already decided it.
      if (!approval) return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
      return NextResponse.json({ approval });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
