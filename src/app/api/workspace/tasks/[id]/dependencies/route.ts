import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  addDependency,
  getWorkspaceTask,
  listDependencies,
  removeDependency,
  requireProjectCapability,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../guard";

/**
 * "This task waits on that one." The POST refuses an edge that would close a
 * cycle — the DB CHECK only catches a self-edge, so A→B→C→A is stopped in the
 * service before the write.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const task = await getWorkspaceTask(owner.businessId, id);
      if (!task) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireProjectCapability(owner, task.projectId, "view");
      return NextResponse.json({ dependencies: await listDependencies(id) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      const task = await getWorkspaceTask(owner.businessId, id);
      if (!task) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireProjectCapability(owner, task.projectId, "edit");
      const dependencies = await addDependency(owner.businessId, id, String(body.dependsOnId ?? ""));
      return NextResponse.json({ dependencies }, { status: 201 });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const dependsOnId = new URL(request.url).searchParams.get("dependsOnId") ?? "";
    try {
      const task = await getWorkspaceTask(owner.businessId, id);
      if (!task) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireProjectCapability(owner, task.projectId, "edit");
      return NextResponse.json({ dependencies: await removeDependency(id, dependsOnId) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
