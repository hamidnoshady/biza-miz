import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { knowledgePage } from "@/lib/knowledge-base";
import { tourForViewer, tourSummary, toursForPage } from "@/lib/tours";
import { loadTourProgress, tourViewerFor } from "@/lib/tours-service";

/**
 * The tours a member may start from the «آموزش» button of one page (issue
 * #972). The page key is looked up in the server-owned registry exactly as
 * `GET /api/knowledge` does, and eligibility (permission, industry, feature
 * flags, costing system) is decided here, so a tour a member cannot use is
 * not described to them at all, and a tour they can use is counted over the
 * steps that apply to THEM. The response carries titles, counts and the caller's own progress —
 * never step copy or anchors; those come with `GET …/[tourId]` at start.
 *
 * Separate from `/api/knowledge` on purpose: the article half of the modal
 * must keep working when this lookup fails, so neither depends on the other.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const page = knowledgePage((request.nextUrl.searchParams.get("page") ?? "").trim());
  if (!page) return NextResponse.json({ error: "unknown_page" }, { status: 400 });

  const candidates = toursForPage(page.key);
  const viewer = await tourViewerFor(guard.session.businessId, guard.membership.permissions, candidates);
  const tours = candidates.flatMap((tour) => {
    const visible = tourForViewer(tour, viewer);
    return visible ? [visible] : [];
  });
  const progress = await loadTourProgress(
    guard.session.businessId,
    guard.session.sub,
    tours.map((tour) => tour.id),
  );
  return NextResponse.json({
    tours: tours.map((tour) => tourSummary(tour, progress.get(tour.id) ?? null)),
  });
});
