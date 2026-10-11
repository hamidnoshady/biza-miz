/**
 * The permission catalogue's own invariants.
 *
 * The registry is what the role editor renders, so a permission missing from it
 * is a permission an owner cannot grant through the UI — a silent hole rather
 * than a visible error. These tests make the catalogue's completeness and
 * internal consistency a build failure instead.
 */
import { describe, expect, it } from "vitest";
import {
  PERMISSION_GROUP_ORDER,
  PERMISSION_METADATA,
  impliedPermissions,
  isDangerousPermission,
  permissionGroupLabel,
  permissionsInGroup,
  searchPermissions,
} from "./permission-registry";
import { ALL_PERMISSIONS, isOwnerOnlyPermission, PERMISSIONS } from "./permissions";

describe("catalogue completeness", () => {
  it("describes every permission the system recognises", () => {
    const missing = ALL_PERMISSIONS.filter((key) => !PERMISSION_METADATA[key]);
    expect(missing).toEqual([]);
  });

  it("describes nothing that is not a real permission", () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    expect(Object.keys(PERMISSION_METADATA).filter((k) => !known.has(k))).toEqual([]);
  });

  it("gives every permission a label and a description, not a placeholder", () => {
    for (const key of ALL_PERMISSIONS) {
      const meta = PERMISSION_METADATA[key];
      expect(meta.label.length).toBeGreaterThan(2);
      expect(meta.description.length).toBeGreaterThan(10);
      expect(meta.label).not.toBe(meta.key);
    }
  });

  it("places every permission in a rendered group", () => {
    const rendered = new Set(PERMISSION_GROUP_ORDER.flatMap((g) => permissionsInGroup(g).map((m) => m.key)));
    for (const key of ALL_PERMISSIONS) expect(rendered.has(key)).toBe(true);
  });

  it("names every group", () => {
    for (const group of PERMISSION_GROUP_ORDER) {
      expect(permissionGroupLabel(group).length).toBeGreaterThan(1);
    }
  });
});

describe("owner-only metadata agrees with the enforcing code", () => {
  /**
   * The registry describing a key as delegatable while `permissions.ts` refuses
   * to delegate it would put a checkbox in the role editor that silently does
   * nothing. Derived rather than restated, and asserted here so it stays that
   * way.
   */
  it("marks exactly the non-delegable keys as ownerOnly", () => {
    for (const key of ALL_PERMISSIONS) {
      expect(PERMISSION_METADATA[key].ownerOnly).toBe(isOwnerOnlyPermission(key));
      expect(PERMISSION_METADATA[key].delegatable).toBe(!isOwnerOnlyPermission(key));
    }
  });
});

describe("risk classification", () => {
  it("treats money reversal, history rewriting and bulk export as dangerous", () => {
    for (const key of [
      PERMISSIONS.paymentsRefund,
      PERMISSIONS.ordersAmendClosed,
      PERMISSIONS.crmExport,
      PERMISSIONS.crmMerge,
      PERMISSIONS.dataExport,
      PERMISSIONS.dataImport,
      PERMISSIONS.inventoryAdjust,
      PERMISSIONS.teamPermissionsManage,
      PERMISSIONS.backupManage,
      PERMISSIONS.apiManage,
      PERMISSIONS.ledgerClosePeriod,
      PERMISSIONS.cmsConfigure,
    ]) {
      expect(isDangerousPermission(key)).toBe(true);
    }
  });

  it("does not cry wolf over ordinary reads", () => {
    for (const key of [
      PERMISSIONS.menuView,
      PERMISSIONS.inventoryView,
      PERMISSIONS.reportsView,
      PERMISSIONS.ledgerView,
      PERMISSIONS.teamView,
    ]) {
      expect(isDangerousPermission(key)).toBe(false);
    }
  });

  it("audits every high-risk capability", () => {
    for (const key of ALL_PERMISSIONS) {
      if (isDangerousPermission(key)) expect(PERMISSION_METADATA[key].audit).toBe(true);
    }
  });
});

describe("dependencies", () => {
  it("makes a write imply the matching read", () => {
    expect(impliedPermissions([PERMISSIONS.inventoryAdjust])).toContain("inventory.view");
    expect(impliedPermissions([PERMISSIONS.menuEdit])).toContain("menu.view");
    expect(impliedPermissions([PERMISSIONS.ledgerPost])).toContain("ledger.view");
    expect(impliedPermissions([PERMISSIONS.ledgerClosePeriod])).toContain("ledger.view");
    expect(impliedPermissions([PERMISSIONS.reportsExport])).toContain("reports.view");
  });

  it("resolves a chain transitively", () => {
    // amend_closed → void, and discount → create → menu.view.
    expect(impliedPermissions([PERMISSIONS.cmsPublish])).toEqual(
      expect.arrayContaining(["cms.view"]),
    );
  });

  it("never implies a key that is not a real permission", () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const key of ALL_PERMISSIONS) {
      for (const implied of PERMISSION_METADATA[key].implies ?? []) {
        expect(known.has(implied)).toBe(true);
      }
    }
  });

  it("has no permission implying itself", () => {
    for (const key of ALL_PERMISSIONS) {
      expect(impliedPermissions([key])).not.toContain(key);
    }
  });

  it("terminates rather than looping, whatever the table says", () => {
    expect(() => impliedPermissions(ALL_PERMISSIONS)).not.toThrow();
  });
});

describe("search", () => {
  it("matches the Persian label", () => {
    expect(searchPermissions("بازگشت وجه").map((m) => m.key)).toContain("payments.refund");
  });

  it("matches the raw key", () => {
    expect(searchPermissions("payments.refund").map((m) => m.key)).toEqual(["payments.refund"]);
  });

  it("matches a group name, returning the whole group", () => {
    const keys = searchPermissions("حسابداری").map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(["ledger.view", "ledger.post", "accounts.edit"]));
  });

  it("returns everything for an empty term rather than nothing", () => {
    expect(searchPermissions("   ")).toHaveLength(ALL_PERMISSIONS.length);
  });
});
