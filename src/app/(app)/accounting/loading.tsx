import { DashboardPageSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Streaming fallback for the whole Accounting realm — every route under
 * `/accounting` (the ledger `[section]` pages, `overview`, and the sibling
 * work-desk routes such as `pos`, `products`, `reports`, `menu`, …), since
 * Next only resolves one `loading.tsx` per route segment and none of these
 * owns a more specific fallback of its own.
 *
 * Issue #909 §13 — before this, none of those routes had a boundary beneath
 * the persistent workspace shell, so a slow server render (or a client
 * navigation waiting on `loading.tsx` while a Server Component resolves) fell
 * all the way back to the *root* `loading.tsx` — a centred login/setup-card
 * skeleton, visually nothing like the page actually being waited for. Reusing
 * the dashboard's own realm skeleton (header + KPI row + a section card/table)
 * is the right shape here: every Accounting screen — the ledger overview, a
 * report, a directory list — is built from exactly those same primitives.
 */
export default function AccountingLoading() {
  return <DashboardPageSkeleton />;
}
