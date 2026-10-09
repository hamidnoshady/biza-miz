import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_SECTIONS,
  accountingSectionsFor,
} from "./accounting-nav";
import { roleBasePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
import {
  ACCOUNTING_SECTION_KEYS,
  accountingSectionHref,
} from "./accounting-routes";
import {
  accountingWorkspaceGroups,
  accountingWorkspaceHrefs,
  LEDGER_WORKSPACE_GROUP_KEY,
  LEDGER_WORKSPACE_LABEL,
  LEDGER_WORKSPACE_SECTION_KEYS,
  LEDGER_WORKSPACE_SUBGROUPS,
  workspaceEntryIsActive,
  type WorkspaceNavEntry,
} from "./accounting-workspace";
import { partyDirectoryHref } from "@/lib/party-directory";
import {
  ACCOUNTING_WORKSPACE_HREFS,
  accountingProductsHref,
} from "@/lib/app-routes";

/**
 * Accounting is the business's primary workspace.
 *
 * The regression these assertions exist to prevent is the one they were
 * written for: «حسابداری» opening straight into the ledger rail, with every
 * other work area of the business living in a second main menu at
 * `/dashboard/*`. So the contract is:
 *
 *  1. the menu is a *complete* work menu, not the ledger alone;
 *  2. «فضای کار حسابداری» is a group *inside* it, never the whole thing;
 *  3. the business entries are adopted from the nav the shell already gated —
 *     never re-declared here, so a page the member cannot open cannot appear.
 */

/** A business nav the way the shell hands it over: already filtered, flattened. */
const BUSINESS_NAV = [
  { label: "داشبورد", href: "/overview" },
  { label: "سفارش‌ها", href: ACCOUNTING_WORKSPACE_HREFS.orders },
  { label: "صندوق (فروش)", href: ACCOUNTING_WORKSPACE_HREFS.pos },
  { label: "انبار", href: ACCOUNTING_WORKSPACE_HREFS.inventory },
  {
    label: "محصولات",
    href: ACCOUNTING_WORKSPACE_HREFS.products,
    iconKey: ACCOUNTING_WORKSPACE_HREFS.products,
  },
  { label: "لیست قیمت", href: accountingProductsHref("prices") },
  { label: "گزارش‌ها", href: ACCOUNTING_WORKSPACE_HREFS.reports },
  { label: "مرکز آموزش", href: "/knowledge" },
];

/**
 * The rail is driven by effective permissions now. These helpers keep the
 * tests reading in terms of roles, because what they pin is the migration
 * invariant: each built-in preset must see exactly the rail its old role list
 * produced.
 */
function of(role: Role | "none"): ReadonlySet<string> {
  return new Set<string>(role === "none" ? [] : roleBasePermissions(role));
}

function groupsFor(role: Role | "none", navItems = BUSINESS_NAV) {
  return accountingWorkspaceGroups({ permissions: of(role), navItems });
}

describe("the Accounting workspace menu", () => {
  it("opens on a complete overview, not on the ledger", () => {
    const groups = groupsFor("owner");
    // The very first entry of the very first group is the app's home.
    expect(groups[0].entries[0].href).toBe(accountingSectionHref("dashboard"));
    // …and the ledger is not the first thing in the menu any more.
    expect(groups[0].key).not.toBe(LEDGER_WORKSPACE_GROUP_KEY);
  });

  it("exposes the business's primary work areas, not only the ledger", () => {
    const hrefs = accountingWorkspaceHrefs(groupsFor("owner"));
    for (const expected of [
      ACCOUNTING_WORKSPACE_HREFS.orders,
      ACCOUNTING_WORKSPACE_HREFS.pos,
      ACCOUNTING_WORKSPACE_HREFS.inventory,
      ACCOUNTING_WORKSPACE_HREFS.products,
      ACCOUNTING_WORKSPACE_HREFS.reports,
    ]) {
      expect(
        hrefs,
        `«حسابداری» must expose ${expected} as a primary work area`,
      ).toContain(expected);
    }
  });

  it("keeps «فضای کار حسابداری» as one named group inside the menu", () => {
    const groups = groupsFor("owner");
    const ledger = groups.find(
      (group) => group.key === LEDGER_WORKSPACE_GROUP_KEY,
    );
    expect(ledger).toBeDefined();
    expect(ledger?.label).toBe(LEDGER_WORKSPACE_LABEL);
    // A group, not the menu: there is strictly more in the menu than it.
    expect(groups.length).toBeGreaterThan(1);
    // And it holds the financial tools the product promises there.
    const keys = ledger?.entries.map((entry) => entry.section);
    for (const expected of [
      "trial-balance",
      "entries",
      "manual",
      "expenses",
      "fiscal-periods",
      "receivables",
      "payables",
      "receipts",
      "installments",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it("keeps Accounting settings in one final app-owned group", () => {
    const groups = groupsFor("owner");
    const settingsHref = accountingSectionHref("settings");
    const containingGroups = groups.filter((group) =>
      group.entries.some((entry) => entry.href === settingsHref),
    );

    expect(containingGroups.map((group) => group.key)).toEqual(["settings"]);
    expect(
      containingGroups[0].entries.find((entry) => entry.href === settingsHref)
        ?.label,
    ).toBe("تنظیمات حسابداری");
  });

  it("gives every accounting section a home somewhere in the menu", () => {
    // The ledger group plus the top-level entries must between them account
    // for every section an owner may open — a section with no home is a
    // section that silently vanished from the app.
    const hrefs = new Set(accountingWorkspaceHrefs(groupsFor("owner")));
    for (const section of accountingSectionsFor(of("owner"))) {
      expect(
        hrefs,
        `section "${section.key}" has no entry in the Accounting menu`,
      ).toContain(accountingSectionHref(section.key));
    }
  });

  it("adopts only pages the shell already granted this member", () => {
    // The same role, a nav with no انبار (a trade that has none, or a member
    // who may not open it): the entry simply is not there. One gate.
    const hrefs = accountingWorkspaceHrefs(
      groupsFor(
        "owner",
        BUSINESS_NAV.filter(
          (item) => item.href !== ACCOUNTING_WORKSPACE_HREFS.inventory,
        ),
      ),
    );
    expect(hrefs).not.toContain(ACCOUNTING_WORKSPACE_HREFS.inventory);
    expect(hrefs).toContain(ACCOUNTING_WORKSPACE_HREFS.products);
  });

  it("never adopts a page that is not a work area", () => {
    const hrefs = accountingWorkspaceHrefs(groupsFor("owner"));
    expect(hrefs).not.toContain("/knowledge");
  });

  it("respects the per-section role gate", () => {
    // Payroll needs `payroll.view` (compensation data): the owner, admin and
    // accountant presets hold it, the manager's does not, so a manager's menu
    // has the ledger group without it.
    const managerHrefs = accountingWorkspaceHrefs(groupsFor("manager"));
    expect(managerHrefs).not.toContain(accountingSectionHref("payroll"));
    expect(managerHrefs).toContain(accountingSectionHref("trial-balance"));
    expect(accountingWorkspaceHrefs(groupsFor("owner"))).toContain(
      accountingSectionHref("payroll"),
    );
  });

  it("restricts a non-accounting role to their authorized business groups without ledger sections", () => {
    const cashierHrefs = accountingWorkspaceHrefs(groupsFor("cashier"));
    expect(cashierHrefs).toContain(ACCOUNTING_WORKSPACE_HREFS.orders);
    expect(cashierHrefs).toContain(ACCOUNTING_WORKSPACE_HREFS.pos);
    expect(cashierHrefs).not.toContain(accountingSectionHref("dashboard"));
    expect(cashierHrefs).not.toContain(accountingSectionHref("trial-balance"));
    expect(cashierHrefs).not.toContain(accountingSectionHref("payroll"));
    expect(cashierHrefs).not.toContain(accountingSectionHref("entries"));
  });

  it("offers exactly one people directory, plus filtered deep links", () => {
    const groups = groupsFor("owner");
    const people = groups.find((group) => group.key === "people");
    expect(people).toBeDefined();
    // One entry per *view*, all of them the one route.
    for (const entry of people!.entries) {
      expect(entry.href.split("?")[0]).toBe(accountingSectionHref("directory"));
    }
    expect(people!.entries.map((entry) => entry.href)).toEqual([
      accountingSectionHref("directory"),
      partyDirectoryHref("customers"),
      partyDirectoryHref("suppliers"),
    ]);
  });

  it("has no duplicate entries — one href, one row", () => {
    const hrefs = accountingWorkspaceHrefs(groupsFor("owner"));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("divides the long ledger group into named sub-groups, like every other group", () => {
    // The regression: «فضای کار حسابداری» was the one group in the menu with
    // sixteen rows under a single heading and no internal structure, which is
    // what made it read as a drawer bolted onto the menu rather than a part
    // of it.
    const ledger = groupsFor("owner").find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY);
    expect(ledger?.subGroups?.length).toBeGreaterThan(1);
    for (const subGroup of ledger!.subGroups!) {
      expect(subGroup.label).not.toBe("");
      expect(subGroup.entries.length).toBeGreaterThan(0);
    }
  });

  it("keeps the sub-groups an arrangement of the group, never a second list", () => {
    const ledger = groupsFor("owner").find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY);
    const fromSubGroups = ledger!.subGroups!.flatMap((subGroup) => subGroup.entries.map((e) => e.href));
    expect(fromSubGroups).toEqual(ledger!.entries.map((entry) => entry.href));
    // …and each entry sits in exactly one of them.
    expect(new Set(fromSubGroups).size).toBe(fromSubGroups.length);
  });

  it("drops a sub-group the member's role empties, rather than showing an empty heading", () => {
    // Payroll needs `payroll.view`, which the manager preset lacks; a manager
    // keeps «دوره، مالیات و حقوق» (it still holds دوره‌های مالی و مالیات) but
    // never an empty heading.
    for (const role of ["owner", "manager", "accountant"] as const) {
      const ledger = groupsFor(role).find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY);
      for (const subGroup of ledger?.subGroups ?? []) {
        expect(subGroup.entries.length, `«${subGroup.label}» is empty for ${role}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives the collapsible group a glyph, because its heading hides at the icon rail", () => {
    const ledger = groupsFor("owner").find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY);
    expect(ledger?.iconKey).toBeTruthy();
  });

  it("only marks the long ledger group as collapsible", () => {
    const collapsible = groupsFor("owner").filter((group) => group.collapsible);
    expect(collapsible.map((group) => group.key)).toEqual([
      LEDGER_WORKSPACE_GROUP_KEY,
    ]);
  });
});

describe("the ledger group's own sub-groups", () => {
  it("gives every ledger section exactly one sub-group", () => {
    const placed = LEDGER_WORKSPACE_SUBGROUPS.flatMap((subGroup) => subGroup.keys);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual([...LEDGER_WORKSPACE_SECTION_KEYS].sort());
  });

  it("names each sub-group once", () => {
    const keys = LEDGER_WORKSPACE_SUBGROUPS.map((subGroup) => subGroup.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the ledger group's own section list", () => {
  it("names only real sections, none of them twice", () => {
    for (const key of LEDGER_WORKSPACE_SECTION_KEYS) {
      expect(ACCOUNTING_SECTION_KEYS).toContain(key);
    }
    expect(new Set(LEDGER_WORKSPACE_SECTION_KEYS).size).toBe(
      LEDGER_WORKSPACE_SECTION_KEYS.length,
    );
  });

  it("leaves app-level areas out of the ledger while keeping every section owned", () => {
    // Home, people, reports, growth analysis and app settings are focused
    // groups of their own; none is buried in the financial-tools disclosure.
    for (const outside of [
      "dashboard",
      "directory",
      "financial-reports",
      "growth",
      "settings",
    ]) {
      expect(LEDGER_WORKSPACE_SECTION_KEYS).not.toContain(outside);
    }
    const hrefs = new Set(accountingWorkspaceHrefs(groupsFor("owner")));
    for (const section of ACCOUNTING_SECTIONS) {
      expect(hrefs, `section "${section.key}" is in no Accounting menu group`).toContain(
        accountingSectionHref(section.key),
      );
    }
  });
});


/**
 * One «you are here» rule for both sidebars that draw this menu.
 *
 * The Accounting app's contextual sidebar is the one renderer of these groups.
 * The active rule is still kept separately because filtered directory views and
 * nested product pages are the places a raw prefix match gets wrong.
 */
describe("which menu entry is the page you are on", () => {
  const entry = (href: string, extra: Partial<WorkspaceNavEntry> = {}): WorkspaceNavEntry => ({
    label: "x",
    href,
    ...extra,
  });

  it("matches a plain entry on its own path and anything nested under it", () => {
    const orders = entry("/accounting/orders");
    expect(workspaceEntryIsActive(orders, "/accounting/orders", "")).toBe(true);
    expect(workspaceEntryIsActive(orders, "/accounting/orders/42", "")).toBe(true);
    expect(workspaceEntryIsActive(orders, "/accounting/reports", "")).toBe(false);
  });

  it("does not let a prefix match spill past a path boundary", () => {
    // `/accounting/order-templates` is a different page, not a child.
    expect(
      workspaceEntryIsActive(entry("/accounting/orders"), "/accounting/orders-archive", ""),
    ).toBe(false);
  });

  it("keeps the «محصولات» hub exact, so its sub-pages do not light it", () => {
    const products = entry(ACCOUNTING_WORKSPACE_HREFS.products);
    expect(workspaceEntryIsActive(products, ACCOUNTING_WORKSPACE_HREFS.products, "")).toBe(true);
    expect(
      workspaceEntryIsActive(products, `${ACCOUNTING_WORKSPACE_HREFS.products}/prices`, ""),
    ).toBe(false);
  });

  it("keeps «میز کار» exact, so it is not lit by every dashboard page", () => {
    const home = entry("/dashboard");
    expect(workspaceEntryIsActive(home, "/dashboard", "")).toBe(true);
    expect(workspaceEntryIsActive(home, "/dashboard/pos", "")).toBe(false);
  });

  it("lets a `?view=` deep link own its view, and the parent own the default", () => {
    const all = entry(partyDirectoryHref(), { section: "directory" });
    const customers = entry(partyDirectoryHref("customers"), { section: "directory" });
    const pathname = partyDirectoryHref().split("?")[0];
    expect(workspaceEntryIsActive(all, pathname, "")).toBe(true);
    expect(workspaceEntryIsActive(customers, pathname, "")).toBe(false);
    expect(workspaceEntryIsActive(customers, pathname, "view=customers")).toBe(true);
    expect(workspaceEntryIsActive(all, pathname, "view=customers")).toBe(false);
  });

  it("never lights two entries of the real menu at once", () => {
    const groups = accountingWorkspaceGroups({ permissions: of("owner"), navItems: [] });
    const entries = groups.flatMap((group) => group.entries);
    for (const current of entries) {
      const [pathname, search = ""] = current.href.split("?");
      const lit = entries.filter((candidate) =>
        workspaceEntryIsActive(candidate, pathname, search),
      );
      expect(lit.map((item) => item.href)).toEqual([current.href]);
    }
  });
});
