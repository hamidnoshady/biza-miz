import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  addChecklistItem,
  deleteChecklistItem,
  getWorkspaceTask,
  listChecklist,
  requireProjectCapability,
  requireTaskWork,
  setChecklistItem,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../guard";

/**
 * A task's sub-steps. Ticking one is `contribute` work — the whole point of
 * the contributor role is that somebody doing the job can record progress on
 * it without being able to re-scope the task.
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
      return NextResponse.json({ checklist: await listChecklist(id) });
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
      await requireTaskWork(owner, task, false);
      return NextResponse.json({ checklist: await addChecklistItem(id, String(body.title ?? "")) }, { status: 201 });
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
      const task = await getWorkspaceTask(owner.businessId, id);
      if (!task) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireTaskWork(owner, task, false);
      const checklist = await setChecklistItem(id, String(body.itemId ?? ""), body.done === true);
      return NextResponse.json({ checklist });
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
    const itemId = new URL(request.url).searchParams.get("itemId") ?? "";
    try {
      const task = await getWorkspaceTask(owner.businessId, id);
      if (!task) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireTaskWork(owner, task, true);
      return NextResponse.json({ checklist: await deleteChecklistItem(id, itemId) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
