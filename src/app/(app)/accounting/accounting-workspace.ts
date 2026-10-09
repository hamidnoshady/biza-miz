/**
 * The complete Accounting workspace menu — what «حسابداری» actually contains.
 *
 * The problem this file exists to fix: Accounting *was* the whole ledger and
 * nothing else. Opening it dropped you straight into «فضای کار حسابداری» —
 * تراز آزمایشی، دفتر روزنامه، اسناد، اشخاص، دریافت و پرداخت — while everything
 * a business does that the ledger then records (فروش و فاکتور، خرید و انبار،
 * محصولات، گزارش‌ها، عملیات صنف) lived in a *second* main menu at
 * `/dashboard/*`. Two competing "main" navigations for one product, and the
 * one called «حسابداری» was the narrower of the two.
 *
 * So Accounting is the primary workspace, and the ledger is one ordinary
 * link inside it — «فضای کار حسابداری», no disclosure and no chevron — whose
 * landing page (`/accounting/ledger`, the `ledger` section) lists every
 * permitted ledger tool under the accountant's own divisions. Concretely:
 *
 *  - the **work areas** (sales, purchases, inventory, products, reports, the
 *    trade's own operational screens) are the business nav entries that
 *    already exist. They are *picked out of* the list the shell already built
 *    — `navItems`, with every module / role / feature / permission filter
 *    already applied — and never re-declared here. A business whose trade has
 *    no انبار has no انبار row, because the entry was never in the list.
 *  - the **ledger tools** are `LEDGER_WORKSPACE_SECTION_KEYS`, unchanged: they
 *    keep their routes, gates and labels, and `LEDGER_WORKSPACE_SUBGROUPS`
 *    arranges them on the workspace page the way an accountant divides the
 *    work — دفتر، دریافتنی و پرداختنی، وجوه و هزینه، دوره و مالیات.
 *
 * Framework-free (no React, no JSX, no icons) like `accounting-nav.ts` beside
 * it, so the same composition is testable and can be read by the server nav
 * builder as well as by the client sidebar.
 */

import type { AccountingSectionKey } from "./accounting-routes";
import { accountingSectionHref, isAccountingSectionPathname } from "./accounting-routes";
import { accountingSectionsFor, type AccountingSectionDef } from "./accounting-nav";
import { ACCOUNTING_WORKSPACE_HREFS, accountingProductsHref } from "@/lib/app-routes";
import { partyDirectoryHref } from "@/lib/party-directory";

/** A nav entry as the composer needs it — the business nav's shape, narrowed. */
export interface WorkspaceNavEntry {
  label: string;
  href: string;
  /** Set when this entry came from a business page rather than an accounting section. */
  external?: boolean;
  /** The Accounting section this entry is, when it is one. Decides the glyph and the active rule. */
  section?: AccountingSectionKey;
  /**
   * The nav icon key, for an entry drawn from the business nav — and for the
   * one section row that wears the app's own glyph (`LEDGER_WORKSPACE_ICON_KEY`)
   * instead of its section map entry.
   */
  iconKey?: string;
}

/**
 * A named block of the menu: a heading over its rows. A group with no label is
 * one ordinary link standing in the column where a group used to be — the
 * «فضای کار حسابداری» workspace door, which wears its words on the row the way
 * «فروش و فاکتور» does rather than on a heading above it.
 */
export interface WorkspaceNavGroup {
  /** The group's own id, stable across renders. */
  key: string;
  /** Absent for the single-link workspace door — the row *is* the label. */
  label?: string;
  /** One line under the heading, for the groups whose contents are not obvious. */
  description?: string;
  /** Every entry of the group, flat and in menu order — what a picker, a test or a bottom-nav reads. */
  entries: WorkspaceNavEntry[];
}

/** The business nav entries this menu is willing to adopt, by href, in menu order. */
interface WorkspaceSlot {
  /** The business nav href to look for. */
  href: string;
  /** Override the business nav's own label when Accounting calls it something else. */
  label?: string;
}

/**
 * Which business pages belong in which Accounting group.
 *
 * Matched on href rather than on label or module: the label is the trade's
 * word for the page («فروش و فاکتور» in a jewellery shop, «صندوق (فروش)» in a
 * café) and must stay the trade's word, while the href is the stable identity
 * of the page. A page not in this table is simply not adopted, which is how
 * «مرکز آموزش» and «پشتیبانی» stay out of a work menu without being filtered
 * by a rule that could accidentally catch something else.
 */
const WORKSPACE_GROUP_SLOTS: readonly { key: string; label: string; description?: string; slots: readonly WorkspaceSlot[] }[] = [
  {
    key: "sales",
    label: "فروش و درآمد",
    description: "فاکتورها، صندوق و مشتریان",
    slots: [
      { href: "/accounting/orders" },
      { href: ACCOUNTING_WORKSPACE_HREFS.pos },
      // After «صندوق (فروش)» (issue #844): the menu is what the till sells.
      { href: ACCOUNTING_WORKSPACE_HREFS.menu },
    ],
  },
  {
    key: "purchasing",
    label: "خرید و انبار",
    description: "تأمین، موجودی و کالا",
    slots: [
      { href: ACCOUNTING_WORKSPACE_HREFS.inventory },
      { href: accountingProductsHref() },
      { href: accountingProductsHref("new") },
      { href: accountingProductsHref("prices") },
      { href: accountingProductsHref("attributes") },
      { href: accountingProductsHref("barcode-templates") },
      { href: accountingProductsHref("reports") },
    ],
  },
  {
    key: "operations",
    label: "عملیات",
    description: "بخش‌های عملیاتی این صنف",
    slots: [
      { href: ACCOUNTING_WORKSPACE_HREFS.floor },
      { href: "/accounting/waiter" },
      { href: ACCOUNTING_WORKSPACE_HREFS.kitchen },
      { href: ACCOUNTING_WORKSPACE_HREFS.reservations },
      { href: ACCOUNTING_WORKSPACE_HREFS.delivery },
      { href: "/accounting/jewelry" },
      { href: "/accounting/watch" },
      { href: ACCOUNTING_WORKSPACE_HREFS.cosmetics },
    ],
  },
];

/** The reports group's business entries — kept apart because it sits after the ledger. */
const REPORTS_SLOTS: readonly WorkspaceSlot[] = [
  { href: ACCOUNTING_WORKSPACE_HREFS.reports, label: "گزارش‌های کسب‌وکار" },
];

/**
 * The ledger's own tools — everything the «فضای کار حسابداری» page links to.
 *
 * Membership lives here; the *order* and the headings live in
 * `LEDGER_WORKSPACE_SUBGROUPS` below, which arranges exactly these keys.
 * Their routes, labels, icons and permissions are untouched: the sidebar
 * simply links to the workspace page instead of listing them all, and the
 * page lists them through the same permission helper the menu used.
 *
 * Everything `ACCOUNTING_SECTIONS` holds except the workspace door itself and
 * the app-level areas: the app's home (a group of its own at the top), the
 * directory (the people group), reports, the cross-domain growth analysis,
 * and app settings. Those destinations have their own focused groups rather
 * than being buried among ledger tools.
 */
export const LEDGER_WORKSPACE_SECTION_KEYS: readonly AccountingSectionKey[] = [
  "trial-balance",
  "entries",
  "manual",
  "chart-of-accounts",
  "receivables",
  "payables",
  "receipts",
  "installments",
  "cheques",
  "expenses",
  "reconciliation",
  "fixed-assets",
  "fiscal-periods",
  "vat",
  "payroll",
];

/**
 * How the «فضای کار حسابداری» page divides its tools.
 *
 * The workspace is one ordinary menu link now, so the ledger's sixteen rows no
 * longer sit in the sidebar at all — they are listed on `/accounting/ledger`
 * under these headings. These are the accountant's own divisions — the same
 * ones the in-page rail already draws (`ACCOUNTING_NAV_GROUPS`), narrowed to
 * the keys `LEDGER_WORKSPACE_SECTION_KEYS` holds.
 *
 * The union of these keys is exactly `LEDGER_WORKSPACE_SECTION_KEYS`, asserted
 * in `accounting-workspace.test.ts`, so a ledger tool can never be added
 * without a home — and the sub-groups can never become a second, disagreeing
 * list.
 */
export const LEDGER_WORKSPACE_SUBGROUPS: readonly {
  key: string;
  label: string;
  keys: readonly AccountingSectionKey[];
}[] = [
  { key: "ledger-books", label: "دفتر و اسناد", keys: ["trial-balance", "entries", "manual", "chart-of-accounts"] },
  {
    key: "ledger-receivables",
    label: "دریافتنی و پرداختنی",
    keys: ["receivables", "payables", "installments", "cheques"],
  },
  { key: "ledger-funds", label: "وجوه و هزینه", keys: ["receipts", "expenses", "reconciliation", "fixed-assets"] },
  { key: "ledger-periods", label: "دوره، مالیات و حقوق", keys: ["fiscal-periods", "vat", "payroll"] },
];

/** The label «فضای کار حسابداری» wears wherever it is drawn — menu row and page alike. */
export const LEDGER_WORKSPACE_LABEL = "فضای کار حسابداری";
export const LEDGER_WORKSPACE_GROUP_KEY = "ledger";
/**
 * The glyph the workspace row wears — the same calculator the workspace rail
 * and the bottom nav already use for «حسابداری», so the row is recognisable at
 * 4rem where its label is hidden. It is the *mapping* (an `NAV_ICONS` key), not
 * a copy of the icon, so the two surfaces can never drift apart.
 */
export const LEDGER_WORKSPACE_ICON_KEY = "/accounting";

/**
 * Compose the Accounting app's complete menu.
 *
 * `navItems` is the business nav the shell already built and already filtered;
 * the composer only *arranges* it. A slot whose page this member cannot reach
 * is absent from that list, so it is absent here — no second gate, and no way
 * for the two to disagree.
 */
export function accountingWorkspaceGroups({
  permissions,
  navItems,
}: {
  /** The member's effective permissions — the same set the routes enforce. */
  permissions: ReadonlySet<string>;
  /** The business nav, flattened (parents and children alike), already gated. */
  navItems: readonly { label: string; href: string; iconKey?: string }[];
}): WorkspaceNavGroup[] {
  const allowed = accountingSectionsFor(permissions);
  const byKey = new Map<AccountingSectionKey, AccountingSectionDef>(
    allowed.map((section) => [section.key, section]),
  );
  const businessByHref = new Map(navItems.map((item) => [item.href, item]));

  const sectionEntry = (key: AccountingSectionKey, label?: string): WorkspaceNavEntry[] => {
    const section = byKey.get(key);
    if (!section) return [];
    return [{ label: label ?? section.label, href: accountingSectionHref(key), section: key }];
  };

  const businessEntries = (slots: readonly WorkspaceSlot[]): WorkspaceNavEntry[] =>
    slots.flatMap((slot) => {
      const item = businessByHref.get(slot.href);
      if (!item) return [];
      return [
        {
          label: slot.label ?? item.label,
          href: item.href,
          external: true,
          iconKey: item.iconKey ?? item.href,
        },
      ];
    });

  const groups: WorkspaceNavGroup[] = [];

  // 1. The main dashboard / workspace home: «میز کار» with «داشبورد حسابداری»
  const homeEntries = sectionEntry("dashboard", "داشبورد حسابداری");
  if (homeEntries.length > 0) {
    groups.push({
      key: "home",
      label: "میز کار",
      entries: homeEntries,
    });
  }

  // 2. The business work areas, in the order a day runs: sell, buy, operate.
  for (const group of WORKSPACE_GROUP_SLOTS) {
    const entries = businessEntries(group.slots);
    if (entries.length === 0) continue;
    groups.push({ key: group.key, label: group.label, description: group.description, entries });
  }

  // 3. The one people directory, with its useful views as deep links.
  const directory = sectionEntry("directory", "اشخاص");
  if (directory.length > 0) {
    groups.push({
      key: "people",
      label: "اشخاص",
      description: "مشتریان، تأمین‌کنندگان و کارکنان — یک فهرست",
      entries: [
        ...directory,
        { label: "مشتریان", href: partyDirectoryHref("customers"), section: "directory" },
        { label: "تأمین‌کنندگان", href: partyDirectoryHref("suppliers"), section: "directory" },
      ],
    });
  }

  // 4. «فضای کار حسابداری» — one ordinary link, in the same menu position the
  // long ledger group used to occupy. No disclosure, no chevron, no nested
  // panel: the row is drawn like every other menu link and opens the workspace
  // page (`/accounting/ledger`), which lists the permitted tools under the
  // accountant's own divisions. It appears only for a member the same section
  // gate lets in (`accountingSectionsFor` → the `ledger.view` door).
  const ledgerWorkspace = sectionEntry("ledger").map((entry) => ({
    ...entry,
    iconKey: LEDGER_WORKSPACE_ICON_KEY,
  }));
  if (ledgerWorkspace.length > 0) {
    groups.push({
      key: LEDGER_WORKSPACE_GROUP_KEY,
      entries: ledgerWorkspace,
    });
  }

  // 5. Reports — the ledger's own, then the business's.
  const reports = [
    ...sectionEntry("financial-reports", "گزارش‌های مالی"),
    ...businessEntries(REPORTS_SLOTS),
    ...sectionEntry("growth"),
  ];
  if (reports.length > 0) {
    groups.push({ key: "reports", label: "گزارش و تحلیل", entries: reports });
  }

  // 6. App settings, last. Shared business settings, technical connections,
  // billing and Website Management deliberately stay out of Accounting's menu:
  // they are reached through the platform user menu or an explicit contextual
  // link, not represented as Accounting sub-workspaces.
  const settings = sectionEntry("settings");
  if (settings.length > 0) {
    groups.push({ key: "settings", label: "تنظیمات", entries: settings });
  }

  return groups;
}

/** Every href the composed menu offers — what a test and the bottom-nav picker read. */
export function accountingWorkspaceHrefs(groups: readonly WorkspaceNavGroup[]): string[] {
  return groups.flatMap((group) => group.entries.map((entry) => entry.href));
}

/** One heading of the workspace page, with the permitted tools under it. */
export interface LedgerWorkspaceToolGroup {
  key: string;
  label: string;
  entries: WorkspaceNavEntry[];
}

/**
 * What the «فضای کار حسابداری» page lists: the ledger's tools, arranged by
 * `LEDGER_WORKSPACE_SUBGROUPS` and filtered through the *same* permission
 * helper the menu and the page gates use (`accountingSectionsFor`). The page
 * and the sidebar therefore can never disagree about who sees payroll — and
 * this function is the testable half of that promise.
 *
 * A sub-group the member's permissions empty is dropped rather than shown as
 * an empty heading.
 */
export function ledgerWorkspaceToolGroups(
  permissions: ReadonlySet<string>,
): LedgerWorkspaceToolGroup[] {
  const allowed = accountingSectionsFor(permissions);
  return LEDGER_WORKSPACE_SUBGROUPS.flatMap((subGroup) => {
    const entries = subGroup.keys.flatMap((key) => {
      const section = allowed.find((candidate) => candidate.key === key);
      return section ? [{ label: section.label, href: accountingSectionHref(key), section: key }] : [];
    });
    return entries.length > 0 ? [{ key: subGroup.key, label: subGroup.label, entries }] : [];
  });
}

/**
 * Whether this pathname is the ledger workspace or one of the tools it owns —
 * the «you are here» of the one menu row that stands for all of them.
 *
 * Deliberately *not* every Accounting page: the workspace row must light on
 * `/accounting/ledger` and the tool routes (`LEDGER_WORKSPACE_SECTION_KEYS`)
 * and stay dark on unrelated areas — sales, inventory, the directory, reports
 * and the overview (`داشبورد حسابداری`) each have their own row.
 */
export function isLedgerWorkspacePathname(pathname: string): boolean {
  return (
    isAccountingSectionPathname(pathname, "ledger") ||
    LEDGER_WORKSPACE_SECTION_KEYS.some((key) => isAccountingSectionPathname(pathname, key))
  );
}

/**
 * Is this entry the page we are on? — the ONE rule, for every menu that draws
 * these groups.
 *
 * Accounting's contextual sidebar draws `accountingWorkspaceGroups()` through
 * this one rule. Earlier copies had already drifted: separate product
 * destinations could light their parent and a filtered people directory could
 * lose its selected view. Keeping the answer beside the menu composition makes
 * those states consistent wherever the group is rendered.
 *
 * Three kinds of entry, three rules:
 *  - the ledger workspace row matches its landing page *and* the tool routes
 *    it owns (`isLedgerWorkspacePathname`) — and nothing else;
 *  - an accounting *section* matches by section key, plus the `?view=` filter
 *    so a deep link («مشتریان») is only current while that view is showing and
 *    the parent («اشخاص») owns the default list;
 *  - a bare href matches its path prefix, except for the roots that would
 *    otherwise swallow everything beneath them.
 */
export function workspaceEntryIsActive(
  entry: WorkspaceNavEntry,
  pathname: string,
  search: string,
): boolean {
  if (entry.section === "ledger") {
    return isLedgerWorkspacePathname(pathname);
  }
  if (entry.section) {
    if (!isAccountingSectionPathname(pathname, entry.section)) return false;
    const view = new URLSearchParams(entry.href.split("?")[1] ?? "").get("view");
    const current = new URLSearchParams(search).get("view");
    return view ? current === view : !current;
  }

  const [base] = entry.href.split("?");

  // The products hub has sub-pages (prices, attributes, …) that are
  // their own destinations, so the hub row is exact.
  if (base === ACCOUNTING_WORKSPACE_HREFS.products) {
    return pathname === ACCOUNTING_WORKSPACE_HREFS.products;
  }
  if (base === "/dashboard") return pathname === "/dashboard";
  return pathname === base || pathname.startsWith(`${base}/`);
}
