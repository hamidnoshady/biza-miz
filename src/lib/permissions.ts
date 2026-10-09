/**
 * Phase 12 — permissions.
 *
 * The decision was "system-role presets plus per-member overrides", not a
 * role builder: a business picks a role for each member and then grants or
 * revokes individual capabilities on top of it. That keeps the common case
 * (a cashier is a cashier) free of configuration while still allowing "this
 * manager may also post journal entries".
 *
 * Framework-free and side-effect-free by design — this is the file that
 * decides who may do what, so it is unit-tested directly (permissions.test.ts)
 * rather than only through route handlers.
 */
import type { Role } from "./auth";

/**
 * Every capability the system recognises. Coarse enough to stay manageable in
 * a UI (Phase 13 renders these as checkboxes), fine enough that the accounting
 * surfaces Phase 16 adds can be delegated without handing over the whole
 * business.
 */
export const PERMISSIONS = {
  // AI workspace — capability keys are intentionally separate from module
  // permissions. `ai.use` opens the canonical workspace; the management keys
  // only control the corresponding panel/API surfaces. A member may use AI
  // without receiving any of the data tools below.
  aiUse: "ai.use",
  aiManage: "ai.manage",
  aiAutomationsManage: "ai.automations.manage",
  aiUsageView: "ai.usage.view",

  // Point of sale
  ordersView: "orders.view",
  ordersCreate: "orders.create",
  ordersVoid: "orders.void",
  /**
   * Editing or removing an order that has already been paid for. Deliberately
   * separate from `orders.void`, which only reaches an *open* order nobody has
   * settled: this one reverses posted revenue, VAT, COGS and stock, so it is a
   * back-office privilege rather than a till one.
   */
  ordersAmendClosed: "orders.amend_closed",
  ordersDiscount: "orders.discount",
  paymentsTake: "payments.take",
  paymentsRefund: "payments.refund",

  // Floor
  tablesManage: "tables.manage",
  tablesEdit: "tables.edit",
  /**
   * Reading the reservation book versus writing in it. A waiter checks
   * tonight's book; taking the booking is a separate act.
   */
  reservationsView: "reservations.view",
  reservationsManage: "reservations.manage",
  kitchenView: "kitchen.view",
  deliveryManage: "delivery.manage",
  deliveryConfigure: "delivery.configure",

  // Catalogue
  menuView: "menu.view",
  menuEdit: "menu.edit",

  // Inventory
  inventoryView: "inventory.view",
  inventoryAdjust: "inventory.adjust",
  purchasesManage: "purchases.manage",

  /**
   * Parties — «اشخاص»: the one record behind a customer, a supplier and a
   * member of staff (migration 0137 renamed `customers` to `parties`, and this
   * permission is why the ledger can hand a supplier file to the same screen as a
   * customer's). `parties.view` is the read of the record and of the pickers that
   * depend on it; `parties.manage` is the write, and it is deliberately *not*
   * enough to change the accounting number and the tax rate of a party the ledger
   * settles against — those two fields are additionally gated on `ledger.view`.
   */
  partiesView: "parties.view",
  partiesManage: "parties.manage",

  /**
   * CRM — the relationship layer on top of «اشخاص».
   *
   * Separate from `parties.*` because they answer different questions.
   * `parties.manage` is "may correct this person's phone number", which a
   * cashier needs a dozen times a shift. The permissions below are "may read
   * everyone's purchase history", "may merge two customers irreversibly", "may
   * decide who can be marketed to" — each of which is a different kind of
   * trust, and bundling them into one `crm.manage` would mean granting a
   * junior salesperson the ability to destroy the directory in order to let
   * them log a phone call.
   *
   * The split is by *blast radius*, not by screen:
   */
  /** Read the 360° file, pipeline, segments and reports. */
  crmView: "crm.view",
  /** Day-to-day relationship work: notes, tasks, activities, cases, deals. */
  crmManage: "crm.manage",
  /**
   * Merge two customer records. **Irreversible** — it rewrites every order,
   * invoice and receipt that pointed at the loser and archives it. Its own
   * permission because it is the only CRM action that cannot be undone, and
   * because "clean up the duplicates" is exactly the task a business delegates
   * to its newest employee.
   */
  crmMerge: "crm.merge",
  /**
   * Change marketing consent. Consent is a legal record, not a preference:
   * whoever holds this can make the business's messaging lawful or unlawful.
   */
  crmConsentManage: "crm.consent_manage",
  /**
   * Export customer data — CSV, segment downloads, directory dumps. Reading
   * one customer's file on screen and walking out with the whole customer list
   * are not the same act, and only the second one is how a directory ends up
   * at a competitor.
   */
  crmExport: "crm.export",
  /**
   * Reconfigure pipelines, stages and segment definitions. Structural: a stage
   * rename or deletion reshapes every historical report built on it.
   */
  crmConfigure: "crm.configure",
  /** Destroying a customer record together with its history. */
  crmDelete: "crm.delete",

  /**
   * My Workspace — «میز کار من» (Phase G).
   *
   * Split by blast radius, the same way the CRM block above is, because the
   * four acts are four different kinds of trust. `workspace.view` is "may see
   * the projects I am on"; `workspace.manage` is the day-to-day write across
   * projects, tasks, documents and the calendar; the remaining two are carved
   * out because each can commit the business to something.
   *
   * These gate the AREA. Which projects a member may touch, and how deeply, is
   * the member's project role in `workspace_members` (owner/manager/editor/
   * contributor/viewer) — the two are intersected, never substituted. That is
   * not a second permission system: a project role can only ever narrow what
   * the permission below already allows.
   */
  workspaceView: "workspace.view",
  workspaceManage: "workspace.manage",
  /**
   * Create and amend execution contracts. Its own key because a contract is a
   * financial commitment to a third party: whoever holds this can record that
   * the business owes a contractor 500 million Rial. Logging a site visit and
   * signing a supplier agreement are not the same act.
   */
  workspaceContractsManage: "workspace.contracts_manage",
  /**
   * Decide an approval. The approval gate exists precisely so that one person
   * proposes and another accepts; letting everyone who can request also
   * approve would make the whole mechanism decorative.
   */
  workspaceApprove: "workspace.approve",
  /**
   * Issue a document revision to an outside party (issue #799 §24's
   * "drawings/document issue"). Drafting a revision is ordinary project work and
   * rides `workspace.manage`; *issuing* one is the moment a drawing becomes a
   * record that names what went to whom, and the moment the register stops
   * accepting changes to it (migration 0197 freezes it). Its own key for the
   * same reason a contract has one: the act cannot be taken back, so it must not
   * be inherited by everyone who can tick a task off.
   */
  workspaceDocumentsIssue: "workspace.documents_issue",
  /**
   * Reach every project regardless of membership, acting as its manager.
   * The explicit business-wide override (#761): `workspace.view` and
   * `workspace.manage` only ever reach the projects a member is on, and this
   * is the one key that lifts that — so a business owner is never locked out
   * of a project nobody added them to, without every viewer being able to
   * enumerate every project.
   */
  workspaceAdmin: "workspace.admin",

  // Accounting
  ledgerView: "ledger.view",
  ledgerPost: "ledger.post",
  ledgerApprove: "ledger.approve",
  ledgerClosePeriod: "ledger.close_period",
  accountsEdit: "accounts.edit",
  /**
   * Drafting a manual journal. A draft has no ledger effect; approval stays
   * on ledger.approve.
   */
  ledgerPropose: "ledger.propose",

  /**
   * Operational finance — money moving as a consequence of trading, distinct
   * from accounting authority (ledger.post / approve / close_period).
   */
  financeExpensesManage: "finance.expenses_manage",
  financeReceivablesManage: "finance.receivables_manage",
  financePayablesManage: "finance.payables_manage",
  financeChequesManage: "finance.cheques_manage",
  financeInstallmentsManage: "finance.installments_manage",
  financeReconciliationManage: "finance.reconciliation_manage",
  financeAssetsManage: "finance.assets_manage",

  /**
   * Salary data is narrower than the surrounding ledger, so it has its own pair
   * of keys. `payroll.view` reads wage orders, payroll runs and the wage-change
   * history; `payroll.manage` sets wages and accrues, pays and voids a run (it
   * implies view). The default presets give both to the owner, the admin and
   * the accountant and neither to the manager, but a business can grant or
   * revoke either key per member — so code tests the capability, never a role
   * name.
   */
  payrollView: "payroll.view",
  payrollManage: "payroll.manage",

  // Insight
  reportsView: "reports.view",
  reportsExport: "reports.export",

  /**
   * «ورود و خروج داده» — the platform-wide data transfer engine.
   *
   * These two gate the ENGINE, and are always intersected with the entity's
   * own permission, never substituted for it: exporting the customer directory
   * needs `data.export` AND `crm.export`; importing a menu needs `data.import`
   * AND `menu.edit`. That is deliberate and is the whole security model of the
   * module — one screen that reaches every app must not become a way around
   * any app's own gate.
   *
   * They exist as keys of their own because bulk transfer is a different kind
   * of trust from the per-record permission it sits on top of. Reading one
   * customer's file and walking out with fifty thousand rows of them are not
   * the same act; neither are correcting one price and replacing the entire
   * catalogue from a spreadsheet. A business that wants its CRM manager to
   * keep editing customers but never bulk-export them now revokes one key
   * instead of having no way to express it.
   *
   * Nobody loses access they had: every role whose preset already included a
   * bulk door (the manager's `crm.export`, the accountant's `reports.export`)
   * receives these, and no floor role had one to lose.
   */
  dataImport: "data.import",
  dataExport: "data.export",

  // Administration
  /** Reading the team list. Narrower than administering it. */
  teamView: "team.view",
  teamManage: "team.manage",
  /**
   * Handing out capability. Separate from suspend/rename so a delegated
   * administrator cannot quietly widen their own grants.
   */
  teamPermissionsManage: "team.permissions_manage",
  settingsManage: "settings.manage",
  locationsManage: "locations.manage",
  backupManage: "backup.manage",
  backupConfigure: "backup.configure",
  backupExport: "backup.export",
  backupRestore: "backup.restore",
  rollupManage: "rollup.manage",
  // Phase 19: long-lived third-party credentials remain owner-only in V1.
  apiManage: "api.manage",

  // Website, growth and integration applications
  websiteView: "website.view",
  websiteManage: "website.manage",
  websiteSettingsManage: "website.settings_manage",
  cmsView: "cms.view",
  cmsContentManage: "cms.content_manage",
  cmsPublish: "cms.publish",
  cmsConfigure: "cms.configure",
  woocommerceView: "woocommerce.view",
  woocommerceManage: "woocommerce.manage",
  woocommerceSync: "woocommerce.sync",
  woocommerceConfigure: "woocommerce.configure",
  /**
   * Growth & Marketing (issue #764). One key per capability, split by what
   * the act does to money and to people — not by screen:
   *
   *   growth.view           the management dashboard, the audience insights and
   *                         the accounting bridge. Not a floor capability.
   *   campaigns.*           discount rules and outbound messaging.
   *   loyalty.view/manage   reading balances / configuring loyalty programs.
   *   loyalty.redeem        spending a customer's earned points at the till.
   *   store_credit.issue    *creating* a liability out of nothing (a goodwill
   *                         credit) — a different trust from redeeming one.
   *   store_credit.payout   paying a credit balance out in cash or to a bank.
   *   gift_cards.*          looking a card up / issuing one (a new liability) /
   *                         spending one.
   *   commission.*          compensation data. Its own boundary, server-side;
   *                         hiding the menu entry was never the protection.
   *                         `calculate` builds a settlement run, `approve`
   *                         reviews and approves it, `payout` pays it out and
   *                         closes it, `reverse` undoes a payout (#869).
   *   marketing.configure   Growth-wide configuration.
   *
   * `src/lib/growth-access.ts` maps every Growth page and API to exactly one of
   * these, and its test asserts the routes agree.
   */
  growthView: "growth.view",
  campaignsView: "campaigns.view",
  campaignsManage: "campaigns.manage",
  loyaltyView: "loyalty.view",
  loyaltyManage: "loyalty.manage",
  loyaltyRedeem: "loyalty.redeem",
  storeCreditIssue: "store_credit.issue",
  storeCreditPayout: "store_credit.payout",
  giftCardsView: "gift_cards.view",
  giftCardsIssue: "gift_cards.issue",
  giftCardsRedeem: "gift_cards.redeem",
  commissionView: "commission.view",
  commissionManage: "commission.manage",
  // Issue #869: the settlement lifecycle is split so that no single key can
  // both decide what is owed and pay it out.
  commissionCalculate: "commission.calculate",
  commissionApprove: "commission.approve",
  commissionPayout: "commission.payout",
  commissionReverse: "commission.reverse",
  marketingConfigure: "marketing.configure",
  integrationsView: "integrations.view",
  integrationsManage: "integrations.manage",
  mediaView: "media.view",
  mediaManage: "media.manage",
  printingExecute: "printing.execute",
  billingView: "billing.view",
  billingManage: "billing.manage",
} as const;

/** The till/POS surface edits an order and takes money; neither key alone is enough. */
export const POS_REQUIRED_PERMISSIONS = [
  PERMISSIONS.ordersCreate,
  PERMISSIONS.paymentsTake,
] as const;

export function canUsePos(permissions: ReadonlySet<string>): boolean {
  return POS_REQUIRED_PERMISSIONS.every((permission) => permissions.has(permission));
}

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export type PermissionRisk = "low" | "medium" | "high" | "critical";
export interface PermissionMetadata {
  key: Permission;
  group: string;
  label: string;
  description: string;
  risk: PermissionRisk;
  delegatable: boolean;
  ownerOnly: boolean;
  requiresReason: boolean;
  audit: boolean;
}

const HIGH_RISK = new Set<Permission>([
  PERMISSIONS.ordersAmendClosed,
  PERMISSIONS.paymentsRefund,
  PERMISSIONS.crmMerge,
  PERMISSIONS.crmExport,
  PERMISSIONS.ledgerApprove,
  PERMISSIONS.ledgerClosePeriod,
  PERMISSIONS.reportsExport,
  PERMISSIONS.dataExport,
  PERMISSIONS.teamManage,
  PERMISSIONS.backupManage,
  PERMISSIONS.storeCreditIssue,
  PERMISSIONS.storeCreditPayout,
  PERMISSIONS.giftCardsIssue,
  PERMISSIONS.commissionManage,
  PERMISSIONS.commissionCalculate,
  PERMISSIONS.commissionApprove,
  PERMISSIONS.commissionPayout,
  PERMISSIONS.commissionReverse,
]);
const REASON_REQUIRED = new Set<Permission>([
  PERMISSIONS.ordersAmendClosed,
  PERMISSIONS.paymentsRefund,
  PERMISSIONS.crmMerge,
  PERMISSIONS.ledgerClosePeriod,
]);

/**
 * Canonical permission catalogue consumed by guards and access-management UI.
 * Labels deliberately default to stable keys until translated product copy is
 * supplied; metadata must never be independently recreated by a feature.
 */
export const PERMISSION_DEFINITIONS: readonly PermissionMetadata[] = ALL_PERMISSIONS.map((key) => {
  const ownerOnly = new Set<Permission>([
    PERMISSIONS.apiManage,
    PERMISSIONS.backupConfigure,
    PERMISSIONS.backupExport,
    PERMISSIONS.backupRestore,
    PERMISSIONS.rollupManage,
  ]).has(key);
  const risk: PermissionRisk = ownerOnly ? "critical" : HIGH_RISK.has(key) ? "high" : "medium";
  return {
    key,
    group: key.split(".")[0],
    label: key,
    description: key,
    risk,
    delegatable: !ownerOnly,
    ownerOnly,
    requiresReason: REASON_REQUIRED.has(key),
    audit: risk === "high" || risk === "critical",
  };
});

export const PERMISSION_METADATA: ReadonlyMap<Permission, PermissionMetadata> = new Map(
  PERMISSION_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/**
 * Permissions that must never be delegated through member overrides. A leaked
 * API credential has a larger and more durable blast radius than ordinary
 * back-office access, so V1 keeps its lifecycle exclusively with the owner.
 */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.apiManage,
  PERMISSIONS.backupConfigure,
  PERMISSIONS.backupExport,
  PERMISSIONS.backupRestore,
  PERMISSIONS.rollupManage,
];

export function isOwnerOnlyPermission(permission: Permission): boolean {
  return OWNER_ONLY_PERMISSIONS.includes(permission);
}

const {
  aiUse, aiManage, aiAutomationsManage, aiUsageView,
  ordersView, ordersCreate, ordersVoid, ordersAmendClosed, ordersDiscount, paymentsTake, paymentsRefund,
  tablesManage, tablesEdit, reservationsView, reservationsManage, kitchenView, deliveryManage, deliveryConfigure,
  menuView, menuEdit,
  inventoryView, inventoryAdjust, purchasesManage,
  partiesView, partiesManage,
  crmView, crmManage, crmMerge, crmConsentManage, crmExport, crmConfigure, crmDelete,
  workspaceView, workspaceManage, workspaceContractsManage, workspaceApprove, workspaceDocumentsIssue,
  workspaceAdmin,
  ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit, ledgerPropose,
  financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
  financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
  payrollView, payrollManage,
  reportsView, reportsExport,
  dataImport, dataExport,
  teamView, teamManage, teamPermissionsManage, settingsManage, locationsManage, backupManage,
  websiteView, websiteManage, websiteSettingsManage,
  cmsView, cmsContentManage, cmsPublish, cmsConfigure,
  woocommerceView, woocommerceManage, woocommerceSync, woocommerceConfigure,
  growthView, campaignsView, campaignsManage, loyaltyView, loyaltyManage, loyaltyRedeem,
  storeCreditIssue, storeCreditPayout, giftCardsView, giftCardsIssue, giftCardsRedeem,
  commissionView, commissionManage, commissionCalculate, commissionApprove, commissionPayout, commissionReverse,
  marketingConfigure,
  integrationsView, integrationsManage, mediaView, mediaManage, printingExecute, billingView, billingManage,
} = PERMISSIONS;

/**
 * What each system role can do out of the box.
 *
 * `owner` is deliberately absent: it is not a list but a rule (see
 * `roleBasePermissions`). Giving the owner an enumerated set would mean every
 * new permission added later silently excludes them.
 */
const ROLE_PRESETS: Record<Exclude<Role, "owner">, Permission[]> = {
  // Tenant administrator: every delegatable operational capability, but never
  // ownership, destructive recovery, master API or cross-location trust keys.
  admin: ALL_PERMISSIONS.filter((permission) => !isOwnerOnlyPermission(permission)),
  manager: [
    aiUse, aiManage, aiAutomationsManage, aiUsageView,
    ordersView, ordersCreate, ordersVoid, ordersAmendClosed, ordersDiscount, paymentsTake, paymentsRefund,
    tablesManage, tablesEdit, reservationsView, reservationsManage, kitchenView, deliveryManage, deliveryConfigure,
    menuView, menuEdit,
    inventoryView, inventoryAdjust, purchasesManage,
    partiesView, partiesManage,
    // The manager reached every CRM screen before these permissions existed
    // (the routes gated on requireRole("owner","manager")), so the preset
    // grants all of them. Introducing a permission must not quietly remove
    // access somebody already had — that is an outage, not a security
    // improvement. A business that wants a narrower manager revokes
    // individual capabilities per member.
    crmView, crmManage, crmMerge, crmConsentManage, crmExport, crmConfigure, crmDelete,
    // Phase G, same rule as the CRM block: before these keys existed the
    // project pages gated on requireMember, so every manager could already
    // open them and do everything on them. Introducing a permission must not
    // remove access somebody already had, so the preset grants all four. A
    // business that wants a narrower manager revokes the individual keys.
    workspaceView, workspaceManage, workspaceContractsManage, workspaceApprove, workspaceDocumentsIssue,
    workspaceAdmin,
    ledgerView, reportsView, reportsExport,
    // Operational finance the manager already did under a role gate. Not
    // accounting authority, and not payroll.
    financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
    financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
    ledgerPropose,
    // «ورود و خروج داده». The manager already held every bulk door the product
    // had (crm.export gated both the customer export AND the customer import;
    // reports.export gated the report download), so granting these two keeps
    // the access they had rather than handing them a new capability. The
    // engine still intersects them with each entity's own permission.
    dataImport, dataExport,
    settingsManage, backupManage,
    websiteView, websiteManage, websiteSettingsManage,
    cmsView, cmsContentManage, cmsPublish, cmsConfigure,
    woocommerceView, woocommerceManage, woocommerceSync, woocommerceConfigure,
    // Issue #764 split the old loyalty.manage / growth.view into graded
    // capabilities; the manager keeps every one of them, so nothing they did
    // before is lost.
    growthView, campaignsView, campaignsManage, loyaltyView, loyaltyManage, loyaltyRedeem,
    storeCreditIssue, storeCreditPayout, giftCardsView, giftCardsIssue, giftCardsRedeem,
    commissionView, commissionManage,
    // #869: a manager may build a settlement run, but approving and paying it
    // is the books' work, and stays with the accountant.
    commissionCalculate,
    marketingConfigure,
    integrationsView, integrationsManage, mediaView, mediaManage, printingExecute, billingView, billingManage,
  ],
  // Phase 16's role: the books, and only the books. No till, no floor. Manages
  // the «اشخاص» file inside the Accounting app (its own customers, suppliers
  // and staff view with the ledger's columns) — the CRM app itself stays
  // closed to this role, so the 360° file, segments and notes are not a back
  // door into customer PII without an accounting reason.
  accountant: [
    aiUse, aiUsageView,
    menuView,
    inventoryView,
    partiesView, partiesManage,
    ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit, ledgerPropose,
    financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
    financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
    payrollView, payrollManage,
    reportsView, reportsExport,
    // Same reasoning as the manager's: the accountant already downloaded the
    // financial statements through reports.export, and importing a chart of
    // accounts or a month of expenses is the accounting work this role exists
    // for. Which entities they may actually move is still decided by the
    // entity permissions above — no crm.export here, so no customer dump.
    dataImport, dataExport,
    // A project is a cost centre the books post against (journal_entries
    // .project_id), so the accountant must be able to read the workspace and
    // the contracts whose values they are accruing. Read only: recording a
    // cost is accounting work, committing the business to a new contractor is
    // not.
    workspaceView,
    // Growth accounting and customer reads were open to the accountant, and
    // commission is compensation — the same data class as payroll, which this
    // role already reads. Writing a commission rule is not books work; the
    // settlement lifecycle is (#869): build, approve, pay and reverse a run.
    growthView, commissionView,
    commissionCalculate, commissionApprove, commissionPayout, commissionReverse,
  ],
  cashier: [
    aiUse,
    ordersView, ordersCreate, ordersDiscount, paymentsTake,
    tablesManage, reservationsView, reservationsManage,
    menuView, deliveryManage,
    inventoryView,
    partiesView, partiesManage,
    // Matches what the CRM nav already showed a cashier (directory, persons,
    // activities, cases) — logging that a customer called is floor work. No
    // crmView: the 360° file, segments and pipeline are not. No merge, no
    // consent, no export.
    crmManage,
    // Till staff earn and redeem loyalty points and look a gift card's balance
    // up. Since issue #764 that is all: no growth.view (the management
    // dashboard and the accounting bridge), no commission data, no
    // campaigns, and no act that *creates* or pays out a liability — issuing
    // store credit or a gift card, paying credit out, or spending a gift card
    // outside the till's own tender flow. An owner who wants a senior cashier
    // to do one of those grants that exact key.
    loyaltyView, loyaltyRedeem, giftCardsView, printingExecute,
    // Sees the projects they are a member of and works the tasks on them —
    // the floor-staff case the workspace is for. No contracts, no approvals.
    workspaceView, workspaceManage,
  ],
  waiter: [
    aiUse,
    ordersView, ordersCreate,
    tablesManage, reservationsView, reservationsManage,
    menuView,
    // Read-only: a waiter may be a contributor on a project (a refit, an
    // event) and needs to see the tasks assigned to them.
    workspaceView, printingExecute,
  ],
  kitchen: [
    aiUse,
    kitchenView, printingExecute,
    menuView,
  ],
};

/** Per-member adjustments layered on top of the role preset. */
export interface PermissionOverrides {
  granted?: string[];
  revoked?: string[];
}

/** True when this role holds every permission unconditionally. */
export function isAbsoluteRole(role: Role): role is "owner" {
  return role === "owner";
}

/** Built-in roles that resolve to a preset. Kept in step with `roles.ts`. */
export const ROLE_PRESET_ROLES: readonly Role[] = ["owner", ...(Object.keys(ROLE_PRESETS) as Exclude<Role, "owner">[])];

/** The preset for a role, before any per-member overrides. */
export function roleBasePermissions(role: Role): Permission[] {
  if (isAbsoluteRole(role)) return [...ALL_PERMISSIONS];
  return [...(ROLE_PRESETS[role] ?? [])];
}

function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

/**
 * The effective permission set: preset ∪ granted \ revoked.
 *
 * Unknown keys in the overrides are ignored rather than throwing — a stored
 * override naming a permission that a later release removed must not be able
 * to break every request that member makes.
 *
 * An owner's set is not reducible. A business that could revoke its way out of
 * `team.manage` on its only owner would be permanently locked out of itself,
 * so overrides are simply not applied to an absolute role.
 */
const PERMISSION_DEPENDENCIES: Partial<Record<Permission, readonly Permission[]>> = {
  [PERMISSIONS.crmManage]: [PERMISSIONS.crmView],
  [PERMISSIONS.crmMerge]: [PERMISSIONS.crmView],
  [PERMISSIONS.crmConsentManage]: [PERMISSIONS.crmView],
  [PERMISSIONS.crmConfigure]: [PERMISSIONS.crmView],
  [PERMISSIONS.crmDelete]: [PERMISSIONS.crmView],
  [PERMISSIONS.inventoryAdjust]: [PERMISSIONS.inventoryView],
  [PERMISSIONS.purchasesManage]: [PERMISSIONS.inventoryView],
  [PERMISSIONS.menuEdit]: [PERMISSIONS.menuView],
  [PERMISSIONS.ledgerPost]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.ledgerPropose]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.financeExpensesManage]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.financeReceivablesManage]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.financePayablesManage]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.financeChequesManage]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.financeInstallmentsManage]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.financeReconciliationManage]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.financeAssetsManage]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.payrollManage]: [PERMISSIONS.payrollView],
  [PERMISSIONS.ledgerApprove]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.accountsEdit]: [PERMISSIONS.ledgerView],
  [PERMISSIONS.reportsExport]: [PERMISSIONS.reportsView],
  [PERMISSIONS.workspaceAdmin]: [PERMISSIONS.workspaceView, PERMISSIONS.workspaceManage],
  [PERMISSIONS.reservationsManage]: [PERMISSIONS.reservationsView],
  [PERMISSIONS.teamManage]: [PERMISSIONS.teamView],
  [PERMISSIONS.teamPermissionsManage]: [PERMISSIONS.teamView],
  [PERMISSIONS.woocommerceManage]: [PERMISSIONS.woocommerceView],
  [PERMISSIONS.woocommerceSync]: [PERMISSIONS.woocommerceView],
  [PERMISSIONS.woocommerceConfigure]: [PERMISSIONS.woocommerceView],
  [PERMISSIONS.websiteManage]: [PERMISSIONS.websiteView],
  [PERMISSIONS.websiteSettingsManage]: [PERMISSIONS.websiteView],
  [PERMISSIONS.cmsContentManage]: [PERMISSIONS.cmsView],
  [PERMISSIONS.cmsPublish]: [PERMISSIONS.cmsView],
  [PERMISSIONS.cmsConfigure]: [PERMISSIONS.cmsView],
  // Growth (issue #764). A write implies its own read only — never
  // growth.view, which is the management dashboard: granting a cashier
  // gift-card redemption must not hand them the business's KPIs.
  [PERMISSIONS.campaignsManage]: [PERMISSIONS.campaignsView],
  [PERMISSIONS.loyaltyManage]: [PERMISSIONS.loyaltyView],
  [PERMISSIONS.loyaltyRedeem]: [PERMISSIONS.loyaltyView],
  [PERMISSIONS.storeCreditIssue]: [PERMISSIONS.loyaltyView],
  [PERMISSIONS.storeCreditPayout]: [PERMISSIONS.loyaltyView],
  [PERMISSIONS.giftCardsIssue]: [PERMISSIONS.giftCardsView],
  [PERMISSIONS.giftCardsRedeem]: [PERMISSIONS.giftCardsView],
  [PERMISSIONS.commissionManage]: [PERMISSIONS.commissionView],
  [PERMISSIONS.commissionCalculate]: [PERMISSIONS.commissionView],
  [PERMISSIONS.commissionApprove]: [PERMISSIONS.commissionView],
  [PERMISSIONS.commissionPayout]: [PERMISSIONS.commissionView],
  [PERMISSIONS.commissionReverse]: [PERMISSIONS.commissionView],
  [PERMISSIONS.integrationsManage]: [PERMISSIONS.integrationsView],
  [PERMISSIONS.mediaManage]: [PERMISSIONS.mediaView],
  [PERMISSIONS.billingManage]: [PERMISSIONS.billingView],
};

/**
 * Every permission a member holding `permission` also holds: the transitive
 * closure of `PERMISSION_DEPENDENCIES`.
 *
 * Exported because a *second* reader needs the same answer as the runtime:
 * `crm-permissions.test.ts` checks each CRM API route against the section
 * table, and it must model "who holds what" exactly as a request does. A test
 * with its own idea of the implications would pass while production 403s.
 */
export function impliedPermissions(permission: Permission): Set<Permission> {
  const out = new Set<Permission>();
  const pending = [...(PERMISSION_DEPENDENCIES[permission] ?? [])];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    for (const dependency of PERMISSION_DEPENDENCIES[next] ?? []) pending.push(dependency);
  }
  return out;
}

export function effectivePermissions(
  role: Role,
  overrides: PermissionOverrides | null | undefined,
  customRolePermissions?: readonly string[] | null,
): Set<Permission> {
  const base = new Set<Permission>(
    role === "owner" || customRolePermissions == null
      ? roleBasePermissions(role)
      : customRolePermissions.filter(isPermission).filter((permission) => !isOwnerOnlyPermission(permission)),
  );
  if (isAbsoluteRole(role)) return base;

  for (const key of overrides?.granted ?? []) {
    if (isPermission(key) && !isOwnerOnlyPermission(key)) base.add(key);
  }

  // Convenience grants include their read prerequisites. Explicit revocation
  // is applied afterwards and therefore remains authoritative.
  for (const permission of [...base]) {
    for (const dependency of impliedPermissions(permission)) base.add(dependency);
  }
  for (const key of overrides?.revoked ?? []) {
    if (isPermission(key)) base.delete(key);
  }

  // A revoked prerequisite also disables dependent mutation capabilities.
  let changed = true;
  while (changed) {
    changed = false;
    for (const permission of [...base]) {
      if ((PERMISSION_DEPENDENCIES[permission] ?? []).some((dependency) => !base.has(dependency))) {
        base.delete(permission);
        changed = true;
      }
    }
  }
  return base;
}

/** Whether a member with this role and these overrides may do `permission`. */
export function hasPermission(
  role: Role,
  overrides: PermissionOverrides | null | undefined,
  permission: Permission,
  customRolePermissions?: readonly string[] | null,
): boolean {
  if (isAbsoluteRole(role)) return true;
  return effectivePermissions(role, overrides, customRolePermissions).has(permission);
}

/**
 * Normalises whatever was stored in `users.permissions` into overrides.
 *
 * The column is jsonb and therefore can hold anything, including values
 * written by an older release. Everything unrecognised degrades to "no
 * override" rather than throwing.
 */
export function parseOverrides(value: unknown): PermissionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];
  const removeOwnerOnly = (items: string[]) =>
    items.filter((item) => !isPermission(item) || !isOwnerOnlyPermission(item));
  return {
    granted: removeOwnerOnly(list(raw.granted)),
    revoked: removeOwnerOnly(list(raw.revoked)),
  };
}
