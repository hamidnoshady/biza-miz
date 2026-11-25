import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  completedTourStepIds,
  learningPathProgressView,
  LEARNING_PATHS,
} from "@/lib/learning-paths";
import {
  listAllLearningPathAssignments,
  loadLearningPathProgressForBusiness,
} from "@/lib/learning-paths-service";
import { publishedTours } from "@/lib/tour-studio-service";
import { tourProgressView } from "@/lib/tours";
import { listAllTourAssignments, loadTourProgressForBusiness } from "@/lib/tours-service";

/**
 * Staff learning report (issue #972, Phase E).
 *
 * `team.manage` — the capability that already guards the assignment
 * endpoints — can see who was assigned which published tour or learning path
 * and how far they got. The report is tenant-scoped by RLS and by the explicit
 * `business_id` predicate; it exposes only the member's name and learning
 * state, never their business data.
 *
 * A path's `tour` steps are counted from the member's own tour progress, not
 * from a client claim, so the same honesty rule as the member view applies.
 */
export const GET = withTenantScope(async () => {
  const guard = await requirePermission(PERMISSIONS.teamManage);
  if (guard.error) return guard.error;
  const businessId = guard.session.businessId;

  const [pathAssignments, tourAssignments, pathProgress, tourProgress, published] =
    await Promise.all([
      listAllLearningPathAssignments(businessId),
      listAllTourAssignments(businessId),
      loadLearningPathProgressForBusiness(businessId),
      loadTourProgressForBusiness(businessId),
      publishedTours().catch(() => []),
    ]);

  /** Tour ids this member has completed, from their own progress rows. */
  const completedToursFor = (userId: string): Set<string> => {
    const rows = tourProgress.get(userId);
    const completed = new Set<string>();
    if (!rows) return completed;
    for (const [tourId, stored] of rows) {
      const definition = published.find((tour) => tour.id === tourId);
      if (definition && tourProgressView(definition, stored).status === "completed") {
        completed.add(tourId);
      }
    }
    return completed;
  };

  const pathDefinitions = new Map(LEARNING_PATHS.map((path) => [path.id, path]));
  const paths = pathAssignments.map((assignment) => {
    const definition = pathDefinitions.get(assignment.pathId);
    if (!definition) {
      return {
        ...assignment,
        title: assignment.pathId,
        state: "unavailable" as const,
        percent: 0,
        completedAt: null,
        lastActiveAt: null,
      };
    }
    const view = learningPathProgressView(
      definition,
      pathProgress.get(assignment.userId)?.get(assignment.pathId) ?? null,
      completedTourStepIds(definition, completedToursFor(assignment.userId)),
    );
    return {
      ...assignment,
      title: definition.title,
      state: view.status,
      percent: view.percent,
      completedAt: view.completedAt,
      lastActiveAt: view.lastActiveAt,
    };
  });

  const tours = tourAssignments.map((assignment) => {
    const definition = published.find((tour) => tour.id === assignment.tourId);
    if (!definition) {
      return {
        ...assignment,
        title: assignment.tourId,
        state: "unavailable" as const,
        percent: 0,
        completedAt: null,
        lastActiveAt: null,
      };
    }
    const view = tourProgressView(
      definition,
      tourProgress.get(assignment.userId)?.get(assignment.tourId) ?? null,
    );
    return {
      ...assignment,
      title: definition.title,
      state: view.status,
      percent: view.percent,
      completedAt: view.completedAt,
      lastActiveAt: view.lastActiveAt,
    };
  });

  const incomplete = (row: { state: string }) =>
    row.state === "in_progress" || row.state === "not_started" || row.state === "unavailable";

  return NextResponse.json({
    paths,
    tours,
    counts: {
      paths: paths.length,
      tours: tours.length,
      incomplete: paths.filter(incomplete).length + tours.filter(incomplete).length,
      completed:
        paths.filter((row) => row.state === "completed").length +
        tours.filter((row) => row.state === "completed").length,
    },
  });
});
