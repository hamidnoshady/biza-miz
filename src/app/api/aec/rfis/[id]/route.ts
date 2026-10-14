import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { deleteRfi, loadRfi, rfiProjectId, updateRfi } from "@/lib/aec-rfi-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One RFI (issue #799 §10): its question, who owes the answer, its impacts, its
 * attachments and whether it is late.
 *
 * The project is resolved from the RFI *before* the authorization check, so a
 * manager of another project in the same business is refused here exactly as
 * they are on the project's own routes.
 *
 * PATCH edits what is still editable — §33 is the rule: the number and the
 * question freeze when the RFI leaves draft, and the response freezes once it
 * exists. The service refuses, and migration 0198's trigger refuses again.
 * DELETE is a draft-only escape hatch for an RFI raised by mistake.
 *
 * `+` on `PATCH status` is deliberately *not* how an RFI is answered: the four
 * acts of §10's chain have their own route (`…/status`), because each has its
 * own consequences and one of them writes the response.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await rfiProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ rfi: await loadRfi(owner.businessId, id) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await rfiProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const rfi = await updateRfi(owner, id, await readBody(request));
      return NextResponse.json({ rfi });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await rfiProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteRfi(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
