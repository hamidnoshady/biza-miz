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
import { PERMISSION_DEPENDENCIES as PERMISSION_DEPENDENCIES_SOURCE } from "./permission-dependencies";

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
   * Voiding one sent line of an OPEN order (issue #913 item 3). Deliberate
   * its own key rather than inherited from `orders.create` (how it silently
   * worked at the HTTP layer) or folded into `orders.void` (which would drag
   * full-bill cancellation along with a waiter's line correction): removing a
   * line re-prices a bill the kitchen already saw, so it must be expressible
   * as a grant ("may correct a sent line") and a revocation ("may not") on
   * its own. Presets that could already reach the item PATCH grant it, so the
   * split changes nobody's day-to-day access — only what an override can say.
   */
  ordersVoidItem: "orders.void_item",
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
   * Issuing more of an item than the branch holds.
   *
   * The حواله issue path refuses to drive stock negative unless the caller
   * explicitly confirms, and the confirm step used to be a flag on the request
   * body: any client that sent `allowNegativeStock: true` bypassed it, so the
   * "confirm" was a UI convention rather than a privilege. This key is the
   * gate. Without it the flag is ignored and the shortfall is answered
   * `negative_stock_requires_confirm`; with it the issue posts and is audited,
   * because a negative balance is a discrepancy somebody has to explain.
   */
  inventoryNegativeStockOverride: "inventory.negative_stock_override",

  /**
   * Automotive — «خودرو و نمایشگاه اتومبیل» (issue #839).
   *
   * Split by *blast radius*, like the CRM and Growth blocks, because the trade
   * has three genuinely different jobs on one lot: a salesperson shows and
   * prices cars, a cashier takes money for one, and only the office may touch
   * what the dealership paid. The two boundaries the issue names explicitly are
   * both here and both are *reads* of money rather than screens:
   *
   *   * `vehicles.cost_view` is the cost/margin read. A cashier or salesperson
   *     without it sees the asking price and the car, never the basis — which is
   *     why it is its own key rather than a side effect of `vehicles.view`;
   *     `vehicles.view` deliberately grants no cost, price-history or margin.
   *   * `vehicles.override_min_price` is the one act that can complete a sale
   *     below the floor the owner set. It is separate from `vehicles.sell` so
   *     "sell cars" and "sell cars at a loss the owner did not authorise" are
   *     two decisions, and it is audited.
   *
   * `vehicles.cost_edit` and `vehicles.expense_record` are the two ways the
   * effective cost changes — the number COGS freezes at sale — so both are
   * high-risk and audited. Pricing is deliberately *not* a cost permission
   * (issue §6): `vehicles.price_edit` writes the asking/minimum/wholesale
   * figures and can never reach the acquisition cost.
   */
  vehiclesView: "vehicles.view",
  vehiclesCreate: "vehicles.create",
  vehiclesEdit: "vehicles.edit",
  vehiclesCostView: "vehicles.cost_view",
  vehiclesCostEdit: "vehicles.cost_edit",
  vehiclesPriceEdit: "vehicles.price_edit",
  vehiclesReserve: "vehicles.reserve",
  vehiclesReservationCancel: "vehicles.reservation_cancel",
  vehiclesSell: "vehicles.sell",
  /**
   * Issue #963 — the two-sided deal: sell one car while taking the
   * customer's car in against it. Its own key because it is two acts at
   * once (a sale that can leave a receivable, and an acquisition that fixes
   * the handed-in car's cost basis at an allowance the holder agrees), and
   * the route still layers `vehicles.sell`, `vehicles.create` and
   * `vehicles.cost_edit` on top — this key is the decision that *combining*
   * them is allowed, audited as one act.
   */
  vehiclesTradeIn: "vehicles.trade_in",
  vehiclesOverrideMinPrice: "vehicles.override_min_price",
  vehiclesTransfer: "vehicles.transfer",
  vehiclesExpenseRecord: "vehicles.expense_record",
  vehiclesArchive: "vehicles.archive",

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
   * Shareholder capital and profit distribution (issue #864). Party identity
   * remains in `parties`; this is the narrow Accounting authority for dated
   * ownership, capital postings, approved distributions, settlement and
   * permissioned retroactive corrections.
   */
  shareholdersView: "shareholders.view",
  shareholdersManage: "shareholders.manage",
  shareholdersRetroactive: "shareholders.retroactive",
  shareholdersCapitalPost: "shareholders.capital_post",
  shareholdersCapitalReverse: "shareholders.capital_reverse",
  shareholdersDistributionsManage: "shareholders.distributions_manage",
  shareholdersDistributionsAdjust: "shareholders.distributions_adjust",
  shareholdersDistributionsApprove: "shareholders.distributions_approve",
  shareholdersDistributionsPay: "shareholders.distributions_pay",
  shareholdersDistributionsReverse: "shareholders.distributions_reverse",

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
   * «حساب‌های مالی» and «انتقال وجه» (issue #862).
   *
   * Two keys rather than one, because the two acts are different sizes: an
   * account is a master record (its chart link, its branch, its default), a
   * transfer is money moving *now*. A business that wants a cashier to be able
   * to move the day's takings between the till and the safe, without also being
   * able to register or re-point containers, can grant exactly the second.
   *
   * Both imply `ledger.view`: a transfer screen is a ledger screen.
   */
  financeAccountsManage: "finance.accounts_manage",
  financeTransfersManage: "finance.transfers_manage",

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

  // Taxpayer e-invoicing (issue #866). One key per thing it changes: what the
  // authority sees, what leaves the building, what is withdrawn, and who may hold
  // the taxpayer's keys. A business can grant the reading without the sending.
  taxView: "tax.view",
  taxPrepare: "tax.prepare",
  taxSend: "tax.send",
  taxInquiry: "tax.inquiry",
  taxAmend: "tax.amend",
  taxCancel: "tax.cancel",
  taxManageSettings: "tax.manage_settings",
  taxExport: "tax.export",

  /**
   * Insight — the reporting stack's capabilities (issue #819).
   *
   * The keys answer four *different* questions, and the audit that produced
   * them found the answers conflated: `/api/reports/query` — the normal read
   * path for previews, row reports and the builder — required
   * `reports.export`, so `reports.view` alone could not run a report; saving
   * or deleting a saved report required the download key; cross-branch
   * consolidated reporting was guarded by the same `reports.view` as a single
   * branch's own reports; and a role's default dashboard layout could be
   * replaced by anybody who could view reports at all.
   *
   *   reports.view   run/read standard reports, saved reports, builder
   *                  previews, and the caller's own dashboard widgets.
   *   reports.manage author saved reports: create, rename, edit, delete, and
   *                  save a personal dashboard layout. Not a read key, and not
   *                  a download key.
   *   reports.export CSV/Excel/PDF download. Export is a different act from
   *                  reading — it is how data leaves the building — so it
   *                  implies `reports.view` rather than the other way round.
   *   reports.business_wide
   *                  consolidated numbers across the business's own branches
   *                  (the branch-comparison screen, its export, and the AI
   *                  branch-comparison tool). Owner-reserved, in the same
   *                  cross-location trust family as `rollup.manage`: a member
   *                  sees their own branch's reports with `reports.view`, and
   *                  reading every branch at once stays with ownership.
   *   reports.dashboard_defaults.manage
   *                  replace a *role's* default dashboard layout, which a
   *                  member inherits until they make a personal override.
   *                  Owner, Admin and Manager receive it by default; it is
   *                  separate from both personal-layout (`reports.manage`) and
   *                  business-wide reporting authority.
   */
  reportsView: "reports.view",
  reportsManage: "reports.manage",
  reportsExport: "reports.export",
  reportsBusinessWide: "reports.business_wide",
  reportsDashboardDefaultsManage: "reports.dashboard_defaults.manage",

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
  /**
   * Issue #933 — the shift controls used to hang off `orders.create`, which
   * meant the kitchen role was shown a clock-in button it could never use and a
   * waiter's attendance depended on a till capability. A shift is attendance,
   * not a sale:
   *
   *   shifts.self          clock myself in and out, with or without a count.
   *   shifts.manage        read the whole history, force-close a forgotten
   *                        shift, record cash movements and correct a finalized
   *                        cash-up. A supervisory read of other people's money.
   *   business_day.close   close or reopen the branch's trading day — resets
   *                        what every till shows, so it is its own key rather
   *                        than `ledger.close_period` (which belongs to the
   *                        books and 403'd the button the panel drew from
   *                        `settings.manage`).
   */
  shiftsSelf: "shifts.self",
  shiftsManage: "shifts.manage",
  businessDayClose: "business_day.close",
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
  // Issue #883 P0-4: minting, narrowing, revoking and consenting to MCP
  // connections — a machine credential with continuous read (and optional
  // write) reach over a whole branch — is owner-only, exactly like api.manage.
  mcpManage: "mcp.manage",
  /**
   * Issue #884 — seeing and revoking every Android installation registered
   * to the business, not only one's own. Not owner-only: a business that
   * wants a delegated security admin to run this without owning the tenant
   * grants this one key, the same "system-role presets plus per-member
   * overrides" shape every other capability in this file has. The `admin`
   * preset holds it automatically (every non-owner-only permission); no
   * other preset does, because unlike the CRM/workspace splits above this is
   * a brand-new capability, not one a role already had before the key
   * existed.
   */
  nativeDevicesManage: "native_devices.manage",

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
  // Cross-branch consolidated numbers (issue #819): money-adjacent data
  // leaving its own branch, and owner-reserved below.
  PERMISSIONS.reportsBusinessWide,
  PERMISSIONS.dataExport,
  PERMISSIONS.teamManage,
  // Issue #933: a force-close finalizes somebody else's drawer and a cash-up
  // correction rewrites what a variance is understood to be. Both are audited.
  PERMISSIONS.shiftsManage,
  PERMISSIONS.backupManage,
  PERMISSIONS.storeCreditIssue,
  PERMISSIONS.storeCreditPayout,
  PERMISSIONS.giftCardsIssue,
  PERMISSIONS.commissionManage,
  PERMISSIONS.commissionCalculate,
  PERMISSIONS.commissionApprove,
  PERMISSIONS.commissionPayout,
  PERMISSIONS.commissionReverse,
  // Issue #864: the ownership history and the money allocated to it are
  // sensitive and irreversible in the book (corrections are mirror entries).
  PERMISSIONS.shareholdersManage,
  PERMISSIONS.shareholdersRetroactive,
  PERMISSIONS.shareholdersCapitalPost,
  PERMISSIONS.shareholdersCapitalReverse,
  PERMISSIONS.shareholdersDistributionsManage,
  PERMISSIONS.shareholdersDistributionsAdjust,
  PERMISSIONS.shareholdersDistributionsApprove,
  PERMISSIONS.shareholdersDistributionsPay,
  PERMISSIONS.shareholdersDistributionsReverse,
  // Issue #839: changing what a car cost (the figure COGS freezes at), selling
  // below the owner's floor, and hiding a vehicle from the lot.
  PERMISSIONS.vehiclesCostEdit,
  PERMISSIONS.vehiclesOverrideMinPrice,
  PERMISSIONS.vehiclesArchive,
  // Issue #963: agreeing a handed-in car's value fixes its cost basis in the
  // same act that sells another car against it.
  PERMISSIONS.vehiclesTradeIn,
]);
const REASON_REQUIRED = new Set<Permission>([
  PERMISSIONS.ordersAmendClosed,
  PERMISSIONS.paymentsRefund,
  PERMISSIONS.crmMerge,
  PERMISSIONS.ledgerClosePeriod,
  PERMISSIONS.shareholdersRetroactive,
  PERMISSIONS.shareholdersCapitalReverse,
  PERMISSIONS.shareholdersDistributionsAdjust,
  PERMISSIONS.shareholdersDistributionsReverse,
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
    PERMISSIONS.mcpManage,
    PERMISSIONS.rollupManage,
  ]).has(key);
  const risk: PermissionRisk = ownerOnly ? "critical" : HIGH_RISK.has(key) ? "high" : "medium";
  return {
    key,
    group: key.startsWith("shareholders.") ? "accounting" : key.split(".")[0],
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
  PERMISSIONS.mcpManage,
  PERMISSIONS.rollupManage,
  // Issue #819 — the reporting-stack member of the cross-location trust
  // family, next to `rollup.manage` (cross-branch aggregation pushed between
  // servers). The branch-comparison screen, its export and the AI's branch
  // comparison are the whole business's trading at once; a member assigned to
  // one branch reaches their own branch's reports with `reports.view` and
  // never the rest by asking for a "report".
  PERMISSIONS.reportsBusinessWide,
];

export function isOwnerOnlyPermission(permission: Permission): boolean {
  return OWNER_ONLY_PERMISSIONS.includes(permission);
}

const {
  aiUse, aiManage, aiAutomationsManage, aiUsageView,
  ordersView, ordersCreate, ordersVoid, ordersVoidItem, ordersAmendClosed, ordersDiscount, paymentsTake, paymentsRefund,
  tablesManage, tablesEdit, reservationsView, reservationsManage, kitchenView, deliveryManage, deliveryConfigure,
  menuView, menuEdit,
  inventoryView, inventoryAdjust, purchasesManage, inventoryNegativeStockOverride,
  vehiclesView, vehiclesCreate, vehiclesEdit, vehiclesCostView, vehiclesCostEdit,
  vehiclesPriceEdit, vehiclesReserve, vehiclesReservationCancel, vehiclesSell,
  vehiclesTradeIn,
  vehiclesOverrideMinPrice, vehiclesTransfer, vehiclesExpenseRecord, vehiclesArchive,
  partiesView, partiesManage,
  crmView, crmManage, crmMerge, crmConsentManage, crmExport, crmConfigure, crmDelete,
  workspaceView, workspaceManage, workspaceContractsManage, workspaceApprove, workspaceDocumentsIssue,
  workspaceAdmin,
  ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit, ledgerPropose,
  shareholdersView, shareholdersManage, shareholdersRetroactive, shareholdersCapitalPost,
  shareholdersCapitalReverse, shareholdersDistributionsManage, shareholdersDistributionsAdjust,
  shareholdersDistributionsApprove, shareholdersDistributionsPay, shareholdersDistributionsReverse,
  financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
  financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
  financeAccountsManage, financeTransfersManage,
  payrollView, payrollManage,
  taxView, taxPrepare, taxSend, taxInquiry, taxAmend, taxCancel, taxManageSettings, taxExport,
  reportsView, reportsManage, reportsExport, reportsBusinessWide, reportsDashboardDefaultsManage,
  dataImport, dataExport,
  shiftsSelf, shiftsManage, businessDayClose,
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
    ordersView, ordersCreate, ordersVoid, ordersVoidItem, ordersAmendClosed, ordersDiscount, paymentsTake, paymentsRefund,
    tablesManage, tablesEdit, reservationsView, reservationsManage, kitchenView, deliveryManage, deliveryConfigure,
    menuView, menuEdit,
    // `inventory.negative_stock_override` keeps the manager's existing reach:
    // the حواله form has always let a manager confirm a negative issue.
    inventoryView, inventoryAdjust, purchasesManage, inventoryNegativeStockOverride,
    // Issue #839 — the manager runs the lot: every vehicle capability,
    // including the cost and margin reads and the audited override. A
    // dealership that wants a narrower sales manager revokes the individual
    // keys per member, which is what overrides are for.
    vehiclesView, vehiclesCreate, vehiclesEdit, vehiclesCostView, vehiclesCostEdit,
    vehiclesPriceEdit, vehiclesReserve, vehiclesReservationCancel, vehiclesSell,
    // Issue #963 — a trade-in is the manager's deal to strike: it prices the
    // customer's car and sells one against it in a single act.
    vehiclesTradeIn,
    vehiclesOverrideMinPrice, vehiclesTransfer, vehiclesExpenseRecord, vehiclesArchive,
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
    // Issue #819. `reports.manage` and the role-default dashboard key keep the
    // manager doing what the reports screens and the widgets route always
    // documented they could do; `reports.export` they already held. Not
    // `reports.business_wide`: cross-branch comparison is granted explicitly.
    ledgerView, reportsView, reportsManage, reportsExport, reportsDashboardDefaultsManage,
    // Operational finance the manager already did under a role gate. Not
    // accounting authority, and not payroll.
    financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
    financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
    // Issue #862 — the manager kept every screen the ledger already had, and
    // the two new ones are the same work («حساب‌های مالی»، «انتقال وجه»).
    financeAccountsManage, financeTransfersManage,
    ledgerPropose,
    // Taxpayer invoicing, operational half: prepare, send and inquire. The
    // amendment, cancellation, export and the taxpayer's keys stay with the
    // accountant and the administrator, who answer for what the authority holds.
    taxView, taxPrepare, taxSend, taxInquiry,
    // «ورود و خروج داده». The manager already held every bulk door the product
    // had (crm.export gated both the customer export AND the customer import;
    // reports.export gated the report download), so granting these two keeps
    // the access they had rather than handing them a new capability. The
    // engine still intersects them with each entity's own permission.
    dataImport, dataExport,
    settingsManage, backupManage,
    // Issue #933 — the manager runs the shifts they already administrated
    // through `team.manage`-gated screens, and is the role that closes the
    // branch's day. `shifts.self` is included so a manager at the till can
    // clock in without borrowing the cashier role.
    shiftsSelf, shiftsManage, businessDayClose,
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
    // Issue #839 — the books read vehicle stock at cost. `vehicles.cost_view`
    // is the vehicle valuation and COGS side; `vehicles.view` is what the car
    // is. No selling, no reserving, no expense recording: a cost the office
    // did not agree to is not the accountant's to enter, and margin is not a
    // floor capability.
    vehiclesView, vehiclesCostView,
    partiesView, partiesManage,
    ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit, ledgerPropose,
    // Issue #864: the accountant manages dated ownership/capital and prepares,
    // approves, posts and pays closed-year distributions. Backdating and
    // corrections/reversals remain separate grants for an owner to delegate.
    shareholdersView, shareholdersManage, shareholdersCapitalPost,
    shareholdersDistributionsManage, shareholdersDistributionsAdjust,
    shareholdersDistributionsApprove, shareholdersDistributionsPay,
    financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
    financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
    // Issue #862 — registering the business's accounts and moving money between
    // them is bookkeeping, which is this role.
    financeAccountsManage, financeTransfersManage,
    payrollView, payrollManage,
    // Taxpayer invoicing, accounting half: every record action except the
    // taxpayer's keys, which only the administrator holds. Cancelling an accepted
    // invoice and exporting the register are the two most consequential here.
    taxView, taxPrepare, taxSend, taxInquiry, taxAmend, taxCancel, taxExport,
    // Issue #819: the accountant could already download the statements; running
    // and saving a report is the read/manage half of the same work. Not the
    // role-default dashboard key (Owner, Admin and Manager receive that
    // separate capability by default) and not `reports.business_wide`.
    reportsView, reportsManage, reportsExport,
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
    ordersView, ordersCreate, ordersVoidItem, ordersDiscount, paymentsTake,
    tablesManage, reservationsView, reservationsManage,
    menuView, deliveryManage,
    inventoryView,
    // Issue #839 — a cashier may take payment for a car the lot has already
    // priced, and nothing else: no cost or margin read, no price edit, no
    // reservation authority, no sale below the floor. `vehicles.sell` is the
    // till act; `phone the office` is what a deal below the floor takes.
    vehiclesView, vehiclesSell,
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
    // Issue #933 — attendance is not an order capability.
    shiftsSelf,
    // Sees the projects they are a member of and works the tasks on them —
    // the floor-staff case the workspace is for. No contracts, no approvals.
    workspaceView, workspaceManage,
  ],
  waiter: [
    aiUse,
    ordersView, ordersCreate, ordersVoidItem,
    tablesManage, reservationsView, reservationsManage,
    menuView,
    // Read-only: a waiter may be a contributor on a project (a refit, an
    // event) and needs to see the tasks assigned to them.
    workspaceView, printingExecute,
    // Issue #933 — a waiter clocks in and out like anyone on the floor.
    shiftsSelf,
  ],
  kitchen: [
    aiUse,
    kitchenView, printingExecute,
    menuView,
    // Issue #933 — the sidebar drew the clock-in button for every PIN role,
    // and this role's preset could not call the route behind it.
    shiftsSelf,
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
const PERMISSION_DEPENDENCIES = PERMISSION_DEPENDENCIES_SOURCE;

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
