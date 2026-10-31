import { TablePageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for «بررسی کارفرما» — a list of review rounds with their
 * progress and link counts, and no KPI stat row of its own.
 *
 * Same reasoning as `/media`'s own `loading.tsx` (issue #909 §4): without this
 * the route falls back to the shared `(app)` boundary's `DashboardPageSkeleton`,
 * whose KPI cards promise numbers this page never shows.
 */
export default function MediaReviewLoading() {
  return <TablePageSkeleton />;
}
