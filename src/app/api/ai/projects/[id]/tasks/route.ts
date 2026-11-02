import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { addTask, listTasks } from "@/lib/ai-projects";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * Phase F pt.3 — project tasks: units of work with a lifecycle (open -> done).
 *
 * GET  — list a project's tasks (open first, then completed)
 * POST — add an open task (source 'user'; the assistant adds tasks through the
 *        confirmed `project.task.add` action, which also lands here)
 *
 * Issue #907 F01 — reading needs `view` on the project and writing needs
 * `edit`; the business session alone is not authorization to read or file work
 * on somebody else's project. The row-level service query stays as a second
 * layer, so neither check is the only one.
 */

export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;

    try {
      await requireProjectCapability(owner, id, "view");
      const tasks = await listTasks({
        businessId: owner.businessId,
        actorUserId: owner.actorUserId,
        projectId: id,
      });
      return NextResponse.json({ tasks });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id } = await context.params;

    const body = await request.json().catch(() => null);
    if (!body || typeof body.title !== "string") {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    // The write path is the same whether a person typed it or confirmed an
    // assistant proposal; the caller may tag the source, defaulting to 'user'.
    const source = body.source === "ai" ? "ai" : "user";

    try {
      await requireProjectCapability(owner, id, "edit");
      const task = await addTask(
        { businessId: owner.businessId, actorUserId: owner.actorUserId, projectId: id },
        { title: body.title, source },
      );
      return NextResponse.json({ task }, { status: 201 });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes("not found")) {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
        if (
          err.message.includes("character limit") ||
          err.message.includes("required") ||
          err.message.includes("too many")
        ) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
      }
      return handleWorkspaceError(err);
    }
  },
);
