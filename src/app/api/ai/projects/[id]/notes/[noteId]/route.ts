import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { deleteNote } from "@/lib/ai-projects";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * DELETE — remove a note from a project
 *
 * Issue #907 F01 — needs `edit` on the project, the same capability that lets
 * somebody add the note it removes.
 */

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; noteId: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id, noteId } = await context.params;

    try {
      await requireProjectCapability(owner, id, "edit");
      const deleted = await deleteNote({
        businessId: owner.businessId,
        actorUserId: owner.actorUserId,
        projectId: id,
        noteId,
      });
      if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
