/**
 * Phase D (unified entity model) — the pure core of the custom Agent.
 *
 * A *custom agent* is a business-defined lens over the SAME dashboard
 * assistant: its own name, its own instructions (a system-prompt fragment),
 * and two allowlists that NARROW what a chat turn run as this agent may see and
 * do. It adds no new tool, no new action and no new mutation path — a turn run
 * as an agent still emits `propose_action`, still lands in the confirm loop,
 * and still applies through the same role-guarded route with the user's own
 * session. The agent only decides which subset of the already-existing,
 * already-guarded catalogue the model is allowed to name.
 *
 * Everything here is framework-free — no DB, no provider, no `next/*` — so the
 * validation rules can be unit-tested in isolation and reused by both the HTTP
 * route (on write) and the chat runtime (on read). Persistence lives in
 * `ai-custom-agents-service.ts`.
 *
 * The two allowlists are validated against the LIVE catalogue, never a frozen
 * copy: the read tools come from `toolDefinitions("dashboard")` and the actions
 * from `ACTION_CATALOG`, so a tool or action that is renamed or removed cannot
 * linger in an agent's allowlist and quietly do nothing.
 */
import {
  ACTION_CATALOG,
  isKnownAction,
  toolDefinitions,
  type ActionType,
} from "./ai";
// From the pure module, not from the executor: this file is reachable from a
// client component, and `ai-workspace-tools` imports the database layer.
import { WORKSPACE_TOOL_LABELS } from "./workspace-shared";
import { AEC_AI_TOOL_LABELS } from "./aec";

export const MAX_AGENT_NAME = 80;
export const MAX_AGENT_INSTRUCTIONS = 4000;

/** A custom agent as stored and returned by the service. */
export interface CustomAgent {
  id: string;
  businessId: string;
  name: string;
  instructions: string;
  toolAllowlist: string[];
  actionAllowlist: ActionType[];
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The writable shape a route hands to the service (create or update). */
export interface CustomAgentInput {
  name?: unknown;
  instructions?: unknown;
  toolAllowlist?: unknown;
  actionAllowlist?: unknown;
  enabled?: unknown;
}

/** A validated, normalized agent write — what actually reaches the database. */
export interface NormalizedCustomAgent {
  name: string;
  instructions: string;
  toolAllowlist: string[];
  actionAllowlist: ActionType[];
  enabled: boolean;
}

export type CustomAgentValidation =
  | { ok: true; value: NormalizedCustomAgent }
  | { ok: false; errors: string[] };

/**
 * The read tools an agent may allow — exactly the dashboard assistant's own
 * read surface, minus `propose_action` (which the action allowlist governs) and
 * minus the attachment-only receipt drafter (offered per-turn, not per-agent).
 * Derived from `toolDefinitions` so it can never drift from what the runtime
 * actually offers.
 */
export function selectableAgentTools(): string[] {
  return toolDefinitions("dashboard", { hasAttachment: false, retrieval: true })
    .map((tool) => tool.function.name)
    .filter((name) => name !== "propose_action");
}

/**
 * The actions an agent may allow — every catalogue action a human can apply
 * from the chat, minus the coworker-only ones (which only a pre-authored
 * coworker job may ever name). This is the same boundary
 * `assertWriteToolsMatchCatalogue` draws for MCP writes, kept in one place.
 */
export function selectableAgentActions(): ActionType[] {
  return (Object.keys(ACTION_CATALOG) as ActionType[]).filter(
    (type) => !ACTION_CATALOG[type].coworkerOnly,
  );
}

/**
 * Human names for the read tools an agent may allow, so the editor lists
 * «مشتریان در معرض ریزش» rather than the raw `get_at_risk_customers`. A tool
 * with no entry here falls back to its own name (harmless, and a visible nudge
 * to add a label). Kept beside `selectableAgentTools` so the two never drift.
 */
export const AGENT_TOOL_LABELS: Record<string, string> = {
  get_setup_state: "وضعیت راه‌اندازی کسب‌وکار",
  list_reports: "فهرست گزارش‌های استاندارد",
  run_report: "اجرای گزارش استاندارد",
  get_customer_profile: "پروندهٔ یک مشتری",
  get_at_risk_customers: "مشتریان در معرض ریزش",
  find_customers: "جست‌وجوی مشتریان",
  get_customer_timeline: "سابقهٔ فعالیت یک مشتری",
  preview_customer_segment: "پیش‌نمایش یک بخش از مشتریان",
  get_ar_aging: "سن‌بندی مطالبات",
  forecast_demand: "پیش‌بینی تقاضا",
  run_accounting_review: "بازبینی سلامت حساب‌ها",
  find_items: "جست‌وجوی کالا و آیتم منو",
  get_waste_history: "تاریخچهٔ ضایعات",
  list_website_posts: "فهرست نوشته‌های وب‌سایت",
  list_website_products: "فهرست محصولات وب‌سایت",
  list_message_templates: "قالب‌های پیام",
  get_menu_item_details: "جزئیات یک آیتم منو",
  get_bill_split_preview: "پیش‌نمایش تقسیم صورت‌حساب",
  get_backup_health: "سلامت پشتیبان‌گیری",
  get_menu_performance: "عملکرد فروش منو",
  get_void_pattern: "الگوی ابطال فاکتورها",
  get_stock_valuation: "ارزش‌گذاری موجودی انبار",
  get_supplier_performance: "عملکرد تأمین‌کنندگان",
  get_reservation_conflicts: "تداخل رزروها",
  get_table_turnover_rate: "نرخ چرخش میزها",
  get_courier_performance: "عملکرد پیک‌ها",
  list_customer_segments: "فهرست بخش‌های مشتریان",
  get_ap_upcoming: "بدهی‌های سررسیدشونده",
  get_unreconciled_bank_lines: "تراکنش‌های بانکی مغایرت‌دار",
  get_payroll_summary: "خلاصهٔ حقوق و دستمزد",
  get_vat_liability: "بدهی مالیات بر ارزش افزوده",
  get_branch_comparison: "مقایسهٔ شعبه‌ها",
  get_near_expiry_items: "کالاهای نزدیک به انقضا",
  get_staff_commission: "پورسانت کارکنان",
  get_repurchase_candidates: "مشتریان آمادهٔ خرید دوباره",
  describe_app: "معرفی امکانات نرم‌افزار",
  list_coworker_jobs: "فهرست کارهای همکار هوشمند",
  get_website_status: "وضعیت وب‌سایت",
  list_message_campaigns: "فهرست کمپین‌های پیام",
  search_business_knowledge: "جست‌وجو در دانش کسب‌وکار",
  request_input: "درخواست ورودی ساختارمند از کاربر",
  // Phase G — «میز کار من». Spread from the module's own table so an agent
  // builder cannot offer a workspace tool the executor does not implement.
  ...WORKSPACE_TOOL_LABELS,
  // Issue #799 §23 — the AEC reads, spread the same way from `aec.ts` (which
  // stays free of `pg` so this builder can import it).
  ...AEC_AI_TOOL_LABELS,
};

/** The Persian label for a tool name, or the raw name if none is registered. */
export function agentToolLabel(name: string): string {
  return AGENT_TOOL_LABELS[name] ?? name;
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const value = String(entry ?? "").trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * Validate and normalize an agent write. Rejects — rather than silently
 * dropping — an unknown tool or action, because an allowlist that quietly
 * ignores what it does not recognise is an allowlist the owner cannot trust.
 */
export function validateCustomAgent(input: CustomAgentInput): CustomAgentValidation {
  const errors: string[] = [];

  const name = String(input.name ?? "").trim();
  if (!name) errors.push("name_required");
  else if (name.length > MAX_AGENT_NAME) errors.push("name_too_long");

  const instructions = String(input.instructions ?? "").trim();
  if (instructions.length > MAX_AGENT_INSTRUCTIONS) errors.push("instructions_too_long");

  const selectableTools = new Set(selectableAgentTools());
  const toolAllowlist = normalizeStringArray(input.toolAllowlist);
  for (const tool of toolAllowlist) {
    if (!selectableTools.has(tool)) errors.push(`unknown_tool:${tool}`);
  }

  const selectableActions = new Set<string>(selectableAgentActions());
  const actionAllowlist = normalizeStringArray(input.actionAllowlist);
  for (const action of actionAllowlist) {
    if (!isKnownAction(action) || !selectableActions.has(action)) {
      errors.push(`unknown_action:${action}`);
    }
  }

  const enabled = input.enabled === undefined ? true : input.enabled === true;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      instructions,
      toolAllowlist,
      actionAllowlist: actionAllowlist as ActionType[],
      enabled,
    },
  };
}

/**
 * The scope a chat turn adopts when it runs as an agent. `null` action list
 * would mean "no restriction"; an agent ALWAYS restricts, so this is always a
 * concrete (possibly empty) set. An empty action list is a read-only agent.
 */
export interface AgentTurnScope {
  id: string;
  name: string;
  instructions: string;
  /** Read-tool names this turn may call; the runtime intersects with the mode's own set. */
  toolAllowlist: string[];
  /** Action types this turn may propose; empty means the turn proposes nothing. */
  actionTypes: ActionType[];
}

/** Build the runtime scope for a turn from a stored, enabled agent. */
export function agentTurnScope(agent: CustomAgent): AgentTurnScope {
  return {
    id: agent.id,
    name: agent.name,
    instructions: agent.instructions,
    toolAllowlist: [...agent.toolAllowlist],
    actionTypes: [...agent.actionAllowlist],
  };
}

/**
 * The request-level agent id a chat turn should carry, given the surface mode
 * and the composer's current pick. Only the dashboard assistant runs as a
 * custom agent (the floor and wizard surfaces are their own realms), so any
 * pick is dropped outside dashboard mode; an empty/whitespace id resolves to
 * null (the full assistant). Kept pure so the composer and its test share one
 * rule.
 */
export function agentIdForTurn(
  mode: "wizard" | "dashboard" | "floor",
  agentId: string | null | undefined,
): string | undefined {
  if (mode !== "dashboard") return undefined;
  const trimmed = typeof agentId === "string" ? agentId.trim() : "";
  return trimmed ? trimmed : undefined;
}

const AGENT_ERROR_MESSAGES: Record<string, string> = {
  name_required: "نام ایجنت را وارد کنید.",
  name_too_long: "نام ایجنت بیش از حد بلند است.",
  instructions_too_long: "دستورالعمل ایجنت بیش از حد بلند است.",
  name_taken: "ایجنتی با این نام از قبل وجود دارد.",
  not_found: "ایجنت پیدا نشد.",
};

/** Persian message for an agent error code; unknown tool/action codes are explained generically. */
export function customAgentErrorMessage(code: string): string {
  if (code.startsWith("unknown_tool:")) return "ابزار انتخاب‌شده معتبر نیست.";
  if (code.startsWith("unknown_action:")) return "نوع عملیات انتخاب‌شده معتبر نیست.";
  return AGENT_ERROR_MESSAGES[code] ?? "درخواست نامعتبر است.";
}
