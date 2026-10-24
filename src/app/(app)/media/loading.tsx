import { TablePageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for «کتابخانهٔ رسانه» — a folder/category browser over a
 * library of files, with no KPI stat row of its own.
 *
 * Issue #909 §4 — without this, Media fell back to the shared `(app)`
 * boundary's `DashboardPageSkeleton`, whose KPI cards promise numbers the
 * media library never shows.
 */
export default function MediaLoading() {
  return <TablePageSkeleton />;
}
