# Issue #883 — MCP coverage matrix (machine-reviewable)

> GENERATED FILE — do not edit by hand. Regenerate with
> `npx tsx scripts/write-mcp-coverage-matrix.mts` after changing
> `src/lib/mcp/coverage-map.ts`, the registries, or API routes; the matrix
> test fails on drift.
>
> Legend: an operation cell shows the MCP verbs serving it, `(route only)`
> when the HTTP API supports the operation but MCP does not, and `—` when the
> domain has no such operation. Status **covered** means every operation the
> API exposes has an MCP path; **partial** means some do; **MCP gap** means
> none do; **backend gap** means neither side supports it.

Route files scanned: **881**. Rows: tenant **80**, platform **19**.

## Summary of remaining gaps

### Tenant (62)
- **accounting.accounts** (Accounting · Chart of accounts) — partial
- **accounting.entries** (Accounting · Journal entries) — partial
- **accounting.fixed-assets** (Accounting · Fixed assets (register, depreciate, dispose, transfer)) — partial
- **accounting.payroll** (Accounting · Payroll (settings, staff, runs, advances)) — partial
- **accounting.reconciliation** (Accounting · Bank reconciliation) — partial
- **accounting.fiscal** (Accounting · Fiscal years & periods (open/close), readiness) — partial
- **pos.orders** (POS · Orders (open, amend, pay, refund/returns)) — partial
- **pos.kitchen-floor** (POS · Kitchen display / floor / waiter queues) — partial
- **pos.reservations** (POS · Reservations) — partial
- **pos.tables** (POS · Dining tables & table sessions) — MCP gap
- **inventory.items** (Inventory · Stock items & stock levels) — partial
- **inventory.warehouses-transfers** (Inventory · Warehouses, transfers, warehouse documents) — MCP gap
- **inventory.counts** (Inventory · Stock counts / periodic closings / visual count scans) — MCP gap
- **inventory.purchases-suppliers** (Inventory · Purchases, supplier returns, suppliers) — partial
- **inventory.production** (Inventory · Production formulas & runs, modifier recipes) — partial
- **inventory.barcodes** (Inventory · Barcodes (lookup, bulk)) — partial
- **inventory.waste-writedowns** (Inventory · Waste & write-downs) — partial
- **crm.customers** (CRM · Customers (profile, notes, tags, relationships, merge, duplicates, consent)) — partial
- **crm.deals-leads** (CRM · Deals & leads (handoff, convert)) — MCP gap
- **crm.cases-activities** (CRM · Cases & activities) — MCP gap
- **crm.pipelines** (CRM · Pipelines & stages) — MCP gap
- **crm.segments-views** (CRM · Segments, saved views, queues, RFM) — partial
- **crm.config** (CRM · CRM automations, custom fields, audit) — MCP gap
- **crm.overview** (CRM · CRM overview, members, consent state, data quality) — MCP gap
- **crm.loyalty** (CRM · Loyalty programs, store credit, redemptions) — partial
- **growth.settings-campaigns** (Growth · Growth overview, settings, campaign audience, accounting) — partial
- **growth.messaging** (Growth · Messaging rules & templates) — partial
- **growth.promotions** (Growth · Promotions & gift cards (issue, expire, redeem)) — MCP gap
- **cms.posts-products** (Website / CMS · Posts & products (publish, update)) — partial
- **cms.drafts-pages-media** (Website / CMS · Drafts, pages, website media) — MCP gap
- **cms.setup-design-domain** (Website / CMS · Connection, setup/build, design, domain/DNS, CDN) — MCP gap
- **cms.orders** (Website / CMS · Website orders) — MCP gap
- **cms.woocommerce** (Website / CMS · WooCommerce manager (posts, queue, syncs)) — MCP gap
- **workspace.projects** (Workspace · Projects, members, phases) — partial
- **workspace.tasks** (Workspace · Tasks, checklist, dependencies) — partial
- **workspace.calendar-comments** (Workspace · Calendar, comments, documents, templates) — MCP gap
- **workspace.contracts** (Workspace · Contracts & lifecycle) — partial
- **workspace.approvals** (Workspace · Approvals) — partial
- **workspace.aec** (Workspace · AEC registers (RFIs, change orders, payment certificates, submittals, site issues, procurement)) — partial
- **config.settings** (Business config · Business profile & settings (accounts, pricing, tax, logo, MFA policy, print rules/templates/printers, payment methods, online platforms)) — partial
- **config.team** (Business config · Staff, roles & permissions, invitations, credentials, site access) — MCP gap
- **config.branches** (Business config · Branches & locations) — partial
- **config.integrations** (Business config · Integration connections & syncs (Holoo etc.)) — partial
- **config.ai** (Business config · AI config, automations, coworker jobs/templates/review, widgets, memory, conversations, research) — partial
- **config.data** (Business config · Data transfer: entities, exports, imports, schedules, templates, Holoo provider) — MCP gap
- **config.backup** (Business config · Backup & restore (tenant scope)) — MCP gap
- **config.billing** (Business config · Tenant billing (plans/packages, wallet, payments)) — MCP gap
- **config.devices** (Business config · Devices & printing config, pairing) — MCP gap
- **media.assets** (Media · Media assets, folders, collections, AI transforms) — MCP gap
- **knowledge.articles** (Knowledge base · Knowledge articles & search) — MCP gap
- **reports.reports** (Reports · Reports (standard, saved, export, query, drill-down, views)) — partial
- **misc.audit-orders** (Cross-cutting · Audit log, dashboard, commission, deliveries, couriers, business-day, business-info, bug report, industry, security, watch/sessions/rollup) — partial
- **misc.products** (Products (retail) · Product items, attributes, barcode templates) — MCP gap
- **misc.price-lists** (Products (retail) · Price lists & entries (bulk quick-update)) — MCP gap
- **misc.invoices** (Sales · Sales invoices & voids) — MCP gap
- **wire.workspace-overview** (Workspace · Workspace dashboard, insights, lookups, reports, search) — MCP gap
- **vertical_jewelry** (Verticals · Jewelry (items, stones, custom orders, buy-back, layaway, consignors, prices, reports)) — MCP gap
- **vertical_cosmetics** (Verticals · Cosmetics (rot management, suppliers, reports)) — partial
- **vertical_haberdashery** (Verticals · Haberdashery (models, measurements, work orders)) — MCP gap
- **vertical_tools** (Verticals · Tools & fittings (rentals, deposits, reports)) — MCP gap
- **vertical_accessories** (Verticals · Accessories (mobile/PC sale & repair)) — MCP gap
- **vertical_wholesale** (Verticals · Wholesale (files, payments, reports)) — MCP gap

### Platform (17)
- **platform.biz-directory** (Platform — Tenants · Business directory (search, identity, usage, reports)) — partial
- **platform.biz-lifecycle** (Platform — Tenants · Tenant lifecycle (provision, status, suspend, delete)) — partial
- **platform.biz-owner** (Platform — Tenants · Owner & impersonation) — MCP gap
- **platform.biz-features** (Platform — Tenants · Features & app availability) — partial
- **platform.biz-devices** (Platform — Tenants · Tenant devices) — MCP gap
- **platform.billing-plans** (Platform — Billing · Plans & packages (features, rates, settings)) — MCP gap
- **platform.billing-runtime** (Platform — Billing · Subscriptions, invoices, payments, meters, manual review, spend, credits/overrides) — MCP gap
- **platform.billing-config** (Platform — Billing · Billing config, gateway credentials, audit) — MCP gap
- **platform.ai** (Platform — AI · AI config: models, gateway (LiteLLM), modes, prompts, agents, research, widgets) — MCP gap
- **platform.integrations** (Platform — Integrations · Cloud exceptions, messaging, notification/SMS config) — MCP gap
- **platform.cms-sites** (Platform — CMS · CMS sites, deployments, targets, keys) — MCP gap
- **platform.cms-ops** (Platform — CMS · CMS config, runs, sync, infrastructure, theme packages, self tests, billing sync) — MCP gap
- **platform.deploy-ops** (Platform — Ops · Updates/releases, system, observability, overview) — MCP gap
- **platform.backup** (Platform — Ops · Backup config, run, status, peers, tokens, restore) — MCP gap
- **platform.security** (Platform — Security · Audit log, support tickets, admins, platform sessions, pairing) — MCP gap
- **platform.knowledge** (Platform — Content · Knowledge base (platform), media config) — MCP gap
- **platform.cross-business** (Platform — Search & reports · Cross-business search/reporting) — partial

## Tenant realm (posmcp_)

Full CRUD + lifecycle verbs where the domain supports them. The permission column is read from the route files themselves.

Counts — covered: 10 · partial: 32 · MCP gap: 30 · backend gap: 0 · n/a (infra): 7 · duplicate surface: 1

| module | entity | list/search/detail | create | update | delete/lifecycle | bulk/import/export | permission | approval | MCP tool | test | status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Accounting | Chart of accounts<br>_list, create/edit/disable, statement, history_ | list_accounts | account.create | account.disable, account.update | (route only) | — | accounts.edit, ledger.view | connection mode | list_accounts, account.create, account.disable, account.update | integration/ledger.integration.test.ts | partial |
| Accounting | Journal entries<br>_list, detail, reverse (manual drafts covered by journal.manual.propose)_ | list_journal_entries, list_manual_journal_drafts | (route only) | — | journal.draft.approve, journal.draft.reject, journal.manual.propose | — | ledger.approve, ledger.propose, ledger.view | connection mode; step-up (always approve) | list_journal_entries, list_manual_journal_drafts, journal.draft.approve, journal.draft.reject, journal.manual.propose | integration/ledger.integration.test.ts | partial |
| Accounting | Receivables (receipts, aging, customers) | get_ar_aging, list_receipts | ar.receipt.record | — | — | — | finance.receivables_manage, ledger.view | step-up (always approve) | get_ar_aging, list_receipts, ar.receipt.record | integration/expense.integration.test.ts | covered |
| Accounting | Payables (payments, aging, suppliers) | get_ap_upcoming, list_payments | ap.payment.record | — | ap.payment.reverse | — | finance.payables_manage, ledger.approve, ledger.view | step-up (always approve) | get_ap_upcoming, list_payments, ap.payment.record, ap.payment.reverse | integration/expense.integration.test.ts | covered |
| Accounting | Cheques (receivable/payable) | list_cheques | cheque.create | — | cheque.transition | — | finance.cheques_manage, ledger.view | connection mode; step-up (always approve) | list_cheques, cheque.create, cheque.transition | — | covered |
| Accounting | Expenses | get_expense, list_expenses | expense.categorize | — | expense.reverse | — | finance.expenses_manage, ledger.view | step-up (always approve) | get_expense, list_expenses, expense.categorize, expense.reverse | integration/expense.integration.test.ts | covered |
| Accounting | Fixed assets (register, depreciate, dispose, transfer) | list_fixed_assets | fixed-asset.create | (route only) | fixed-asset.depreciate, fixed-asset.dispose | — | finance.assets_manage, ledger.view | connection mode; step-up (always approve) | list_fixed_assets, fixed-asset.create, fixed-asset.depreciate, fixed-asset.dispose | integration/fixed-assets.integration.test.ts | partial |
| Accounting | Payroll (settings, staff, runs, advances) | get_payroll_summary, list_payroll_advances, list_payroll_runs | payroll.advance.record, payroll.run.accrue | (route only) | payroll.advance.void, payroll.run.pay, payroll.run.void | — | payroll.manage, payroll.view | step-up (always approve) | get_payroll_summary, list_payroll_advances, list_payroll_runs, payroll.advance.record, payroll.run.accrue, payroll.advance.void, payroll.run.pay, payroll.run.void | integration/payroll.integration.test.ts | partial |
| Accounting | Bank reconciliation | get_unreconciled_bank_lines, list_reconciliations | reconciliation.create | (route only) | reconciliation.complete | — | finance.reconciliation_manage, ledger.view | connection mode; step-up (always approve) | get_unreconciled_bank_lines, list_reconciliations, reconciliation.create, reconciliation.complete | integration/bank-reconciliation.integration.test.ts | partial |
| Accounting | Fiscal years & periods (open/close), readiness | list_fiscal_years | (route only) | (route only) | (route only) | — | ledger.close_period, ledger.view | — | list_fiscal_years | integration/fiscal-readiness.integration.test.ts | partial |
| Accounting | VAT & trial balance | get_vat_liability, run_report | — | — | — | — | ledger.view | — | get_vat_liability, run_report | integration/ledger.integration.test.ts | covered |
| Accounting | Installment contracts | list_installment_plans | installment.plan.create | — | installment.item.pay | — | finance.installments_manage, ledger.view | connection mode; step-up (always approve) | list_installment_plans, installment.plan.create, installment.item.pay | integration/installments.integration.test.ts | covered |
| Accounting | Ledger overview / settings / shift sales | run_accounting_review | — | — | — | — | ledger.view | — | run_accounting_review | — | covered |
| POS | Orders (open, amend, pay, refund/returns)<br>_amend, pay/settle and returns/refunds stay MCP gaps by design for now: their posting orchestration is inline in the route handlers (COGS, outbox, loyalty, refunds post with about/reversal shape). A money path is only exposed after its orchestration is extracted into a shared service — see issue #883 package 2 follow-ups._ | get_order, get_void_pattern, list_orders | order.create, order.discount.apply | (route only) | (route only) | — | orders.amend_closed, orders.create, orders.view, payments.refund, payments.take, reports.view | connection mode | get_order, get_void_pattern, list_orders, order.create, order.discount.apply | integration/orders.integration.test.ts | partial |
| POS | Shifts (start/end/close, active) | list_shifts | shift.start | — | shift.close, shift.end | — | orders.create, team.manage | connection mode | list_shifts, shift.start, shift.close, shift.end | integration/shifts.integration.test.ts | covered |
| POS | Kitchen display / floor / waiter queues<br>_read-only live queues; writes happen through order item actions_ | get_table_turnover_rate | (route only) | (route only) | (route only) | — | kitchen.view, tables.edit, tables.manage | — | get_table_turnover_rate | — | partial |
| POS | Reservations | get_reservation_conflicts | (route only) | (route only) | (route only) | — | reservations.manage, reservations.view | — | get_reservation_conflicts | integration/reservations.integration.test.ts | partial |
| POS | Dining tables & table sessions | (route only) | (route only) | (route only) | (route only) | — | tables.edit, tables.manage | — | — | — | MCP gap |
| Menu | Menu categories, items, modifier groups, modifiers, reorder | find_items, get_menu_performance, get_menu_tree | menu.category.create, menu.item.create | menu.category.update, menu.item.priceUpdate, menu.item.update | menu.item.disable | — | ledger.view, menu.edit, menu.view | connection mode; step-up (always approve) | find_items, get_menu_performance, get_menu_tree, menu.category.create, menu.item.create, menu.category.update, menu.item.priceUpdate, menu.item.update, menu.item.disable | integration/menu.integration.test.ts | covered |
| Inventory | Stock items & stock levels | forecast_demand, get_stock_valuation | inventory.adjustment.propose | (route only) | (route only) | (route only) | inventory.adjust, inventory.view, parties.manage, purchases.manage | connection mode | forecast_demand, get_stock_valuation, inventory.adjustment.propose | integration/stock.integration.test.ts | partial |
| Inventory | Warehouses, transfers, warehouse documents | (route only) | (route only) | — | (route only) | — | inventory.adjust, inventory.view | — | — | integration/stock.integration.test.ts | MCP gap |
| Inventory | Stock counts / periodic closings / visual count scans | (route only) | (route only) | (route only) | (route only) | — | inventory.adjust, inventory.view | — | — | integration/stock.integration.test.ts | MCP gap |
| Inventory | Purchases, supplier returns, suppliers | get_supplier_performance | inventory.reorder.draftPO | (route only) | (route only) | — | inventory.view, parties.manage, purchases.manage | connection mode | get_supplier_performance, inventory.reorder.draftPO | integration/purchases.integration.test.ts | partial |
| Inventory | Production formulas & runs, modifier recipes | list_formulas, list_production_runs | (route only) | (route only) | inventory.production.run | — | inventory.adjust, inventory.view | step-up (always approve) | list_formulas, list_production_runs, inventory.production.run | integration/production.integration.test.ts | partial |
| Inventory | Barcodes (lookup, bulk) | list_item_barcodes, list_items_without_barcode | barcode.assign | — | — | (route only) | inventory.adjust, inventory.view | connection mode | list_item_barcodes, list_items_without_barcode, barcode.assign | integration/stock.integration.test.ts | partial |
| Inventory | Waste & write-downs | get_waste_history | (route only) | — | (route only) | — | inventory.adjust, inventory.view | — | get_waste_history | integration/stock.integration.test.ts | partial |
| Inventory | stock/* routes<br>_legacy alias of the inventory/* surface_ | (route only) | (route only) | — | (route only) | — | inventory.adjust, inventory.view, purchases.manage | — | — | — | duplicate surface |
| CRM | Customers (profile, notes, tags, relationships, merge, duplicates, consent) | find_customers, get_at_risk_customers, get_customer_profile, get_customer_timeline | crm.customer.note, customer.note.add, party.customer.create, party.supplier.create | crm.customer.tag | (route only) | — | crm.consent_manage, crm.manage, crm.merge, crm.view, ledger.view, parties.manage, parties.view | connection mode | find_customers, get_at_risk_customers, get_customer_profile, get_customer_timeline, crm.customer.note, customer.note.add, party.customer.create, party.supplier.create, crm.customer.tag | integration/parties.integration.test.ts | partial |
| CRM | Deals & leads (handoff, convert) | (route only) | (route only) | (route only) | (route only) | — | crm.manage, crm.view | — | — | integration/crm.integration.test.ts | MCP gap |
| CRM | Cases & activities | (route only) | (route only) | (route only) | (route only) | — | crm.delete, parties.manage, parties.view | — | — | integration/crm.integration.test.ts | MCP gap |
| CRM | Pipelines & stages | (route only) | (route only) | (route only) | — | — | crm.configure | — | — | integration/crm.integration.test.ts | MCP gap |
| CRM | Segments, saved views, queues, RFM | get_repurchase_candidates, list_customer_segments, preview_customer_segment | (route only) | (route only) | (route only) | — | crm.configure, crm.manage, crm.view | — | get_repurchase_candidates, list_customer_segments, preview_customer_segment | integration/crm.integration.test.ts | partial |
| CRM | CRM automations, custom fields, audit | (route only) | (route only) | (route only) | (route only) | — | crm.configure | — | — | integration/crm.integration.test.ts | MCP gap |
| CRM | CRM overview, members, consent state, data quality | (route only) | — | — | — | — | crm.merge, crm.view | — | — | integration/crm.integration.test.ts | MCP gap |
| CRM | Loyalty programs, store credit, redemptions | get_repurchase_candidates | (route only) | — | (route only) | — | loyalty.manage, loyalty.redeem, loyalty.view, store_credit.issue, store_credit.payout | — | get_repurchase_candidates | integration/loyalty.integration.test.ts | partial |
| Growth | Growth overview, settings, campaign audience, accounting | list_message_campaigns, list_message_templates | (route only) | (route only) | — | — | campaigns.manage, growth.view, marketing.configure | — | list_message_campaigns, list_message_templates | integration/crm.integration.test.ts | partial |
| Growth | Messaging rules & templates | list_message_templates | (route only) | — | crm.customer.note | — | campaigns.manage, campaigns.view | connection mode | list_message_templates, crm.customer.note | integration/crm.integration.test.ts | partial |
| Growth | Promotions & gift cards (issue, expire, redeem) | (route only) | (route only) | (route only) | (route only) | — | campaigns.manage, campaigns.view, gift_cards.issue, gift_cards.redeem, gift_cards.view | — | — | integration/giftcards.integration.test.ts | MCP gap |
| Website / CMS | Posts & products (publish, update) | list_website_posts, list_website_products | website.post.draft | website.post.update, website.product.upsert | (route only) | — | cms.content_manage, cms.publish | connection mode | list_website_posts, list_website_products, website.post.draft, website.post.update, website.product.upsert | integration/website.integration.test.ts | partial |
| Website / CMS | Website overview & state | get_website_status | — | — | — | — | cms.view | — | get_website_status | integration/website.integration.test.ts | covered |
| Website / CMS | Order events, revalidate, public website connector endpoints (leads, managers, billing) | (route only) | (route only) | — | (route only) | — | billing.manage, website.view | — | — | — | n/a (infra) |
| Website / CMS | Drafts, pages, website media | (route only) | (route only) | (route only) | (route only) | — | cms.content_manage, cms.publish, cms.view | — | — | integration/website.integration.test.ts | MCP gap |
| Website / CMS | Connection, setup/build, design, domain/DNS, CDN | (route only) | (route only) | (route only) | (route only) | — | cms.configure, cms.view | — | — | integration/website.integration.test.ts | MCP gap |
| Website / CMS | Website orders | — | — | (route only) | — | — | cms.content_manage | — | — | integration/website.integration.test.ts | MCP gap |
| Website / CMS | WooCommerce manager (posts, queue, syncs)<br>_wp-manager content/queue are covered by list_website_*; sync verbs are WP-dashboard operations, not business records_ | (route only) | (route only) | — | (route only) | — | woocommerce.manage, woocommerce.sync, woocommerce.view | — | — | — | MCP gap |
| Workspace | Projects, members, phases | get_workspace_project_status | (route only) | (route only) | (route only) | — | workspace.manage, workspace.view | — | get_workspace_project_status | integration/workspace.integration.test.ts | partial |
| Workspace | Tasks, checklist, dependencies | list_workspace_tasks | (route only) | (route only) | (route only) | — | workspace.manage, workspace.view | — | list_workspace_tasks | integration/workspace.integration.test.ts | partial |
| Workspace | Calendar, comments, documents, templates | (route only) | (route only) | (route only) | (route only) | — | workspace.manage, workspace.view | — | — | integration/workspace.integration.test.ts | MCP gap |
| Workspace | Contracts & lifecycle | list_expiring_contracts | (route only) | (route only) | (route only) | — | workspace.contracts_manage, workspace.view | — | list_expiring_contracts | integration/workspace.integration.test.ts | partial |
| Workspace | Approvals | list_workspace_approvals | (route only) | — | (route only) | — | workspace.approve, workspace.manage, workspace.view | — | list_workspace_approvals | integration/workspace.integration.test.ts | partial |
| Workspace | AEC registers (RFIs, change orders, payment certificates, submittals, site issues, procurement) | get_aec_project_financial_health, get_boq_variance, get_latest_drawing_revision, list_change_orders, list_delayed_project_activities, list_payment_certificates, list_pending_rfis, list_pending_submittals, list_procurement_delays, list_project_commercial_risks, list_site_issues, list_upcoming_milestones | (route only) | (route only) | (route only) | — | settings.manage, workspace.approve, workspace.documents_issue, workspace.manage, workspace.view | — | get_aec_project_financial_health, get_boq_variance, get_latest_drawing_revision, list_change_orders, list_delayed_project_activities, list_payment_certificates, list_pending_rfis, list_pending_submittals, list_procurement_delays, list_project_commercial_risks, list_site_issues, list_upcoming_milestones | — | partial |
| Business config | Business profile & settings (accounts, pricing, tax, logo, MFA policy, print rules/templates/printers, payment methods, online platforms) | get_setup_state | (route only) | (route only) | (route only) | — | accounts.edit, settings.manage | — | get_setup_state | integration/business-settings.integration.test.ts | partial |
| Business config | Staff, roles & permissions, invitations, credentials, site access | (route only) | (route only) | (route only) | (route only) | — | team.manage, team.permissions_manage, team.view | — | — | integration/team.integration.test.ts | MCP gap |
| Business config | Branches & locations | get_branch_comparison | (route only) | (route only) | — | — | locations.manage | — | get_branch_comparison | integration/branch-management.integration.test.ts | partial |
| Business config | Integration connections & syncs (Holoo etc.) | describe_app | (route only) | (route only) | (route only) | — | integrations.manage, integrations.view | — | describe_app | integration/connections.integration.test.ts | partial |
| Business config | WooCommerce webhooks / WordPress event bridges / connections management planes (API keys, desktop, MCP, website)<br>_inbound webhooks and the token-management planes of the API connector families (the panel hosts the UI); the MCP management plane itself is expressly out of scope_ | (route only) | (route only) | (route only) | (route only) | — | integrations.manage, integrations.view, mcp.manage | — | — | — | n/a (infra) |
| Business config | AI config, automations, coworker jobs/templates/review, widgets, memory, conversations, research | get_setup_state, list_coworker_jobs | (route only) | (route only) | (route only) | — | ai.automations.manage, ai.manage, ai.usage.view, ai.use, finance.expenses_manage, settings.manage | — | get_setup_state, list_coworker_jobs | integration/ai-autopilot.integration.test.ts | partial |
| Business config | Data transfer: entities, exports, imports, schedules, templates, Holoo provider | (route only) | (route only) | (route only) | (route only) | (route only) | data.export, data.import, integrations.view | — | — | integration/data-transfer.integration.test.ts | MCP gap |
| Business config | Backup & restore (tenant scope) | (route only) | (route only) | (route only) | (route only) | — | backup.configure, backup.export, backup.manage, backup.restore | — | — | integration/backup.integration.test.ts | MCP gap |
| Business config | Tenant billing (plans/packages, wallet, payments) | (route only) | (route only) | — | (route only) | — | billing.manage, billing.view | — | — | integration/billing.integration.test.ts | MCP gap |
| Business config | Devices & printing config, pairing | (route only) | (route only) | (route only) | (route only) | — | orders.amend_closed, payments.refund, payments.take, printing.execute, settings.manage | — | — | integration/printing.integration.test.ts | MCP gap |
| Business config | Onboarding wizard routes<br>_first-run wizard flow — UI-only; nothing to operate once a business exists_ | (route only) | (route only) | — | (route only) | (route only) | settings.manage | — | — | — | n/a (infra) |
| Media | Media assets, folders, collections, AI transforms | (route only) | (route only) | (route only) | (route only) | — | inventory.view, ledger.view, media.manage, media.view, menu.view, parties.view | — | — | integration/media.integration.test.ts | MCP gap |
| Knowledge base | Knowledge articles & search | (route only) | — | — | — | — | — | — | — | integration/knowledge.integration.test.ts | MCP gap |
| Reports | Reports (standard, saved, export, query, drill-down, views) | list_reports, run_report | (route only) | (route only) | (route only) | (route only) | ledger.view, reports.export, reports.view | — | list_reports, run_report | integration/reports.integration.test.ts | partial |
| Cross-cutting | Audit log, dashboard, commission, deliveries, couriers, business-day, business-info, bug report, industry, security, watch/sessions/rollup<br>_small surfaces; audit-log read is the audit trail_ | describe_app, get_setup_state | (route only) | (route only) | (route only) | — | commission.manage, commission.view, delivery.configure, delivery.manage, inventory.adjust, inventory.view, ledger.close_period, ledger.view | — | describe_app, get_setup_state | integration/security.integration.test.ts | partial |
| Cross-cutting | Support tickets (tenant side) | (route only) | (route only) | (route only) | (route only) | — | — | — | — | — | n/a (infra) |
| Products (retail) | Product items, attributes, barcode templates | (route only) | (route only) | (route only) | (route only) | — | menu.edit, menu.view | — | — | integration/products.integration.test.ts | MCP gap |
| Products (retail) | Price lists & entries (bulk quick-update) | (route only) | (route only) | (route only) | (route only) | — | menu.edit, menu.view | — | — | integration/products.integration.test.ts | MCP gap |
| Sales | Sales invoices & voids | (route only) | (route only) | — | (route only) | — | orders.amend_closed, orders.view, payments.take | — | — | integration/sales.integration.test.ts | MCP gap |
| Workspace | Workspace dashboard, insights, lookups, reports, search | (route only) | — | — | — | — | workspace.view | — | — | integration/workspace.integration.test.ts | MCP gap |
| Cross-cutting | server-sync, sync, peer, pairing, v1, desktop releases/update, mcp management APIs | (route only) | (route only) | (route only) | (route only) | — | team.permissions_manage | — | — | — | n/a (infra) |
| Cross-cutting | tenant auth/session endpoints (login, MFA, OTP, webauthn, step-up, switch business) + OAuth discovery metadata<br>_credential exchange surface — never an AI-callable verb_ | (route only) | (route only) | — | (route only) | — | — | — | — | — | n/a (infra) |
| Verticals | Jewelry (items, stones, custom orders, buy-back, layaway, consignors, prices, reports) | (route only) | (route only) | (route only) | (route only) | — | inventory.adjust, inventory.view, orders.create, reports.view | — | — | integration/jewelry.integration.test.ts | MCP gap |
| Verticals | Cosmetics (rot management, suppliers, reports) | get_near_expiry_items | (route only) | — | — | — | inventory.adjust, inventory.view, reports.view | — | get_near_expiry_items | integration/cosmetics.integration.test.ts | partial |
| Verticals | Haberdashery (models, measurements, work orders) | (route only) | (route only) | — | (route only) | — | inventory.adjust, inventory.view, orders.create, reports.view | — | — | integration/haberdashery.integration.test.ts | MCP gap |
| Verticals | Tools & fittings (rentals, deposits, reports) | (route only) | (route only) | — | (route only) | — | inventory.adjust, inventory.view, orders.create, reports.view | — | — | integration/tools-fittings.integration.test.ts | MCP gap |
| Verticals | Accessories (mobile/PC sale & repair) | (route only) | (route only) | — | (route only) | — | inventory.adjust, inventory.view, orders.create, reports.view | — | — | integration/accessories.integration.test.ts | MCP gap |
| Verticals | Merchandising (displays, perishables) | (route only) | (route only) | — | — | — | inventory.adjust, inventory.view | — | — | — | n/a (infra) |
| Verticals | Wholesale (files, payments, reports) | (route only) | (route only) | — | (route only) | — | inventory.adjust, inventory.view, orders.create, reports.view | — | — | integration/wholesale.integration.test.ts | MCP gap |

## Platform realm (pospmcp_) — Superadmin

Each tool carries a per-tool \`platformCan\` capability re-checked on every call; step-up rules mirror the tenant ones (billing/credits/restore/access/secrets/mass mutation/deletion/financial posting/large exports).

Counts — covered: 0 · partial: 4 · MCP gap: 13 · backend gap: 0 · n/a (infra): 2 · duplicate surface: 0

| module | entity | list/search/detail | create | update | delete/lifecycle | bulk/import/export | permission | approval | MCP tool | test | status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Platform — Tenants | Business directory (search, identity, usage, reports) | get_business_identity, list_businesses | (route only) | (route only) | (route only) | — | — | — | get_business_identity, list_businesses | integration/platform-mcp.integration.test.ts | partial |
| Platform — Tenants | Tenant lifecycle (provision, status, suspend, delete) | (route only) | (route only) | (route only) | set_business_status | — | — | none (capability-managed) | set_business_status | integration/platform-mcp.integration.test.ts | partial |
| Platform — Tenants | Owner & impersonation | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-business-management.integration.test.ts | MCP gap |
| Platform — Tenants | Features & app availability | list_business_features, list_feature_flags | (route only) | (route only) | set_business_feature | — | — | none (capability-managed) | list_business_features, list_feature_flags, set_business_feature | integration/platform-mcp.integration.test.ts | partial |
| Platform — Tenants | Tenant devices | (route only) | (route only) | (route only) | (route only) | — | — | — | — | — | MCP gap |
| Platform — Billing | Plans & packages (features, rates, settings) | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-billing.integration.test.ts | MCP gap |
| Platform — Billing | Subscriptions, invoices, payments, meters, manual review, spend, credits/overrides | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-billing.integration.test.ts | MCP gap |
| Platform — Billing | Billing config, gateway credentials, audit | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-billing.integration.test.ts | MCP gap |
| Platform — AI | AI config: models, gateway (LiteLLM), modes, prompts, agents, research, widgets | (route only) | (route only) | (route only) | — | — | — | — | — | integration/platform-ai.integration.test.ts | MCP gap |
| Platform — Integrations | Cloud exceptions, messaging, notification/SMS config | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-cloud-exceptions.integration.test.ts | MCP gap |
| Platform — CMS | CMS sites, deployments, targets, keys | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-cms.integration.test.ts | MCP gap |
| Platform — CMS | CMS config, runs, sync, infrastructure, theme packages, self tests, billing sync | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-cms.integration.test.ts | MCP gap |
| Platform — Ops | Updates/releases, system, observability, overview | (route only) | (route only) | (route only) | — | — | — | — | — | integration/platform-admin.integration.test.ts | MCP gap |
| Platform — Ops | Backup config, run, status, peers, tokens, restore | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-backup.integration.test.ts | MCP gap |
| Platform — Security | Audit log, support tickets, admins, platform sessions, pairing | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-admin.integration.test.ts | MCP gap |
| Platform — Content | Knowledge base (platform), media config | (route only) | (route only) | (route only) | (route only) | — | — | — | — | integration/platform-knowledge.integration.test.ts | MCP gap |
| Platform — MCP | MCP connections management (console UI + management API)<br>_the management plane of this very feature; mint/list/revoke exist as HTTP+UI, not MCP verbs_ | (route only) | (route only) | — | (route only) | — | — | — | — | — | n/a (infra) |
| Platform — Company | Platform's own company surfaces (CRM, growth, workspace, websites, reports, setup)<br>_the operator-of-record business; its rows use the *tenant* suite, not the platform realm_ | (route only) | (route only) | (route only) | (route only) | — | crm.view, growth.view, ledger.post, ledger.view, team.manage, website.manage, website.view, workspace.manage | — | — | — | n/a (infra) |
| Platform — Search & reports | Cross-business search/reporting | get_business_identity, list_businesses | (route only) | (route only) | (route only) | — | — | — | get_business_identity, list_businesses | — | partial |

## Unclassified routes (not claimed by any row)

_none — every route file belongs to a row_
