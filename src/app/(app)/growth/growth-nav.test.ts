import { effectivePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth-edge";
import { describe, expect, it } from "vitest";
import { GROWTH_NAV_ITEMS, growthNavItemsForPermissions } from "./growth-nav";
import {
  canOpenGrowth,
  canViewGrowthSection,
  GROWTH_SECTION_KEYS,
  growthFallbackHref,
  growthSectionHref,
  isGrowthSectionPathname,
} from "./growth-routes";

const permissionsFor = (role: string) => role ? effectivePermissions(role as Role, null) : new Set<import("@/lib/permissions").Permission>();

describe("GROWTH_NAV_ITEMS", () => {
  it("lists every section of the app, exactly once, in menu order", () => {
    // A new engine (CRM, messaging, the website manager) that lands without a
    // menu entry is invisible; this fails until it is seated in the app's rail.
    expect(GROWTH_NAV_ITEMS.map((item) => item.key)).toEqual([...GROWTH_SECTION_KEYS]);
  });

  it("gives each entry a label and a line of help", () => {
    for (const item of GROWTH_NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
    const labels = GROWTH_NAV_ITEMS.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("is the app's own menu and nothing else's", () => {
    // The complaint this answers: the growth screens were being reached through
    // the accounting sidebar. So the app's menu must hold only its own routes —
    // no ledger, no reports, no other app's page.
    for (const item of GROWTH_NAV_ITEMS) {
      const href = growthSectionHref(item.key);
      expect(href === "/growth/overview" || href.startsWith("/growth/")).toBe(true);
      expect(href).not.toContain("ledger");
      expect(href).not.toContain("reports");
    }
  });
});

describe("growthNavItemsForPermissions", () => {
  it("shows owner and manager the whole app", () => {
    for (const role of ["owner", "manager"]) {
      expect(growthNavItemsForPermissions(permissionsFor(role)).map((item) => item.key)).toEqual([...GROWTH_SECTION_KEYS]);
    }
  });

  it("shows a cashier only the floor surfaces, and never a page they are redirected off", () => {
    // The menu and the route guard must agree exactly: an entry that leads to a
    // redirect is a button that does nothing. Loyalty (earn/redeem points) and
    // the gift-card balance lookup are the till's; the dashboard, audience,
    // campaigns and compensation are not (issue #764).
    expect(growthNavItemsForPermissions(effectivePermissions("cashier" as Role, null)).map((item) => item.key)).toEqual(["gift-cards", "loyalty"]);
  });

  it("shows a role the app does not admit nothing at all", () => {
    // `growth/layout.tsx` redirects these roles out of the app; a menu with
    // entries that all redirect away would be the same door with extra steps.
    for (const role of ["waiter", "kitchen", ""]) {
      expect(growthNavItemsForPermissions(permissionsFor(role))).toEqual([]);
    }
    // The accountant reads the Growth dashboard (its accounting bridge), the
    // audience figures, and commission — compensation, like the payroll they
    // already read — but none of the marketing engines.
    expect(growthNavItemsForPermissions(effectivePermissions("accountant" as Role, null)).map((item) => item.key)).toEqual(["overview", "customers", "commission"]);
  });

  it("is the same gate the pages enforce", () => {
    for (const role of ["owner", "manager", "cashier", "accountant"]) {
      const shown = new Set(growthNavItemsForPermissions(permissionsFor(role)).map((item) => item.key));
      for (const key of GROWTH_SECTION_KEYS) {
        expect(shown.has(key)).toBe(canViewGrowthSection(permissionsFor(role), key));
      }
    }
  });
});

describe("customer data projection", () => {
  it("opens the customer section in Growth without moving ownership", () => {
    expect(growthSectionHref("customers")).toBe("/growth/customers");
    expect(canViewGrowthSection(effectivePermissions("accountant" as Role, null), "customers")).toBe(true);
    expect(canOpenGrowth(effectivePermissions("accountant" as Role, null))).toBe(true);
  });
});

describe("growthFallbackHref", () => {
  it("keeps someone inside the app whenever it has a surface for them", () => {
    // The per-page gates this replaces sent an accountant who opened
    // /growth/campaigns to «وفاداری», which an accountant may not open either —
    // a redirect straight into a second redirect.
    expect(growthFallbackHref(effectivePermissions("accountant" as Role, null))).toBe(growthSectionHref("overview"));
    expect(growthFallbackHref(effectivePermissions("cashier" as Role, null))).toBe(growthSectionHref("gift-cards"));
    expect(growthFallbackHref(effectivePermissions("owner" as Role, null))).toBe(growthSectionHref("overview"));
    expect(growthFallbackHref(effectivePermissions("manager" as Role, null))).toBe(growthSectionHref("overview"));
  });

  it("only leaves the app for a role with nothing here", () => {
    for (const role of ["waiter", "kitchen", ""]) {
      expect(canOpenGrowth(permissionsFor(role))).toBe(false);
      expect(growthFallbackHref(permissionsFor(role))).toBe("/dashboard");
    }
  });

  it("never sends anyone to a page they would be bounced off again", () => {
    // The invariant the eight hand-written gates kept breaking.
    for (const role of ["owner", "manager", "cashier", "accountant"]) {
      const target = growthFallbackHref(permissionsFor(role));
      const key = GROWTH_SECTION_KEYS.find((k) => growthSectionHref(k) === target);
      expect(key).toBeDefined();
      expect(canViewGrowthSection(permissionsFor(role), key!)).toBe(true);
    }
  });
});

describe("isGrowthSectionPathname", () => {
  it("lights the overview only on the app's root", () => {
    // Every section page lives under the root path, so a prefix match here would
    // leave «میز کار رشد» active on all six pages.
    expect(isGrowthSectionPathname("/growth/overview", "overview")).toBe(true);
    expect(isGrowthSectionPathname("/growth/campaigns", "overview")).toBe(false);
    expect(isGrowthSectionPathname("/growth/customers", "customers")).toBe(true);
  });

  it("keeps a section active on its page and anything nested under it", () => {
    expect(isGrowthSectionPathname("/growth/gift-cards", "gift-cards")).toBe(true);
    expect(isGrowthSectionPathname("/growth/gift-cards/41", "gift-cards")).toBe(true);
    expect(isGrowthSectionPathname("/growth/loyalty", "gift-cards")).toBe(false);
    expect(isGrowthSectionPathname("/dashboard/ledger", "campaigns")).toBe(false);
  });
});
