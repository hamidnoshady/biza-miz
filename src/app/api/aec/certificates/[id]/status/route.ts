import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { certificateActionNeedsApproval, isCertificateAction } from "@/lib/aec-commercial";
import { applyCertificateAction, certificateProjectId } from "@/lib/aec-commercial-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * §16's cycle, one endpoint.
 *
 * Two permissions, for the same reason the variation route splits them:
 *
 *   * `submit` (send the claim) and `reopen` (return it to draft to re-measure
 *     it) are the claimant's own work — `workspace.manage`;
 *   * `review`, `certify`, `reject` and `cancel` are determinations on somebody
 *     else's money and need `workspace.approve`. `certify` fixes the approved
 *     figure and the date; it does not record a receipt — the money that moved
 *     stays in Accounting (§16's boundary, and the reason nothing here stores a
 *     paid balance).
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "");
    if (!isCertificateAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needsApproval = certificateActionNeedsApproval(action);
    const { owner, error } = await aecOwner(
      needsApproval ? PERMISSIONS.workspaceApprove : PERMISSIONS.workspaceManage,
    );
    if (error) return error;

    try {
      const projectId = await certificateProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, needsApproval ? "view" : "manage");
      const certificate = await applyCertificateAction(owner, id, action, {
        approvedAmountRial: body.approvedAmountRial,
        note: body.note,
      });
      return NextResponse.json({ certificate });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
