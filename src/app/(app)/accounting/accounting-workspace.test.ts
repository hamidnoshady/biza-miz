import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_SECTIONS,
  accountingSectionsFor,
  canViewAccountingSection,
  LEDGER_WORKSPACE_LABEL,
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
  isLedgerWorkspacePathname,
  ledgerWorkspaceToolGroups,
  LEDGER_WORKSPACE_GROUP_KEY,
  LEDGER_WORKSPACE_ICON_KEY,
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
 * `/dashboard/*`. Then a second one: the ledger as a long disclosure bolted
 * onto the menu — sixteen rows, a chevron and a remembered open/closed state.
 * So the contract is:
 *
 *  1. the menu is a *complete* work menu, not the ledger alone;
 *  2. «فضای کار حسابداری» is ONE ordinary link inside it — same row skin as
 *     every other entry, no disclosure, no nested panel — whose href is the
 *     workspace page at `/accounting/ledger`;
 *  3. the workspace page lists every permitted ledger tool at its canonical
 *     route, filtered by the same permission helper the pages enforce;
 *  4. the business entries are adopted from the nav the shell already gated —
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

  it("keeps «فضای کار حسابداری» as ONE ordinary link in the same menu position", () => {
    const groups = groupsFor("owner");
    const ledger = groups.find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY);
    // One row, labelled exactly, at the workspace page's canonical href.
    expect(ledger?.entries).toEqual([
      {
        label: LEDGER_WORKSPACE_LABEL,
        href: "/accounting/ledger",
        section: "ledger",
        iconKey: LEDGER_WORKSPACE_ICON_KEY,
      },
    ]);
    // An ordinary row: it carries no disclosure furniture at all — no
    // collapsible marker, no sub-groups, no heading of its own. The words live
    // on the row, like «فروش و فاکتور»'s.
    expect(ledger?.label).toBeUndefined();
    expect(ledger?.description).toBeUndefined();
    // …in the same position it has always held: after the people directory,
    // before «گزارش و تحلیل».
    const keys = groups.map((group) => group.key);
    expect(keys.indexOf(LEDGER_WORKSPACE_GROUP_KEY)).toBeGreaterThan(keys.indexOf("people"));
    expect(keys.indexOf(LEDGER_WORKSPACE_GROUP_KEY)).toBeLessThan(keys.indexOf("reports"));
    // A group, not the menu: there is strictly more in the menu than it.
    expect(groups.length).toBeGreaterThan(1);
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

  it("gives every accounting section a home: a menu row or the workspace page", () => {
    // The menu rows plus the workspace door plus the tools the workspace page
    // lists must between them account for every section an owner may open — a
    // section with no home is a section that silently vanished from the app.
    const menuHrefs = new Set(accountingWorkspaceHrefs(groupsFor("owner")));
    const toolHrefs = new Set(
      ledgerWorkspaceToolGroups(of("owner")).flatMap((group) =>
        group.entries.map((entry) => entry.href),
      ),
    );
    for (const section of accountingSectionsFor(of("owner"))) {
      const href = accountingSectionHref(section.key);
      expect(
        menuHrefs.has(href) || toolHrefs.has(href),
        `section "${section.key}" has no entry in the Accounting menu or on the workspace page`,
      ).toBe(true);
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

  it("respects the per-section role gate on the workspace page", () => {
    // Payroll needs `payroll.view` (compensation data): the owner, the admin
    // and the accountant presets hold it by default, the manager's does not —
    // unless the business grants them the key — so a manager's workspace page
    // has the other tools without it.
    const managerTools = ledgerWorkspaceToolGroups(of("manager")).flatMap((group) => group.entries);
    expect(managerTools.map((entry) => entry.href)).not.toContain(accountingSectionHref("payroll"));
    expect(managerTools.map((entry) => entry.href)).toContain(accountingSectionHref("trial-balance"));
    const ownerTools = ledgerWorkspaceToolGroups(of("owner")).flatMap((group) => group.entries);
    expect(ownerTools.map((entry) => entry.href)).toContain(accountingSectionHref("payroll"));
    // And the section's own gate is what a hand-typed URL meets — hidden on
    // the page and denied at the door are the same permission, not two.
    expect(canViewAccountingSection(of("manager"), "payroll")).toBe(false);
    expect(canViewAccountingSection(of("owner"), "payroll")).toBe(true);
  });

  it("restricts a non-accounting role to their authorized business groups without the ledger", () => {
    const cashierGroups = groupsFor("cashier");
    const cashierHrefs = accountingWorkspaceHrefs(cashierGroups);
    expect(cashierHrefs).toContain(ACCOUNTING_WORKSPACE_HREFS.orders);
    expect(cashierHrefs).toContain(ACCOUNTING_WORKSPACE_HREFS.pos);
    // No workspace door, no tool links — and the door is denied server-side too.
    expect(cashierHrefs).not.toContain(accountingSectionHref("ledger"));
    expect(cashierHrefs).not.toContain(accountingSectionHref("dashboard"));
    expect(cashierHrefs).not.toContain(accountingSectionHref("trial-balance"));
    expect(ledgerWorkspaceToolGroups(of("cashier"))).toEqual([]);
    expect(canViewAccountingSection(of("cashier"), "ledger")).toBe(false);
    expect(canViewAccountingSection(of("cashier"), "trial-balance")).toBe(false);
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
});

describe("the «فضای کار حسابداری» workspace page's tool list", () => {
  it("lists every ledger tool under its named division", () => {
    // The regression: the ledger was sixteen rows in the sidebar with no
    // internal structure. The four divisions live on the workspace page now,
    // and every tool keeps its canonical route.
    const groups = ledgerWorkspaceToolGroups(of("owner"));
    expect(groups.map((group) => group.label)).toEqual([
      "دفتر و اسناد",
      "دریافتنی و پرداختنی",
      "وجوه و هزینه",
      "دوره، مالیات و حقوق",
    ]);
    for (const group of groups) {
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        expect(entry.href).toBe(accountingSectionHref(entry.section!));
      }
    }
  });

  it("is an arrangement of the ledger tools, never a second list", () => {
    const fromPage = ledgerWorkspaceToolGroups(of("owner"))
      .flatMap((group) => group.entries.map((entry) => entry.href))
      .sort();
    const canonical = LEDGER_WORKSPACE_SECTION_KEYS.map((key) =>
      accountingSectionHref(key),
    ).sort();
    expect(fromPage).toEqual(canonical);
    // …and each tool sits in exactly one division.
    expect(new Set(fromPage).size).toBe(fromPage.length);
  });

  it("drops a division the member's role empties, rather than showing an empty heading", () => {
    // Payroll needs `payroll.view`, which the manager preset lacks; a manager
    // keeps «دوره، مالیات و حقوق» (it still holds دوره‌های مالی و مالیات) but
    // never an empty heading.
    for (const role of ["owner", "manager", "accountant"] as const) {
      for (const group of ledgerWorkspaceToolGroups(of(role))) {
        expect(group.entries.length, `«${group.label}» is empty for ${role}`).toBeGreaterThan(0);
      }
    }
    // …and payroll is genuinely absent from the manager's page, not merely
    // hidden by the renderer: the same helper the section gate reads.
    const managerTools = ledgerWorkspaceToolGroups(of("manager"))
      .flatMap((group) => group.entries)
      .map((entry) => entry.section);
    expect(managerTools).not.toContain("payroll");
    expect(managerTools).toContain("vat");
  });
});

describe("the ledger workspace's own section list", () => {
  it("names only real sections, none of them twice", () => {
    for (const key of LEDGER_WORKSPACE_SECTION_KEYS) {
      expect(ACCOUNTING_SECTION_KEYS).toContain(key);
    }
    expect(new Set(LEDGER_WORKSPACE_SECTION_KEYS).size).toBe(
      LEDGER_WORKSPACE_SECTION_KEYS.length,
    );
  });

  it("leaves app-level areas and the workspace door itself out of the tool list", () => {
    // Home, the workspace page, people, reports, growth analysis and app
    // settings are focused homes of their own; none is buried among ledger
    // tools — and every section still has a home (menu row or workspace page).
    for (const outside of [
      "dashboard",
      "ledger",
      "directory",
      "financial-reports",
      "growth",
      "settings",
    ]) {
      expect(LEDGER_WORKSPACE_SECTION_KEYS).not.toContain(outside);
    }
  });
});

describe("the ledger tool divisions", () => {
  it("gives every ledger tool exactly one division, and the tool set is exactly these fifteen", () => {
    // The contract, written out: a tool added or dropped must change this list
    // on purpose. The tool set is derived from the divisions, so this is the one
    // place the membership is pinned — not a second copy of it.
    const expected = [
      "trial-balance", "entries", "manual", "chart-of-accounts",
      "receivables", "payables", "installments", "cheques",
      "receipts", "expenses", "reconciliation", "fixed-assets",
      "fiscal-periods", "vat", "payroll",
    ];
    const placed = LEDGER_WORKSPACE_SUBGROUPS.flatMap((subGroup) => subGroup.keys);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...LEDGER_WORKSPACE_SECTION_KEYS].sort()).toEqual([...expected].sort());
    expect([...placed].sort()).toEqual([...expected].sort());
    // The order inside each division is what the page and the in-page rail
    // show, so it is pinned too: the rail's siblings follow this order.
    expect(LEDGER_WORKSPACE_SUBGROUPS.map((subGroup) => subGroup.keys)).toEqual([
      ["trial-balance", "entries", "manual", "chart-of-accounts"],
      ["receivables", "payables", "installments", "cheques"],
      ["receipts", "expenses", "reconciliation", "fixed-assets"],
      ["fiscal-periods", "vat", "payroll"],
    ]);
  });

  it("names each division once", () => {
    const keys = LEDGER_WORKSPACE_SUBGROUPS.map((subGroup) => subGroup.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * One «you are here» rule for the menu that draws these groups.
 *
 * The Accounting app's contextual sidebar is the one renderer of these groups.
 * The active rule is still kept separately because the workspace row stands
 * for sixteen pages, filtered directory views and nested product pages are the
 * places a raw prefix match gets wrong.
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

  it("lights the workspace row on its landing page and its owned tool routes", () => {
    const workspace = entry(accountingSectionHref("ledger"), {
      section: "ledger",
      iconKey: LEDGER_WORKSPACE_ICON_KEY,
    });
    expect(workspaceEntryIsActive(workspace, "/accounting/ledger", "")).toBe(true);
    for (const key of LEDGER_WORKSPACE_SECTION_KEYS) {
      expect(
        workspaceEntryIsActive(workspace, accountingSectionHref(key), ""),
        `the workspace row must light on ${key}`,
      ).toBe(true);
    }
    expect(isLedgerWorkspacePathname("/accounting/ledger")).toBe(true);
  });

  it("keeps the workspace row dark on unrelated Accounting areas", () => {
    const workspace = entry(accountingSectionHref("ledger"), { section: "ledger" });
    for (const path of [
      "/accounting/overview",
      "/accounting/directory",
      "/accounting/orders",
      "/accounting/orders/42",
      "/accounting/pos",
      "/accounting/inventory",
      "/accounting/reports",
      "/accounting/settings",
    ]) {
      expect(
        workspaceEntryIsActive(workspace, path, ""),
        `the workspace row must stay dark on ${path}`,
      ).toBe(false);
      expect(isLedgerWorkspacePathname(path), `${path} is not a ledger workspace route`).toBe(false);
    }
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

  it("lights exactly one entry on every tool route too", () => {
    // The tools are not in the menu any more — the workspace row is the one
    // «you are here» that stands for them, and nothing else may light beside it.
    const groups = accountingWorkspaceGroups({ permissions: of("owner"), navItems: [] });
    const entries = groups.flatMap((group) => group.entries);
    for (const key of LEDGER_WORKSPACE_SECTION_KEYS) {
      const lit = entries.filter((candidate) =>
        workspaceEntryIsActive(candidate, accountingSectionHref(key), ""),
      );
      expect(lit.map((item) => item.href)).toEqual([accountingSectionHref("ledger")]);
    }
  });
});
