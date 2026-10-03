import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { addRevision, drawingProjectId, loadDrawing } from "@/lib/aec-doc-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A new revision of a drawing (issue #799 §9).
 *
 * POST  — register the next revision. The number is allocated from the register
 *         (§9's "revision"), the code is only suggested, and the file may come
 *         from the Media Library (`mediaAssetId`, which creates the
 *         `workspace_documents` row) or be an existing document
 *         (`workspaceDocumentId`).
 * GET   — the register entry with its whole history, which is what the screen
 *         reloads after adding one.
 *
 * A revision is born editable: only issuing it — through a transmittal — makes
 * it a record that cannot change.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await drawingProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      const revision = await addRevision(owner, id, await readBody(request));
      return NextResponse.json({ revision }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

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
