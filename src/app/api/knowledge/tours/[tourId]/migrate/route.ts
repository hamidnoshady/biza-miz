import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { eligibleTourById } from "@/lib/tours-service";
import { migrateTourProgressForTour } from "@/lib/tours-service";

/**
 * Migrates every member's stored progress for one tour within the caller's
 * business to the tour's current revision (issue #972, item 8 — version
 * migrations). Bumps `tour_version`, drops seen step ids that no longer
 * exist, withdraws completion when a new step appeared the member never saw,
 * and nulls a resume step that no longer exists.
 *
 * Idempotent — running it again after a successful migration changes nothing.
 */
export const POST = withTenantScope(
  async (
    request: NextRequest,
    context: { params: Promise<{ tourId: string }> },
  ) => {
    const guard = await requireMember();
    if (guard.error) return guard.error;

    const { tourId } = await context.params;
    const tour = await eligibleTourById(
      tourId,
      guard.session.businessId,
      guard.membership.permissions,
    );
    if (!tour) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const result = await migrateTourProgressForTour(
      guard.session.businessId,
      tourId,
      tour,
    );
    return NextResponse.json({ changed: result.changed, migrated: result.migrated });
  },
);
