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
  "orders.amend_closed": ["orders.void"],
  "payments.refund": ["payments.take"],
  "reservations.manage": ["reservations.view"],
  "delivery.configure": ["delivery.manage"],
  "menu.edit": ["menu.view"],

  // Inventory and parties
  "inventory.adjust": ["inventory.view"],
  "purchases.manage": ["inventory.view"],
  "parties.manage": ["parties.view"],

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
  "finance.expenses_manage": ["ledger.view"],
  "finance.receivables_manage": ["ledger.view"],
  "finance.payables_manage": ["ledger.view"],
  "finance.cheques_manage": ["ledger.view"],
  "finance.installments_manage": ["ledger.view"],
  "finance.reconciliation_manage": ["ledger.view"],
  "finance.assets_manage": ["ledger.view"],
  "payroll.manage": ["payroll.view"],
  "reports.export": ["reports.view"],

  // Growth and marketing
  "campaigns.manage": ["campaigns.view"],
  "loyalty.manage": ["loyalty.view"],
  "loyalty.redeem": ["loyalty.view"],
  "store_credit.issue": ["loyalty.view"],
  "store_credit.payout": ["loyalty.view"],
  "gift_cards.issue": ["gift_cards.view"],
  "gift_cards.redeem": ["gift_cards.view"],
  "commission.manage": ["commission.view"],
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
