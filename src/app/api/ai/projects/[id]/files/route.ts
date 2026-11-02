import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { getProject } from "@/lib/ai-projects";
import { listMediaAssets } from "@/lib/media-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * Phase F capstone (with Phase G) — a project's files.
 *
 * GET — the Media Library assets that belong to this project (the images users
 *       sent the assistant inside the project, plus anything else tagged with
 *       this project_id). Read-only: files are created through the chat/media
 *       write paths and tagged with provenance there; this surface just shows a
 *       project its own files.
 *
 * Issue #907 F01 — the project's `view` capability, not the bare session: the
 * asset list is scoped by business AND project, and the project half was the
 * one a same-business member could skip by naming any project id.
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;

    try {
      await requireProjectCapability(owner, id, "view");
      const project = await getProject({
        businessId: owner.businessId, actorUserId: owner.actorUserId, projectId: id,
      });
      if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });

      const { assets, total } = await listMediaAssets(owner.businessId, {
        projectId: id,
        folderId: "any",
        limit: 100,
      });
      return NextResponse.json({ files: assets, total });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
