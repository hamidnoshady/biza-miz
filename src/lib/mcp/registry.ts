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
  { name: "get_vat_liability", kind: "read", app: "accounting", branchPolicy: "business_wide" },
  { name: "run_accounting_review", kind: "read", app: "accounting", branchPolicy: "business_wide" },

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
  // Production consumes stock and posts its cost to the ledger — same step-up.
  { actionType: "inventory.production.run", kind: "write", app: "pos", risk: "high", approval: "always_approve" },
  // Journal drafts are drafts — they post nothing until the books flow takes
  // them; mode-driven approval is honest.
  { actionType: "journal.manual.propose", kind: "write", app: "accounting", risk: "low", approval: "mode" },
  // CRM
  { actionType: "customer.note.add", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.customer.note", kind: "write", app: "crm", risk: "low", approval: "mode" },
  { actionType: "crm.customer.tag", kind: "write", app: "crm", risk: "low", approval: "mode" },
  // Website
  { actionType: "website.post.draft", kind: "write", app: "website", risk: "low", approval: "mode" },
  { actionType: "website.post.update", kind: "write", app: "website", risk: "low", approval: "mode" },
  { actionType: "website.product.upsert", kind: "write", app: "website", risk: "low", approval: "mode" },
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
