import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { decideEstimateApproval } from "@/lib/aec-boq-service";
import { decideCertificateApproval, decideVariationApproval } from "@/lib/aec-commercial-service";
import { decideSubmittalApproval } from "@/lib/aec-rfi-service";
import { approvalSubjectType, decideApproval } from "@/lib/workspace";
import type { WorkspaceApprovalDecision } from "@/lib/workspace-shared";
import { handleAecError } from "../../../aec/guard";
import { PERMISSIONS, readBody, workspaceOwner } from "../../guard";

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
 *
 * §15 and §16 (Wave 8) are the commercial pair (`decideVariationApproval`,
 * `decideCertificateApproval`). Approving a change order sets the agreed amount
 * and, through migration 0200's trigger, the contract's revised value;
 * certifying a claim fixes the certified figure. Both are `workspace.approve`
 * decisions however they are reached, which is §24's rule for them.
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
      if (subjectType === "variation") {
        const result = await decideVariationApproval(owner, id, decision, note);
        if (!result.applied) {
          return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
        }
        return NextResponse.json({ approval: null, variationId: result.variationId });
      }
      if (subjectType === "payment_certificate") {
        const result = await decideCertificateApproval(owner, id, decision, note);
        if (!result.applied) {
          return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
        }
        return NextResponse.json({ approval: null, certificateId: result.certificateId });
      }
      const approval = await decideApproval(owner, id, decision, note);
      // Null means "no pending approval with this id" — either it never
      // existed for this business, or somebody else already decided it.
      if (!approval) return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
      return NextResponse.json({ approval });
    } catch (err) {
      // The AEC subjects decide through their own modules, whose refusals are
      // `AecError`s; `handleAecError` maps those and falls through to the
      // workspace guard for everything else, so one catch covers both.
      return handleAecError(err);
    }
  },
);
