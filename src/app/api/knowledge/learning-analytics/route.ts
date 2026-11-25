import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { publishedTours } from "@/lib/tour-studio-service";
import { loadTourAnalyticsForBusiness } from "@/lib/tours-service";

/**
 * Tenant-level learning analytics (issue #972, remaining analytics item).
 *
 * `team.manage` sees how many members started, completed or abandoned each
 * tour and where unfinished members are parked. It is deliberately aggregate:
 * counts, a tour title and a step id — no member name, no form value, no
 * business payload. RLS and the explicit business predicate keep another
 * tenant out; the route cannot return cross-tenant rows.
 */
export const GET = withTenantScope(async () => {
  const guard = await requirePermission(PERMISSIONS.teamManage);
  if (guard.error) return guard.error;

  const [rows, published] = await Promise.all([
    loadTourAnalyticsForBusiness(guard.session.businessId),
    publishedTours().catch(() => []),
  ]);

  const tours = rows.map((row) => {
    const definition = published.find((tour) => tour.id === row.tourId);
    const stepTitle = row.topStuckStep
      ? definition?.steps.find((step) => step.id === row.topStuckStep!.stepId)?.title ?? null
      : null;
    return {
      ...row,
      title: definition?.title ?? row.tourId,
      route: definition?.route ?? null,
      topStuckStep: row.topStuckStep
        ? { ...row.topStuckStep, title: stepTitle }
        : null,
      completionPercent:
        row.started === 0 ? 0 : Math.floor((row.completed / row.started) * 100),
    };
  });

  const totals = tours.reduce(
    (sum, row) => ({
      started: sum.started + row.started,
      completed: sum.completed + row.completed,
      inProgress: sum.inProgress + row.inProgress,
      abandoned: sum.abandoned + row.abandoned,
    }),
    { started: 0, completed: 0, inProgress: 0, abandoned: 0 },
  );

  return NextResponse.json({
    tours,
    totals: {
      ...totals,
      completionPercent: totals.started === 0 ? 0 : Math.floor((totals.completed / totals.started) * 100),
    },
  });
});
