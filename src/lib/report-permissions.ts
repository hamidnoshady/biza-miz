/**
 * The reporting capability contract (issue #819) — one place that turns
 * *effective permissions* into the questions the reporting UI asks, so the
 * screens and the routes answer them the same way.
 *
 * ## Why this file exists
 *
 * The reports area used to answer those questions from a hand-written role
 * table (`const REPORTS_ROLES = ["owner", "manager", "accountant"]`) while its
 * APIs answered them from permissions. The two drifted on day one: an `admin`
 * holds `reports.view` but was not in the list, so the page's own API let them
 * in while the navigation offered them nothing; a member granted `reports.view`
 * through a per-member override passed every route guard and got an empty
 * section list. Hiding a tab was also treated as authorization — a crafted
 * `?tab=branches` rendered the branch comparison for anyone the API had already
 * refused (it had not, actually: the API was guarded by plain `reports.view`).
 *
 * So: the *server* page resolves the member's permissions once, maps them
 * through `reportCapabilities`, and hands the result to both the navigation and
 * every action control. The routes keep using `requirePermission` on the same
 * keys, which is what makes the tab list a rendering of the security model
 * rather than a second, weaker copy of it.
 *
 * Framework-free and pure — unit-tested in `report-permissions.test.ts` — so a
 * `"use client"` component may import it. It reaches only `permissions.ts`,
 * which is itself client-safe (type-only imports at the top).
 */
import { PERMISSIONS, type Permission } from "./permissions";

/**
 * What the signed-in member may do in «گزارش‌ها» — the six questions the
 * section actually asks, named after the user-facing acts rather than after the
 * permission keys, so a rename of a key cannot silently change a screen.
 */
export interface ReportCapabilities {
  /** Run and read reports: ready-made reports, saved reports, builder previews, and the caller's own dashboard widgets. */
  canViewReports: boolean;
  /**
   * Open the Report Builder and run its previews.
   *
   * A separate question from viewing, and both answer `reports.view`: the
   * builder is offered to every member who can read reports, because running a
   * draft is a read. *Saving* one needs `canManageSavedReports` — the builder
   * renders its save action from that flag, not from this one.
   */
  canBuildReports: boolean;
  /** Create, rename, edit and delete saved custom reports, and save a personal dashboard layout. */
  canManageSavedReports: boolean;
  /** Download CSV / Excel / PDF files. */
  canExportReports: boolean;
  /** Consolidated numbers across the business's own branches — the comparison screen and its export. */
  canViewBusinessWide: boolean;
  /** Replace a *role's* default dashboard widget layout, which every member of that role inherits. */
  canManageRoleWidgets: boolean;
}

/**
 * The permission behind each capability, for callers that gate a navigation
 * entry or a route by key rather than by a resolved `ReportCapabilities`
 * object (`workspace-shell.tsx` sets it as a nav entry's
 * `requiredAnyPermission`). Derived from the same map `reportCapabilities`
 * reads, so a capability cannot mean one permission on the screen and another
 * in the sidebar.
 */
export const REPORT_CAPABILITY_PERMISSIONS: Record<keyof ReportCapabilities, Permission> = {
  canViewReports: PERMISSIONS.reportsView,
  canBuildReports: PERMISSIONS.reportsView,
  canManageSavedReports: PERMISSIONS.reportsManage,
  canExportReports: PERMISSIONS.reportsExport,
  canViewBusinessWide: PERMISSIONS.reportsBusinessWide,
  canManageRoleWidgets: PERMISSIONS.reportsDashboardDefaultsManage,
};

/** Maps an effective permission set onto the reporting capabilities above. */
export function reportCapabilities(permissions: ReadonlySet<string>): ReportCapabilities {
  const has = (permission: Permission) => permissions.has(permission);
  return {
    canViewReports: has(PERMISSIONS.reportsView),
    canBuildReports: has(PERMISSIONS.reportsView),
    canManageSavedReports: has(PERMISSIONS.reportsManage),
    canExportReports: has(PERMISSIONS.reportsExport),
    canViewBusinessWide: has(PERMISSIONS.reportsBusinessWide),
    canManageRoleWidgets: has(PERMISSIONS.reportsDashboardDefaultsManage),
  };
}

/**
 * Whether the reports workspace admits this member at all.
 *
 * Deliberately *not* "holds any reports capability": every report capability
 * implies `reports.view`, so the read key is the one door and there is no
 * second way to be admitted to a section whose every request would then 403.
 */
export function canOpenReports(capabilities: ReportCapabilities): boolean {
  return capabilities.canViewReports;
}
