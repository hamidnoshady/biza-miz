/**
 * The «گزارش‌ها» section list — the reports sub-menu.
 *
 * Reports are one in-page tabbed workspace (`/accounting/reports`), so like
 * the ledger they are query-string targets. Kept framework-free so the
 * sidebar, the in-page rail (`reports-manager.tsx`) and the reports page all
 * read the same list and never disagree about what «گزارش‌ها» contains.
 *
 * Which tabs a member gets is a *capability* question, answered once by
 * `report-permissions.ts` from their effective permissions — not a role table
 * (issue #819: the old `REPORTS_ROLES = ["owner", "manager", "accountant"]`
 * admitted an admin to the page's APIs and then offered them no navigation,
 * and gave a member with an explicit `reports.view` override nothing usable).
 * The same capability object drives the page's own gating, so a tab can be
 * shown exactly when its API would answer.
 */

import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";
import type { ReportCapabilities } from "@/lib/report-permissions";

export const REPORTS_TAB_KEYS = ["standard", "shift-orders", "builder", "growth", "branches"] as const;
export type ReportsTabKey = (typeof REPORTS_TAB_KEYS)[number];

export interface ReportsTabDef {
  key: ReportsTabKey;
  label: string;
  /**
   * The capability that opens this tab, named as the key on
   * `ReportCapabilities`. Also carried by the sidebar's child entry as
   * `requiredAnyPermission`, so the two navigation surfaces are gated by the
   * same permission rather than by two copies of a role list.
   */
  capability: keyof ReportCapabilities;
}

export const REPORTS_TABS: readonly ReportsTabDef[] = [
  { key: "standard", label: "گزارش‌های آماده", capability: "canViewReports" },
  { key: "shift-orders", label: "سفارش‌های شیفت", capability: "canViewReports" },
  { key: "builder", label: "گزارش‌ساز", capability: "canBuildReports" },
  { key: "growth", label: "رشد و بازاریابی", capability: "canViewReports" },
  // Cross-branch comparison: the consolidated view of every branch, one step
  // more restricted than a single branch's own reports (issue #819).
  { key: "branches", label: "مقایسهٔ شعب", capability: "canViewBusinessWide" },
];

/**
 * The route for a section. Every entry is an explicit `?tab=` target — the
 * first tab included — so the sidebar can tell «گزارش‌های آماده» apart from a
 * sibling tab; the bare `/accounting/reports` still lands on the first tab.
 */
export function reportsTabHref(key: ReportsTabKey): string {
  return `${ACCOUNTING_WORKSPACE_HREFS.reports}?tab=${key}`;
}

/**
 * The sections this member's capabilities open, in menu order.
 *
 * Returns an empty list for a member who may not open the workspace at all —
 * the same answer the page's own redirect gives — so a caller cannot render a
 * rail whose every request would 403.
 */
export function reportsTabsForCapabilities(capabilities: ReportCapabilities): ReportsTabDef[] {
  if (!capabilities.canViewReports) return [];
  return REPORTS_TABS.filter((tab) => capabilities[tab.capability]);
}

/**
 * The tab a `?tab=` value selects: the requested tab only when it is one of
 * the member's *allowed* tabs, otherwise the first allowed tab.
 *
 * Validating against `REPORTS_TAB_KEYS` alone (the old behaviour) let a crafted
 * URL render a section the member's capabilities never offered — which was
 * only safe while the API behind it happened to agree. Rendering and
 * authorization must not be two different answers, so the check is against
 * `tabs`, and the APIs remain authoritative regardless.
 */
export function resolveReportsTab(
  requested: string | null | undefined,
  tabs: readonly ReportsTabDef[],
): ReportsTabKey | null {
  if (tabs.length === 0) return null;
  const match = tabs.find((tab) => tab.key === requested);
  return match?.key ?? tabs[0].key;
}

export function isReportsTabKey(value: string | null | undefined): value is ReportsTabKey {
  return typeof value === "string" && (REPORTS_TAB_KEYS as readonly string[]).includes(value);
}
