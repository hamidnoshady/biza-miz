import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { addMemory, listMemory } from "@/lib/ai-projects";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * Phase F — project memory: standing facts the assistant carries for a project.
 *
 * GET  — list a project's memory entries
 * POST — add one (source 'user'; the assistant writes memory through the
 *        confirmed `project.memory.add` action, which also lands here)
 *
 * Issue #907 F01 — `view` to read, `edit` to write. Memory is prompt context:
 * a member who may not edit the project must not be able to plant a fact the
 * assistant will repeat to everyone working on it.
 */

export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;

    try {
      await requireProjectCapability(owner, id, "view");
      const memory = await listMemory({
        businessId: owner.businessId,
        actorUserId: owner.actorUserId,
        projectId: id,
      });
      return NextResponse.json({ memory });
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
    if (!body || typeof body.content !== "string") {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }
    // The write path is the same whether a person typed it or confirmed an
    // assistant proposal; the caller may tag the source, defaulting to 'user'.
    const source = body.source === "ai" ? "ai" : "user";

    try {
      await requireProjectCapability(owner, id, "edit");
      const memory = await addMemory(
        { businessId: owner.businessId, actorUserId: owner.actorUserId, projectId: id },
        { content: body.content, source },
      );
      return NextResponse.json({ memory }, { status: 201 });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes("not found")) {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
        if (err.message.includes("character limit") || err.message.includes("required") || err.message.includes("full")) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
      }
      return handleWorkspaceError(err);
    }
  },
);
