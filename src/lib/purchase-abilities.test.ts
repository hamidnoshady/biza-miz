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
});
