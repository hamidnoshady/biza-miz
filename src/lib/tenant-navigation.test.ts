import { describe, expect, it } from "vitest";
import type { Role } from "@/lib/auth-edge";
import type { NavItem } from "@/app/dashboard/dashboard-sidebar";
import { ENABLED_INDUSTRIES } from "./industries";
import { hasModule, type ModuleKey } from "./industry-profile";
import { ALL_PERMISSIONS, type Permission } from "./permissions";
import { accessibleNavItemsFor } from "./tenant-navigation";

/**
 * Issue #1128 P0 — "RTL sidebar" as a contract rather than a screenshot.
 *
 * The rail is built by one pure function (`navItemsFor` → `accessibleNavItemsFor`)
 * from the industry's module set, the member's role, their permissions and the
 * business's feature flags, and every label in it is Persian. Rendering the
 * shell in a test would assert markup; asserting *this* function catches the
 * failure that actually matters — an entry for an area the trade does not have,
 * which is both a wrong sidebar and, until `auth.ts` refuses the route, a door.
 *
 * The agency case is the reason the file exists, and the sweep at the end is
 * the reason it stays useful: the same assertion runs for all twelve industries,
 * so the next trade added to `industry-profile.ts` inherits it.
 */

const OWNER: Role = "owner";
const EVERY_PERMISSION = new Set<Permission>(ALL_PERMISSIONS);

/** Every flag the rail reads, on: the sweep is about modules, not flags. */
const ALL_FEATURES: Record<string, boolean> = {
  reservations: true,
  delivery: true,
  inventory: true,
  ledger: true,
  reporting: true,
};

/**
 * What an agency actually runs: the two commercial flags on, the three features
 * its profile disables off (`industry-profile.ts` → `defaultDisabledFeatures`).
 */
const AGENCY_FEATURES: Record<string, boolean> = {
  reservations: false,
  delivery: false,
  inventory: false,
  ledger: true,
  reporting: true,
};

function navFor(
  industry: (typeof ENABLED_INDUSTRIES)[number],
  features: Record<string, boolean>,
): NavItem[] {
  return accessibleNavItemsFor(industry, { settingsTabs: [] }, OWNER, EVERY_PERMISSION, features);
}

/** Groups («محصولات») carry their entries in `children`; the rail shows both. */
function flatten(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

function modulesOf(items: NavItem[]): Set<ModuleKey> {
  return new Set(flatten(items).map((item) => item.module));
}

function labelsOf(items: NavItem[]): string[] {
  return flatten(items).map((item) => item.label);
}

describe("the tenant rail of an advertising agency (#1128)", () => {
  const items = navFor("advertising_agency", AGENCY_FEATURES);
  const modules = modulesOf(items);

  /** Words that belong to a shop or a café, not to an agency (§ non-goals). */
  const RETAIL_WORDS = ["منو", "سفارش", "صندوق", "میز", "آشپزخانه", "انبار", "کالا", "رزرو", "پیک"];

  /**
   * The one shop word an agency's rail still says, and the only one this test
   * allows: «سفارش‌های شیفت», the current shift's sales and orders report.
   *
   * It comes from `REPORTS_TABS` (`reports-nav.ts`), whose entries are gated by
   * a *report capability* and deliberately carry no industry axis — the list is
   * shared by the sidebar, the in-page rail and the reports page so the three
   * cannot disagree, and its contract is "a tab is shown exactly when its API
   * would answer". The shift-orders API does answer for this trade; it has
   * nothing to say, because a business with no till never opens or closes a
   * shift. The same is true of the two other POS-less trades (AEC, SaaS), so
   * hiding the entry is an industry-aware-UI decision across three shipped
   * trades rather than an agency fix, and it belongs to #1081's sweep.
   *
   * Named here so it cannot grow: a second shop word anywhere in the rail fails
   * the test below, and fixing this one in `reports-nav.ts` fails the exemption
   * test, which is the reminder to delete it.
   */
  const REPORTS_TAB_LEAK = "سفارش‌های شیفت";

  it("shows an entry only for a module the trade has", () => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of flatten(items)) {
      expect(hasModule("advertising_agency", item.module), `${item.label} (${item.module})`).toBe(
        true,
      );
    }
  });

  it("has no till, no orders board, no menu, no floor and no warehouse", () => {
    // The areas §"Explicit non-goals" rules out, by module: an agency sells
    // work, so none of these exists in its profile and none may appear here.
    for (const module of [
      "pos",
      "orders",
      "menu",
      "tables",
      "waiter",
      "kitchen",
      "reservations",
      "delivery",
      "stock",
      "inventory",
    ] as const) {
      expect(modules.has(module), module).toBe(false);
    }
  });

  it("names nothing in the vocabulary of a shop or a café", () => {
    // The labels are the RTL surface an owner reads. The agency's own nouns are
    // «صورتحساب» and «خدمات تبلیغاتی» (industry-profile.ts), so a rail entry
    // saying «منو» or «کالا» would be a copy bug even if the module were right.
    // The one entry exempted here belongs to the reports list, not to the
    // industry profile — see `REPORTS_TAB_LEAK` above and the test below.
    const labels = labelsOf(items)
      .filter((label) => label !== REPORTS_TAB_LEAK)
      .join(" ");
    for (const word of RETAIL_WORDS) {
      expect(labels, word).not.toContain(word);
    }
  });

  it("leaks exactly one shop word, from the reports list and not from the profile", () => {
    const leaked = labelsOf(items).filter((label) =>
      RETAIL_WORDS.some((word) => label.includes(word)),
    );
    expect(leaked).toEqual([REPORTS_TAB_LEAK]);
    // It is a report tab, so its module is one every trade has — which is why
    // the module sweep above cannot catch it and why it is written down here.
    expect(hasModule("advertising_agency", "reports")).toBe(true);
  });

  it("reaches all four tenant apps", () => {
    // Accounting (ledger), CRM (customers), Growth (loyalty) and Website
    // Management (website) — the four apps `apps.ts` allows, each through its
    // own module. My Workspace is deliberately not here: the shell is not a
    // gated module (industry-profile.ts), so it has no rail entry to assert.
    for (const module of ["ledger", "customers", "loyalty", "website"] as const) {
      expect(modules.has(module), module).toBe(true);
    }
  });

  it("keeps the shared areas every trade has", () => {
    for (const module of ["media", "reports", "settings"] as const) {
      expect(modules.has(module), module).toBe(true);
    }
  });
});

describe("the rail of every enabled industry", () => {
  it("never offers an area the industry's profile does not have", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      for (const item of flatten(navFor(industry, ALL_FEATURES))) {
        expect(
          hasModule(industry, item.module),
          `${industry}: ${item.label} (${item.module})`,
        ).toBe(true);
      }
    }
  });

  it("gives every trade a ledger, customers and settings", () => {
    // The three areas no profile may lack: money, people and configuration.
    for (const industry of ENABLED_INDUSTRIES) {
      const modules = modulesOf(navFor(industry, ALL_FEATURES));
      for (const module of ["ledger", "customers", "settings"] as const) {
        expect(modules.has(module), `${industry}: ${module}`).toBe(true);
      }
    }
  });
});
