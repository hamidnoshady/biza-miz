/**
 * Issue #883 (wave 2) — the capability register: one machine-reviewable place
 * that says, for every MCP tool, WHICH app it belongs to, how it relates to
 * branches, and how dangerous it is. `tools.ts` used to know only "read or
 * write"; the granular-grants work (issue #883 §1) needs the answers the
 * code used to leave implicit:
 *
 *   * **app** — the grant bucket the tool lands in (see grants.ts). A
 *     connection granted "CRM read" sees the CRM rows only.
 *   * **branchPolicy** — how the tool's content behaves across branches:
 *       - `agnostic`      no branch dimension at all (setup state, catalogues,
 *                         app overview) — same answer whatever the branch;
 *       - `business_wide` the answer AGGREGATES across branches (P&L, branch
 *                         comparison). Consent for a *subset* of branches can
 *                         never be honoured here — answering it would leak the
 *                         branches the owner did NOT consent to — so the tool
 *                         is visible only to connections whose branch consent
 *                         covers every branch (grants.branches === "all");
 *       - `pinned`        branch-scoped by design: the executor resolves a
 *                         single branch (primary location today) and the MCP
 *                         layer overrides it with the consented branch set.
 *   * **risk / approval** — writes only. `risk: "high"` + `approval:
 *     "always_approve"` is the issue's step-up rule: sensitive financial
 *     postings (an expense written into the books, a production run posting
 *     ledger + stock) ALWAYS land in the approval queue, even on an
 *     `apply`-mode connection. Nothing here ever removes the human from a
 *     path today's catalogue keeps; step-up only ever adds one.
 *
 * Parity is enforced by `registry.test.ts` (in CI via `npm run test:unit`):
 * every read tool the catalogue exposes and every executor-backed write must
 * have exactly one entry here, and every entry must resolve to a live tool —
 * so a new feature that ships an AI tool is forced to name its grant bucket,
 * branch behaviour and risk before it goes green. That is the issue's
 * "CI parity enforcement" requirement.
 */
import type { McpApp } from "./grants";

export type McpBranchPolicy = "agnostic" | "business_wide" | "pinned";

export type McpRisk = "low" | "high";

export interface McpReadRegistryEntry {
  name: string;
  kind: "read";
  app: McpApp;
  branchPolicy: McpBranchPolicy;
  /** The tool runs only for certain trades (refuses politely otherwise). */
  module?: "cosmetics" | "aec";
}

export interface McpWriteRegistryEntry {
  /** actionType — the canonical write identity (see ACTION_CATALOG / WRITE_TOOL_SPECS). */
  actionType: string;
  kind: "write";
  app: McpApp;
  risk: McpRisk;
  /** "mode" follows the connection's write_mode; "always_approve" is step-up. */
  approval: "mode" | "always_approve";
}

export type McpRegistryEntry = McpReadRegistryEntry | McpWriteRegistryEntry;

// ---------------------------------------------------------------------------
// Read tools — one row per name the MCP catalogue can expose.
// ---------------------------------------------------------------------------

export const MCP_READ_REGISTRY: readonly McpReadRegistryEntry[] = [
  // ---- POS (operations) ----
  { name: "get_setup_state", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_reports", kind: "read", app: "pos", branchPolicy: "agnostic" },
  // trade reports resolve ONE branch; P&L/balance-sheet aggregate every branch —
  // the executor enforces the second half when the connection is branch-pinned.
  { name: "run_report", kind: "read", app: "pos", branchPolicy: "pinned" },
  { name: "get_menu_performance", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "get_void_pattern", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "get_stock_valuation", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "get_supplier_performance", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "get_reservation_conflicts", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "get_table_turnover_rate", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "get_courier_performance", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "forecast_demand", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "get_near_expiry_items", kind: "read", app: "pos", branchPolicy: "pinned", module: "cosmetics" },
  { name: "get_staff_commission", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "get_waste_history", kind: "read", app: "pos", branchPolicy: "business_wide" },
  { name: "find_items", kind: "read", app: "pos", branchPolicy: "pinned" },
  { name: "describe_app", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "get_branch_comparison", kind: "read", app: "pos", branchPolicy: "business_wide" },
  // The coworker's standing jobs are operations config; the permission map
  // already gates them to aiAutomationsManage holders.
  { name: "list_coworker_jobs", kind: "read", app: "pos", branchPolicy: "agnostic" },

  // ---- Accounting ----
  { name: "get_ar_aging", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  { name: "get_ap_upcoming", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  { name: "get_unreconciled_bank_lines", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  { name: "get_payroll_summary", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  // Batch B — POS operations: everything below answers per-branch facts and
  // resolves the branch through the consent pins before reading.
  { name: "list_orders", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "get_order", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_shifts", kind: "read", app: "pos", branchPolicy: "agnostic" },
  // Batch C — menu catalogue, production and barcode hygiene. Everything
  // answers per-branch facts and resolves the branch the same way list_orders
  // does (pinned consent / explicit param), so the policy stays agnostic.
  { name: "get_menu_tree", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_formulas", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_production_runs", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_item_barcodes", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_items_without_barcode", kind: "read", app: "pos", branchPolicy: "agnostic" },
  // Batch D — CRM records are business-scoped facts; pinned consent pins
  // refusal on writes via the write-service and is answered by all (agnostic
  // — the customer file isn't a per-branch view).
  { name: "list_customer_notes", kind: "read", app: "crm", branchPolicy: "agnostic" },
  { name: "list_crm_activities", kind: "read", app: "crm", branchPolicy: "agnostic" },
  // (list_customer_segments exists from before — do not re-add)
  { name: "list_crm_automations", kind: "read", app: "crm", branchPolicy: "agnostic" },
  // Batch E — the business's own shape: branches and staff are business-wide
  // configuration views, not per-branch facts.
  { name: "list_branches", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_team_members", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  // Batch F — growth reads.
  { name: "list_promotions", kind: "read", app: "growth", branchPolicy: "agnostic" },
  { name: "get_gift_card_status", kind: "read", app: "growth", branchPolicy: "agnostic" },
  // Batch G — inventory readings and the suppliers directory.
  { name: "list_stock_counts", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "get_stock_count", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_suppliers", kind: "read", app: "pos", branchPolicy: "agnostic" },
  // Batch H — workspace projects are business-scoped records.
  { name: "list_workspace_projects", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  // Batch N1 — dashboard/insights/report/template lane; agnostic like the
  // other workspace reads (project rows are business-wide themselves).
  { name: "get_workspace_dashboard", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "get_workspace_insights", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "get_workspace_project_report", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_workspace_templates", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_workspace_calendar", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_workspace_comments", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_workspace_documents", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "get_workspace_document", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  // Batch I — knowledge centre (platform catalogue, member-wide) and the
  // media library (business-scoped files).
  { name: "search_kb_articles", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_media_assets", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "get_media_asset", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  // Batch K1 — CRM sales workflow: business-wide (no location dimension) but
  // pinned would not be wrong; agnostic matches the other CRM reads.
  // Batch K3 — the service-desk lane. Cases read rides listCases the screen
  // calls, agnostic like the other CRM reads.
  { name: "list_crm_cases", kind: "read", app: "crm", branchPolicy: "agnostic" },

  // Batch L — transfers span two branches by definition and documents carry
  // their location on the row; business-wide listing, so agnostic like orders.
  { name: "list_inventory_transfers", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_warehouse_documents", kind: "read", app: "pos", branchPolicy: "agnostic" },
  // Batch M — price lists are branch-scoped rows, but either the pin or the
  // explicit locationId resolves them; agnostic like menu catalogue reads.
  { name: "list_price_lists", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "list_price_list_entries", kind: "read", app: "pos", branchPolicy: "agnostic" },  { name: "list_crm_deals", kind: "read", app: "crm", branchPolicy: "agnostic" },
  { name: "list_crm_leads", kind: "read", app: "crm", branchPolicy: "agnostic" },
  { name: "list_crm_pipelines", kind: "read", app: "crm", branchPolicy: "agnostic" },
  // K2 addendum — CRM dashboard/quality/roster surfaces are business-wide by
  // nature (no location column anywhere in them), so business_wide policy.
  { name: "get_crm_overview", kind: "read", app: "crm", branchPolicy: "business_wide" },
  { name: "get_crm_data_quality", kind: "read", app: "crm", branchPolicy: "business_wide" },
  { name: "list_crm_members", kind: "read", app: "crm", branchPolicy: "agnostic" },
  { name: "get_crm_queue", kind: "read", app: "crm", branchPolicy: "agnostic" },
  // Batch J — saved reports are business-wide configuration rows.
  { name: "list_saved_reports", kind: "read", app: "pos", branchPolicy: "agnostic" },
  { name: "get_vat_liability", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  { name: "run_accounting_review", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  // ── Accounting module lists/details (issue #883 package 2, batch A) ───────
  // The account books are business-scoped objects (one ledger per business),
  // so every read below refuses when the consent is pinned to branches —
  // answering with a pin would pretend the ledger of one branch exists.
  { name: "list_accounts", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_journal_entries", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  { name: "list_manual_journal_drafts", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_expenses", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  { name: "get_expense", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_receipts", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_payments", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_cheques", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_fixed_assets", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_installment_plans", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_fiscal_years", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_payroll_runs", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_payroll_advances", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_reconciliations", kind: "read", app: "accounting", branchPolicy: "business_wide" },

  // ---- CRM ----
  { name: "get_customer_profile", kind: "read", app: "crm", branchPolicy: "business_wide" },
  { name: "get_at_risk_customers", kind: "read", app: "crm", branchPolicy: "business_wide" },
  { name: "find_customers", kind: "read", app: "crm", branchPolicy: "agnostic" },
  { name: "get_customer_timeline", kind: "read", app: "crm", branchPolicy: "business_wide" },
  { name: "list_customer_segments", kind: "read", app: "crm", branchPolicy: "agnostic" },
  { name: "preview_customer_segment", kind: "read", app: "crm", branchPolicy: "agnostic" },
  { name: "get_repurchase_candidates", kind: "read", app: "crm", branchPolicy: "pinned" },

  // ---- Growth & Marketing ----
  { name: "list_message_templates", kind: "read", app: "growth", branchPolicy: "agnostic" },
  { name: "list_message_campaigns", kind: "read", app: "growth", branchPolicy: "agnostic" },

  // ---- Website ----
  { name: "list_website_posts", kind: "read", app: "website", branchPolicy: "agnostic" },
  { name: "list_website_products", kind: "read", app: "website", branchPolicy: "agnostic" },
  { name: "get_website_status", kind: "read", app: "website", branchPolicy: "agnostic" },
  // Batch O — pages/media are site-side catalogues, business-wide like the
  // other website reads. Page publish deliberately stays out of MCP exactly
  // like website.post.publish (a human-confirmed publish action).
  { name: "list_cms_pages", kind: "read", app: "website", branchPolicy: "agnostic" },
  { name: "list_cms_media", kind: "read", app: "website", branchPolicy: "agnostic" },
  // Batch V — product masters are branch-scoped (pinned) like price lists.
  { name: "list_product_attributes", kind: "read", app: "pos", branchPolicy: "pinned" },
  // Batch X — media library reads, agnostic like the existing media reads.
  { name: "list_media_collections", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_media_folders", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  // Batch W — the audit trail has no branch dimension (agnostic, like the
  // other business-wide reads).
  { name: "list_audit_log", kind: "read", app: "pos", branchPolicy: "agnostic" },
  // Batch Y — the ledger is business-wide for reads (agnostic like ledgerView).
  { name: "get_account_statement", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  // Batch Z4 — the close readiness screen's read (agnostic ledger-wide).
  { name: "get_fiscal_readiness", kind: "read", app: "accounting", branchPolicy: "agnostic" },
  { name: "list_barcode_templates", kind: "read", app: "pos", branchPolicy: "pinned" },
  // Batch Q — sales invoices are branch-scoped like every other POS order read.
  { name: "list_sales_invoices", kind: "read", app: "pos", branchPolicy: "pinned" },
  // Batch S — the WooCommerce manager is a site-level catalogue (agnostic),
  // exactly like the other website reads.
  { name: "list_wp_queue", kind: "read", app: "website", branchPolicy: "agnostic" },
  { name: "get_wp_queue_summary", kind: "read", app: "website", branchPolicy: "agnostic" },
  { name: "get_wp_overview", kind: "read", app: "website", branchPolicy: "agnostic" },
  // Batch T — site-level infra reads (agnostic, like every website read).
  { name: "get_website_dns", kind: "read", app: "website", branchPolicy: "agnostic" },
  { name: "get_website_cdn", kind: "read", app: "website", branchPolicy: "agnostic" },
  // Batch U — the help catalogue is whole-app shared content (agnostic).
  { name: "list_kb_catalogue", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "get_sales_invoice", kind: "read", app: "pos", branchPolicy: "pinned" },

  // ---- Workspace / AEC (project desk is business-scoped, never branch-scoped) ----
  { name: "get_workspace_project_status", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_workspace_tasks", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_expiring_contracts", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "list_workspace_approvals", kind: "read", app: "workspace", branchPolicy: "agnostic" },
  { name: "get_aec_project_financial_health", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "get_boq_variance", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "get_latest_drawing_revision", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_pending_rfis", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_change_orders", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_delayed_project_activities", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_payment_certificates", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_project_commercial_risks", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_procurement_delays", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_upcoming_milestones", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_pending_submittals", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
  { name: "list_site_issues", kind: "read", app: "workspace", branchPolicy: "agnostic", module: "aec" },
];

// ---------------------------------------------------------------------------
// Write tools — one row per WRITE_TOOL_SPECS / executor-backed action.
// ---------------------------------------------------------------------------

export const MCP_WRITE_REGISTRY: readonly McpWriteRegistryEntry[] = [
  // POS
  { actionType: "menu.item.priceUpdate", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "menu.item.disable", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "order.discount.apply", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "inventory.reorder.draftPO", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "inventory.adjustment.propose", kind: "write", app: "pos", risk: "low", approval: "mode" },
  // Financial posting — this books an expense into the ledger RIGHT NOW, not
  // a draft. Issue #883 step-up: always human-approved, even on apply mode.
  { actionType: "expense.categorize", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  // Batch B — POS operations. Opening an order carries its own idempotency
  // key and posts nothing to money (settlement is deliberately not a verb
  // here — payment orchestration is route-bound), and shifts are clock
  // records under the manager's clock: all follow connection mode.
  { actionType: "order.create", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "shift.start", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "shift.end", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "shift.close", kind: "write", app: "pos", risk: "low", approval: "mode" },
  // Production consumes stock and posts its cost to the ledger — same step-up.
  { actionType: "inventory.production.run", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  // Journal drafts are drafts — they post nothing until the books flow takes
  // them; mode-driven approval is honest.
  { actionType: "journal.manual.propose", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  // ── Accounting module verbs (issue #883 package 2, batch A) ───────────────
  // Chart-of-accounts structure and draft review are reversible bookkeeping:
  // approval follows the connection's mode. Everything that posts or reverses
  // money (receipts, payments, reversals, cheque transitions that post the
  // clearing entry, installment settlement, payroll outflows, asset disposal
  // with proceeds) is high risk and goes through the approval queue even for
  // apply-mode connections — same treatment as expense.categorize.
  { actionType: "account.create", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  { actionType: "account.update", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  { actionType: "account.disable", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  { actionType: "journal.draft.approve", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "journal.draft.reject", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  { actionType: "expense.reverse", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "ar.receipt.record", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "ap.payment.record", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "ap.payment.reverse", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "cheque.create", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  { actionType: "cheque.transition", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "installment.plan.create", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  { actionType: "installment.item.pay", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "reconciliation.create", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  { actionType: "reconciliation.complete", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "payroll.run.accrue", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "payroll.run.pay", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "payroll.run.void", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "payroll.advance.record", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "payroll.advance.void", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "fixed-asset.create", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  { actionType: "fixed-asset.depreciate", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "fixed-asset.dispose", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  // Batch C — POS catalogue and barcode hygiene (approval mode = write tool's
  // setting; repricing stays explicit, not silent cron).
  { actionType: "menu.category.create", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "menu.category.update", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "menu.item.create", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  { actionType: "menu.item.update", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  { actionType: "barcode.assign", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "party.customer.create", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "party.supplier.create", kind: "write", app: "crm", risk: "low", approval: "mode" },
  // Batch D — CRM: notes bookkeeping is low; consent is a legal record and
  // automation toggles re-shape behaviour for every customer at once, so
  // both ask for explicit approval.
  { actionType: "project.create", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "project.update", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "task.create", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "task.update", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "task.status", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  // Batch D — production formulas. The run itself is inventory.production.run
  // (pre-existing, reversible via its own undo path — not duplicated here).
  { actionType: "production.formula.create", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "production.formula.update", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "production.formula.deactivate", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "production.formulaInput.set", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "production.formulaInput.delete", kind: "write", app: "pos", risk: "low", approval: "mode" },
  // Batch L — stock-moving between branches / immediate posting: every verb
  // that prices layers sits as a step-up write, exactly like waste count-line
  // commits and inventory.production.run.
  { actionType: "workspace.document.create", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "workspace.document.update", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "workspace.document.delete", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "workspace.template.save", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "workspace.template.archive", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "workspace.event.create", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "workspace.event.update", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "workspace.event.delete", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "workspace.comment.add", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "priceList.create", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "priceList.rename", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "priceList.delete", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "priceList.entries.save", kind: "write", app: "pos", risk: "low", approval: "mode" },
  // Mass price mutation across (potentially) every item of the branch.
  { actionType: "priceList.quick_update", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  { actionType: "transfer.create", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "transfer.ship", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  { actionType: "transfer.receive", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  { actionType: "transfer.cancel", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  { actionType: "warehouseDocument.create", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  { actionType: "crm.case.save", kind: "write", app: "crm", risk: "low", approval: "mode" },
  // A status move drives the SLA clock (first response, waits, close-out) —
  // still a normal inbox action on the screen, so mode not always_approve.
  { actionType: "crm.case.set_status", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.activity.create", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.activity.update", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.lead.save", kind: "write", app: "crm", risk: "low", approval: "mode" },
  // A convert creates a customer record (and optionally a deal) — the service
  // itself blocks on duplicates unless the caller explicitly acknowledged them.
  { actionType: "crm.lead.convert", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.deal.save", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.deal.move_stage", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.pipeline.create", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.pipeline.update", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "report.saved.create", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "report.saved.update", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "report.saved.delete", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "supplier.return.create", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  { actionType: "promotion.upsert", kind: "write", app: "growth", risk: "low", approval: "mode" },
  { actionType: "promotion.toggle", kind: "write", app: "growth", risk: "low", approval: "mode" },
  { actionType: "gift_card.issue", kind: "write", app: "growth", risk: "high", approval: "always_approve" },
  { actionType: "branch.create", kind: "write", app: "workspace", risk: "high", approval: "always_approve" },
  { actionType: "branch.update", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "branch.lifecycle", kind: "write", app: "workspace", risk: "high", approval: "always_approve" },
  { actionType: "crm.note.delete", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.note.pin", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.consent.set", kind: "write", app: "crm", risk: "high", approval: "always_approve" },
  { actionType: "crm.segment.create", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.segment.update", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.segment.archive", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.automation.toggle", kind: "write", app: "crm", risk: "high", approval: "always_approve" },
  // CRM
  { actionType: "customer.note.add", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.customer.note", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.customer.tag", kind: "write", app: "crm", risk: "low", approval: "mode" },
  // Website
  { actionType: "website.post.draft", kind: "write", app: "website", risk: "low", approval: "mode" },
  { actionType: "website.post.update", kind: "write", app: "website", risk: "low", approval: "mode" },
  { actionType: "website.product.upsert", kind: "write", app: "website", risk: "low", approval: "mode" },
  // Batch Q — voiding a settled receipt reverses ledger postings, restores
  // batches and unwinds loyalty/commission. Explicit human approval each
  // time; the mandatory reason is enforced by the service, not the parser.
  { actionType: "sales.invoice.void", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  // Batch R — paid/refunded/cancelled is customer-facing money state on the
  // connected site (the CMS's hooks settle stock); explicit approval every time.
  { actionType: "website.order.status", kind: "write", app: "website", risk: "high", approval: "always_approve" },
  // Batch S — queue re-pends events already approved once (no new data
  // moves to the site); flush only nudges the drainer early.
  { actionType: "wp.queue.retry", kind: "write", app: "website", risk: "low", approval: "mode" },
  { actionType: "wp.queue.retry_all_failed", kind: "write", app: "website", risk: "low", approval: "mode" },
  { actionType: "wp.queue.flush", kind: "write", app: "website", risk: "low", approval: "mode" },
  // Batch T — renaming the live site is a configuration switch with large
  // blast radius on links; connection mode confirms it, but a good executor
  // tells the human exactly what it is doing.
  { actionType: "website.domain.set", kind: "write", app: "website", risk: "low", approval: "mode" },
  // Batch V — catalogue masters behind menuEdit, same tier as price lists.
  { actionType: "product.attribute.create", kind: "write", app: "pos", risk: "low", approval: "mode" },
  { actionType: "barcode.template.create", kind: "write", app: "pos", risk: "low", approval: "mode" },
  // Batch X — library organisation only: collections never touch bytes, and
  // the soft trash is recoverable. The hard delete (storage object gone for
  // good) stays screen-only, recorded on the matrix row.
  { actionType: "media.collection.create", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  // Batch Y2 — a no-postings account can be re-added; the service refuses
  // every used shape (postings, drafts, children, well-known codes).
  { actionType: "account.delete", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  // Batch Z — a register field (source link), not a posting; the asset's
  // depreciate/dispose siblings already carry the gate tier.
  { actionType: "fixed-asset.set_acquisition", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  // Batch Z2 — same tier as the other payroll money-shaping verbs on the
  // row: settings govern every future run, wage terms change somebody's pay.
  { actionType: "payroll.settings.update", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "payroll.staff.terms", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  // Batch Z3 — ticking lines on an in-progress reconciliation posts nothing;
  // like the screen, a refused batch is refused whole.
  { actionType: "reconciliation.line.clear", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  // Batch Z4 — the financial calendar itself: a reopened period takes
  // postings again, a locked one freezes them, a closed year builds its
  // closing entries under the year lock. Explicit human approval every time.
  { actionType: "fiscal.year.create", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "fiscal.period.set_status", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "fiscal.year.close", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  // Batch Z5 — a posting reversal: new mirrored entry into the ledger.
  { actionType: "journal.entry.reverse", kind: "write", app: "accounting", risk: "high", approval: "always_approve" },
  { actionType: "media.collection.rename", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "media.collection.delete", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "media.asset.set_collection", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "media.asset.trash", kind: "write", app: "workspace", risk: "low", approval: "mode" },
  { actionType: "media.asset.restore", kind: "write", app: "workspace", risk: "low", approval: "mode" },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const READ_BY_NAME = new Map(MCP_READ_REGISTRY.map((entry) => [entry.name, entry]));
const WRITE_BY_ACTION = new Map(MCP_WRITE_REGISTRY.map((entry) => [entry.actionType, entry]));

export function mcpReadRegistryEntry(name: string): McpReadRegistryEntry | null {
  return READ_BY_NAME.get(name) ?? null;
}

export function mcpWriteRegistryEntry(actionType: string): McpWriteRegistryEntry | null {
  return WRITE_BY_ACTION.get(actionType) ?? null;
}

/**
 * The branch visibility rule in one pure place: a tool aggregates across
 * branches and may therefore only be answered when the connection's branch
 * consent covering EVERY branch. Called by the catalogue (hide) and again by
 * the dispatcher (refuse) — the two must agree exactly.
 */
export function mcpBusinessWideToolAllowed(branchConsentIsAll: boolean): boolean {
  return branchConsentIsAll;
}

// ---------------------------------------------------------------------------
// Resources (issue #883 §2) — a resource REPUBLISHES a tool's answer, so its
// registry entry IS the tool's. The conventions document is static prose about
// the codebase's own storage rules: no tool, no registry row, no tenant data.
// ---------------------------------------------------------------------------

const RESOURCE_READ_TOOL: Record<string, string> = {
  "pos://app/overview": "describe_app",
  "pos://reports/catalog": "run_report",
};

/**
 * The registry entry a resource URI republishes, or null for the conventions
 * document (static, no registry row). A second row of truth on purpose: a
 * resource with no mapping must STILL be offered (the conventions document is
 * exactly one), but every tenant-data resource must resolve through here, or
 * the grants filter in resources.ts has nothing to consult.
 */
export function mcpRegistryEntryForResource(uri: string): McpReadRegistryEntry | null {
  const tool = RESOURCE_READ_TOOL[uri];
  return tool ? mcpReadRegistryEntry(tool) : null;
}
