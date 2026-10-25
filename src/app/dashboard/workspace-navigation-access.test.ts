import { describe, expect, it } from "vitest";
import { accessibleNavItemsFor } from "./workspace-shell";
import { resolveAccessibleAppLanding } from "@/lib/apps";
import { effectivePermissions, PERMISSIONS, roleBasePermissions, type Permission } from "@/lib/permissions";

const features = new Proxy({} as Record<string, boolean>, { get: () => true });
const hrefs = (role: Parameters<typeof accessibleNavItemsFor>[2], permissions: Set<Permission>) =>
  accessibleNavItemsFor("food_service", { settingsTabs: [] }, role, permissions, features)
    .flatMap((item) => [item.href, ...(item.children ?? []).map((child) => child.href)])
    .filter((href): href is string => Boolean(href));

describe("food-service Accounting navigation access", () => {
  it("gives a standard cashier the launcher, POS and Orders, landing on the overview without ledger access", () => {
    const permissions = new Set(roleBasePermissions("cashier"));
    const nav = accessibleNavItemsFor("food_service", { settingsTabs: [] }, "cashier", permissions, features);
    const visible = hrefs("cashier", permissions);
    expect(visible).toContain("/accounting/pos");
    expect(visible).toContain("/accounting/orders");
    expect(visible).not.toContain("/accounting/overview");
    // Issue #1124 — the app opens on its overview; the till stays its own row.
    // The overview page shows this member shortcuts only (no ledger figures),
    // so landing there grants nothing the nav does not already list.
    expect(resolveAccessibleAppLanding("accounting", nav)).toBe("/accounting/overview");
  });

  it("lands every ledger-capable role on the overview too, and follows a ledger grant or revoke", () => {
    for (const role of ["owner", "admin", "manager", "accountant"] as const) {
      const permissions = new Set(roleBasePermissions(role));
      const nav = accessibleNavItemsFor("food_service", { settingsTabs: [] }, role, permissions, features);
      expect(hrefs(role, permissions), role).toContain("/accounting/overview");
      expect(resolveAccessibleAppLanding("accounting", nav), role).toBe("/accounting/overview");
    }

    const cashier = effectivePermissions("cashier", { granted: [PERMISSIONS.ledgerView] });
    expect(hrefs("cashier", cashier)).toContain("/accounting/overview");
    const revoked = effectivePermissions("manager", { revoked: [PERMISSIONS.ledgerView] });
    expect(hrefs("manager", revoked)).not.toContain("/accounting/overview");
    const nav = accessibleNavItemsFor("food_service", { settingsTabs: [] }, "manager", revoked, features);
    expect(resolveAccessibleAppLanding("accounting", nav)).toBe("/accounting/overview");
  });

  it("offers no Accounting door at all to a member whose permissions open none of its areas", () => {
    const none = new Set<Permission>();
    const nav = accessibleNavItemsFor("food_service", { settingsTabs: [] }, "cashier", none, features);
    expect(resolveAccessibleAppLanding("accounting", nav)).toBeNull();
  });

  it("keeps a waiter out of full POS while retaining valid order/table areas", () => {
    const permissions = new Set(roleBasePermissions("waiter"));
    const visible = hrefs("waiter", permissions);
    expect(visible).toContain("/accounting/orders");
    expect(visible).toContain("/accounting/floor");
    expect(visible).not.toContain("/accounting/pos");
  });

  it("honours explicit cashier revocations and permission-driven custom access", () => {
    const revoked = effectivePermissions("cashier", { revoked: [PERMISSIONS.paymentsTake] });
    expect(hrefs("cashier", revoked)).not.toContain("/accounting/pos");
    expect(hrefs("cashier", revoked)).toContain("/accounting/orders");

    const custom = new Set<Permission>([PERMISSIONS.ordersView, PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake]);
    expect(hrefs("cashier", custom)).toContain("/accounting/pos");
    expect(custom.has(PERMISSIONS.ledgerView)).toBe(false);
  });

  it("keeps kitchen away from financial sections", () => {
    const permissions = new Set(roleBasePermissions("kitchen"));
    const visible = hrefs("kitchen", permissions);
    expect(visible).toContain("/accounting/kitchen");
    expect(visible).not.toContain("/accounting/overview");
    expect(visible).not.toContain("/accounting/financial-reports");
  });
});
