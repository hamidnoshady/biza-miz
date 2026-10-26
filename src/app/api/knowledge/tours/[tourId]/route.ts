import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { tourPlayback, tourProgressView } from "@/lib/tours";
import { eligibleTourById, loadTourProgress, tourViewerFor } from "@/lib/tours-service";

/**
 * The steps of one tour plus the caller's resume point, fetched when the
 * member presses Start/Continue. An unknown tour and one the caller is not
 * eligible for answer identically (404): whether a tour exists is itself
 * metadata about screens the member may not be allowed to see.
 */
export const GET = withTenantScope(
  async (_request, context: { params: Promise<{ tourId: string }> }) => {
    const guard = await requireMember();
    if (guard.error) return guard.error;

    const { tourId } = await context.params;
    const viewer = await tourViewerFor(guard.session.businessId, guard.membership.permissions);
    const tour = eligibleTourById(tourId, viewer);
    if (!tour) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const progress = (await loadTourProgress(guard.session.businessId, guard.session.sub, [tour.id])).get(tour.id) ?? null;
    return NextResponse.json({
      tour: tourPlayback(tour),
      progress: tourProgressView(tour, progress),
    });
  },
);
