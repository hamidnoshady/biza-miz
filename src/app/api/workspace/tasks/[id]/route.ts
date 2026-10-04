import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteWorkspaceTask,
  getWorkspaceTask,
  listChecklist,
  listComments,
  listDependencies,
  listDocuments,
  requireProjectCapability,
  requireTaskWork,
  updateWorkspaceTask,
} from "@/lib/workspace";
import { roleCan } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../guard";

/**
 * GET    — one task with its checklist, dependencies, comments and documents.
 * PATCH  — amend it (including the board drag, which is a status + position).
 * DELETE — remove it.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const task = await getWorkspaceTask(owner.businessId, id);
      if (!task) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      const role = await requireProjectCapability(owner, task.projectId, "view");
      const [checklist, dependencies, comments, documents] = await Promise.all([
        listChecklist(id),
        listDependencies(id),
        listComments(owner.businessId, "task", id),
        listDocuments(owner, { taskId: id }),
      ]);
      // What the drawer may offer — the same rule `requireTaskWork` enforces:
      // editors re-scope, the assigned contributor works the task.
      const writes = owner.access?.canManage === true;
      const canEdit = writes && roleCan(role, "edit");
      const capabilities = {
        canEdit,
        canWork: canEdit || (writes && roleCan(role, "contribute") && task.assigneeUserId === owner.actorUserId),
        canComment: writes && roleCan(role, "contribute"),
      };
      return NextResponse.json({ task, checklist, dependencies, comments, documents, capabilities });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      const existing = await getWorkspaceTask(owner.businessId, id);
      if (!existing) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      // A contributor may work the task they were given (status, position)
      // but not re-scope it; re-assigning or re-dating it is editor work.
      const structural =
        body.title !== undefined || body.description !== undefined ||
        body.assigneeUserId !== undefined || body.dueDate !== undefined ||
        body.phaseId !== undefined || body.partyId !== undefined || body.priority !== undefined;
      await requireTaskWork(owner, existing, structural);
      const task = await updateWorkspaceTask(owner, id, body);
      return NextResponse.json({ task });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const existing = await getWorkspaceTask(owner.businessId, id);
      if (!existing) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireProjectCapability(owner, existing.projectId, "edit");
      return NextResponse.json({ deleted: await deleteWorkspaceTask(owner.businessId, id) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
