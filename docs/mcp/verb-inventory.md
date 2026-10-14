# Issue #883 — MCP verb inventory (machine-reviewable)

> GENERATED FILE — do not edit by hand. Source of truth: `src/lib/mcp/registry.ts`.
> Regenerate with `npx tsx scripts/write-mcp-verb-inventory.mts` after changing
> the registry; the registry test fails while this file and the registry drift.

Current surface: **142 read verbs** (**25** business-wide aggregates —
visible only to connections consented for every branch) and **291 write verbs**
(**79** high-risk, forced through the approval queue even on `apply`-mode connections).

## Read verbs (what `tools/list` may expose subject to grants ∩ permissions)

| MCP tool | app bucket | branch policy | gating permission | enforced by tests |
|---|---|---|---|---|
| `get_setup_state` | pos | agnostic | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_reports` | pos | agnostic | `reports.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `run_report` | pos | pinned | `reports.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_menu_performance` | pos | business_wide | `menu.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_void_pattern` | pos | business_wide | `orders.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_stock_valuation` | pos | business_wide | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_supplier_performance` | pos | business_wide | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_reservation_conflicts` | pos | business_wide | `reservations.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_table_turnover_rate` | pos | business_wide | `reports.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_courier_performance` | pos | business_wide | `delivery.manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `forecast_demand` | pos | business_wide | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_near_expiry_items` | pos | pinned (cosmetics businesses only) | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_staff_commission` | pos | business_wide | `commission.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_waste_history` | pos | business_wide | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `find_items` | pos | pinned | `menu.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `describe_app` | pos | agnostic | `ai.use` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_branch_comparison` | pos | business_wide | `reports.business_wide` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_coworker_jobs` | pos | agnostic | `ai.automations.manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_ar_aging` | accounting | business_wide | `finance.receivables_manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_ap_upcoming` | accounting | business_wide | `finance.payables_manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_unreconciled_bank_lines` | accounting | business_wide | `finance.reconciliation_manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_payroll_summary` | accounting | business_wide | `payroll.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_orders` | pos | agnostic | `orders.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_order` | pos | agnostic | `orders.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_shifts` | pos | agnostic | `team.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_menu_tree` | pos | agnostic | `menu.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_formulas` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_production_runs` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_item_barcodes` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_items_without_barcode` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_customer_notes` | crm | agnostic | `parties.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_activities` | crm | agnostic | `parties.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_automations` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_branches` | workspace | agnostic | `locations.manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_team_members` | workspace | agnostic | `team.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_promotions` | growth | agnostic | `campaigns.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_gift_card_status` | growth | agnostic | `gift_cards.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_backup_status` | workspace | agnostic | `backup.manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_devices` | workspace | agnostic | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_jewelry_items` | pos | pinned | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_cosmetic_items` | pos | pinned (cosmetics businesses only) | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_cosmetic_brands` | pos | pinned (cosmetics businesses only) | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_accessory_items` | pos | pinned (accessories businesses only) | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_trade_goods_items` | pos | pinned | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_data_entities` | workspace | agnostic | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_export_jobs` | workspace | agnostic | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_export_job` | workspace | agnostic | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_import_jobs` | workspace | agnostic | `data.import` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_import_job` | workspace | agnostic | `data.import` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_data_schedules` | workspace | agnostic | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_data_templates` | workspace | agnostic | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_stock_counts` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_stock_count` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_suppliers` | pos | agnostic | `parties.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_workspace_projects` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_workspace_dashboard` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_workspace_insights` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_workspace_project_report` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_workspace_templates` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_workspace_calendar` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_workspace_comments` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_workspace_documents` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_workspace_document` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `search_kb_articles` | workspace | agnostic | `ai.use` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_media_assets` | workspace | agnostic | `media.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_media_asset` | workspace | agnostic | `media.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_cases` | crm | agnostic | `parties.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_inventory_transfers` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_warehouse_documents` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_price_lists` | pos | agnostic | `menu.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_price_list_entries` | pos | agnostic | `menu.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_deals` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_leads` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_pipelines` | crm | agnostic | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_crm_overview` | crm | business_wide | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_crm_data_quality` | crm | business_wide | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_members` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_crm_queue` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_saved_reports` | pos | agnostic | `reports.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_vat_liability` | accounting | business_wide | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `run_accounting_review` | accounting | business_wide | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_accounts` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_journal_entries` | accounting | business_wide | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_manual_journal_drafts` | accounting | agnostic | `ledger.propose` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_expenses` | accounting | business_wide | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_expense` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_receipts` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_payments` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_cheques` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_fixed_assets` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_installment_plans` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_fiscal_years` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_payroll_runs` | accounting | agnostic | `payroll.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_payroll_advances` | accounting | agnostic | `payroll.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_reconciliations` | accounting | business_wide | `finance.reconciliation_manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_customer_profile` | crm | business_wide | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_at_risk_customers` | crm | business_wide | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `find_customers` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_customer_timeline` | crm | business_wide | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_customer_segments` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `preview_customer_segment` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_repurchase_candidates` | crm | pinned | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_message_templates` | growth | agnostic | `campaigns.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_message_campaigns` | growth | agnostic | `campaigns.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_website_posts` | website | agnostic | `cms.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_website_products` | website | agnostic | `cms.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_website_status` | website | agnostic | `website.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_cms_pages` | website | agnostic | `cms.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_cms_media` | website | agnostic | `cms.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_product_attributes` | pos | pinned | `menu.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_media_collections` | workspace | agnostic | `media.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_media_folders` | workspace | agnostic | `media.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_audit_log` | pos | agnostic | `team.manage` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_account_statement` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_fiscal_readiness` | accounting | agnostic | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_barcode_templates` | pos | pinned | `menu.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_sales_invoices` | pos | pinned | `orders.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_wp_queue` | website | agnostic | `woocommerce.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_wp_queue_summary` | website | agnostic | `woocommerce.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_wp_overview` | website | agnostic | `woocommerce.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_website_dns` | website | agnostic | `cms.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_website_cdn` | website | agnostic | `cms.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_kb_catalogue` | workspace | agnostic | `ai.use` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_sales_invoice` | pos | pinned | `orders.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_workspace_project_status` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_workspace_contract` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_custom_fields` | crm | agnostic | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_workspace_tasks` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_expiring_contracts` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_workspace_approvals` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_aec_project_financial_health` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_boq_variance` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_latest_drawing_revision` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_pending_rfis` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_change_orders` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_delayed_project_activities` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_payment_certificates` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_project_commercial_risks` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_procurement_delays` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_upcoming_milestones` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_pending_submittals` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_site_issues` | workspace | agnostic (aec businesses only) | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |

## Write verbs

| MCP tool | actionType | app bucket | risk | approval mode | gating permission | enforced by tests |
|---|---|---|---|---|---|---|
| `write_menu_item_price` | `menu.item.priceUpdate` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_menu_item_availability` | `menu.item.disable` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_order_discount` | `order.discount.apply` | pos | low | connection write_mode | `orders.discount` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_order_amend_apply` | `order.amend.apply` | pos | high | always approval queue (step-up) | `orders.amend_closed` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_order_return_create` | `order.return.create` | pos | high | always approval queue (step-up) | `payments.refund` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_purchase_draft` | `inventory.reorder.draftPO` | pos | low | connection write_mode | `purchases.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_stock_count` | `inventory.adjustment.propose` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_expense` | `expense.categorize` | accounting | high | always approval queue (step-up) | `finance.expenses_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_order_create` | `order.create` | pos | low | connection write_mode | `orders.create` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_shift_start` | `shift.start` | pos | low | connection write_mode | `orders.create` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_shift_end` | `shift.end` | pos | low | connection write_mode | `orders.create` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_shift_close` | `shift.close` | pos | low | connection write_mode | `team.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_production_run` | `inventory.production.run` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_journal_draft` | `journal.manual.propose` | accounting | low | connection write_mode | `ledger.propose` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_account_create` | `account.create` | accounting | low | connection write_mode | `accounts.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_account_update` | `account.update` | accounting | low | connection write_mode | `accounts.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_account_disable` | `account.disable` | accounting | low | connection write_mode | `accounts.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_journal_draft_approve` | `journal.draft.approve` | accounting | high | always approval queue (step-up) | `ledger.approve` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_journal_draft_reject` | `journal.draft.reject` | accounting | low | connection write_mode | `ledger.approve` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_expense_reverse` | `expense.reverse` | accounting | high | always approval queue (step-up) | `finance.expenses_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_ar_receipt_record` | `ar.receipt.record` | accounting | high | always approval queue (step-up) | `finance.receivables_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_ap_payment_record` | `ap.payment.record` | accounting | high | always approval queue (step-up) | `finance.payables_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_ap_payment_reverse` | `ap.payment.reverse` | accounting | high | always approval queue (step-up) | `ledger.approve` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cheque_create` | `cheque.create` | accounting | low | connection write_mode | `finance.cheques_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cheque_transition` | `cheque.transition` | accounting | high | always approval queue (step-up) | `finance.cheques_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_installment_plan_create` | `installment.plan.create` | accounting | low | connection write_mode | `finance.installments_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_installment_item_pay` | `installment.item.pay` | accounting | high | always approval queue (step-up) | `finance.installments_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_reconciliation_create` | `reconciliation.create` | accounting | low | connection write_mode | `finance.reconciliation_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_reconciliation_complete` | `reconciliation.complete` | accounting | high | always approval queue (step-up) | `finance.reconciliation_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payroll_run_accrue` | `payroll.run.accrue` | accounting | high | always approval queue (step-up) | `payroll.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payroll_run_pay` | `payroll.run.pay` | accounting | high | always approval queue (step-up) | `payroll.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payroll_run_void` | `payroll.run.void` | accounting | high | always approval queue (step-up) | `payroll.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payroll_advance_record` | `payroll.advance.record` | accounting | high | always approval queue (step-up) | `payroll.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payroll_advance_void` | `payroll.advance.void` | accounting | high | always approval queue (step-up) | `payroll.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_fixed_asset_create` | `fixed-asset.create` | accounting | low | connection write_mode | `finance.assets_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_fixed_asset_depreciate` | `fixed-asset.depreciate` | accounting | high | always approval queue (step-up) | `finance.assets_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_fixed_asset_dispose` | `fixed-asset.dispose` | accounting | high | always approval queue (step-up) | `finance.assets_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_menu_category_create` | `menu.category.create` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_menu_category_update` | `menu.category.update` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_menu_item_create` | `menu.item.create` | pos | high | always approval queue (step-up) | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_menu_item_update` | `menu.item.update` | pos | high | always approval queue (step-up) | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_barcode_assign` | `barcode.assign` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_party_customer_create` | `party.customer.create` | crm | low | connection write_mode | `parties.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_party_supplier_create` | `party.supplier.create` | crm | low | connection write_mode | `parties.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_project_create` | `project.create` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_project_update` | `project.update` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_project_member_set` | `project.member.set` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_project_member_remove` | `project.member.remove` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_project_phase_create` | `project.phase.create` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_contract_create` | `contract.create` | workspace | low | connection write_mode | `workspace.contracts_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_contract_update` | `contract.update` | workspace | low | connection write_mode | `workspace.contracts_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_contract_delete` | `contract.delete` | workspace | high | always approval queue (step-up) | `workspace.contracts_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_contract_lifecycle` | `contract.lifecycle` | workspace | low | connection write_mode | `workspace.contracts_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_custom_field_save` | `crm.customField.save` | crm | low | connection write_mode | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_custom_field_archive` | `crm.customField.archive` | crm | low | connection write_mode | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_barcode_bulk_mint` | `barcode.bulkMint` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_purchase_update` | `purchase.update` | pos | low | connection write_mode | `purchases.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_purchase_lifecycle` | `purchase.lifecycle` | pos | low | connection write_mode | `purchases.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_purchase_receive` | `purchase.receive` | pos | high | always approval queue (step-up) | `purchases.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_purchase_delete` | `purchase.delete` | pos | high | always approval queue (step-up) | `purchases.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_supplier_update` | `supplier.update` | pos | low | connection write_mode | `purchases.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_supplier_archive` | `supplier.archive` | pos | low | connection write_mode | `purchases.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_table_edit` | `table.edit` | pos | low | connection write_mode | `tables.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_table_status` | `table.status` | pos | low | connection write_mode | `tables.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_table_delete` | `table.delete` | pos | low | connection write_mode | `tables.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_reservation_create` | `reservation.create` | pos | low | connection write_mode | `reservations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_reservation_edit` | `reservation.edit` | pos | low | connection write_mode | `reservations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_reservation_lifecycle` | `reservation.lifecycle` | pos | low | connection write_mode | `reservations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_reservation_delete` | `reservation.delete` | pos | high | always approval queue (step-up) | `reservations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_floor_section_create` | `floor.section.create` | pos | low | connection write_mode | `tables.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_floor_section_update` | `floor.section.update` | pos | low | connection write_mode | `tables.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_floor_section_delete` | `floor.section.delete` | pos | low | connection write_mode | `tables.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_kitchen_item_status` | `kitchen.item.status` | pos | low | connection write_mode | `kitchen.view` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_waste_record` | `waste.record` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_down_create` | `writeDown.create` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_down_reverse` | `writeDown.reverse` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_ai_automation_save` | `ai.automation.save` | workspace | low | connection write_mode | `ai.automations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_ai_automation_delete` | `ai.automation.delete` | workspace | low | connection write_mode | `ai.automations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_ai_automation_run` | `ai.automation.run` | workspace | high | always approval queue (step-up) | `ai.automations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_coworker_job_save` | `coworker.job.save` | workspace | low | connection write_mode | `ai.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_coworker_job_delete` | `coworker.job.delete` | workspace | low | connection write_mode | `ai.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_coworker_job_run` | `coworker.job.run` | workspace | high | always approval queue (step-up) | `ai.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_memory_add` | `memory.add` | workspace | low | connection write_mode | `ai.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_memory_delete` | `memory.delete` | workspace | low | connection write_mode | `ai.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_settings_business_save` | `settings.business.save` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_settings_pricing_save` | `settings.pricing.save` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_settings_tax_save` | `settings.tax.save` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_settings_online_platforms_save` | `settings.onlinePlatforms.save` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_settings_mfa_policy_save` | `settings.mfaPolicy.save` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_settings_accounts_save` | `settings.accounts.save` | accounting | low | connection write_mode | `accounts.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payment_method_create` | `paymentMethod.create` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payment_method_update` | `paymentMethod.update` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payment_method_delete` | `paymentMethod.delete` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payment_method_reorder` | `paymentMethod.reorder` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_printer_create` | `printer.create` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_printer_update` | `printer.update` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_printer_delete` | `printer.delete` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_print_template_save` | `printTemplate.save` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_print_template_delete` | `printTemplate.delete` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_settings_print_rules_save` | `settings.printRules.save` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_integrations_sync_products` | `integrations.sync.products` | workspace | low | connection write_mode | `integrations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_integrations_sync_orders` | `integrations.sync.orders` | workspace | low | connection write_mode | `integrations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_integrations_sync_customers` | `integrations.sync.customers` | workspace | low | connection write_mode | `integrations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_integrations_sync_inventory` | `integrations.sync.inventory` | workspace | low | connection write_mode | `integrations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_integrations_connection_test` | `integrations.connection.test` | workspace | low | connection write_mode | `integrations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_setup_save` | `website.setup.save` | website | low | connection write_mode | `cms.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_design_theme_save` | `website.design.theme.save` | website | low | connection write_mode | `cms.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_cdn_purge` | `website.cdn.purge` | website | low | connection write_mode | `cms.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_product_create` | `website.product.create` | website | low | connection write_mode | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_product_update` | `website.product.update` | website | low | connection write_mode | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_product_delete` | `website.product.delete` | website | high | always approval queue (step-up) | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_post_delete` | `website.post.delete` | website | high | always approval queue (step-up) | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_media_update` | `website.media.update` | website | low | connection write_mode | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_media_delete` | `website.media.delete` | website | high | always approval queue (step-up) | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wp_content_sync` | `wp.content.sync` | website | low | connection write_mode | `woocommerce.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wp_post_save` | `wp.post.save` | website | low | connection write_mode | `woocommerce.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wp_media_create` | `wp.media.create` | website | low | connection write_mode | `woocommerce.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_commission_rule_save` | `commission.rule.save` | crm | low | connection write_mode | `commission.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_commission_rule_set_active` | `commission.rule.setActive` | crm | low | connection write_mode | `commission.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_courier_create` | `courier.create` | pos | low | connection write_mode | `delivery.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_courier_set_active` | `courier.setActive` | pos | low | connection write_mode | `delivery.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_delivery_assign` | `delivery.assign` | pos | low | connection write_mode | `delivery.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_delivery_status_set` | `delivery.status.set` | pos | low | connection write_mode | `delivery.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_business_day_close` | `businessDay.close` | pos | low | connection write_mode | `ledger.close_period` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_business_day_reopen` | `businessDay.reopen` | pos | low | connection write_mode | `ledger.close_period` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_business_day_config_save` | `businessDay.config.save` | pos | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_rollup_push` | `rollup.push` | workspace | low | connection write_mode | `rollup.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_rollup_location_set_active` | `rollup.location.setActive` | workspace | low | connection write_mode | `rollup.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_inventory_item_save` | `inventory.item.save` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_inventory_item_delete` | `inventory.item.delete` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_record_create` | `aec.record.create` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_record_update` | `aec.record.update` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_record_delete` | `aec.record.delete` | workspace | high | always approval queue (step-up) | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_record_action` | `aec.record.action` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_record_review` | `aec.record.review` | workspace | high | always approval queue (step-up) | `workspace.approve` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_contract_commercial_save` | `aec.contract.commercial.save` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_boq_version_save` | `aec.boq.version.save` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_profile_save` | `aec.profile.save` | workspace | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_project_profile_save` | `aec.projectProfile.save` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_participant_add` | `aec.participant.add` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_participant_update` | `aec.participant.update` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_aec_participant_remove` | `aec.participant.remove` | workspace | high | always approval queue (step-up) | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_task_create` | `task.create` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_task_update` | `task.update` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_task_status` | `task.status` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_production_formula_create` | `production.formula.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_production_formula_update` | `production.formula.update` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_production_formula_deactivate` | `production.formula.deactivate` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_production_formulainput_set` | `production.formulaInput.set` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_production_formulainput_delete` | `production.formulaInput.delete` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_document_create` | `workspace.document.create` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_document_update` | `workspace.document.update` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_document_delete` | `workspace.document.delete` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_template_save` | `workspace.template.save` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_template_archive` | `workspace.template.archive` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_event_create` | `workspace.event.create` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_event_update` | `workspace.event.update` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_event_delete` | `workspace.event.delete` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_comment_add` | `workspace.comment.add` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_pricelist_create` | `priceList.create` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_pricelist_rename` | `priceList.rename` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_pricelist_delete` | `priceList.delete` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_pricelist_entries_save` | `priceList.entries.save` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_pricelist_quick_update` | `priceList.quick_update` | pos | high | always approval queue (step-up) | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_transfer_create` | `transfer.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_transfer_ship` | `transfer.ship` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_transfer_receive` | `transfer.receive` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_transfer_cancel` | `transfer.cancel` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_warehouse_document_create` | `warehouseDocument.create` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_case_save` | `crm.case.save` | crm | low | connection write_mode | `parties.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_case_set_status` | `crm.case.set_status` | crm | low | connection write_mode | `parties.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_activity_create` | `crm.activity.create` | crm | low | connection write_mode | `parties.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_activity_update` | `crm.activity.update` | crm | low | connection write_mode | `parties.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_lead_save` | `crm.lead.save` | crm | low | connection write_mode | `crm.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_lead_convert` | `crm.lead.convert` | crm | low | connection write_mode | `crm.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_deal_save` | `crm.deal.save` | crm | low | connection write_mode | `crm.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_deal_move_stage` | `crm.deal.move_stage` | crm | low | connection write_mode | `crm.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_pipeline_create` | `crm.pipeline.create` | crm | low | connection write_mode | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_pipeline_update` | `crm.pipeline.update` | crm | low | connection write_mode | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_report_saved_create` | `report.saved.create` | pos | low | connection write_mode | `reports.view` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_report_saved_update` | `report.saved.update` | pos | low | connection write_mode | `reports.view` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_report_saved_delete` | `report.saved.delete` | pos | low | connection write_mode | `reports.view` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_supplier_return_create` | `supplier.return.create` | pos | high | always approval queue (step-up) | `purchases.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_promotion_upsert` | `promotion.upsert` | growth | low | connection write_mode | `campaigns.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_promotion_toggle` | `promotion.toggle` | growth | low | connection write_mode | `campaigns.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_gift_card_issue` | `gift_card.issue` | growth | high | always approval queue (step-up) | `gift_cards.issue` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_branch_create` | `branch.create` | workspace | high | always approval queue (step-up) | `locations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_branch_update` | `branch.update` | workspace | low | connection write_mode | `locations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_branch_lifecycle` | `branch.lifecycle` | workspace | high | always approval queue (step-up) | `locations.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_note_delete` | `crm.note.delete` | crm | low | connection write_mode | `parties.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_note_pin` | `crm.note.pin` | crm | low | connection write_mode | `parties.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_consent_set` | `crm.consent.set` | crm | high | always approval queue (step-up) | `crm.consent_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_segment_create` | `crm.segment.create` | crm | low | connection write_mode | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_segment_update` | `crm.segment.update` | crm | low | connection write_mode | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_segment_archive` | `crm.segment.archive` | crm | low | connection write_mode | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_automation_toggle` | `crm.automation.toggle` | crm | high | always approval queue (step-up) | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_customer_note` | `customer.note.add` | crm | low | connection write_mode | `crm.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_customer_note` | `crm.customer.note` | crm | low | connection write_mode | `crm.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_customer_tag` | `crm.customer.tag` | crm | low | connection write_mode | `crm.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_post_draft` | `website.post.draft` | website | low | connection write_mode | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_post_update` | `website.post.update` | website | low | connection write_mode | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_product` | `website.product.upsert` | website | low | connection write_mode | `website.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_sales_invoice_void` | `sales.invoice.void` | pos | high | always approval queue (step-up) | `orders.amend_closed` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_order_status` | `website.order.status` | website | high | always approval queue (step-up) | `cms.content_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wp_queue_retry` | `wp.queue.retry` | website | low | connection write_mode | `woocommerce.sync` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wp_queue_retry_all_failed` | `wp.queue.retry_all_failed` | website | low | connection write_mode | `woocommerce.sync` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wp_queue_flush` | `wp.queue.flush` | website | low | connection write_mode | `woocommerce.sync` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_website_domain_set` | `website.domain.set` | website | low | connection write_mode | `cms.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_product_attribute_create` | `product.attribute.create` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_barcode_template_create` | `barcode.template.create` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_media_collection_create` | `media.collection.create` | workspace | low | connection write_mode | `media.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_account_delete` | `account.delete` | accounting | low | connection write_mode | `accounts.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_fixed_asset_set_acquisition` | `fixed-asset.set_acquisition` | accounting | low | connection write_mode | `finance.assets_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payroll_settings_update` | `payroll.settings.update` | accounting | high | always approval queue (step-up) | `payroll.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_payroll_staff_terms` | `payroll.staff.terms` | accounting | high | always approval queue (step-up) | `payroll.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_reconciliation_line_clear` | `reconciliation.line.clear` | accounting | low | connection write_mode | `finance.reconciliation_manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_fiscal_year_create` | `fiscal.year.create` | accounting | high | always approval queue (step-up) | `ledger.close_period` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_fiscal_period_set_status` | `fiscal.period.set_status` | accounting | high | always approval queue (step-up) | `ledger.close_period` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_fiscal_year_close` | `fiscal.year.close` | accounting | high | always approval queue (step-up) | `ledger.close_period` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_journal_entry_reverse` | `journal.entry.reverse` | accounting | high | always approval queue (step-up) | `ledger.approve` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_inventory_count_edit` | `inventory.count.edit` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_inventory_count_reverse` | `inventory.count.reverse` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_messaging_template_save` | `messaging.template.save` | growth | low | connection write_mode | `campaigns.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_messaging_campaign_pause` | `messaging.campaign.pause` | growth | low | connection write_mode | `campaigns.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_messaging_campaign_resume` | `messaging.campaign.resume` | growth | high | always approval queue (step-up) | `campaigns.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_messaging_campaign_launch` | `messaging.campaign.launch` | growth | high | always approval queue (step-up) | `campaigns.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_gift_card_redeem` | `gift_card.redeem` | growth | high | always approval queue (step-up) | `gift_cards.redeem` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_gift_card_expire_run` | `gift_card.expire_run` | growth | high | always approval queue (step-up) | `gift_cards.issue` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_deal_delete` | `crm.deal.delete` | crm | high | always approval queue (step-up) | `crm.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_crm_case_delete` | `crm.case.delete` | crm | high | always approval queue (step-up) | `crm.delete` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_loyalty_points_redeem` | `loyalty.points.redeem` | crm | high | always approval queue (step-up) | `loyalty.redeem` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_loyalty_store_credit_issue` | `loyalty.store_credit.issue` | crm | high | always approval queue (step-up) | `store_credit.issue` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_loyalty_store_credit_use` | `loyalty.store_credit.use` | crm | high | always approval queue (step-up) | `store_credit.payout` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_loyalty_program_upsert` | `loyalty.program.upsert` | crm | low | connection write_mode | `loyalty.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_backup_config_set` | `backup.config.set` | workspace | low | connection write_mode | `backup.configure` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_backup_run_now` | `backup.run_now` | workspace | high | always approval queue (step-up) | `backup.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_backup_restore_apply` | `backup.restore.apply` | workspace | high | always approval queue (step-up) | `backup.restore` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_device_rename` | `device.rename` | workspace | low | connection write_mode | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_device_revoke` | `device.revoke` | workspace | high | always approval queue (step-up) | `settings.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_product_attribute_update` | `product.attribute.update` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_product_attribute_delete` | `product.attribute.delete` | pos | high | always approval queue (step-up) | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_barcode_template_delete` | `barcode.template.delete` | pos | low | connection write_mode | `menu.edit` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_approval_request` | `workspace.approval.request` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_workspace_approval_decide` | `workspace.approval.decide` | workspace | high | always approval queue (step-up) | `workspace.approve` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_item_create` | `jewelry.item.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_item_update` | `jewelry.item.update` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_stone_add` | `jewelry.stone.add` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_stone_delete` | `jewelry.stone.delete` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_item_consign` | `jewelry.item.consign` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_item_sell` | `jewelry.item.sell` | pos | high | always approval queue (step-up) | `orders.create` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_buyback_create` | `jewelry.buyback.create` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_layaway_create` | `jewelry.layaway.create` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_layaway_pay` | `jewelry.layaway.pay` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_layaway_complete` | `jewelry.layaway.complete` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_consignor_payout` | `jewelry.consignor.payout` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_price_record` | `jewelry.price.record` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_jewelry_consignor_create` | `jewelry.consignor.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cosmetics_brand_create` | `cosmetics.brand.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cosmetics_item_create` | `cosmetics.item.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cosmetics_batch_receive` | `cosmetics.batch.receive` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cosmetics_stock_update` | `cosmetics.stock.update` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cosmetics_tester_open` | `cosmetics.tester.open` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cosmetics_profile_update` | `cosmetics.profile.update` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_cosmetics_matrix_create` | `cosmetics.matrix.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_accessories_item_create` | `accessories.item.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_accessories_item_sell` | `accessories.item.sell` | pos | low | connection write_mode | `orders.create` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_accessories_stock_update` | `accessories.stock.update` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wholesale_item_create` | `wholesale.item.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wholesale_item_sell` | `wholesale.item.sell` | pos | low | connection write_mode | `orders.create` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_wholesale_stock_update` | `wholesale.stock.update` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_tools_fittings_item_create` | `tools_fittings.item.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_tools_fittings_item_sell` | `tools_fittings.item.sell` | pos | low | connection write_mode | `orders.create` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_tools_fittings_stock_update` | `tools_fittings.stock.update` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_haberdashery_item_create` | `haberdashery.item.create` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_haberdashery_item_sell` | `haberdashery.item.sell` | pos | low | connection write_mode | `orders.create` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_haberdashery_stock_update` | `haberdashery.stock.update` | pos | low | connection write_mode | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_data_schedule_create` | `data.schedule.create` | workspace | low | connection write_mode | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_data_schedule_update` | `data.schedule.update` | workspace | low | connection write_mode | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_data_schedule_run` | `data.schedule.run` | workspace | low | connection write_mode | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_data_schedule_delete` | `data.schedule.delete` | workspace | low | connection write_mode | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_data_template_create` | `data.template.create` | workspace | low | connection write_mode | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_data_template_update` | `data.template.update` | workspace | low | connection write_mode | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_data_template_delete` | `data.template.delete` | workspace | low | connection write_mode | `data.export` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_data_import_run` | `data.import.run` | workspace | high | always approval queue (step-up) | `data.import` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_table_session_open` | `table.session.open` | pos | low | connection write_mode | `tables.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_table_session_update` | `table.session.update` | pos | low | connection write_mode | `tables.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_media_collection_rename` | `media.collection.rename` | workspace | low | connection write_mode | `media.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_media_collection_delete` | `media.collection.delete` | workspace | low | connection write_mode | `media.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_media_asset_set_collection` | `media.asset.set_collection` | workspace | low | connection write_mode | `media.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_media_asset_trash` | `media.asset.trash` | workspace | low | connection write_mode | `media.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_media_asset_restore` | `media.asset.restore` | workspace | low | connection write_mode | `media.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |

## Deliberate exclusions (not MCP verbs here by design)

- **Coworker-only actions** (`ACTION_CATALOG[*].coworkerOnly === true`) purposefully stay off
  the connector surface; cURL-only tooling is not part of the OAuth/MCP contract.
- **Reads excluded from the dashboard scope** in `ai.ts` — they never become MCP tools.
- **The platform Superadmin realm** (`pospmcp_`) has its own inventory in
  `src/lib/mcp/platform-mcp.ts`'s `PLATFORM_MCP_NPC_TOOL_REGISTRY` (six tools, each gated by
  a per-tool `platformCan` capability re-checked on every call); it is a separate bearer
  family on a separate endpoint and deliberately never appears in this document.
- **`get_write_status`** — the always-available introspection route for a connection's own
  execution and consent state; not a domain verb (see `mcp/consent` and tools tests).

## How a new verb lands here

1. Register it in `src/lib/mcp/registry.ts` with app bucket, branch policy, and (writes)
   risk tier + approval mode.
2. The parity tests in `src/lib/mcp/registry.test.ts` fail until `docs/mcp/verb-inventory.md`
   matches `buildMcpVerbInventory()` again — regenerate, review the diff, commit.
