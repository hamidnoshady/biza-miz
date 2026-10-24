import { TablePageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for the Websites module — CMS pages, WordPress content/
 * media/sync queues, each a list or settings form, with no KPI stat row.
 *
 * Issue #909 §4 — without this, Websites fell back to the shared `(app)`
 * boundary's `DashboardPageSkeleton`, whose KPI cards promise numbers none
 * of its screens show.
 */
export default function WebsitesLoading() {
  return <TablePageSkeleton />;
}
