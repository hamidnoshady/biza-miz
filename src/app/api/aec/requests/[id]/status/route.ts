import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { isMaterialRequestAction, materialRequestActionNeedsApproval } from "@/lib/aec-procurement";
import { applyMaterialRequestAction, requestProjectId } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * §18's request chain, one endpoint — the same shape as the commercial registers'
 * status routes and for the same reason: the transitions belong together, so the
 * chain is one readable list rather than six routes that can drift apart.
 *
 * Two permissions, deliberately not one (§24: a high-risk action must not
 * inherit ordinary edit rights):
 *
 *   * `submit` (filing the requirement for approval), `close`, `cancel` and
 *     `reopen` are somebody still writing the register — `workspace.manage`;
 *   * `approve` and `reject` are the determination that the firm may go and buy
 *     it. They need `workspace.approve`, the key no role below manager holds by
 *     preset, and the split is stated in the module
 *     (`materialRequestActionNeedsApproval`) rather than hardcoded here.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "");
    if (!isMaterialRequestAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needsApproval = materialRequestActionNeedsApproval(action);
    const { owner, error } = await aecOwner(
      needsApproval ? PERMISSIONS.workspaceApprove : PERMISSIONS.workspaceManage,
    );
    if (error) return error;

    try {
      const projectId = await requestProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, needsApproval ? "view" : "manage");
      const materialRequest = await applyMaterialRequestAction(owner, id, action, {
        note: body.note,
      });
      return NextResponse.json({ materialRequest });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
