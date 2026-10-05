/**
 * Canonical AI capability policy.
 *
 * The model is never an authorization boundary. This registry is the single
 * intersection between the provider-facing catalogue and the effective
 * permissions resolved by `authorize()`. It is intentionally separate from
 * `ai.ts` so the catalogue stays framework-free and future tools fail closed
 * until somebody assigns them a real domain permission.
 */
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from "./permissions";
import type { ActionType, OpenAiTool } from "./ai";

/** Every dashboard read tool must have an entry here. Unknown tools are denied. */
export const AI_TOOL_PERMISSION_MAP: Readonly<Record<string, Permission>> = {
  get_setup_state: PERMISSIONS.settingsManage,
  list_reports: PERMISSIONS.reportsView,
  run_report: PERMISSIONS.reportsView,
  get_menu_performance: PERMISSIONS.menuView,
  get_void_pattern: PERMISSIONS.ordersView,
  get_stock_valuation: PERMISSIONS.inventoryView,
  get_supplier_performance: PERMISSIONS.inventoryView,
  get_reservation_conflicts: PERMISSIONS.reservationsView,
  get_table_turnover_rate: PERMISSIONS.reportsView,
  get_courier_performance: PERMISSIONS.deliveryManage,
  get_customer_profile: PERMISSIONS.crmView,
  get_at_risk_customers: PERMISSIONS.crmView,
  find_customers: PERMISSIONS.crmView,
  get_customer_timeline: PERMISSIONS.crmView,
  list_customer_segments: PERMISSIONS.crmView,
  preview_customer_segment: PERMISSIONS.crmView,
  get_ar_aging: PERMISSIONS.financeReceivablesManage,
  get_ap_upcoming: PERMISSIONS.financePayablesManage,
  get_unreconciled_bank_lines: PERMISSIONS.financeReconciliationManage,
  get_payroll_summary: PERMISSIONS.payrollView,
  get_vat_liability: PERMISSIONS.ledgerView,
  get_branch_comparison: PERMISSIONS.reportsView,
  forecast_demand: PERMISSIONS.inventoryView,
  get_menu_item_details: PERMISSIONS.menuView,
  get_bill_split_preview: PERMISSIONS.ordersView,
  get_near_expiry_items: PERMISSIONS.inventoryView,
  get_staff_commission: PERMISSIONS.payrollView,
  get_repurchase_candidates: PERMISSIONS.crmView,
  run_accounting_review: PERMISSIONS.ledgerView,
  list_coworker_jobs: PERMISSIONS.aiAutomationsManage,
  find_items: PERMISSIONS.menuView,
  get_waste_history: PERMISSIONS.inventoryView,
  describe_app: PERMISSIONS.aiUse,
  list_website_posts: PERMISSIONS.websiteView,
  list_website_products: PERMISSIONS.websiteView,
  get_website_status: PERMISSIONS.websiteView,
  list_message_templates: PERMISSIONS.campaignsView,
  list_message_campaigns: PERMISSIONS.campaignsView,
  get_workspace_project_status: PERMISSIONS.workspaceView,
  list_workspace_tasks: PERMISSIONS.workspaceView,
  list_expiring_contracts: PERMISSIONS.workspaceView,
  list_workspace_approvals: PERMISSIONS.workspaceView,
  // Issue #799 §23 (AEC reads). Both sit on the same key the workspace module
  // and its financial report use — the cost figures they quote are already
  // visible to `workspace.view` on the project screen, so the assistant adds no
  // reach. When §24's dedicated commercial keys arrive (project financial view,
  // payment certificates), these move with them rather than staying broader.
  get_aec_project_financial_health: PERMISSIONS.workspaceView,
  list_delayed_project_activities: PERMISSIONS.workspaceView,
  // The BOQ variance quotes an approved estimate (the project's working budget)
  // and the ledger's actual cost — both of which `workspace.view` already shows
  // on the project page, so the assistant adds no reach here either.
  get_boq_variance: PERMISSIONS.workspaceView,
  // The drawing register is the documents tab the same member already opens, so
  // this read adds no reach either — it answers «آخرین رویژن…» from those rows.
  get_latest_drawing_revision: PERMISSIONS.workspaceView,
  // The two pending registers (issue #799 §23, Wave 6) are the RFI and submittal
  // tabs the same member already opens, so these reads add no reach: like the
  // drawing read above they sit on `workspace.view`.
  list_pending_rfis: PERMISSIONS.workspaceView,
  // Issue #799 §23/§24 (Wave 8) — the commercial reads. They quote the same
  // contract, change-order and certificate rows the «تغییرات» and
  // «صورت‌وضعیت و پرداخت» tabs show to a member with `workspace.view`, and the
  // ledger's actual cost exactly as `projectReport` gives it (null without
  // `ledger.view`), so the assistant adds no reach the screen does not already
  // have. §24's high-risk split is about *writing* a commercial action, which
  // these tools never do.
  list_change_orders: PERMISSIONS.workspaceView,
  list_payment_certificates: PERMISSIONS.workspaceView,
  list_project_commercial_risks: PERMISSIONS.workspaceView,
  // Wave 9's procurement read is the «تأمین و خرید» tab's own data (the awards
  // past their delivery date and the requests nobody has picked up), so like the
  // commercial three above it adds no reach beyond `workspace.view` — the
  // service gates it on the `procurement` capability on top.
  list_procurement_delays: PERMISSIONS.workspaceView,
  list_upcoming_milestones: PERMISSIONS.workspaceView,
  list_pending_submittals: PERMISSIONS.workspaceView,
  // The site and quality queue (issue #799 §23, Wave 7) is the register the same
  // member opens on the project page, so this read adds no reach either.
  list_site_issues: PERMISSIONS.workspaceView,
  draft_expense_from_receipt: PERMISSIONS.financeExpensesManage,
  get_accounting_review: PERMISSIONS.ledgerView,
};

/** Permission required before a proposed action can be shown to the model. */
/** Explicit context for trusted tenant-scoped background/MCP reads. The
 * caller has already passed its own job/connection scope; this set is never
 * exposed to browser turns, which always use effective member permissions. */
export const SYSTEM_AI_READ_PERMISSIONS: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);

export const AI_ACTION_PERMISSION_MAP: Readonly<Partial<Record<ActionType, Permission>>> = {
  "setup.business": PERMISSIONS.settingsManage,
  "setup.accounts": PERMISSIONS.accountsEdit,
  "setup.costing": PERMISSIONS.settingsManage,
  "setup.tax": PERMISSIONS.settingsManage,
  "setup.menu.category": PERMISSIONS.menuEdit,
  "setup.menu.item": PERMISSIONS.menuEdit,
  "menu.item.priceUpdate": PERMISSIONS.menuEdit,
  "menu.item.disable": PERMISSIONS.menuEdit,
  "order.discount.apply": PERMISSIONS.ordersDiscount,
  "inventory.reorder.draftPO": PERMISSIONS.purchasesManage,
  "inventory.adjustment.propose": PERMISSIONS.inventoryAdjust,
  "reservation.create": PERMISSIONS.reservationsManage,
  "reservation.reschedule": PERMISSIONS.reservationsManage,
  "table.merge": PERMISSIONS.tablesManage,
  "courier.assign": PERMISSIONS.deliveryManage,
  "customer.note.add": PERMISSIONS.crmManage,
  "crm.customer.tag": PERMISSIONS.crmManage,
  "crm.customer.note": PERMISSIONS.crmManage,
  "journal.manual.propose": PERMISSIONS.ledgerPropose,
  "expense.categorize": PERMISSIONS.financeExpensesManage,
  "inventory.waste.log": PERMISSIONS.inventoryAdjust,
  "inventory.production.run": PERMISSIONS.inventoryAdjust,
  "menu.item.create": PERMISSIONS.menuEdit,
  "website.post.draft": PERMISSIONS.cmsContentManage,
  "website.post.update": PERMISSIONS.cmsContentManage,
  "website.product.upsert": PERMISSIONS.websiteManage,
  "website.post.publish": PERMISSIONS.cmsPublish,
  "messaging.campaign.trigger": PERMISSIONS.campaignsManage,
  "party.customer.create": PERMISSIONS.partiesManage,
  "party.supplier.create": PERMISSIONS.partiesManage,
  "messaging.campaign.create": PERMISSIONS.campaignsManage,
  "ar.receipt.record": PERMISSIONS.financeReceivablesManage,
  "project.memory.add": PERMISSIONS.workspaceManage,
  "project.task.add": PERMISSIONS.workspaceManage,
};

export function aiToolPermission(name: string): Permission | null {
  return AI_TOOL_PERMISSION_MAP[name] ?? null;
}

export function aiActionPermission(type: ActionType): Permission | null {
  return AI_ACTION_PERMISSION_MAP[type] ?? null;
}

export function canUseAiTool(name: string, permissions: ReadonlySet<Permission>): boolean {
  const required = aiToolPermission(name);
  return required !== null && permissions.has(required);
}

export function allowedAiActions(
  actionTypes: readonly ActionType[],
  permissions: ReadonlySet<Permission>,
): ActionType[] {
  return actionTypes.filter((type) => {
    const required = aiActionPermission(type);
    return required !== null && permissions.has(required);
  });
}

/**
 * Remove domain tools before the request reaches the provider. `propose_action`
 * and `request_input` are protocol tools and are retained here; action enum
 * filtering happens in `runAgentTurn` using AI_ACTION_PERMISSION_MAP.
 */
export function filterAiToolsByPermissions(
  tools: readonly OpenAiTool[],
  permissions: ReadonlySet<Permission>,
): OpenAiTool[] {
  return tools.filter((tool) => {
    const name = tool.function.name;
    if (name === "propose_action" || name === "request_input") return true;
    return canUseAiTool(name, permissions);
  });
}

/** A small, serializable summary for diagnostics and UI capability payloads. */
export function aiCapabilitySnapshot(permissions: ReadonlySet<Permission>) {
  return {
    canUse: permissions.has(PERMISSIONS.aiUse),
    canManage: permissions.has(PERMISSIONS.aiManage),
    canManageAgents: permissions.has(PERMISSIONS.aiAgentsManage),
    canManageAutomations: permissions.has(PERMISSIONS.aiAutomationsManage),
    canManageKnowledge: permissions.has(PERMISSIONS.aiKnowledgeManage),
    canViewUsage: permissions.has(PERMISSIONS.aiUsageView),
    canManageWidgets: permissions.has(PERMISSIONS.aiWidgetsManage),
  };
}
