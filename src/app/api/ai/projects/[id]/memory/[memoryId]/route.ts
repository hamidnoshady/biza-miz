import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { deleteMemory } from "@/lib/ai-projects";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * DELETE — forget a memory entry (removes it from the project's prompt context).
 *
 * Issue #907 F01 — `edit` on the project, matching the write that added it.
 */

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; memoryId: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id, memoryId } = await context.params;

    try {
      await requireProjectCapability(owner, id, "edit");
      const deleted = await deleteMemory({
        businessId: owner.businessId,
        actorUserId: owner.actorUserId,
        projectId: id,
        memoryId,
      });
      if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
