# Issue #883 — MCP verb inventory (machine-reviewable)

> GENERATED FILE — do not edit by hand. Source of truth: `src/lib/mcp/registry.ts`.
> Regenerate with `npx tsx scripts/write-mcp-verb-inventory.mts` after changing
> the registry; the registry test fails while this file and the registry drift.

Current surface: **92 read verbs** (**23** business-wide aggregates —
visible only to connections consented for every branch) and **76 write verbs**
(**25** high-risk, forced through the approval queue even on `apply`-mode connections).

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
| `get_staff_commission` | pos | business_wide | `payroll.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_waste_history` | pos | business_wide | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `find_items` | pos | pinned | `menu.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `describe_app` | pos | agnostic | `ai.use` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_branch_comparison` | pos | business_wide | `reports.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
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
| `list_stock_counts` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_stock_count` | pos | agnostic | `inventory.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_suppliers` | pos | agnostic | `parties.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_workspace_projects` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `search_kb_articles` | workspace | agnostic | `ai.use` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_media_assets` | workspace | agnostic | `media.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_media_asset` | workspace | agnostic | `media.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_deals` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_leads` | crm | agnostic | `crm.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_crm_pipelines` | crm | agnostic | `crm.configure` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
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
| `list_website_posts` | website | agnostic | `website.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `list_website_products` | website | agnostic | `website.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_website_status` | website | agnostic | `website.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `get_workspace_project_status` | workspace | agnostic | `workspace.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
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
| `write_task_create` | `task.create` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_task_update` | `task.update` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_task_status` | `task.status` | workspace | low | connection write_mode | `workspace.manage` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
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
