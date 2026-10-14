import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createVariation, listProjectVariations } from "@/lib/aec-commercial-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's variation/change-order register (issue #799 §15).
 *
 * GET  — every change on the project, newest first, each with the contract it
 *        amends, the RFI behind it, its four money figures and the queue row it
 *        filed when it was submitted.
 * POST — raise one. It starts as a draft and is numbered `VO-001` per project by
 *        the service, under an advisory lock, so two surveyors pricing a change
 *        at the same moment cannot both be handed the same number.
 *
 * Both go through the workspace module's per-project authorization on top of the
 * platform permission, like every other AEC route: `workspace.view` for reading,
 * `workspace.manage` for writing. *Approving* a change is not here — that is
 * `…/variations/[id]/status`, on `workspace.approve` (§24).
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ variations: await listProjectVariations(owner.businessId, id) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "manage");
      const variation = await createVariation(owner, id, await readBody(request));
      return NextResponse.json({ variation }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
