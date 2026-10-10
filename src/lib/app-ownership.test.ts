/**
 * The lines between the apps, asserted from the outside.
 *
 * Each app's own suite already checks its own menu. What nothing checked is
 * the rule that spans them: an app's settings entry must point at *its own*
 * settings route, no app's menu may lead into the platform's settings area
 * (billing and the subscription are the platform's, and the only way in is the
 * sidebar's platform menu), and the record each app owns must appear in that
 * app's menu and not in a neighbour's.
 *
 * That is the regression this whole change exists to prevent coming back: the
 * apps used to share one settings page and one `/dashboard/*` tree, so "open
 * the CRM's settings" and "open the platform's settings" were the same URL.
 */
import { describe, expect, it } from "vitest";
import {
  APP_HOME_HREFS,
  APP_ROUTE_PREFIXES,
  APP_SETTINGS_HREFS,
  PLATFORM_BILLING_HREF,
  PLATFORM_SETTINGS_HOME,
  PLATFORM_SUBSCRIPTION_HREF,
  appPrefixForPathname,
  isPlatformSettingsPathname,
} from "./app-routes";
import { ACCOUNTING_SECTIONS } from "@/app/(app)/accounting/accounting-nav";
import {
  accountingWorkspaceGroups,
  LEDGER_WORKSPACE_SECTION_KEYS,
} from "@/app/(app)/accounting/accounting-workspace";
import { roleBasePermissions } from "@/lib/permissions";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";
import { CRM_NAV_ITEMS } from "@/app/(app)/crm/crm-nav";
import { CRM_SECTION_KEYS, crmSectionHref } from "@/app/(app)/crm/crm-routes";
import { GROWTH_NAV_ITEMS } from "@/app/(app)/growth/growth-nav";
import { growthSectionHref } from "@/app/(app)/growth/growth-routes";
import { CMS_NAV_ITEMS, WP_NAV_ITEMS } from "@/app/(app)/websites/website-nav";
import { cmsSectionHref, wpSectionHref } from "@/app/(app)/websites/website-routes";
import { WORKSPACE_SECTIONS } from "@/lib/workspace-shared";
import { workspaceSectionHref } from "./app-routes";

/** Every app's menu, flattened to the hrefs it offers. */
const APP_MENUS: Record<string, readonly string[]> = {
  "/accounting": ACCOUNTING_SECTIONS.map((section) => accountingSectionHref(section.key)),
  "/crm": CRM_NAV_ITEMS.map((item) => crmSectionHref(item.key)),
  "/growth": GROWTH_NAV_ITEMS.map((item) => growthSectionHref(item.key)),
  "/websites": [
    APP_HOME_HREFS["/websites"],
    ...CMS_NAV_ITEMS.map((item) => cmsSectionHref(item.key)),
    ...WP_NAV_ITEMS.map((item) => wpSectionHref(item.key)),
    APP_SETTINGS_HREFS["/websites"],
  ],
};

const CONTEXTUAL_NAV_HREFS = [
  ...Object.values(APP_MENUS).flat(),
  ...WORKSPACE_SECTIONS.map(workspaceSectionHref),
];

describe("each app's menu stays inside its own app", () => {
  it("points every entry at the app's own prefix", () => {
    for (const [prefix, hrefs] of Object.entries(APP_MENUS)) {
      for (const href of hrefs) {
        expect(appPrefixForPathname(href), `${href} should be inside ${prefix}`).toBe(prefix);
      }
    }
  });

  it("never leads into the platform's settings area", () => {
    for (const [prefix, hrefs] of Object.entries(APP_MENUS)) {
      for (const href of hrefs) {
        expect(
          isPlatformSettingsPathname(href),
          `${prefix}'s menu must not open platform settings (${href})`,
        ).toBe(false);
      }
      expect(hrefs).not.toContain(PLATFORM_BILLING_HREF);
      expect(hrefs).not.toContain(PLATFORM_SUBSCRIPTION_HREF);
      expect(hrefs).not.toContain(PLATFORM_SETTINGS_HOME);
    }
  });

  it("ends with the app's own settings entry", () => {
    for (const [prefix, hrefs] of Object.entries(APP_MENUS)) {
      expect(hrefs.at(-1), `${prefix}'s menu should end with its own settings`).toBe(
        APP_SETTINGS_HREFS[prefix as keyof typeof APP_SETTINGS_HREFS],
      );
    }
  });

  it("starts at the app's home, which is its overview", () => {
    for (const [prefix, hrefs] of Object.entries(APP_MENUS)) {
      expect(hrefs[0]).toBe(APP_HOME_HREFS[prefix as keyof typeof APP_HOME_HREFS]);
    }
  });

  it("does not produce a legacy dashboard, standalone-AI or retired overview URL", () => {
    // Redirects deliberately keep old URLs alive for bookmarks, but menus must
    // never make a new internal link to one. This collects the actual menu
    // href producers for all four apps plus shared Workspace navigation.
    for (const href of CONTEXTUAL_NAV_HREFS) {
      expect(href, `${href} must not use a retired dashboard child URL`).not.toMatch(/^\/dashboard\//);
      expect(href, `${href} must not use the retired standalone AI`).not.toMatch(/^\/ai(?:\/|$)/);
      expect(href, `${href} must not use the retired overview root`).not.toMatch(/^\/overview(?:\/|$)/);
    }
  });
});

describe("Accounting's menu and workspace", () => {
  it("gives every section exactly one home: a menu row, or a tool on the ledger workspace page", () => {
    // The guard reads the menu the owner actually gets, not a second list of
    // groups, so a section that vanishes from the sidebar and is not a ledger
    // tool fails here rather than quietly disappearing.
    const groups = accountingWorkspaceGroups({
      permissions: new Set(roleBasePermissions("owner")),
      navItems: [],
    });
    // A section's home is its own canonical row. Deep links to a view of the
    // same section (the people group's «مشتریان» and «تأمین‌کنندگان») are not
    // second homes, so they are not counted.
    const canonicalRows = groups.flatMap((group) =>
      group.entries.flatMap((entry) =>
        entry.section && entry.href === accountingSectionHref(entry.section) ? [entry.section] : [],
      ),
    );
    const ledgerTools = new Set<string>(LEDGER_WORKSPACE_SECTION_KEYS);
    for (const { key } of ACCOUNTING_SECTIONS) {
      const homes =
        canonicalRows.filter((section) => section === key).length + (ledgerTools.has(key) ? 1 : 0);
      expect(homes, `«${key}» must have exactly one home`).toBe(1);
    }
  });
});

describe("what each app owns", () => {
  it("keeps the one people directory in Accounting, as one section", () => {
    const keys = ACCOUNTING_SECTIONS.map((section) => section.key);
    expect(keys).toContain("directory");
    // «مشتریان»، «تأمین‌کنندگان» and «فروشندگان» were three more sections over
    // the same table. They are `?view=` filters of the directory now
    // (`party-directory.ts`), so the app must not grow those routes back.
    for (const gone of ["customers", "suppliers", "vendors"]) {
      expect(keys).not.toContain(gone);
    }
  });

  it("keeps the CRM's own records in the CRM", () => {
    // The CRM's *sections*, not just its rail: «اشخاص تکراری» is reached inside
    // the «کیفیت داده» workspace now, and a sub-section is still a section this
    // app owns — its route, its gate and its data live here. (What must not
    // happen is Growth growing its own copy, which the half below checks.)
    const keys = [...CRM_SECTION_KEYS];
    for (const owned of ["activities", "cases", "deals", "segments", "duplicates", "consent"]) {
      expect(keys).toContain(owned);
    }
    // The destinations themselves stay on the rail for the ones that are not
    // sub-sections.
    const navKeys = CRM_NAV_ITEMS.map((item) => item.key);
    for (const owned of ["activities", "cases", "deals", "segments", "consent"]) {
      expect(navKeys).toContain(owned);
    }
    // ...and Growth does not grow a second copy of them.
    const growthKeys = GROWTH_NAV_ITEMS.map((item) => item.key) as string[];
    for (const owned of ["activities", "cases", "deals", "segments", "duplicates", "consent"]) {
      expect(growthKeys).not.toContain(owned);
    }
  });

  it("keeps campaigns, loyalty, messaging, gift cards and commission in Growth", () => {
    const keys = GROWTH_NAV_ITEMS.map((item) => item.key);
    for (const owned of ["campaigns", "loyalty", "messaging", "gift-cards", "commission"]) {
      expect(keys).toContain(owned);
    }
    const crmKeys = CRM_NAV_ITEMS.map((item) => item.key) as string[];
    for (const owned of ["campaigns", "loyalty", "messaging", "gift-cards", "commission"]) {
      expect(crmKeys).not.toContain(owned);
    }
  });

  it("gives each app a settings route of its own, all four distinct", () => {
    const hrefs = APP_ROUTE_PREFIXES.map((prefix) => APP_SETTINGS_HREFS[prefix]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(isPlatformSettingsPathname(href)).toBe(false);
  });
});
