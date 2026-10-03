import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { deleteDrawing, drawingProjectId, loadDrawing, updateDrawing } from "@/lib/aec-doc-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One register entry (issue #799 §9): the document, its revision history, and
 * which transmittal each revision went out on.
 *
 * The project is resolved from the document *before* the authorization check, so
 * a manager of another project in the same business is refused here exactly as
 * they are on the project's own routes.
 *
 * DELETE removes the register entry and its revisions, and the database refuses
 * while any revision is issued: history is superseded, never erased. The files
 * stay in the document library, where the documents screen manages them.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await drawingProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view", true);
      return NextResponse.json({ drawing: await loadDrawing(owner.businessId, id) });
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
      const projectId = await drawingProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      const drawing = await updateDrawing(owner, id, await readBody(request));
      return NextResponse.json({ drawing });
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
      const projectId = await drawingProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      await deleteDrawing(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
