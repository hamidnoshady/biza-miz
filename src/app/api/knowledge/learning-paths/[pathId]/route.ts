import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { completedTourStepIds, learningPathById } from "@/lib/learning-paths";
import { pathsForViewer } from "@/lib/learning-paths";
import { completedTourIdsForPaths, learningPathViewerFor } from "@/lib/learning-paths-service";
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
      [path],
    );
    const visible = pathsForViewer([path], viewer);
    if (visible.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const progress = await loadLearningPathProgress(
      guard.session.businessId,
      guard.session.sub,
      [pathId],
    );
    const completedTours = await completedTourIdsForPaths(
      guard.session.businessId,
      guard.session.sub,
      visible,
      guard.membership.permissions,
    );
    const visiblePath = visible[0];
    const external = completedTourStepIds(visiblePath, completedTours);
    const stored = progress.get(pathId) ?? null;
    const done = new Set([...(stored?.completedStepIds ?? []), ...external]);

    return NextResponse.json({
      path: learningPathSummary(visiblePath, stored, external),
      steps: visiblePath.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        target: step.target,
        title: step.title,
        body: step.body,
        completed: done.has(step.id),
      })),
    });
  },
);
