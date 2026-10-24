import { FormPageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for the automation rule builder — a column of labelled
 * fields (trigger, schedule, condition, action), not a KPI-and-table report.
 *
 * Issue #909 §4 — without this, Automations fell back to the shared `(app)`
 * boundary's `DashboardPageSkeleton`, whose KPI row promises stat cards this
 * rule-builder form never shows. `ai/usage` (a real KPI dashboard) keeps the
 * inherited default, since it matches that shape already.
 */
export default function AutomationsLoading() {
  return <FormPageSkeleton />;
}
