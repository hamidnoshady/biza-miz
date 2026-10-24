import { describe, expect, it } from "vitest";
import { canManagePurchases } from "./purchase-abilities";
import { PERMISSIONS, roleBasePermissions } from "./permissions";

describe("canManagePurchases (issue #915 — gate purchase mutations in both خرید sections)", () => {
  it("follows the effective permission list when one is supplied", () => {
    expect(canManagePurchases("cashier", [PERMISSIONS.purchasesManage])).toBe(true);
    expect(canManagePurchases("manager", [PERMISSIONS.inventoryView])).toBe(false);
    // An empty list is a known answer (no capabilities), not "unknown".
    expect(canManagePurchases("owner", [])).toBe(false);
  });

  it("falls back to the built-in role presets when no list is supplied", () => {
    expect(canManagePurchases("owner")).toBe(true);
    expect(canManagePurchases("admin")).toBe(true);
    expect(canManagePurchases("manager")).toBe(true);
    expect(canManagePurchases("cashier")).toBe(false);
    expect(canManagePurchases("waiter", null)).toBe(false);
  });

  it("the fallback mirrors ROLE_PRESETS — every preset role answers the same as its real base permissions", () => {
    for (const role of ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen"]) {
      expect(canManagePurchases(role), role).toBe(
        roleBasePermissions(role as never).includes(PERMISSIONS.purchasesManage),
      );
    }
  });

  // Issue #915 phase 3 — staff-level and custom-role members, both ways the
  // product can hand them to the sections.
  it("a staff-level member (cashier/waiter/kitchen) mutates purchases ONLY via an explicit grant", () => {
    for (const role of ["cashier", "waiter", "kitchen"]) {
      // Custom role configuration granted the permission → controls render.
      expect(canManagePurchases(role, [PERMISSIONS.inventoryView, PERMISSIONS.purchasesManage]), role).toBe(true);
      // Default staff permissions → read-only history, no mutation controls.
      expect(canManagePurchases(role, roleBasePermissions(role as never)), role).toBe(false);
    }
  });

  it("a custom (unknown) role name fails CLOSED without a list and follows the list when supplied", () => {
    // No effective list and no preset to mirror → never guess towards access.
    expect(canManagePurchases("procurement_lead")).toBe(false);
    expect(canManagePurchases("procurement_lead", null)).toBe(false);
    // The member's actual effective permissions always win over the name.
    expect(canManagePurchases("procurement_lead", [PERMISSIONS.purchasesManage])).toBe(true);
    expect(canManagePurchases("procurement_lead", [PERMISSIONS.inventoryView])).toBe(false);
  });
});
