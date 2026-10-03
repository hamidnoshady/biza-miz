import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createDrawing, listProjectDrawings, listProjectTransmittals } from "@/lib/aec-doc-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * The document control of one project (issue #799 §9 and §12).
 *
 * GET  — the drawing register and the project's transmittals in one answer,
 *        because the tab shows them together: what exists, and what was sent.
 * POST — register a document. It has no revision yet; the first one is added
 *        from the register row, which is the order a drawing office works in
 *        (the number is booked before the drawing is finished).
 *
 * Both go through the workspace module's per-project authorization on top of the
 * platform permission, exactly like the estimates route next door:
 * `workspace.view` narrows to «میز کار من», `requireProjectCapability` narrows
 * to this project, and `workspace.manage` is the escape hatch for the business's
 * own owner/manager. Issuing is a different question — see the status route.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view", true);
      const [drawings, transmittals] = await Promise.all([
        listProjectDrawings(owner.businessId, id),
        listProjectTransmittals(owner.businessId, id),
      ]);
      return NextResponse.json({ drawings, transmittals });
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
      await requireProjectCapability(owner, id, "manage", true);
      const drawing = await createDrawing(owner, id, await readBody(request));
      return NextResponse.json({ drawing }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
