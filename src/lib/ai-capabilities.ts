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
  // ── Accounting module reads (issue #883 package 2, batch A) ────────────────
  // The route handlers gate the same data on the same keys; the tool map is a
  // mirror, not a second policy. Module writes exist where the *manage* key
  // implies the view (see permission implications in permissions.ts).
  list_accounts: PERMISSIONS.ledgerView,
  list_journal_entries: PERMISSIONS.ledgerView,
  list_manual_journal_drafts: PERMISSIONS.ledgerPropose,
  list_expenses: PERMISSIONS.ledgerView,
  get_expense: PERMISSIONS.ledgerView,
  list_receipts: PERMISSIONS.ledgerView,
  list_payments: PERMISSIONS.ledgerView,
  list_cheques: PERMISSIONS.ledgerView,
  list_fixed_assets: PERMISSIONS.ledgerView,
  list_installment_plans: PERMISSIONS.ledgerView,
  list_fiscal_years: PERMISSIONS.ledgerView,
  list_payroll_runs: PERMISSIONS.payrollView,
  list_payroll_advances: PERMISSIONS.payrollView,
  list_reconciliations: PERMISSIONS.financeReconciliationManage,
  list_orders: PERMISSIONS.ordersView,
  get_order: PERMISSIONS.ordersView,
  // The shifts register lists *other people's* clock-ins; per shift-service's
  // own read gate it is a leader's view, never a till's.
  list_shifts: PERMISSIONS.teamView,
  get_branch_comparison: PERMISSIONS.reportsView,
  forecast_demand: PERMISSIONS.inventoryView,
  get_menu_item_details: PERMISSIONS.menuView,
  // Batch C reads (issue #883): menu tree + barcodes mirror the screens'
  // gates; production lists gate on inventory.view like waste/stock reports.
  get_menu_tree: PERMISSIONS.menuView,
  // Batch D reads — the same gates the CRM screens answer with.
  list_customer_notes: PERMISSIONS.partiesView,
  list_crm_activities: PERMISSIONS.partiesView,
  // list_customer_segments was already mapped; automations is the new read.
  list_crm_automations: PERMISSIONS.crmView,
  // Batch E reads — the routes use locations.manage on branches and
  // team.view on the member list.
  list_branches: PERMISSIONS.locationsManage,
  list_team_members: PERMISSIONS.teamView,
  // Batch F reads — campaigns.view on promotions, giftCards.view on cards.
  list_promotions: PERMISSIONS.campaignsView,
  list_devices: PERMISSIONS.settingsManage,
  // Batch AM read — jewelry weight items table (vertical_jewelry list detail),
  // same gate as every other inventory listing.
  list_jewelry_items: PERMISSIONS.inventoryView,
  // Batch AN reads — vertical boards + brand directory, same inventory gate
  // the screens use on GET.
  list_cosmetic_items: PERMISSIONS.inventoryView,
  list_cosmetic_brands: PERMISSIONS.inventoryView,
  list_accessory_items: PERMISSIONS.inventoryView,
  // Batch AO read — trade-goods board, same inventory gate as its GET routes.
  list_trade_goods_items: PERMISSIONS.inventoryView,
  // Batch AP reads — the data-transfer screens' own gates, engine key copied
  // from each route's dataOwner().
  list_data_entities: PERMISSIONS.dataExport,
  list_export_jobs: PERMISSIONS.dataExport,
  get_export_job: PERMISSIONS.dataExport,
  list_import_jobs: PERMISSIONS.dataImport,
  get_import_job: PERMISSIONS.dataImport,
  list_data_schedules: PERMISSIONS.dataExport,
  list_data_templates: PERMISSIONS.dataExport,
  // Batch AQ read — contract detail, same gate as its GET route.
  get_workspace_contract: PERMISSIONS.workspaceView,
  // Batch AR read — the CRM configurator's field directory.
  list_custom_fields: PERMISSIONS.crmConfigure,
  get_backup_status: PERMISSIONS.backupManage,
  get_gift_card_status: PERMISSIONS.giftCardsView,
  // Batch G reads — inventory.view on counts (the screen's GET gate), the
  // parties directory needs suppliersPage-style inventory view like its route
  // (/api/inventory/purchases tenant-of-purchases-view; here suppliers read
  // mirrors parties.view from the party screens).
  list_stock_counts: PERMISSIONS.inventoryView,
  get_stock_count: PERMISSIONS.inventoryView,
  list_suppliers: PERMISSIONS.partiesView,
  // Batch H — workspace.view on the project list (the screen's GET gate).
  list_workspace_projects: PERMISSIONS.workspaceView,
  // Batch K1 — the routes' own gates: deals/leads read on crmView, writes on
  // crmManage, pipeline configuration on crmConfigure.
  // Batch K3 — the cases route checks partiesView, its writes partiesManage.
  // Batch L — both routes read on inventoryView, write on inventoryAdjust.
  // Batch M — exactly the routes: menuView to look, menuEdit to move prices.
  // Batch N1 — every one of these routes checks workspaceView.
  get_workspace_dashboard: PERMISSIONS.workspaceView,
  get_workspace_insights: PERMISSIONS.workspaceView,
  get_workspace_project_report: PERMISSIONS.workspaceView,
  list_workspace_templates: PERMISSIONS.workspaceView,
  // Batch N2a — routes: calendar/comments read on workspaceView, write on
  // workspaceManage.
  // Batch N2b
  list_workspace_documents: PERMISSIONS.workspaceView,
  get_workspace_document: PERMISSIONS.workspaceView,
  list_workspace_calendar: PERMISSIONS.workspaceView,
  list_workspace_comments: PERMISSIONS.workspaceView,
  list_price_lists: PERMISSIONS.menuView,
  list_price_list_entries: PERMISSIONS.menuView,
  list_inventory_transfers: PERMISSIONS.inventoryView,
  list_warehouse_documents: PERMISSIONS.inventoryView,
  list_crm_cases: PERMISSIONS.partiesView,
  list_crm_deals: PERMISSIONS.crmView,
  list_crm_leads: PERMISSIONS.crmView,
  list_crm_pipelines: PERMISSIONS.crmConfigure,
  // K2 addendum — every one of these routes checks crmView itself.
  get_crm_overview: PERMISSIONS.crmView,
  // GET /api/crm/quality checks crmView (merge-level power is only for
  // POST /quality/merge, which is not exposed).
  get_crm_data_quality: PERMISSIONS.crmView,
  list_crm_members: PERMISSIONS.crmView,
  get_crm_queue: PERMISSIONS.crmView,
  // Batch J — reports.view, the gate POST /api/reports/saved itself enforces.
  list_saved_reports: PERMISSIONS.reportsView,
  // Batch O — the CMS content screens' read gates.
  list_cms_pages: PERMISSIONS.cmsView,
  list_cms_media: PERMISSIONS.cmsView,
  // Batch V — product masters ride the menu/price-list branch pins.
  list_product_attributes: PERMISSIONS.menuView,
  // Batch X — mirrors the media library screens' gates.
  list_media_collections: PERMISSIONS.mediaView,
  list_media_folders: PERMISSIONS.mediaView,
  // Batch W — the audit-trail screen's own gate (who did what, business-wide).
  list_audit_log: PERMISSIONS.teamManage,
  // Batch Y — the chart-of-accounts statement screen's gate.
  get_account_statement: PERMISSIONS.ledgerView,
  // Batch Z4 — what the close-readiness screen needs to answer first.
  get_fiscal_readiness: PERMISSIONS.ledgerView,
  list_barcode_templates: PERMISSIONS.menuView,
  // Batch Q — the sales-invoice screens' read gate.
  list_sales_invoices: PERMISSIONS.ordersView,
  get_sales_invoice: PERMISSIONS.ordersView,
  // Batch S — the WooCommerce manager screens' read gates.
  list_wp_queue: PERMISSIONS.woocommerceView,
  get_wp_queue_summary: PERMISSIONS.woocommerceView,
  get_wp_overview: PERMISSIONS.woocommerceView,
  // Batch T — the website infra reads.
  get_website_dns: PERMISSIONS.cmsView,
  get_website_cdn: PERMISSIONS.cmsView,
  // Batch I — the KB centre is member-wide (requireMember): the ai.use key
  // is the connection's own "may read assistant-side material" baseline, and
  // the same gate that lets the assistant itself read the centre. Media
  // library mirrors the library screen (media.view).
  search_kb_articles: PERMISSIONS.aiUse,
  list_kb_catalogue: PERMISSIONS.aiUse,
  list_media_assets: PERMISSIONS.mediaView,
  get_media_asset: PERMISSIONS.mediaView,
  list_formulas: PERMISSIONS.inventoryView,
  list_production_runs: PERMISSIONS.inventoryView,
  list_item_barcodes: PERMISSIONS.inventoryView,
  list_items_without_barcode: PERMISSIONS.inventoryView,
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
  "table.merge": PERMISSIONS.tablesManage,
  "courier.assign": PERMISSIONS.deliveryManage,
  "customer.note.add": PERMISSIONS.crmManage,
  "crm.customer.tag": PERMISSIONS.crmManage,
  // Batch D — notes activities follow the notes screen (parties manage),
  // consent the consent drawer (crm.consent_manage), segments/automechanics
  // the configure gate the routes themselves use.
  // Batch H — workspace.manage, the gate the project/task screens share.
  "project.create": PERMISSIONS.workspaceManage,
  "project.update": PERMISSIONS.workspaceManage,
  "task.create": PERMISSIONS.workspaceManage,
  "task.update": PERMISSIONS.workspaceManage,
  "task.status": PERMISSIONS.workspaceManage,
  // Batch D — the production routes all gate on inventoryAdjust.
  "production.formula.create": PERMISSIONS.inventoryAdjust,
  "production.formula.update": PERMISSIONS.inventoryAdjust,
  "production.formula.deactivate": PERMISSIONS.inventoryAdjust,
  "production.formulaInput.set": PERMISSIONS.inventoryAdjust,
  "production.formulaInput.delete": PERMISSIONS.inventoryAdjust,
  "workspace.document.create": PERMISSIONS.workspaceManage,
  "workspace.document.update": PERMISSIONS.workspaceManage,
  "workspace.document.delete": PERMISSIONS.workspaceManage,
  "workspace.template.save": PERMISSIONS.workspaceManage,
  "workspace.template.archive": PERMISSIONS.workspaceManage,
  "workspace.event.create": PERMISSIONS.workspaceManage,
  "workspace.approval.request": PERMISSIONS.workspaceManage,
  "workspace.approval.decide": PERMISSIONS.workspaceApprove,
  "jewelry.item.create": PERMISSIONS.inventoryAdjust,
  "jewelry.item.update": PERMISSIONS.inventoryAdjust,
  "jewelry.stone.add": PERMISSIONS.inventoryAdjust,
  "jewelry.stone.delete": PERMISSIONS.inventoryAdjust,
  "jewelry.item.consign": PERMISSIONS.inventoryAdjust,
  "jewelry.item.sell": PERMISSIONS.ordersCreate,
  "jewelry.buyback.create": PERMISSIONS.inventoryAdjust,
  "jewelry.layaway.create": PERMISSIONS.inventoryAdjust,
  "jewelry.layaway.pay": PERMISSIONS.inventoryAdjust,
  "jewelry.layaway.complete": PERMISSIONS.inventoryAdjust,
  "jewelry.consignor.payout": PERMISSIONS.inventoryAdjust,
  "jewelry.price.record": PERMISSIONS.inventoryAdjust,
  // Batch AM — consignor directory creation rides the same inventory gate as
  // the rest of the jewelry write surface.
  "jewelry.consignor.create": PERMISSIONS.inventoryAdjust,
  // Batch AN — the vertical write gates, copied from the routes.
  "cosmetics.brand.create": PERMISSIONS.inventoryAdjust,
  "cosmetics.item.create": PERMISSIONS.inventoryAdjust,
  "cosmetics.batch.receive": PERMISSIONS.inventoryAdjust,
  "cosmetics.stock.update": PERMISSIONS.inventoryAdjust,
  "cosmetics.tester.open": PERMISSIONS.inventoryAdjust,
  "cosmetics.profile.update": PERMISSIONS.inventoryAdjust,
  "cosmetics.matrix.create": PERMISSIONS.inventoryAdjust,
  "accessories.item.create": PERMISSIONS.inventoryAdjust,
  // The sale lane is gated like the sell screen, not the stock room.
  "accessories.item.sell": PERMISSIONS.ordersCreate,
  "accessories.stock.update": PERMISSIONS.inventoryAdjust,
  // Batch AO — the trade-goods write guards, copied from trade-goods-routes.ts
  // callers: stock lanes inventoryAdjust, the sale lanes ordersCreate.
  "wholesale.item.create": PERMISSIONS.inventoryAdjust,
  "wholesale.stock.update": PERMISSIONS.inventoryAdjust,
  "wholesale.item.sell": PERMISSIONS.ordersCreate,
  "tools_fittings.item.create": PERMISSIONS.inventoryAdjust,
  "tools_fittings.stock.update": PERMISSIONS.inventoryAdjust,
  "tools_fittings.item.sell": PERMISSIONS.ordersCreate,
  "haberdashery.item.create": PERMISSIONS.inventoryAdjust,
  "haberdashery.stock.update": PERMISSIONS.inventoryAdjust,
  "haberdashery.item.sell": PERMISSIONS.ordersCreate,
  // Batch AP — data-transfer writes. The engine key is copied from the
  // routes' dataOwner(); the executor additionally re-enforces the route's
  // second key (the entity's own permission + the mapping kind's engine).
  "data.schedule.create": PERMISSIONS.dataExport,
  "data.schedule.update": PERMISSIONS.dataExport,
  "data.schedule.run": PERMISSIONS.dataExport,
  "data.schedule.delete": PERMISSIONS.dataExport,
  "data.template.create": PERMISSIONS.dataExport,
  "data.template.update": PERMISSIONS.dataExport,
  "data.template.delete": PERMISSIONS.dataExport,
  "data.import.run": PERMISSIONS.dataImport,
  // Batch AQ — workspace lanes, each behind the route's own engine key.
  "project.member.set": PERMISSIONS.workspaceManage,
  "project.member.remove": PERMISSIONS.workspaceManage,
  "project.phase.create": PERMISSIONS.workspaceManage,
  "contract.create": PERMISSIONS.workspaceContractsManage,
  "contract.update": PERMISSIONS.workspaceContractsManage,
  "contract.delete": PERMISSIONS.workspaceContractsManage,
  "contract.lifecycle": PERMISSIONS.workspaceContractsManage,
  // Batch AR — CRM custom fields, the route's crmConfigure gate.
  "crm.customField.save": PERMISSIONS.crmConfigure,
  "crm.customField.archive": PERMISSIONS.crmConfigure,
  // Batch AS — barcode bulk mint, the route's inventoryAdjust gate.
  "barcode.bulkMint": PERMISSIONS.inventoryAdjust,
  // Batch AT — purchases & suppliers all sit behind purchasesManage.
  "purchase.update": PERMISSIONS.purchasesManage,
  "purchase.lifecycle": PERMISSIONS.purchasesManage,
  "purchase.receive": PERMISSIONS.purchasesManage,
  "purchase.delete": PERMISSIONS.purchasesManage,
  "supplier.update": PERMISSIONS.purchasesManage,
  "supplier.archive": PERMISSIONS.purchasesManage,
  // Batch AV — floor-plan structure vs operational status, the routes' two keys.
  "table.edit": PERMISSIONS.tablesEdit,
  "table.delete": PERMISSIONS.tablesEdit,
  "table.status": PERMISSIONS.tablesManage,
  // Batch AW — every reservation lane rides the same key the routes use;
  // create/reschedule joined the map earlier (the legacy autopilot entries);
  // reschedule stays mapped because the Wave-2 prompt still lists it.
  "reservation.reschedule": PERMISSIONS.reservationsManage,
  "reservation.edit": PERMISSIONS.reservationsManage,
  "reservation.lifecycle": PERMISSIONS.reservationsManage,
  "reservation.delete": PERMISSIONS.reservationsManage,
  // Batch AX — sections are floor-plan config; bumps stay behind kitchenView.
  "floor.section.create": PERMISSIONS.tablesEdit,
  "floor.section.update": PERMISSIONS.tablesEdit,
  "floor.section.delete": PERMISSIONS.tablesEdit,
  "kitchen.item.status": PERMISSIONS.kitchenView,
  // Batch AY — waste & write-downs are ledger postings behind inventoryAdjust.
  "waste.record": PERMISSIONS.inventoryAdjust,
  "writeDown.create": PERMISSIONS.inventoryAdjust,
  "writeDown.reverse": PERMISSIONS.inventoryAdjust,
  "workspace.event.update": PERMISSIONS.workspaceManage,
  "workspace.event.delete": PERMISSIONS.workspaceManage,
  "workspace.comment.add": PERMISSIONS.workspaceManage,
  "priceList.create": PERMISSIONS.menuEdit,
  "priceList.rename": PERMISSIONS.menuEdit,
  "priceList.delete": PERMISSIONS.menuEdit,
  "priceList.entries.save": PERMISSIONS.menuEdit,
  "sales.invoice.void": PERMISSIONS.ordersAmendClosed,
  "website.order.status": PERMISSIONS.cmsContentManage,
  "website.domain.set": PERMISSIONS.cmsConfigure,
  "product.attribute.create": PERMISSIONS.menuEdit,
  "barcode.template.create": PERMISSIONS.menuEdit,
  "media.collection.create": PERMISSIONS.mediaManage,
  "account.delete": PERMISSIONS.accountsEdit,
  "fixed-asset.set_acquisition": PERMISSIONS.financeAssetsManage,
  "payroll.settings.update": PERMISSIONS.payrollManage,
  "payroll.staff.terms": PERMISSIONS.payrollManage,
  "reconciliation.line.clear": PERMISSIONS.financeReconciliationManage,
  "fiscal.year.create": PERMISSIONS.ledgerClosePeriod,
  "fiscal.period.set_status": PERMISSIONS.ledgerClosePeriod,
  "fiscal.year.close": PERMISSIONS.ledgerClosePeriod,
  // Same trust as approving a draft — the route's own comment; the screen
  // gates its button on ledger.approve too.
  "journal.entry.reverse": PERMISSIONS.ledgerApprove,
  "inventory.count.edit": PERMISSIONS.inventoryAdjust,
  "inventory.count.reverse": PERMISSIONS.inventoryAdjust,
  "messaging.template.save": PERMISSIONS.campaignsManage,
  "messaging.campaign.pause": PERMISSIONS.campaignsManage,
  "messaging.campaign.resume": PERMISSIONS.campaignsManage,
  "messaging.campaign.launch": PERMISSIONS.campaignsManage,
  "gift_card.redeem": PERMISSIONS.giftCardsRedeem,
  "gift_card.expire_run": PERMISSIONS.giftCardsIssue,
  "crm.deal.move_stage": PERMISSIONS.crmManage,
  "crm.deal.delete": PERMISSIONS.crmManage,
  "crm.case.delete": PERMISSIONS.crmDelete,
  "loyalty.points.redeem": PERMISSIONS.loyaltyRedeem,
  "loyalty.store_credit.issue": PERMISSIONS.storeCreditIssue,
  "loyalty.store_credit.use": PERMISSIONS.storeCreditPayout,
  "loyalty.program.upsert": PERMISSIONS.loyaltyManage,
  "backup.config.set": PERMISSIONS.backupConfigure,
  "backup.run_now": PERMISSIONS.backupManage,
  "backup.restore.apply": PERMISSIONS.backupRestore,
  "device.rename": PERMISSIONS.settingsManage,
  "device.revoke": PERMISSIONS.settingsManage,
  "product.attribute.update": PERMISSIONS.menuEdit,
  "product.attribute.delete": PERMISSIONS.menuEdit,
  "barcode.template.delete": PERMISSIONS.menuEdit,
  "table.session.open": PERMISSIONS.tablesManage,
  "table.session.update": PERMISSIONS.tablesManage,
  "media.collection.rename": PERMISSIONS.mediaManage,
  "media.collection.delete": PERMISSIONS.mediaManage,
  "media.asset.set_collection": PERMISSIONS.mediaManage,
  "media.asset.trash": PERMISSIONS.mediaManage,
  "media.asset.restore": PERMISSIONS.mediaManage,
  "wp.queue.retry": PERMISSIONS.woocommerceSync,
  "wp.queue.retry_all_failed": PERMISSIONS.woocommerceSync,
  "wp.queue.flush": PERMISSIONS.woocommerceSync,
  "priceList.quick_update": PERMISSIONS.menuEdit,
  "transfer.create": PERMISSIONS.inventoryAdjust,
  "transfer.ship": PERMISSIONS.inventoryAdjust,
  "transfer.receive": PERMISSIONS.inventoryAdjust,
  "transfer.cancel": PERMISSIONS.inventoryAdjust,
  "warehouseDocument.create": PERMISSIONS.inventoryAdjust,
  "crm.case.save": PERMISSIONS.partiesManage,
  "crm.case.set_status": PERMISSIONS.partiesManage,
  "crm.activity.create": PERMISSIONS.partiesManage,
  "crm.activity.update": PERMISSIONS.partiesManage,
  "crm.lead.save": PERMISSIONS.crmManage,
  "crm.lead.convert": PERMISSIONS.crmManage,
  "crm.deal.save": PERMISSIONS.crmManage,
  "crm.pipeline.create": PERMISSIONS.crmConfigure,
  "crm.pipeline.update": PERMISSIONS.crmConfigure,
  "report.saved.create": PERMISSIONS.reportsView,
  "report.saved.update": PERMISSIONS.reportsView,
  "report.saved.delete": PERMISSIONS.reportsView,
  "supplier.return.create": PERMISSIONS.purchasesManage,
  "promotion.upsert": PERMISSIONS.campaignsManage,
  "promotion.toggle": PERMISSIONS.campaignsManage,
  "gift_card.issue": PERMISSIONS.giftCardsIssue,
  "branch.create": PERMISSIONS.locationsManage,
  "branch.update": PERMISSIONS.locationsManage,
  "branch.lifecycle": PERMISSIONS.locationsManage,
  "crm.note.delete": PERMISSIONS.partiesManage,
  "crm.note.pin": PERMISSIONS.partiesManage,
  "crm.consent.set": PERMISSIONS.crmConsentManage,
  "crm.segment.create": PERMISSIONS.crmConfigure,
  "crm.segment.update": PERMISSIONS.crmConfigure,
  "crm.segment.archive": PERMISSIONS.crmConfigure,
  "crm.automation.toggle": PERMISSIONS.crmConfigure,
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
  // Issue #883 package 2, batch A — accounting writes. Each is the same
  // permission its route handler enforces on POST/PATCH.
  "account.create": PERMISSIONS.accountsEdit,
  "account.update": PERMISSIONS.accountsEdit,
  "account.disable": PERMISSIONS.accountsEdit,
  "journal.draft.approve": PERMISSIONS.ledgerApprove,
  "journal.draft.reject": PERMISSIONS.ledgerApprove,
  "expense.reverse": PERMISSIONS.financeExpensesManage,
  "ap.payment.record": PERMISSIONS.financePayablesManage,
  "ap.payment.reverse": PERMISSIONS.ledgerApprove,
  "cheque.create": PERMISSIONS.financeChequesManage,
  "cheque.transition": PERMISSIONS.financeChequesManage,
  "installment.plan.create": PERMISSIONS.financeInstallmentsManage,
  "installment.item.pay": PERMISSIONS.financeInstallmentsManage,
  "reconciliation.create": PERMISSIONS.financeReconciliationManage,
  "reconciliation.complete": PERMISSIONS.financeReconciliationManage,
  "payroll.run.accrue": PERMISSIONS.payrollManage,
  "payroll.run.pay": PERMISSIONS.payrollManage,
  "payroll.run.void": PERMISSIONS.payrollManage,
  "payroll.advance.record": PERMISSIONS.payrollManage,
  "payroll.advance.void": PERMISSIONS.payrollManage,
  "fixed-asset.create": PERMISSIONS.financeAssetsManage,
  "fixed-asset.depreciate": PERMISSIONS.financeAssetsManage,
  "fixed-asset.dispose": PERMISSIONS.financeAssetsManage,
  // Batch B — POS operations; the same key the route handler requires.
  "order.create": PERMISSIONS.ordersCreate,
  "shift.start": PERMISSIONS.ordersCreate,
  "shift.end": PERMISSIONS.ordersCreate,
  "shift.close": PERMISSIONS.teamManage,
  // Batch C — same key as the route gates. Categories/items follow the menu
  // designer (menu.edit); barcode assignment follows the barcode screen
  // (inventory.uniforms → inventory.manage on the route) — permissions.ts
  // comment block at inventoryManage is the authority here.
  "menu.category.create": PERMISSIONS.menuEdit,
  "menu.category.update": PERMISSIONS.menuEdit,
  "menu.item.update": PERMISSIONS.menuEdit,
  // Route /api/inventory/barcodes POST gates on inventory.adjust.
  "barcode.assign": PERMISSIONS.inventoryAdjust,
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
    canManageAutomations: permissions.has(PERMISSIONS.aiAutomationsManage),
    canViewUsage: permissions.has(PERMISSIONS.aiUsageView),
  };
}
