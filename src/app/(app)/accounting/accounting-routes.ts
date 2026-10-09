/**
 * The Accounting app's section routing.
 *
 * The app used to live at `/dashboard/ledger` as one page of in-page tabs
 * (`?tab=` targets), then under `/dashboard/accounting`. It is now a real app
 * at its own top-level public prefix — `/accounting/…`, a real route directory
 * under `src/app/(app)/accounting`, not a middleware rewrite — with one route
 * per section, so an accounting section is a URL a person can bookmark, share
 * and pin.
 *
 * These keys are the one source of truth for the app's menu
 * (`accounting-nav.ts` labels them and draws their role line), for the
 * server-side gate on each page, and for the legacy `?tab=` redirects
 * (`/dashboard/ledger` still forwards here so old bookmarks, saved bottom-nav
 * slots and knowledge-base articles never become dead ends).
 */

import { partyDirectoryHref, type PartyDirectoryViewKey } from "@/lib/party-directory";

/** The app's own home — the workspace rail, the sidebar parent and every "open accounting" link point here. */
export const ACCOUNTING_HOME = "/accounting/overview";

export const ACCOUNTING_SECTION_KEYS = [
  "dashboard",
  // «فضای کار حسابداری» — the ledger workspace's own landing page at
  // `/accounting/ledger`: one ordinary menu link whose page lists every
  // permitted ledger tool by the accountant's own divisions. It is a section
  // like the rest (one route, one gate, one heading), not a disclosure in the
  // sidebar and not a second copy of the tools themselves.
  "ledger",
  "trial-balance",
  "entries",
  "manual",
  "expenses",
  "fiscal-periods",
  // The platform's one people directory — the shared «اشخاص» record with the
  // ledger's columns (accounting code, tax, balance).
  //
  // «مشتریان»، «تأمین‌کنندگان» and «فروشندگان» used to be three more section
  // keys beside this one, three routes and three sidebar rows over the same
  // table. They are `?view=` filters of this section now
  // (`src/lib/party-directory.ts`); their old routes redirect here carrying
  // the matching view, so every bookmark still lands on the right list.
  "directory",
  // Receivables and payables. The keys used to be `ar`/`ap`; the public URLs
  // say what they are, and the two initialisms still resolve (see
  // `accountingSectionForLegacyKey`).
  "receivables",
  "payables",
  "receipts",
  "installments",
  "cheques",
  "reconciliation",
  "chart-of-accounts",
  "payroll",
  "vat",
  "fixed-assets",
  // The accounting-only report index. The business reporting workspace owns
  // `/accounting/reports`; keeping the financial index explicit avoids two
  // different report screens competing for one public URL.
  "financial-reports",
  "growth",
  // Accounting's *own* settings, last — the shape every app's menu ends with.
  // Deliberately not the platform settings page: `/settings` is the platform
  // area, `/accounting/settings` is this app's.
  "settings",
] as const;

export type AccountingSectionKey = (typeof ACCOUNTING_SECTION_KEYS)[number];

/** The route for a section. The dashboard is the app root; the rest nest under it. */
export function accountingSectionHref(key: AccountingSectionKey): string {
  return key === "dashboard" ? ACCOUNTING_HOME : `/accounting/${key}`;
}

/**
 * The customers view of the one directory — where every «برو به مشتری» link in
 * Accounting lands. A filter on the canonical screen, not a screen of its own.
 */
export function accountingCustomersHref(): string {
  return partyDirectoryHref("customers");
}

/** One customer in the directory, with their file opened. */
export function accountingCustomerHref(customerId: string): string {
  return partyDirectoryHref("customers", { party: customerId });
}

/** The suppliers view of the same directory — where A/P and purchasing land. */
export function accountingSuppliersHref(): string {
  return partyDirectoryHref("suppliers");
}

/** One supplier in the directory, with their file opened. */
export function accountingSupplierHref(supplierId: string): string {
  return partyDirectoryHref("suppliers", { party: supplierId });
}

/**
 * Section keys that used to be spelled differently, and what they are now.
 *
 * `ar`/`ap` were the ledger's initialisms; the routes say «receivables» and
 * «payables». `parties` was the old `?tab=` name of the persons directory.
 * Every one of them still resolves rather than 404-ing.
 */
const LEGACY_SECTION_ALIASES: Record<string, AccountingSectionKey> = {
  ar: "receivables",
  ap: "payables",
  parties: "directory",
  // The three per-role party screens are views of the directory now. They keep
  // resolving — as real route-level redirects that carry the view (and every
  // other query parameter the visitor arrived with), never as a 404 and never
  // as a middleware rewrite.
  customers: "directory",
  suppliers: "directory",
  vendors: "directory",
};

/**
 * The directory view an old per-role section URL meant, or null when the key
 * is not one of them.
 *
 * Kept beside the alias table rather than inside it because the two answer
 * different questions: the table says *which section* now serves the URL, this
 * says *which filter* the visitor was asking for. `/accounting/suppliers` has
 * to land on the suppliers list, not on «همه اشخاص».
 */
const LEGACY_DIRECTORY_VIEWS: Record<string, PartyDirectoryViewKey> = {
  customers: "customers",
  suppliers: "suppliers",
  vendors: "vendors",
};

export function accountingDirectoryViewForLegacySection(
  key: string | null | undefined,
): PartyDirectoryViewKey | null {
  if (typeof key !== "string") return null;
  return LEGACY_DIRECTORY_VIEWS[key] ?? null;
}

/** The section an old key names now, or null when it is not an old key. */
export function accountingSectionForLegacyKey(
  key: string | null | undefined,
): AccountingSectionKey | null {
  if (typeof key !== "string") return null;
  return LEGACY_SECTION_ALIASES[key] ?? null;
}

/**
 * The `?tab=` key an old `/dashboard/ledger` link carried, answered with the
 * section it names now. An unknown or missing tab is the app's home, which is
 * what the bare `/dashboard/ledger` always landed on.
 */
export function accountingSectionForLegacyTab(tab: string | null | undefined): AccountingSectionKey {
  const alias = accountingSectionForLegacyKey(tab);
  if (alias) return alias;
  return isAccountingSectionKey(tab) ? tab : "dashboard";
}

export function isAccountingSectionKey(value: string | null | undefined): value is AccountingSectionKey {
  return typeof value === "string" && (ACCOUNTING_SECTION_KEYS as readonly string[]).includes(value);
}

// The app's door used to be a second role list here. It is
// Bookkeeping-section access is `canOpenLedger` in `accounting-nav.ts`; the
// broader application door is resolved from accessible owned routes. Keeping
// those concepts separate prevents operational staff from inheriting ledger
// access merely because POS and Orders live under this prefix.

/**
 * Where to send someone who lands on a section they may not open: back to the
 * app's own dashboard rather than out of the app entirely — being bounced to
 * `/dashboard` from a page they were linked to reads as a bug, not a
 * permission (the same line `crmFallbackHref` draws). (Whether a role may open
 * a section at all is `canViewAccountingSection` in `accounting-nav.ts`, the
 * one place the payroll line is drawn.)
 */
export function accountingFallbackHref(): string {
  return ACCOUNTING_HOME;
}

/**
 * Whether a dashboard path is a given section — the sidebar's idea of "you are
 * here". The dashboard is the app root, so it matches exactly and nothing
 * else; every other section also owns what nests under it.
 */
export function isAccountingSectionPathname(pathname: string, key: AccountingSectionKey): boolean {
  const href = accountingSectionHref(key);
  return key === "dashboard"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}
