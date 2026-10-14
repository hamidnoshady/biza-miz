import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { deleteSiteLog, loadSiteLog, siteLogProjectId, updateSiteLog } from "@/lib/aec-site-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One day (issue #799 §13): its narrative, its lines and its photos.
 *
 * The project is resolved from the log *before* the authorization check, so a
 * manager of another project in the same business is refused here exactly as
 * they are on the project's own routes.
 *
 * PATCH edits a draft — §13 is not §33's immutability list, but a *submitted*
 * day is frozen (header and lines) by migration 0199's triggers until somebody
 * reopens it, and the service refuses first so the answer is a Persian code.
 * DELETE is the draft-only escape hatch for a day written for the wrong project.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await siteLogProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ log: await loadSiteLog(owner.businessId, id) });
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
      const projectId = await siteLogProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      return NextResponse.json({ log: await updateSiteLog(owner, id, await readBody(request)) });
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
      const projectId = await siteLogProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteSiteLog(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
