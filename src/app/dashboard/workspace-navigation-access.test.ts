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
  it("gives a standard cashier the launcher, POS and Orders but no ledger overview", () => {
    const permissions = new Set(roleBasePermissions("cashier"));
    const nav = accessibleNavItemsFor("food_service", { settingsTabs: [] }, "cashier", permissions, features);
    const visible = hrefs("cashier", permissions);
    expect(visible).toContain("/accounting/pos");
    expect(visible).toContain("/accounting/orders");
    expect(visible).not.toContain("/accounting/overview");
    expect(resolveAccessibleAppLanding("accounting", nav)).toBe("/accounting/pos");
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
