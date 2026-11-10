import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { LEARNING_PATHS } from "@/lib/learning-paths";
import { pathsForViewer } from "@/lib/learning-paths";
import { learningPathViewerFor } from "@/lib/learning-paths-service";
import { loadLearningPathProgress } from "@/lib/learning-paths-service";
import { learningPathSummary } from "@/lib/learning-paths";

/**
 * The learning paths a member may start (issue #972, item 3).
 *
 * Eligibility is decided on the server: a path a member cannot use is not
 * described to them at all, and a path they can use is counted over the
 * steps that apply to THEM. The response carries titles, counts and the
 * caller's own progress — never step content; that comes with
 * `GET …/learning-paths/[pathId]` at start.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const viewer = await learningPathViewerFor(
    guard.session.businessId,
    guard.membership.permissions,
  );
  const paths = pathsForViewer(LEARNING_PATHS, {
    permissions: viewer.permissions,
    industry: viewer.industry,
  });

  const progress = await loadLearningPathProgress(
    guard.session.businessId,
    guard.session.sub,
    paths.map((p) => p.id),
  );

  return NextResponse.json({
    paths: paths.map((p) =>
      learningPathSummary(p, progress.get(p.id) ?? null),
    ),
  });
});
