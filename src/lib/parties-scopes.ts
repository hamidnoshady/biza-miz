/**
 * Party scopes — how one shared record looks different in each work area.
 *
 * The rule this encodes: **the data is one thing, the screens are many.** Every
 * app that lists «اشخاص» mounts the same section component over the same
 * `/api/parties` endpoint and the same `parties` table; what differs is which
 * roles it shows, which columns it draws, and what it lets you edit there. A
 * café owner opening the CRM sees customers and their phones; the same person
 * opening Accounting sees the whole file including the ledger number; the store
 * clerk opening Inventory sees suppliers; the Team tab sees personnel; Growth
 * sees the same customers with lifecycle and loyalty columns.
 *
 * Why a table of scopes rather than four hand-written sections: the moment the
 * per-app views are four copies, one of them drifts — a column appears in
 * Accounting and never in the CRM, or the inventory view starts editing tax rates
 * the ledger owns. `PARTY_SCOPES` is the one place that answers "what does this
 * app show", and `parties-scopes.test.ts` is what keeps it answering for every
 * app in `apps.ts`.
 *
 * Framework-free, like `apps.ts` itself.
 */
import type { AppKey } from "./apps";
import { PARTY_ROLE_LABELS, type PartyRole } from "./parties";
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import { PERMISSIONS } from "./permissions";

export const PARTY_SCOPES = [
  "crm",
  // Accounting's «اشخاص» — the platform's *canonical* people directory.
  //
  // There used to be three more scopes beside this one:
  // `accounting-customers`, `accounting-suppliers` and `accounting-vendors`,
  // each its own route and its own sidebar entry over the same `parties`
  // table. They are gone: «مشتریان»، «تأمین‌کنندگان» and «فروشندگان» are
  // *views* of this one directory now (`party-directory.ts`), selected with
  // `?view=`, so there is one screen, one add/edit form and one place a
  // deep link can land.
  "accounting",
  "operations",
  "team",
  "growth",
  "sales",
] as const;
export type PartyScope = (typeof PARTY_SCOPES)[number];

/** A column the list can draw. Which ones are drawn is the scope's business. */
export const PARTY_COLUMNS = [
  "displayName",
  "role",
  "phone",
  "email",
  "city",
  "category",
  "accountingCode",
  "tax",
  "balance",
  "status",
] as const;
export type PartyColumn = (typeof PARTY_COLUMNS)[number];

export const PARTY_COLUMN_LABELS: Record<PartyColumn, string> = {
  displayName: "نام",
  role: "نقش",
  phone: "تلفن",
  email: "پست الکترونیکی",
  city: "شهر",
  category: "دسته",
  accountingCode: "کد حسابداری",
  tax: "نرخ مالیات",
  // The receivable, read from the ledger's own endpoint — a column the CRM has
  // always shown, and the one number here that is *not* stored on the party.
  balance: "مانده حساب",
  status: "وضعیت",
};

export interface PartyScopeDef {
  key: PartyScope;
  /** Standalone app hosting this view, or null for a shared utility. */
  app: AppKey | null;
  /** The roles this app lists — the `WHERE role = ANY(...)` of the section. */
  roles: PartyRole[];
  /** The role preselected when this app creates a party. */
  defaultRole: PartyRole;
  /** The nav label this app gives the section. */
  label: string;
  description: string;
  /** Where the section lives. */
  href: string;
  columns: PartyColumn[];
  /**
   * Whether this app may change the money-adjacent fields (accounting code, tax
   * rate, bank details). `readonly` shows them without inputs; `hidden` omits
   * them — a cashier picking a customer has no use for a ledger number.
   */
  accounting: "editable" | "readonly" | "hidden";
  /**
   * A read-only scope is a *view*: it lists the shared record and links to the
   * app that owns it, as the sales picker scope does. Every real app screen is
   * editable — the record stays one thing because every one of them writes
   * through the same form and the same endpoint, not because only one app may
   * write.
   */
  readOnly: boolean;
}

export const PARTY_SCOPES_DEF: readonly PartyScopeDef[] = [
  {
    key: "crm",
    app: "crm",
    roles: ["Customer"],
    defaultRole: "Customer",
    label: "مشتریان",
    description: "پروندهٔ مشتریان: افزودن، ویرایش و بایگانی",
    href: "/crm/directory",
    columns: ["displayName", "phone", "email", "accountingCode", "balance", "status"],
    // The CRM owns who the person is; the ledger owns their number. The code and the
    // balance are shown because an AR conversation needs them, and never edited
    // because it never does.
    accounting: "readonly",
    readOnly: false,
  },
  {
    key: "accounting",
    app: "accounting",
    // Every counterparty, because the ledger is the one app that settles with all
    // three: AR against customers, AP against suppliers, payroll against staff.
    // This is Accounting's own «اشخاص» — managed here, never by sending the
    // accountant into the CRM's customers screen.
    roles: ["Customer", "Employee", "Supplier"],
    defaultRole: "Customer",
    label: "اشخاص",
    description: "مشتریان، تأمین‌کنندگان، فروشندگان و کارکنان — یک فهرست، با کد حسابداری و اطلاعات مالی",
    // The Accounting app has its own route prefix now (`/accounting`),
    // one route per section — this is its persons directory, and the `?party=`
    // a deep link from another app (an A/R row, an AI answer) carries is read
    // by the section it opens.
    href: "/accounting/directory",
    // The balance travels with the directory now that it is the one screen the
    // A/R and A/P links land on — the ledger's own number, read from the
    // ledger's endpoint, never a copy.
    columns: ["displayName", "role", "phone", "accountingCode", "tax", "balance", "status"],
    accounting: "editable",
    readOnly: false,
  },
  {
    key: "operations",
    app: "accounting",
    roles: ["Supplier"],
    defaultRole: "Supplier",
    label: "تأمین‌کنندگان",
    description: "پروندهٔ تأمین‌کنندگان انبار و خرید",
    href: `${ACCOUNTING_WORKSPACE_HREFS.inventory}?tab=suppliers`,
    columns: ["displayName", "phone", "city", "accountingCode", "status"],
    accounting: "readonly",
    readOnly: false,
  },
  {
    key: "team",
    app: null,
    roles: ["Employee"],
    defaultRole: "Employee",
    label: "کارکنان",
    description: "پروندهٔ کارکنان — حساب جاری، کد ملی و اطلاعات مالی",
    href: "/settings/team",
    columns: ["displayName", "phone", "accountingCode", "status"],
    accounting: "readonly",
    readOnly: false,
  },
  {
    key: "growth",
    app: "growth",
    roles: ["Customer"],
    defaultRole: "Customer",
    label: "مخاطبان",
    description: "بینش مخاطبان رشد: چرخهٔ حیات، امتیاز و خرید — ویرایش پرونده در CRM",
    href: "/growth/customers",
    columns: ["displayName", "phone", "status"],
    accounting: "hidden",
    // Issue #764: Growth *reads* the shared record (lifecycle, spend, loyalty,
    // reachability) and acts on audiences; it does not own the customer's
    // identity. Creating, editing and archiving a customer is the CRM's door,
    // and the Growth audience screen links there rather than mounting a second
    // add/edit form over the same row.
    readOnly: true,
  },
  {
    key: "sales",
    app: "accounting",
    roles: ["Customer"],
    defaultRole: "Customer",
    label: "مشتریان",
    description: "انتخاب مشتری برای فاکتور — ویرایش در CRM",
    href: "/accounting/orders",
    columns: ["displayName", "phone"],
    accounting: "hidden",
    readOnly: true,
  },
];

/** Look up a scope by key. An unknown key is the CRM view: the safest, narrowest one. */
export function partyScopeFor(key: string | null | undefined): PartyScopeDef {
  const found = PARTY_SCOPES_DEF.find((def) => def.key === key);
  return found ?? PARTY_SCOPES_DEF[0];
}

/** The scope an app mounts. `null` for the apps that have no party view at all. */
export function partyScopeForApp(app: AppKey): PartyScopeDef | null {
  return PARTY_SCOPES_DEF.find((def) => def.app === app) ?? null;
}

/** Which role a new party gets in this app — the part that makes the section feel native. */
export function defaultRoleForScope(scope: PartyScopeDef): PartyRole {
  return scope.defaultRole;
}

/** The label a row's role gets inside a scope («مشتری» is noise in the CRM's own list). */
export function roleLabelInScope(scope: PartyScopeDef, role: PartyRole): string | null {
  return scope.roles.length > 1 ? PARTY_ROLE_LABELS[role] : null;
}

export function showsColumn(scope: PartyScopeDef, column: PartyColumn): boolean {
  return scope.columns.includes(column);
}

/** Whether this app may edit the accounting tab at all. */
export function canEditAccountingInScope(scope: PartyScopeDef): boolean {
  return !scope.readOnly && scope.accounting === "editable";
}

/** Whether the accounting fields are visible (read-only counts as visible). */
export function canSeeAccountingInScope(scope: PartyScopeDef): boolean {
  return scope.accounting !== "hidden";
}

/**
 * Client-side filter for the shared lists a section reads for other reasons (the
 * AR balance map, a picker that already has the rows). The server filters too —
 * this is not the boundary, it is one less re-render.
 */
export function partyMatchesScope(scope: PartyScopeDef, role: PartyRole | string | null | undefined): boolean {
  return scope.roles.includes(role as PartyRole);
}

/**
 * The app that *owns* a role's record — the place a read-only view links to.
 *
 * This is the one-screen-per-role half of the rule: an app may list a party it
 * consumes, but the edit affordance always lands on the scope whose business the
 * role is. Customers are CRM's, suppliers the store's, personnel the team's.
 */
export function partyOwnerScopeForRole(role: PartyRole): PartyScopeDef {
  const owner = PARTY_SCOPES_DEF.find(
    // Every accounting-side scope is skipped, not just the full «اشخاص» one:
    // Accounting is a *view* of every counterparty (that is the point of it),
    // so it can never be the answer to "which app owns this role's record".
    (def) => !def.readOnly && !def.key.startsWith("accounting") && def.roles.includes(role),
  );
  // Accounting is the fallback for a role nobody else claims, and every role is
  // claimed, so this only fires if a scope is deleted by mistake.
  return owner ?? partyScopeFor("accounting");
}

/**
 * Which ledger statement a row can open, if any.
 *
 * A statement is per *ledger*, not per party: receivables are kept against
 * customers and payables against suppliers, and the two panels read two
 * different endpoints. The directory lists all three roles in the Accounting
 * scope, so «صورتحساب» on a supplier used to open an A/R statement that is
 * empty by construction, and on an employee a statement that does not exist at
 * all.
 *
 * One person can hold several roles, and then customer wins — the same
 * precedence `primaryPartyRole` uses, so the button agrees with the accounting
 * code beside it.
 */
export function partyStatementKind(
  roles: readonly PartyRole[] | null | undefined,
): "ar" | "ap" | null {
  const set = roles ?? [];
  if (set.includes("Customer")) return "ar";
  if (set.includes("Supplier")) return "ap";
  // Personnel settle through payroll and حساب جاری کارکنان, neither of which
  // is an A/R or A/P statement. Offering one would be a button that answers
  // with an empty table.
  return null;
}

/**
 * Where a row's canonical record is edited, from the point of view of a scope that
 * cannot edit it. The read-only views are only honest if the link is there.
 */
export function partyEditHrefForScope(scope: PartyScopeDef, role: PartyRole | null | undefined): string {
  if (!scope.readOnly) return scope.href;
  return partyOwnerScopeForRole((role ?? "Customer") as PartyRole).href;
}

/**
 * The roles whose *presets* may write a party — the fallback the party section
 * uses when the mounting page could not read the member's effective
 * permissions. Mirrors the presets in `permissions.ts` so a cashier sees
 * «افزودن مشتری» in the CRM and a waiter does not.
 */
export const PARTIES_PRESET_MANAGING_ROLES: readonly string[] = ["owner", "manager", "cashier", "accountant"];

/** Roles whose presets may read the ledger's figures, for the same fallback. */
export const PARTIES_PRESET_LEDGER_ROLES: readonly string[] = ["owner", "manager", "accountant"];

/**
 * The roles the ledger's *statement* endpoints accept.
 *
 * `/api/ledger/ar/customers/:id` and `/api/ledger/ap/suppliers/:id` both call
 * `requireRole("owner", "manager", "accountant")` — a role check, not a
 * permission one — so this is a copy of that list rather than a second policy.
 * Keep the two in step: `parties-scopes.test.ts` asserts the statement gate is
 * never wider than the balance gate.
 */
export const PARTIES_STATEMENT_ROLES: readonly string[] = ["owner", "manager", "accountant"];

export interface PartiesSectionAbilities {
  /** Whether the «افزودن» button and row actions may be drawn at all. */
  canManage: boolean;
  /** Whether the money-shaped columns (balance, tax) may be filled in. */
  canSeeLedger: boolean;
  /**
   * Whether this member may open a party's ledger statement.
   *
   * Not the same question as `canSeeLedger`, and that is the whole reason it
   * exists. The balance column is filled from `/api/ledger/ar/customers`,
   * which `ledger.view` opens; the *statement* panels read
   * `/api/ledger/ar/customers/:id` and `/api/ledger/ap/suppliers/:id`, which
   * are gated by `requireRole("owner","manager","accountant")` instead. A
   * cashier granted `ledger.view` — a supported override, asserted in
   * `parties-scopes.test.ts` — therefore passes the first gate and fails the
   * second, and used to be shown a «صورتحساب» button that opened an empty
   * panel.
   */
  canOpenStatement: boolean;
}

/**
 * What a member may do on a party screen: the real answer when their effective
 * permissions are known, the preset answer when they are not.
 *
 * The write gate is `parties.manage` and the money gate is `ledger.view` — the
 * API enforces both regardless — so this decides only which *buttons* are
 * drawn. A cashier whose grant was revoked sees a read-only list rather than an
 * «افزودن» that answers 403, and a waiter who was *granted* one sees it and it
 * works. `scope.readOnly` is the caller's to combine in: a read-only scope
 * refuses the write no matter who is asking.
 */
export function partiesSectionAbilities(
  role: string,
  permissions?: readonly string[] | null,
): PartiesSectionAbilities {
  const known = permissions !== undefined && permissions !== null;
  const canSeeLedger = known
    ? permissions.includes(PERMISSIONS.ledgerView)
    : PARTIES_PRESET_LEDGER_ROLES.includes(role);
  return {
    canManage: known
      ? permissions.includes(PERMISSIONS.partiesManage)
      : PARTIES_PRESET_MANAGING_ROLES.includes(role),
    canSeeLedger,
    // The statement endpoints ask for a *role*, so no permission grant can
    // open them: a cashier with `ledger.view` reads the balance column and
    // still gets a 403 from the statement. `&& canSeeLedger` keeps the button
    // from outliving the figure it explains when a back-office member's
    // `ledger.view` is revoked.
    canOpenStatement: canSeeLedger && PARTIES_STATEMENT_ROLES.includes(role),
  };
}

/**
 * Roles whose built-in presets carry `parties.view` — the fallback answer when
 * a screen asks whether the directory may be rendered at all without the
 * member's effective permissions in hand. Mirrors `ROLE_PRESETS` in
 * permissions.ts (admin is everything but owner-only keys; waiter and kitchen
 * carry no party read); `parties-scopes.test.ts` pins it against
 * `roleBasePermissions` so the two cannot drift.
 */
export const PARTIES_PRESET_VIEWING_ROLES: readonly string[] = [
  "owner",
  "admin",
  "manager",
  "accountant",
  "cashier",
];

/**
 * Issue #854 (pass 4, gap 3) — may this member see a party directory at all:
 * the real answer when their effective permissions are known, the preset
 * answer when they are not. `/api/parties` enforces `parties.view` either
 * way; this exists so a screen (the Team tab's personnel file) can hide the
 * section instead of rendering a list that only ever answers 403 — without
 * broadening the permission itself.
 */
export function canViewParties(
  role: string,
  permissions?: readonly string[] | null,
): boolean {
  const known = permissions !== undefined && permissions !== null;
  return known
    ? permissions.includes(PERMISSIONS.partiesView)
    : PARTIES_PRESET_VIEWING_ROLES.includes(role);
}
