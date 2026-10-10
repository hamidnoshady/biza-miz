/**
 * The reporting permission matrix (issue #819).
 *
 * The audit that produced these keys was about *conflated* capabilities: the
 * query route required the download key, saving a report required the download
 * key, a role's dashboard layout and the consolidated branch comparison were
 * both writable/readable by anybody holding `reports.view`. So the assertions
 * that matter are the ones that keep those four questions apart — for the
 * presets and for the capability mapping the UI reads.
 */
import { describe, expect, it } from "vitest";
import {
  effectivePermissions,
  hasPermission,
  isOwnerOnlyPermission,
  PERMISSIONS,
  roleBasePermissions,
} from "./permissions";
import {
  REPORT_CAPABILITY_PERMISSIONS,
  canOpenReports,
  reportCapabilities,
} from "./report-permissions";
import { ALL_ROLES } from "./roles";
import type { Role } from "./auth-edge";

const ALL_ROLE_VALUES: Role[] = [...ALL_ROLES];

describe("reportCapabilities", () => {
  it("maps each capability to exactly one permission", () => {
    expect(REPORT_CAPABILITY_PERMISSIONS.canViewReports).toBe(PERMISSIONS.reportsView);
    expect(REPORT_CAPABILITY_PERMISSIONS.canManageSavedReports).toBe(PERMISSIONS.reportsManage);
    expect(REPORT_CAPABILITY_PERMISSIONS.canExportReports).toBe(PERMISSIONS.reportsExport);
    expect(REPORT_CAPABILITY_PERMISSIONS.canViewBusinessWide).toBe(PERMISSIONS.reportsBusinessWide);
    expect(REPORT_CAPABILITY_PERMISSIONS.canManageRoleWidgets).toBe(
      PERMISSIONS.reportsDashboardDefaultsManage,
    );
  });

  it("keeps the four acts independent: a read key grants no manage, export or business-wide", () => {
    const read = reportCapabilities(new Set([PERMISSIONS.reportsView]));
    expect(read.canViewReports).toBe(true);
    expect(read.canBuildReports).toBe(true);
    expect(read.canManageSavedReports).toBe(false);
    expect(read.canExportReports).toBe(false);
    expect(read.canViewBusinessWide).toBe(false);
    expect(read.canManageRoleWidgets).toBe(false);
  });

  it("does not let the export key open the builder's save, nor the manage key open a file", () => {
    const exporter = reportCapabilities(new Set([PERMISSIONS.reportsExport]));
    expect(exporter.canExportReports).toBe(true);
    expect(exporter.canManageSavedReports).toBe(false);

    const manager = reportCapabilities(new Set([PERMISSIONS.reportsManage]));
    expect(manager.canManageSavedReports).toBe(true);
    expect(manager.canExportReports).toBe(false);
  });

  it("admits the workspace on the read key and refuses an empty set", () => {
    expect(canOpenReports(reportCapabilities(new Set([PERMISSIONS.reportsView])))).toBe(true);
    expect(canOpenReports(reportCapabilities(new Set()))).toBe(false);
  });

  it("is derived from the effective permissions, including overrides", () => {
    const granted = effectivePermissions("cashier", { granted: [PERMISSIONS.reportsView] });
    expect(reportCapabilities(granted).canViewReports).toBe(true);
    expect(reportCapabilities(granted).canViewBusinessWide).toBe(false);

    const revoked = effectivePermissions("manager", { revoked: [PERMISSIONS.reportsExport] });
    expect(reportCapabilities(revoked).canExportReports).toBe(false);
    // The rest of the manager's reporting capabilities survive the revocation.
    expect(reportCapabilities(revoked).canManageSavedReports).toBe(true);
  });
});

describe("business-wide reporting is a capability, not a role comment", () => {
  it("grants cross-branch comparison to the owner alone among the presets", () => {
    for (const role of ALL_ROLE_VALUES) {
      expect(hasPermission(role, {}, PERMISSIONS.reportsBusinessWide), role).toBe(role === "owner");
    }
  });

  it("keeps admin, manager, accountant and the custom presets away by default", () => {
    for (const role of ["admin", "manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      expect(roleBasePermissions(role)).not.toContain(PERMISSIONS.reportsBusinessWide);
      expect(new Set(effectivePermissions(role, {})).has(PERMISSIONS.reportsBusinessWide), role).toBe(false);
    }
  });

  it("is owner-reserved, in the cross-location trust family with rollup.manage", () => {
    // The platform rule for cross-branch aggregation is ownership
    // (`rollup.manage` is owner-only for the same reason), so the admin preset
    // — "every delegatable capability, never a cross-location trust key" —
    // excludes it, and a per-member grant cannot hand it out.
    expect(isOwnerOnlyPermission(PERMISSIONS.reportsBusinessWide)).toBe(true);
    const granted = effectivePermissions("manager", { granted: [PERMISSIONS.reportsBusinessWide] });
    expect(granted.has(PERMISSIONS.reportsBusinessWide)).toBe(false);
    expect(reportCapabilities(granted).canViewBusinessWide).toBe(false);
  });
});

describe("presets that must keep working (issue #819 regression)", () => {
  it("lets the manager and the accountant run and save reports, and download files", () => {
    for (const role of ["manager", "accountant"] as const) {
      const permissions = roleBasePermissions(role);
      expect(permissions, role).toContain(PERMISSIONS.reportsView);
      expect(permissions, role).toContain(PERMISSIONS.reportsManage);
      expect(permissions, role).toContain(PERMISSIONS.reportsExport);
    }
  });

  it("lets the manager manage a role's default dashboard layout, and not the accountant", () => {
    expect(roleBasePermissions("manager")).toContain(PERMISSIONS.reportsDashboardDefaultsManage);
    expect(roleBasePermissions("accountant")).not.toContain(
      PERMISSIONS.reportsDashboardDefaultsManage,
    );
  });

  it("gives the admin every reporting capability except the consolidated one", () => {
    const admin = new Set(roleBasePermissions("admin"));
    expect(admin.has(PERMISSIONS.reportsView)).toBe(true);
    expect(admin.has(PERMISSIONS.reportsManage)).toBe(true);
    expect(admin.has(PERMISSIONS.reportsExport)).toBe(true);
    expect(admin.has(PERMISSIONS.reportsDashboardDefaultsManage)).toBe(true);
    expect(admin.has(PERMISSIONS.reportsBusinessWide)).toBe(false);
  });

  it("leaves the floor roles without reporting access by default", () => {
    for (const role of ["cashier", "waiter", "kitchen"] as const) {
      const capabilities = reportCapabilities(new Set(roleBasePermissions(role)));
      expect(capabilities.canViewReports, role).toBe(false);
      expect(capabilities.canViewBusinessWide, role).toBe(false);
    }
  });

  it("a custom member granted only reports.view gets the read and builder sections, no branches", () => {
    const capabilities = reportCapabilities(
      effectivePermissions("cashier", { granted: [PERMISSIONS.reportsView] }),
    );
    expect(capabilities.canViewReports).toBe(true);
    expect(capabilities.canBuildReports).toBe(true);
    expect(capabilities.canViewBusinessWide).toBe(false);
  });
});
