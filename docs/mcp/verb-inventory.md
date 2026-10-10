# Issue #883 — MCP verb inventory (machine-reviewable)

> GENERATED FILE — do not edit by hand. Source of truth: `src/lib/mcp/registry.ts`.
> Regenerate with `npx tsx scripts/write-mcp-verb-inventory.mts` after changing
> the registry; the registry test fails while this file and the registry drift.

Current surface: **52 read verbs** (**20** business-wide aggregates —
visible only to connections consented for every branch) and **14 write verbs**
(**2** high-risk, forced through the approval queue even on `apply`-mode connections).

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
| `get_vat_liability` | accounting | business_wide | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
| `run_accounting_review` | accounting | business_wide | `ledger.view` | registry.test.ts, tools.test.ts, integration/mcp-connector.integration.test.ts |
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
| `write_production_run` | `inventory.production.run` | pos | high | always approval queue (step-up) | `inventory.adjust` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
| `write_journal_draft` | `journal.manual.propose` | accounting | low | connection write_mode | `ledger.propose` | registry.test.ts, tools.test.ts, integration/mcp-grants-hardening.integration.test.ts |
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
