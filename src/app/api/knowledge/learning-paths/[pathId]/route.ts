import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { learningPathById } from "@/lib/learning-paths";
import { pathsForViewer } from "@/lib/learning-paths";
import { learningPathViewerFor } from "@/lib/learning-paths-service";
import { loadLearningPathProgress } from "@/lib/learning-paths-service";
import { learningPathSummary } from "@/lib/learning-paths";

/**
 * One learning path as this member sees it (issue #972, item 3).
 *
 * An ineligible or non-existent path is indistinguishable (404).
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ pathId: string }> }) => {
    const guard = await requireMember();
    if (guard.error) return guard.error;

    const { pathId } = await context.params;
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
    if (visible.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const progress = await loadLearningPathProgress(
      guard.session.businessId,
      guard.session.sub,
      [pathId],
    );

    return NextResponse.json({
      path: learningPathSummary(visible[0], progress.get(pathId) ?? null),
    });
  },
);
