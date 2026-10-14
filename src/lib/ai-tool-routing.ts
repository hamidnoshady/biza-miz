/**
 * Phase 35 Wave 5 — tool routing by app.
 *
 * `src/lib/ai-tools.ts` is 1278 lines of tool definitions, and ALL of them
 * are sent every turn. For "how much did we sell yesterday?" the gold weight,
 * watch repair and cosmetics batch-expiry tools go along for the ride.
 *
 * This module maps tools to apps, so a turn that only touches Accounting sends
 * only sales tools + the always-on set. Three guards protect against
 * misrouting:
 *
 * 1. Always-on tools are never filtered out.
 * 2. An uncertain router sends everything (fallback to today's behavior).
 * 3. The router's own cost is counted in the turn's settlement.
 *
 * Framework-free (no `db`, no `next`).
 */
import type { AppKey } from "./apps";

/**
 * Tools that must always be present regardless of routing. These are the
 * tools that the Phase 33 rules depend on ("before you say something doesn't
 * exist, call describe_app") and the generic reporting entry points.
 */
const ALWAYS_ON_TOOLS = new Set([
  "list_reports",
  "run_report",
  "find_items",
  "describe_app",
  "propose_action",
  "draft_expense_from_receipt",
  "get_bill_split_preview",
  "run_accounting_review",
]);

/**
 * Map from tool name to the app that owns it. Tools not in this map and not
 * in ALWAYS_ON_TOOLS are assumed to be general-purpose and always included.
 */
const TOOL_APP_MAP: Record<string, AppKey> = {
  // Accounting sales and stock tools
  "get_menu_performance": "accounting",
  "get_void_pattern": "accounting",
  "get_waste_history": "accounting",
  "get_stock_valuation": "accounting",
  "get_supplier_performance": "accounting",

  // Growth app — the audience *engines*. The customer record itself moved to
  // the CRM in Phase 36; these stayed because they are about a campaign
  // and a payroll-adjacent payout, not about who a customer is. Message
  // templates and campaign status belong to the same Growth workbench and its
  // `/api/messaging` permission path.
  "get_repurchase_candidates": "growth",
  "get_staff_commission": "growth",
  "list_message_templates": "growth",
  "list_message_campaigns": "growth",

  // CRM app (Phase 36). `get_customer_profile` and `get_at_risk_customers`
  // moved here from Growth with the record they read: a question about one
  // customer's history now routes the same way the screens do.
  "get_customer_profile": "crm",
  "get_at_risk_customers": "crm",
  "find_customers": "crm",
  "get_customer_timeline": "crm",
  "list_customer_segments": "crm",
  "preview_customer_segment": "crm",

  // Accounting operations tools
  "get_reservation_conflicts": "accounting",
  "get_table_turnover_rate": "accounting",
  "get_courier_performance": "accounting",
  "get_near_expiry_items": "accounting",

  // Accounting app
  "get_ar_aging": "accounting",
  "get_ap_upcoming": "accounting",
  "get_unreconciled_bank_lines": "accounting",
  "get_payroll_summary": "accounting",
  "get_vat_liability": "accounting",
  "get_branch_comparison": "accounting",
  "forecast_demand": "accounting",

  // Website app (Phase 38) — the manager's three reads. All go through the
  // business's WebsiteAdapter, so they are website-owned rather than
  // general-purpose: focusing on Website now narrows to these instead of
  // falling back to the whole catalogue.
  "list_website_posts": "website",
  "list_website_products": "website",
  "get_website_status": "website",
};

/**
 * Pure: filters tool names to only those relevant for the given apps.
 * Returns null if routing should be skipped (uncertain → send everything).
 */
export function routeTools(
  allToolNames: string[],
  apps: AppKey[] | null | undefined,
): string[] | null {
  // No apps specified → uncertain → send everything
  if (!apps || apps.length === 0) return null;

  const appSet = new Set(apps);
  const result: string[] = [];

  for (const name of allToolNames) {
    // Always-on tools are never filtered
    if (ALWAYS_ON_TOOLS.has(name)) {
      result.push(name);
      continue;
    }

    // Tools not in the map are general-purpose → always included
    const owningApp = TOOL_APP_MAP[name];
    if (!owningApp) {
      result.push(name);
      continue;
    }

    // Include if the owning app is in scope
    if (appSet.has(owningApp)) {
      result.push(name);
    }
  }

  return result;
}

/**
 * Pure: whether a tool is always-on (must never be filtered).
 */
export function isAlwaysOnTool(name: string): boolean {
  return ALWAYS_ON_TOOLS.has(name);
}

/**
 * Pure: which app owns a tool, or null if it's general-purpose.
 */
export function appForTool(name: string): AppKey | null {
  return TOOL_APP_MAP[name] ?? null;
}
