import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  createWorkspaceTask,
  listWorkspaceTasks,
  taskListPage,
  requireProjectCapability,
  type TaskListFilter,
} from "@/lib/workspace";
import type { WorkspacePriority, WorkspaceTaskStatus } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, pageParams, workspaceOwner } from "../guard";

/**
 * GET  — the workspace-wide task read. One query behind all three views: the
 *        List, the Kanban board and the Calendar are the same rows grouped
 *        differently on the client, never three round trips.
 * POST — create a task on a project.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = new URL(request.url).searchParams;
  const filter: TaskListFilter = {
    ...pageParams(params),
    projectId: params.get("projectId") ?? undefined,
    status: (params.get("status") as WorkspaceTaskStatus | "open_only" | "all") ?? undefined,
    priority: (params.get("priority") as WorkspacePriority) ?? undefined,
    phaseId: params.get("phaseId") ?? undefined,
    dueBefore: params.get("dueBefore") ?? undefined,
    dueAfter: params.get("dueAfter") ?? undefined,
    search: params.get("q") ?? undefined,
    // Same rule as the project list: "assigned to me" comes from the session.
    assigneeUserId: params.get("mine") === "true" ? owner.actorUserId : undefined,
  };
  try {
    const [tasks, { page, summary }] = await Promise.all([
      listWorkspaceTasks(owner, filter),
      taskListPage(owner, filter),
    ]);
    return NextResponse.json({ tasks, page, summary });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  const projectId = String(body.projectId ?? "");
  try {
    await requireProjectCapability(owner, projectId, "edit");
    const task = await createWorkspaceTask(owner, projectId, body);
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
