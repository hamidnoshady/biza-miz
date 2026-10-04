import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteEstimate,
  estimateProjectId,
  loadEstimateTree,
  updateEstimate,
} from "@/lib/aec-boq-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One estimate: its revisions, one revision's full tree (chapters and measured
 * rows) and its recent history.
 *
 * GET    — `?version=` picks a revision; without it the screen's default is the
 *          draft being worked on, else the newest.
 * PATCH  — rename it or change its note.
 * DELETE — remove it, which the service refuses while any revision of it has
 *          been approved: that revision is the record of a budget the ledger
 *          may already have been spent against (§7).
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await estimateProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      const versionId = new URL(request.url).searchParams.get("version");
      return NextResponse.json({ tree: await loadEstimateTree(owner.businessId, id, { versionId }) });
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
      const projectId = await estimateProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      return NextResponse.json({ estimate: await updateEstimate(owner, id, await readBody(request)) });
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
      const projectId = await estimateProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteEstimate(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
