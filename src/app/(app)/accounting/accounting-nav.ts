/**
 * The Accounting app's section list (the «حسابداری» sub-menu).
 *
 * Every section is a real route now (`accounting-routes.ts` answers the path),
 * so this file carries what a menu and a gate need: what each section is
 * *called*, and the capability that opens it. The same list is read by the
 * dashboard's sidebar (built server-side in `layout.tsx`) and the in-page rail
 * (`accounting-manager.tsx`, a client component), so the two can never
 * disagree about what «حسابداری» contains or what each section is called.
 *
 * It stays framework-free (no React, no JSX, no icons) for that reason; the
 * manager keeps its own icon map, the way `crm-nav.ts` does.
 */

import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { canOpenApp } from "@/lib/apps";
import type { AccountingSectionKey } from "./accounting-routes";

/**
 * The app's own door.
 *
 * `ledger.view` rather than a role list: it is the key every Accounting route
 * enforces, and the presets that hold it are owner (by rule), admin, manager
 * and accountant — the same audience the old `ACCOUNTING_ROLES` list named.
 *
 * The gate is *only* the capability, and that is deliberate. The old comment
 * here named a `viewer` role — which is not a member role at all, it is
 * `workspace-shared.ts`'s project-role ladder — so the sentence described an
 * audience the `Role` union cannot produce. Anything that reads like a role
 * list beside this constant is stale by construction: a custom tenant role
 * granted `ledger.view` opens the app, and one without it does not, whatever
 * it is called.
 */
export const ACCOUNTING_DOOR_PERMISSION: Permission = PERMISSIONS.ledgerView;

export interface AccountingSectionDef {
  key: AccountingSectionKey;
  label: string;
  /**
   * The capability this section needs beyond the app's own door. Omitted means
   * `ACCOUNTING_DOOR_PERMISSION` is enough, which the page gate already
   * enforces.
   */
  permission?: Permission;
}

/** The app's sections, in menu order. The dashboard (the app's home) is first. */
export const ACCOUNTING_SECTIONS: readonly AccountingSectionDef[] = [
  { key: "dashboard", label: "داشبورد حسابداری" },
  { key: "trial-balance", label: "تراز آزمایشی" },
  { key: "entries", label: "دفتر روزنامه" },
  { key: "manual", label: "ثبت سند دستی" },
  { key: "expenses", label: "هزینه‌ها" },
  { key: "fiscal-periods", label: "دوره‌های مالی" },
  // The platform's one people directory. «مشتریان»، «تأمین‌کنندگان» and
  // «فروشندگان» were three more sections here; they are `?view=` filters of
  // this one now (`src/lib/party-directory.ts`), so there is one screen, one
  // add/edit form and one place every deep link lands.
  { key: "directory", label: "اشخاص" },
  { key: "receivables", label: "حساب‌های دریافتنی" },
  { key: "payables", label: "حساب‌های پرداختنی" },
  { key: "receipts", label: "دریافت و پرداخت" },
  { key: "installments", label: "اقساط" },
  { key: "cheques", label: "چک‌ها" },
  { key: "reconciliation", label: "تطبیق بانکی" },
  { key: "chart-of-accounts", label: "سرفصل حساب‌ها" },
  { key: "dimensions", label: "ابعاد حسابداری" },
  // Wages are compensation data, so this entry follows `payroll.view` — the
  // same capability the in-page rail and `/api/ledger/payroll/*` enforce. By
  // default that is the owner, the admin and the accountant; a manager may open
  // every other section but not this one, unless the business grants them the
  // key. This used to borrow `ledger.post` because that preset happened to be
  // the right audience; it now asks for the key that actually means "may see
  // payroll". Borrowing a key for its preset rather than its meaning is how a
  // menu and an API drift apart the next time either preset changes.
  { key: "payroll", label: "حقوق و دستمزد", permission: PERMISSIONS.payrollView },
  { key: "vat", label: "گزارش مالیات" },
  { key: "fixed-assets", label: "دارایی‌های ثابت" },
  { key: "financial-reports", label: "گزارش‌های مالی" },
  { key: "growth", label: "رشد و بازاریابی" },
  // Accounting's *own* settings — never the platform settings page. Last in
  // the menu, the way every app's settings entry is.
  { key: "settings", label: "تنظیمات حسابداری" },
];

/**
 * How the *ledger rail* («فضای کار حسابداری», the in-page menu) divides those
 * sections.
 *
 * The app's **sidebar** is no longer this list: Accounting is the business's
 * primary workspace now, so its menu is composed in
 * `accounting-workspace.ts` — the business's work areas plus these sections
 * gathered into one group. This grouping stays because the in-page rail still
 * draws it, and because it is the one place that guarantees every section has
 * a home.
 *
 * Twenty-three rows in one column is a list nobody reads; these are the
 * accountant's own divisions of the work. Every key appears in exactly one
 * group — asserted in `accounting-nav.test.ts`, so a section added to
 * `ACCOUNTING_SECTIONS` without a home here fails the build rather than
 * quietly vanishing from the menu.
 */
export const ACCOUNTING_NAV_GROUPS: readonly {
  label: string;
  keys: readonly AccountingSectionKey[];
}[] = [
  {
    label: "دفتر",
    keys: [
      "dashboard",
      "trial-balance",
      "entries",
      "manual",
      "chart-of-accounts",
      "dimensions",
    ],
  },
  { label: "اشخاص", keys: ["directory"] },
  {
    label: "دریافتنی و پرداختنی",
    keys: ["receivables", "payables", "installments", "cheques"],
  },
  {
    label: "وجوه و هزینه",
    keys: ["receipts", "expenses", "reconciliation", "fixed-assets"],
  },
  {
    label: "دوره و گزارش",
    keys: ["fiscal-periods", "vat", "payroll", "financial-reports", "growth"],
  },
  // The app's settings entry, last — the shape every app's menu ends with.
  { label: "پیکربندی", keys: ["settings"] },
];

/** The sections a member may open — the same list the sidebar and the rail draw. */
export function accountingSectionsFor(
  permissions: ReadonlySet<string>,
): AccountingSectionDef[] {
  if (!permissions.has(ACCOUNTING_DOOR_PERMISSION)) return [];
  return ACCOUNTING_SECTIONS.filter(
    (section) => !section.permission || permissions.has(section.permission),
  );
}

/** Whether a member may open a section — the page gate and the menu agree by construction. */
export function canViewAccountingSection(
  permissions: ReadonlySet<string>,
  key: AccountingSectionKey,
): boolean {
  return accountingSectionsFor(permissions).some((section) => section.key === key);
}

/** Whether the member may read the bookkeeping workspace and ledger sections. */
export function canOpenLedger(permissions: ReadonlySet<string>): boolean {
  return permissions.has(ACCOUNTING_DOOR_PERMISSION);
}

/**
 * Whether the member has any surface owned by the Accounting application.
 * This is intentionally broader than ledger access: selling and floor
 * operations share the app shell without exposing bookkeeping data.
 */
export function canOpenAccountingApp(permissions: ReadonlySet<string>): boolean {
  return canOpenApp("accounting", permissions);
}
