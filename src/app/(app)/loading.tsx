import { DashboardPageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for the whole workspace realm `(app)` — every module
 * under the persistent shell (AI, CRM, Growth, Knowledge, Media, Settings,
 * Support, Websites, Workspace) that does not own a more specific boundary
 * of its own (see `accounting/loading.tsx`, `settings/loading.tsx`).
 *
 * Issue #909 §4/§13 — before this, none of those modules had any boundary
 * beneath the shell, so a slow navigation into any of them fell all the way
 * back to the *root* `loading.tsx` — a centred login/setup-card skeleton,
 * visually nothing like the dashboard-shaped page actually being waited for
 * (header, KPI row, table/section). `DashboardPageSkeleton` is the right
 * default shape here: CRM, Growth and Workspace's own module homes already
 * render exactly that structure.
 */
export default function AppLoading() {
  return <DashboardPageSkeleton />;
}
