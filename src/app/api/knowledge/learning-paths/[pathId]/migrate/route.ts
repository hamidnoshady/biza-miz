import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { learningPathById } from "@/lib/learning-paths";
import { pathsForViewer } from "@/lib/learning-paths";
import { learningPathViewerFor } from "@/lib/learning-paths-service";
import { migrateLearningPathProgressForPath } from "@/lib/learning-paths-service";

/**
 * Migrates every member's stored progress for one learning path within the
 * caller's business to the path's current revision (issue #972, item 8 —
 * version migrations). Bumps `path_version`, drops completed step ids that no
 * longer exist, withdraws completion when a new step appeared the member
 * never completed, and nulls a current step that no longer exists.
 *
 * Idempotent — running it again after a successful migration changes nothing.
 */
export const POST = withTenantScope(
  async (
    request: NextRequest,
    context: { params: Promise<{ pathId: string }> },
  ) => {
    const guard = await requirePermission(PERMISSIONS.settingsManage);
    if (guard.error) return guard.error;

    const { pathId } = await context.params;
    const path = learningPathById(pathId);
    if (!path) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const viewer = await learningPathViewerFor(
      guard.session.businessId,
      guard.membership.permissions,
      [path],
    );
    const visible = pathsForViewer([path], viewer);
    if (visible.length === 0)
      return NextResponse.json({ error: "not_found" }, { status: 404 });

    const result = await migrateLearningPathProgressForPath(
      guard.session.businessId,
      pathId,
      path,
    );
    return NextResponse.json({ changed: result.changed, migrated: result.migrated });
  },
);
