import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { isVariationAction, variationActionNeedsApproval } from "@/lib/aec-commercial";
import { applyVariationAction, variationProjectId } from "@/lib/aec-commercial-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * §15's chain, one endpoint — the same shape as the RFI, submittal and site
 * status routes, and for the same reason: the transitions belong together, so
 * the chain is one readable list rather than eight routes that can drift apart.
 *
 * Two permissions, deliberately not one (§24's rule that a high-risk commercial
 * action must not inherit ordinary edit rights):
 *
 *   * `price`, `submit` and `reopen` are somebody still writing the change —
 *     `workspace.manage`, like every other register edit in this module;
 *   * `review`, `approve`, `reject`, `implement` and `cancel` are the
 *     determinations: agreeing a figure with the client, rejecting it, ordering
 *     the work done. They need `workspace.approve`, the key no role below
 *     manager holds by preset, and `approve` additionally sets the agreed amount
 *     that migration 0200's trigger folds into the contract's revised value.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "");
    if (!isVariationAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needsApproval = variationActionNeedsApproval(action);
    const { owner, error } = await aecOwner(
      needsApproval ? PERMISSIONS.workspaceApprove : PERMISSIONS.workspaceManage,
    );
    if (error) return error;

    try {
      const projectId = await variationProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, needsApproval ? "view" : "manage");
      const variation = await applyVariationAction(owner, id, action, {
        approvedAmountRial: body.approvedAmountRial,
        note: body.note,
      });
      return NextResponse.json({ variation });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
