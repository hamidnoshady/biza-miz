import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { addNote, listNotes } from "@/lib/ai-projects";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * GET  — list notes for a project
 * POST — add a note to a project
 *
 * Issue #907 F01 — the project role, not just the business session: `view` to
 * read a project's notes, `edit` to add one. A note is part of the project's
 * prompt context, so writing one changes what the assistant tells everyone on
 * that project.
 */

export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;

    try {
      await requireProjectCapability(owner, id, "view");
      const notes = await listNotes({
        businessId: owner.businessId,
        actorUserId: owner.actorUserId,
        projectId: id,
      });
      return NextResponse.json({ notes });
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

    try {
      await requireProjectCapability(owner, id, "edit");
      const note = await addNote(
        { businessId: owner.businessId, actorUserId: owner.actorUserId, projectId: id },
        { title: body.title, content: body.content ?? "" },
      );
      return NextResponse.json({ note }, { status: 201 });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes("not found")) {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
        if (err.message.includes("character limit")) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
      }
      return handleWorkspaceError(err);
    }
  },
);
