import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { knowledgePage } from "@/lib/knowledge-base";
import { pageTourCandidates } from "@/lib/tour-baseline";
import { publishedToursForPage } from "@/lib/tour-studio-service";
import { tourForViewer, tourSummary } from "@/lib/tours";
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
 * Which catalogue answers for a page is decided in `tour-baseline.ts`: the
 * authored tours when the page has them (and nothing at all when the member is
 * not eligible for one), otherwise the page's automatic baseline tour — so
 * every registered page's «آموزش» button has something behind it without a
 * second help button or a hand-written entry per page.
 *
 * Separate from `/api/knowledge` on purpose: the article half of the modal
 * must keep working when this lookup fails, so neither depends on the other.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const page = knowledgePage((request.nextUrl.searchParams.get("page") ?? "").trim());
  if (!page) return NextResponse.json({ error: "unknown_page" }, { status: 400 });

  // A console lookup failure degrades to the code catalogue, exactly like the
  // article half of the modal: the button never breaks because the database is
  // slow, and it never shows a draft.
  const published = await publishedToursForPage(page.key).catch(() => []);
  const candidates = pageTourCandidates(page.key, published);
  const viewer = await tourViewerFor(guard.session.businessId, guard.membership.permissions, candidates);
  const eligibleTours = candidates.flatMap((tour) => {
    const visible = tourForViewer(tour, viewer);
    return visible ? [visible] : [];
  });
  // On Accounting Overview, POS, Cosmetics, Directory, Ledger, Trial Balance,
  // Journal Entries, Vouchers and product-workspace pages, an eligible Studio tour replaces built-in choices.
  // Keep those choices as the fallback when no published Studio tour applies.
  const preferStudio = page.route === "/accounting/overview" || page.route === "/accounting/pos" || page.route === "/accounting/products" || page.route === "/accounting/products/new" || page.route === "/accounting/products/prices" || page.route === "/accounting/products/attributes" || page.route === "/accounting/products/barcode-templates" || page.route === "/accounting/products/reports" || page.route === "/accounting/cosmetics" || page.route === "/accounting/directory" || page.route === "/accounting/ledger" || page.route === "/accounting/trial-balance" || page.route === "/accounting/entries" || page.route === "/accounting/vouchers";
  const studioTours = preferStudio
    ? eligibleTours.filter((tour) => published.some((entry) => entry.id === tour.id))
    : [];
  const tours = studioTours.length > 0 ? studioTours : eligibleTours;
  const progress = await loadTourProgress(
    guard.session.businessId,
    guard.session.sub,
    tours.map((tour) => tour.id),
  );
  return NextResponse.json({
    tours: tours.map((tour) => tourSummary(tour, progress.get(tour.id) ?? null)),
  });
});
