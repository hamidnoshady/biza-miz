import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { loadEstimateTree, saveDraftVersion, versionContextProjectId } from "@/lib/aec-boq-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * One revision of a BOQ, addressed by itself.
 *
 * GET — the revision's whole tree: chapters, their measured rows, the items
 *       that belong to no chapter, the quantity per unit and the total.
 * PUT — replace a DRAFT revision's chapters and rows in one transaction. That
 *       is how the editor saves (the whole revision at once), and it is only
 *       possible while the revision is a draft — migration 0196 refuses it for
 *       any other status, so a stale tab posting to an approved revision fails
 *       with a 409 instead of rewriting a historical record.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const { projectId, estimateId } = await versionContextProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      const tree = await loadEstimateTree(owner.businessId, estimateId, { versionId: id });
      return NextResponse.json({ tree });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const { projectId } = await versionContextProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const tree = await saveDraftVersion(owner, id, await readBody(request));
      return NextResponse.json({ tree });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
