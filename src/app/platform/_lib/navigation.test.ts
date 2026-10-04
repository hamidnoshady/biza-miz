import { describe, it, expect } from "vitest";
import {
  NAV_GROUPS,
  navItemVisible,
  navItemActive,
  breadcrumbsForPath,
  type NavItem,
} from "./navigation";
import { CAPABILITIES_FOR, PLATFORM_ADMIN_ROLES, platformCan } from "@/lib/platform-admin";

describe("console navigation IA", () => {
  it("groups the sections under the prescribed headings", () => {
    const labels = NAV_GROUPS.map((g) => g.label);
    expect(labels).toEqual(["فضای کاری", "مشتریان", "درآمد", "محصول", "عملیات", "دسترسی و امنیت"]);
  });

  it("puts the overview first and businesses under مشتریان", () => {
    expect(NAV_GROUPS[0].items[0].href).toBe("/platform");
    expect(NAV_GROUPS[0].items[0].exact).toBe(true);
    const customers = NAV_GROUPS.find((g) => g.label === "مشتریان")!;
    expect(customers.items[0].href).toBe("/platform/businesses");
  });

  it("routes every section under exactly one group", () => {
    const hrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length); // no duplicates
    // Spot-check the required destinations exist.
    for (const href of [
      "/platform/businesses",
      "/platform/support",
      "/platform/cloud-exceptions",
      "/platform/bug-reports",
      "/platform/billing",
      "/platform/messaging",
      "/platform/apps",
      "/platform/ai",
      "/platform/cms",
      "/platform/knowledge",
      "/platform/system",
      "/platform/backup",
      "/platform/media",
      "/platform/updates",
      "/platform/audit",
      "/platform/account",
      "/platform/security",
      "/platform/admins",
    ]) {
      expect(hrefs).toContain(href);
    }
  });

  describe("navItemVisible", () => {
    const supportCaps = CAPABILITIES_FOR("support");
    const ownerCaps = CAPABILITIES_FOR("owner");

    it("agrees with every role's capability preset for every actual console item", () => {
      for (const role of PLATFORM_ADMIN_ROLES) {
        const caps = CAPABILITIES_FOR(role);
        for (const item of NAV_GROUPS.flatMap((group) => group.items)) {
          const required = item.cap ? (Array.isArray(item.cap) ? item.cap : [item.cap]) : [];
          const expected = required.length === 0 || required.some((cap) => platformCan(role, cap));
          expect(
            navItemVisible(item, caps),
            `${role} visibility for ${item.href} must follow the capability source of truth`,
          ).toBe(expected);
        }
      }
    });

    it("hides admins from a support operator, shows it to an owner", () => {
      const admins: NavItem = { label: "مدیران", href: "/platform/admins", cap: "admins.manage" };
      expect(navItemVisible(admins, supportCaps)).toBe(false);
      expect(navItemVisible(admins, ownerCaps)).toBe(true);
    });

    it("shows uncapped items to everyone", () => {
      const overview: NavItem = { label: "نمای کلی", href: "/platform" };
      expect(navItemVisible(overview, [])).toBe(true);
    });

    it("supports an array of capabilities (any-of)", () => {
      const item: NavItem = { label: "x", href: "/x", cap: ["admins.manage", "system.read"] };
      expect(navItemVisible(item, supportCaps)).toBe(true); // has system.read
    });
  });

  describe("navItemActive", () => {
    it("exact-matches the overview only at its own path", () => {
      const overview: NavItem = { label: "نمای کلی", href: "/platform", exact: true };
      expect(navItemActive(overview, "/platform")).toBe(true);
      expect(navItemActive(overview, "/platform/businesses")).toBe(false);
    });

    it("marks businesses active on a detail route via alsoActive", () => {
      const businesses: NavItem = {
        label: "کسب‌وکارها",
        href: "/platform/businesses",
        alsoActive: ["/platform/businesses/"],
      };
      expect(navItemActive(businesses, "/platform/businesses")).toBe(true);
      expect(navItemActive(businesses, "/platform/businesses/abc/plan")).toBe(true);
    });
  });

  describe("breadcrumbsForPath", () => {
    it("returns overview → group → section for a nested path", () => {
      const crumbs = breadcrumbsForPath("/platform/billing");
      expect(crumbs[0].label).toBe("نمای کلی");
      expect(crumbs.map((c) => c.label)).toContain("درآمد");
      // Migration 0176: the single commercial entry (the standalone plans
      // builder retired into /platform/billing?tab=plans).
      expect(crumbs[crumbs.length - 1].label).toBe("صورت‌حساب و درآمد");
    });

    it("falls back to just the overview on an unknown path", () => {
      expect(breadcrumbsForPath("/platform")).toEqual([{ label: "نمای کلی", href: "/platform" }]);
    });
  });
});
