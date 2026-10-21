/**
 * The one direct-implication graph for permissions.
 *
 * Runtime authorization and the role editor both consume this table. Keeping
 * the edges here (rather than re-stating them in permissions.ts and the UI
 * registry) prevents an effective grant from disagreeing with the checkbox
 * prerequisites shown to an owner.
 */
import type { Permission } from "./permissions";

export const PERMISSION_DEPENDENCIES: Partial<Record<Permission, readonly Permission[]>> = {
  // AI
  "ai.manage": ["ai.use"],
  "ai.automations.manage": ["ai.use"],
  "ai.usage.view": ["ai.use"],

  // Sales and payments
  "orders.create": ["menu.view", "orders.view"],
  "orders.discount": ["orders.create"],
  "orders.void_item": ["orders.create"],
  "orders.amend_closed": ["orders.void"],
  "payments.refund": ["payments.take"],
  "reservations.manage": ["reservations.view"],
  "delivery.configure": ["delivery.manage"],
  "menu.edit": ["menu.view"],

  // Inventory and parties
  "inventory.adjust": ["inventory.view"],
  "purchases.manage": ["inventory.view"],
  "parties.manage": ["parties.view"],

  // Vehicles (issue #839). Every vehicle act needs the vehicle list; the two
  // money writes also need to *see* cost, so a role cannot record or change a
  // figure its holder may not read. Reading cost implies only the list.
  "vehicles.create": ["vehicles.view"],
  "vehicles.edit": ["vehicles.view"],
  "vehicles.cost_view": ["vehicles.view"],
  "vehicles.cost_edit": ["vehicles.view", "vehicles.cost_view"],
  "vehicles.price_edit": ["vehicles.view"],
  "vehicles.reserve": ["vehicles.view"],
  "vehicles.reservation_cancel": ["vehicles.view"],
  "vehicles.sell": ["vehicles.view"],
  "vehicles.override_min_price": ["vehicles.view"],
  "vehicles.transfer": ["vehicles.view"],
  "vehicles.expense_record": ["vehicles.view", "vehicles.cost_view"],
  "vehicles.archive": ["vehicles.view"],

  // CRM
  "crm.manage": ["crm.view"],
  "crm.merge": ["crm.view"],
  "crm.consent_manage": ["crm.view"],
  "crm.export": ["crm.view"],
  "crm.configure": ["crm.view"],
  "crm.delete": ["crm.view"],

  // Workspace
  "workspace.manage": ["workspace.view"],
  "workspace.contracts_manage": ["workspace.view"],
  "workspace.admin": ["workspace.view", "workspace.manage"],
  "workspace.approve": ["workspace.view"],
  "workspace.documents_issue": ["workspace.view"],

  // Accounting and operational finance
  "ledger.post": ["ledger.view"],
  "ledger.approve": ["ledger.view"],
  "ledger.close_period": ["ledger.view"],
  "accounts.edit": ["ledger.view"],
  "ledger.propose": ["ledger.view"],
  // Shareholder accounting (issue #864): identity reads flow through the
  // canonical party directory; money writes additionally inherit ledger.post,
  // while reversal paths remain separately grantable high-risk permissions.
  "shareholders.view": ["ledger.view", "parties.view"],
  "shareholders.manage": ["shareholders.view"],
  "shareholders.retroactive": ["shareholders.manage"],
  "shareholders.capital_post": ["shareholders.view", "ledger.post"],
  "shareholders.capital_reverse": ["shareholders.view", "ledger.approve"],
  "shareholders.distributions_manage": ["shareholders.view"],
  "shareholders.distributions_adjust": ["shareholders.distributions_manage"],
  "shareholders.distributions_approve": ["shareholders.view"],
  "shareholders.distributions_pay": ["shareholders.view", "ledger.post"],
  "shareholders.distributions_reverse": ["shareholders.view", "ledger.approve"],
  "finance.expenses_manage": ["ledger.view"],
  "finance.receivables_manage": ["ledger.view"],
  "finance.payables_manage": ["ledger.view"],
  "finance.cheques_manage": ["ledger.view"],
  "finance.installments_manage": ["ledger.view"],
  "finance.reconciliation_manage": ["ledger.view"],
  "finance.assets_manage": ["ledger.view"],
  // Issue #862 — both are ledger screens: an account is a container for ledger
  // money and a transfer is two ledger lines. Neither implies the other.
  "finance.accounts_manage": ["ledger.view"],
  "finance.transfers_manage": ["ledger.view"],
  "payroll.manage": ["payroll.view"],
  "reports.export": ["reports.view"],
  // The reporting stack (issue #819): each key implies the read key, and
  // nothing else. Export is how data leaves the building; business-wide is
  // owner-reserved; dashboard defaults are a role-level act.
  "reports.manage": ["reports.view"],
  "reports.business_wide": ["reports.view"],
  "reports.dashboard_defaults.manage": ["reports.view"],

  // Taxpayer invoicing: viewing the register requires ledger visibility; every
  // consequential operation also inherits the tax register read capability.
  "tax.view": ["ledger.view"],
  "tax.prepare": ["tax.view"],
  "tax.send": ["tax.view"],
  "tax.inquiry": ["tax.view"],
  "tax.amend": ["tax.view"],
  "tax.cancel": ["tax.view"],
  "tax.manage_settings": ["tax.view"],
  "tax.export": ["tax.view"],

  // Growth and marketing
  "campaigns.manage": ["campaigns.view"],
  "loyalty.manage": ["loyalty.view"],
  "loyalty.redeem": ["loyalty.view"],
  "store_credit.issue": ["loyalty.view"],
  "store_credit.payout": ["loyalty.view"],
  "gift_cards.issue": ["gift_cards.view"],
  "gift_cards.redeem": ["gift_cards.view"],
  "commission.manage": ["commission.view"],
  "commission.calculate": ["commission.view"],
  "commission.approve": ["commission.view"],
  "commission.payout": ["commission.view"],
  "commission.reverse": ["commission.view"],
  "marketing.configure": ["growth.view"],

  // Website and integrations
  "website.manage": ["website.view"],
  "website.settings_manage": ["website.view"],
  "cms.content_manage": ["cms.view"],
  "cms.publish": ["cms.view"],
  "cms.configure": ["cms.view"],
  "woocommerce.manage": ["woocommerce.view"],
  "woocommerce.sync": ["woocommerce.view"],
  "woocommerce.configure": ["woocommerce.view"],
  "integrations.manage": ["integrations.view"],
  "media.manage": ["media.view"],
  "billing.manage": ["billing.view"],

  // Team and access
  "team.manage": ["team.view"],
  "team.permissions_manage": ["team.view"],
};
