// src/lib/site-routes.test.ts
import { describe, expect, it } from "vitest";
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import { settingsTabHref } from "./settings-routes";
import { isHybridSite, isSiteLocalRoute, siteHomeFor, tillNavItems } from "./site-routes";

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

describe("tillNavItems", () => {
  it("keeps only till entries, and a group only when a till entry is left in it", () => {
    const items = [
      { label: "pos", href: "/accounting/pos" },
      { label: "crm", href: "/crm/overview" },
      { label: "ops", children: [{ label: "kitchen", href: "/accounting/kitchen" }, { label: "stock", href: "/accounting/inventory" }] },
      { label: "reports", children: [{ label: "sales", href: "/accounting/reports?tab=sales" }] },
    ];
    expect(tillNavItems(items)).toEqual([
      { label: "pos", href: "/accounting/pos" },
      { label: "ops", children: [{ label: "kitchen", href: "/accounting/kitchen" }] },
    ]);
  });
});

describe("siteHomeFor", () => {
  it("opens the screen each role works on", () => {
    expect(siteHomeFor("kitchen")).toBe(ACCOUNTING_WORKSPACE_HREFS.kitchen);
    expect(siteHomeFor("waiter")).toBe(ACCOUNTING_WORKSPACE_HREFS.waiter);
    expect(siteHomeFor("owner")).toBe(ACCOUNTING_WORKSPACE_HREFS.pos);
    expect(siteHomeFor("cashier")).toBe(ACCOUNTING_WORKSPACE_HREFS.pos);
  });
});
