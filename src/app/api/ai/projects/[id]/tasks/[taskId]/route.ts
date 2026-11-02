import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteWorkspaceTask,
  getWorkspaceTask,
  requireProjectCapability,
  requireTaskWork,
  updateWorkspaceTask,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * PATCH  — flip a task open<->done ({ done: boolean }); drops it from / returns
 *          it to the project's prompt context accordingly.
 * DELETE — remove a task from a project.
 *
 * Issue #907 F01 — this route used to call `ai-projects.setTaskStatus` /
 * `deleteTask` straight after `getSession()`: the SQL behind them restricted
 * the parent BUSINESS and nothing else, so any member of the same business who
 * knew two ids could complete or delete somebody else's task on a project they
 * were not on, and could close a task whose dependencies were still open — an
 * update the workspace API refuses.
 *
 * It now runs the workspace module's own commands. `requireTaskWork` is the
 * same rule the task drawer uses (an editor may work any task; a contributor
 * only the one assigned to them), `updateWorkspaceTask` owns the dependency
 * rule (#761 §9) and the completion stamp, and `deleteWorkspaceTask` removes
 * only a task whose project this business owns — after `edit` was proven on it.
 *
 * The task must belong to the `id` in the path, so a task id from another
 * project cannot be driven through this project's route.
 */

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; taskId: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id, taskId } = await context.params;

    const body = await request.json().catch(() => null);
    if (!body || typeof body.done !== "boolean") {
      return NextResponse.json({ error: "done is required" }, { status: 400 });
    }

    try {
      const existing = await getWorkspaceTask(owner.businessId, taskId);
      if (!existing || existing.projectId !== id) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      // A status flip is *working* the task, not restructuring it: the
      // contributor who was given it may do it, and nobody else's task moves.
      await requireTaskWork(owner, existing, false);
      const task = await updateWorkspaceTask(owner, taskId, { status: body.done ? "done" : "open" });
      return NextResponse.json({ task });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; taskId: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id, taskId } = await context.params;

    try {
      const existing = await getWorkspaceTask(owner.businessId, taskId);
      if (!existing || existing.projectId !== id) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      await requireProjectCapability(owner, existing.projectId, "edit");
      return NextResponse.json({ ok: await deleteWorkspaceTask(owner.businessId, taskId) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
