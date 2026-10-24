import { FormPageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for every `/settings/*` route — each one is a form (a
 * business profile field, a billing plan picker, a connection toggle), never
 * a KPI-and-table report.
 *
 * Issue #909 §4 — without this, Settings fell back to the shared `(app)`
 * boundary's `DashboardPageSkeleton`, whose KPI row promises stat cards a
 * settings screen never shows; the loaded page then visibly loses a whole
 * row of chrome the skeleton had reserved for it.
 */
export default function SettingsLoading() {
  return <FormPageSkeleton />;
}
