import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { commitmentActionNeedsApproval, isCommitmentAction } from "@/lib/aec-procurement";
import { applyCommitmentAction, commitmentProjectId } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * §18's commitment chain, one endpoint.
 *
 * This is the flow's money decision, so §24's split is at its sharpest:
 *
 *   * `submit` files the award for approval, `deliver` records that it arrived,
 *     `close` and `reopen` keep the register tidy — `workspace.manage`;
 *   * `approve` and `reject` are the determination that obliges the business, and
 *     `cancel` withdraws an award already approved. They need
 *     `workspace.approve`, the key no role below manager holds by preset, and the
 *     split is stated in the module (`commitmentActionNeedsApproval`) rather than
 *     hardcoded here, exactly as the change orders' and certificates' status
 *     routes do it.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "");
    if (!isCommitmentAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needsApproval = commitmentActionNeedsApproval(action);
    const { owner, error } = await aecOwner(
      needsApproval ? PERMISSIONS.workspaceApprove : PERMISSIONS.workspaceManage,
    );
    if (error) return error;

    try {
      const projectId = await commitmentProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, needsApproval ? "view" : "manage");
      const commitment = await applyCommitmentAction(owner, id, action, {
        note: body.note,
        deliveredOn: body.deliveredOn,
      });
      return NextResponse.json({ commitment });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
