import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { checklistProjectId, deleteChecklist, loadChecklist, updateChecklist } from "@/lib/aec-site-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One checklist: its items, its discipline and whether it is still in use.
 *
 * Reading is `workspace.view`; writing is `workspace.manage` — plus the
 * project-role check when the checklist is scoped to a project, so a member of
 * another project cannot edit it. A business-wide checklist has no project to
 * check against, which is why the check is conditional rather than always on.
 *
 * Deleting a template never deletes an inspection: the checks an issue carries
 * are snapshots, and their provenance column is `ON DELETE SET NULL`.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await checklistProjectId(owner.businessId, id);
      if (projectId) await requireProjectCapability(owner, projectId, "view", true);
      return NextResponse.json({ checklist: await loadChecklist(owner.businessId, id) });
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
      const projectId = await checklistProjectId(owner.businessId, id);
      if (projectId) await requireProjectCapability(owner, projectId, "manage", true);
      return NextResponse.json({
        checklist: await updateChecklist(owner, id, await readBody(request)),
      });
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
      const projectId = await checklistProjectId(owner.businessId, id);
      if (projectId) await requireProjectCapability(owner, projectId, "manage", true);
      await deleteChecklist(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
