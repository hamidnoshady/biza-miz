import { TablePageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for the member support desk — a ticket inbox and
 * conversation thread, with no KPI stat row of its own.
 *
 * Issue #909 §4 — without this, Support fell back to the shared `(app)`
 * boundary's `DashboardPageSkeleton`, whose KPI cards promise numbers the
 * ticket desk never shows.
 */
export default function SupportLoading() {
  return <TablePageSkeleton />;
}
