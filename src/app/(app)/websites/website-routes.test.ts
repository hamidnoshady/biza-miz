import { effectivePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth-edge";
import { describe, expect, it } from "vitest";
import {
  canOpenWebsiteApp,
  cmsSectionHref,
  CMS_SECTION_KEYS,
  EMPTY_WEBSITE_MANAGERS_STATE,
  hasAnyWebsite,
  isCmsSectionPathname,
  isWpSectionPathname,
  managerForPathname,
  visibleCmsSections,
  visibleWpSections,
  WEBSITE_HOME,
  WEBSITE_MANAGER_KEYS,
  wpSectionHref,
  type WebsiteManagersState,
} from "./website-routes";
import { CMS_NAV_ITEMS, WEBSITE_NAV_GROUPS, WP_NAV_ITEMS } from "./website-nav";
import { WP_SECTION_KEYS } from "./wp/wp-routes";

const state = (patch: Partial<WebsiteManagersState> = {}): WebsiteManagersState => ({
  ...EMPTY_WEBSITE_MANAGERS_STATE,
  ...patch,
});

describe("the app's two managers", () => {
  it("has exactly two, and a menu group for each", () => {
    // The app is «مدیریت وب‌سایت» — one door, two rooms. A third manager here
    // without a group is a set of pages nobody can find.
    expect(WEBSITE_MANAGER_KEYS).toEqual(["cms", "wp"]);
    expect(WEBSITE_NAV_GROUPS.map((group) => group.manager)).toEqual([...WEBSITE_MANAGER_KEYS]);
  });

  it("lists every section of each manager, exactly once, in menu order", () => {
    expect(CMS_NAV_ITEMS.map((item) => item.key)).toEqual([...CMS_SECTION_KEYS]);
    expect(WP_NAV_ITEMS.map((item) => item.key)).toEqual([...WP_SECTION_KEYS]);
  });

  it("gives every entry a label and a line of help, and never the same label twice", () => {
    const items = [...CMS_NAV_ITEMS, ...WP_NAV_ITEMS];
    for (const item of items) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
    // The two managers each have a «محتوا» and an overview; labelling them
    // identically is how a member ends up editing the wrong site.
    const labels = items.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("routing", () => {
  it("puts both managers under the one app prefix", () => {
    expect(cmsSectionHref("overview")).toBe(`${WEBSITE_HOME}/cms`);
    expect(cmsSectionHref("setup")).toBe(`${WEBSITE_HOME}/cms/setup`);
    expect(wpSectionHref("overview")).toBe(`${WEBSITE_HOME}/wp`);
    expect(wpSectionHref("orders")).toBe(`${WEBSITE_HOME}/wp/orders`);
  });

  it("marks a section active on its own route and its nested pages only", () => {
    expect(isCmsSectionPathname(`${WEBSITE_HOME}/cms`, "overview")).toBe(true);
    // The manager's root must not light up every section under it.
    expect(isCmsSectionPathname(`${WEBSITE_HOME}/cms/products`, "overview")).toBe(false);
    expect(isCmsSectionPathname(`${WEBSITE_HOME}/cms/products`, "products")).toBe(true);
    expect(isWpSectionPathname(`${WEBSITE_HOME}/wp/orders/12`, "orders")).toBe(true);
    expect(isWpSectionPathname(`${WEBSITE_HOME}/wp`, "orders")).toBe(false);
  });

  it("says which manager a path belongs to, and none for the app home", () => {
    expect(managerForPathname(`${WEBSITE_HOME}/cms/billing`)).toBe("cms");
    expect(managerForPathname(`${WEBSITE_HOME}/wp/queue`)).toBe("wp");
    expect(managerForPathname(WEBSITE_HOME)).toBeNull();
  });

  it("is owner/manager work — both managers write to a live public site", () => {
    expect(canOpenWebsiteApp(effectivePermissions("owner" as Role, null))).toBe(true);
    expect(canOpenWebsiteApp(effectivePermissions("manager" as Role, null))).toBe(true);
    expect(canOpenWebsiteApp(effectivePermissions("cashier" as Role, null))).toBe(false);
    expect(canOpenWebsiteApp(effectivePermissions("kitchen" as Role, null))).toBe(false);
  });
});

describe("what a business sees, given its connections", () => {
  it("offers only the way in when a manager is not connected", () => {
    // A «سفارش‌ها» entry over a site that does not exist is a dead end with a
    // number on it. The WP overview is the way in: it links to the
    // «اتصال‌های فنی» hub, where the store connection is made.
    expect(visibleCmsSections(state())).toEqual(["overview", "setup"]);
    expect(visibleWpSections(state())).toEqual(["overview"]);
  });

  it("opens the whole manager once its connection exists", () => {
    const connected = state({
      cms: { connected: true, domain: "acme.ir", setupStep: "built", siteType: "store" },
      wp: { connected: true, storeCount: 1 },
    });
    expect(visibleCmsSections(connected)).toEqual([...CMS_SECTION_KEYS]);
    expect(visibleWpSections(connected)).toEqual([...WP_SECTION_KEYS]);
  });

  it("hides store sections for portfolio sites", () => {
    const portfolio = state({
      cms: { connected: true, domain: "acme.ir", setupStep: "built", siteType: "portfolio" },
    });
    expect(visibleCmsSections(portfolio)).not.toContain("products");
    expect(visibleCmsSections(portfolio)).not.toContain("orders");
    expect(visibleCmsSections(portfolio)).toContain("pages");
  });

  it("keeps the two answers independent — one connection never opens the other manager", () => {
    const cmsOnly = state({ cms: { connected: true, domain: "acme.ir", setupStep: "built", siteType: "business" } });
    expect(visibleCmsSections(cmsOnly)).toEqual([...CMS_SECTION_KEYS]);
    expect(visibleWpSections(cmsOnly)).toEqual(["overview"]);
    expect(hasAnyWebsite(cmsOnly)).toBe(true);
    expect(hasAnyWebsite(state())).toBe(false);
  });
});
