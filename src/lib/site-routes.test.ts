// src/lib/site-routes.test.ts
import { describe, expect, it } from "vitest";
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import { PERMISSIONS } from "./permissions";
import { settingsTabHref } from "./settings-routes";
import { isHybridSite, isSiteLocalRoute, siteHomeFor } from "./site-routes";

describe("isSiteLocalRoute", () => {
  it("keeps every till screen and its sub-pages on the desktop", () => {
    for (const href of [
      ACCOUNTING_WORKSPACE_HREFS.pos,
      ACCOUNTING_WORKSPACE_HREFS.orders,
      ACCOUNTING_WORKSPACE_HREFS.waiter,
      ACCOUNTING_WORKSPACE_HREFS.floor,
      ACCOUNTING_WORKSPACE_HREFS.kitchen,
      ACCOUNTING_WORKSPACE_HREFS.reservations,
      ACCOUNTING_WORKSPACE_HREFS.delivery,
    ]) {
      expect(isSiteLocalRoute(href)).toBe(true);
      expect(isSiteLocalRoute(`${href}/123`)).toBe(true);
    }
  });

  it("keeps this computer's own settings on the desktop", () => {
    for (const key of ["shifts", "cloud-sync", "devices", "desktop", "printers", "backup", "logs"] as const) {
      expect(isSiteLocalRoute(settingsTabHref(key))).toBe(true);
    }
  });

  it("sends every other screen to the cloud", () => {
    for (const path of [
      "/dashboard",
      "/accounting/overview",
      "/accounting/reports",
      "/accounting/inventory",
      "/accounting/products",
      "/accounting/directory",
      "/crm/overview",
      "/growth/overview",
      "/websites/overview",
      "/workspace",
      "/media",
      "/knowledge",
      "/settings",
      "/settings/business",
      "/settings/team",
      "/settings/menu",
    ]) {
      expect(isSiteLocalRoute(path)).toBe(false);
    }
  });

  it("does not match a longer sibling path", () => {
    expect(isSiteLocalRoute("/accounting/posx")).toBe(false);
    expect(isSiteLocalRoute("/accounting/orders-archive")).toBe(false);
  });
});

describe("isHybridSite", () => {
  it("is only the desktop of a Hybrid business", () => {
    expect(isHybridSite("hybrid", "site")).toBe(true);
    expect(isHybridSite("hybrid", "central")).toBe(false);
    expect(isHybridSite("local", "site")).toBe(false);
    expect(isHybridSite("cloud", "central")).toBe(false);
  });
});

describe("siteHomeFor", () => {
  const all = () => true;
  const perms = (...keys: string[]) => new Set(keys);
  const everything = perms(PERMISSIONS.kitchenView, PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake, PERMISSIONS.ordersView);

  it("opens the screen each role works on", () => {
    const facts = { hasModule: all, reservations: true, permissions: everything };
    expect(siteHomeFor({ ...facts, role: "kitchen" })).toBe(ACCOUNTING_WORKSPACE_HREFS.kitchen);
    expect(siteHomeFor({ ...facts, role: "waiter" })).toBe(ACCOUNTING_WORKSPACE_HREFS.waiter);
    expect(siteHomeFor({ ...facts, role: "owner" })).toBe(ACCOUNTING_WORKSPACE_HREFS.pos);
    expect(siteHomeFor({ ...facts, role: "cashier" })).toBe(ACCOUNTING_WORKSPACE_HREFS.pos);
  });

  it("does not send a waiter to «میزهای من» when reservations are off", () => {
    const waiter = perms(PERMISSIONS.ordersCreate, PERMISSIONS.ordersView);
    expect(siteHomeFor({ role: "waiter", hasModule: all, reservations: false, permissions: waiter })).toBe(
      ACCOUNTING_WORKSPACE_HREFS.orders,
    );
    expect(siteHomeFor({ role: "waiter", hasModule: all, reservations: false, permissions: everything })).toBe(
      ACCOUNTING_WORKSPACE_HREFS.pos,
    );
  });

  it("does not send kitchen staff to a kitchen the trade does not have", () => {
    const home = siteHomeFor({
      role: "kitchen",
      hasModule: (module) => module !== "kitchen",
      reservations: true,
      permissions: everything,
    });
    expect(home).toBe(ACCOUNTING_WORKSPACE_HREFS.pos);
  });

  it("answers null when no till screen can be opened", () => {
    expect(siteHomeFor({ role: "kitchen", hasModule: (m) => m !== "kitchen", reservations: true, permissions: perms(PERMISSIONS.kitchenView) })).toBeNull();
    expect(siteHomeFor({ role: "owner", hasModule: () => false, reservations: true, permissions: everything })).toBeNull();
  });
});
