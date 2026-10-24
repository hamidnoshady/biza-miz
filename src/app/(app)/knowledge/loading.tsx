import { TablePageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for «مرکز آموزش» — a search/category article browser,
 * with no KPI stat row of its own.
 *
 * Issue #909 §4 — without this, Knowledge fell back to the shared `(app)`
 * boundary's `DashboardPageSkeleton`, whose KPI cards promise numbers the
 * knowledge browser never shows.
 */
export default function KnowledgeLoading() {
  return <TablePageSkeleton />;
}
