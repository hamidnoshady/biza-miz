import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { learningPathById } from "@/lib/learning-paths";
import { pathsForViewer } from "@/lib/learning-paths";
import { learningPathViewerFor } from "@/lib/learning-paths-service";
import { unassignLearningPathFromStaff } from "@/lib/learning-paths-service";

/**
 * Unassign a learning path from a staff member (issue #972, item 9 — staff assignments).
 * Requires `team.manage`.
 */
export const DELETE = withTenantScope(
  async (
    _request: Request,
    context: { params: Promise<{ pathId: string; userId: string }> },
  ) => {
    const guard = await requirePermission(PERMISSIONS.teamManage);
    if (guard.error) return guard.error;

    const { pathId, userId } = await context.params;
    const path = learningPathById(pathId);
    if (!path) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const viewer = await learningPathViewerFor(
      guard.session.businessId,
      guard.membership.permissions,
    );
    const visible = pathsForViewer([path], {
      permissions: viewer.permissions,
      industry: viewer.industry,
    });
    if (visible.length === 0)
      return NextResponse.json({ error: "not_found" }, { status: 404 });

    const removed = await unassignLearningPathFromStaff(
      guard.session.businessId,
      pathId,
      userId,
    );
    return NextResponse.json({ removed });
  },
);
