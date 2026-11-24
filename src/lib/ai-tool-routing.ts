/**
 * Issue #1546 — tool routing by app **and** by section.
 *
 * `toolDefinitions()` describes ~150 tools, and before this change every one of
 * them was sent on every round. A measurement of the live catalogue (see
 * `docs/ai/latency-1546.md`) puts that at ~35k prompt tokens of JSON Schema per
 * provider call; with 3–9 calls per turn that schema is resent 3–9 times and
 * dominates the prompt.
 *
 * This module makes the offer smaller *without* making it unsafe:
 *
 * 1. Every tool is classified into a group (a section inside one of the four
 *    apps, or a cross-app group). App Focus then narrows to that app's groups.
 * 2. Within the focused app, the member's own words and the existing task lens
 *    pick the groups worth offering. No extra model call is made: this is a
 *    deterministic string match over the instruction the member already sent.
 * 3. When a question crosses apps ("مشتری‌های سایت") the matching other-app
 *    groups are added, so legitimate cross-app work still has its tools.
 * 4. When nothing matches, the whole focused app is offered — uncertainty
 *    widens the catalogue, it never empties it.
 * 5. A tool with no classification is always offered. Adding a tool to
 *    `toolDefinitions` can therefore never silently disappear from a turn.
 *
 * Authorization is deliberately NOT decided here. `filterAiToolsByPermissions`
 * still intersects this list with the member's permissions, and every executor
 * re-checks tenant, branch, app, project and permission scope when it actually
 * runs. Narrowing the offer cannot widen what a call is allowed to do.
 *
 * Framework-free (no `db`, no `next`).
 */
import type { AppKey } from "./apps";

/** A selectable section of the assistant's tool surface. */
export type ToolGroup =
  | "shared"
  | "settings"
  | "accounting:sales"
  | "accounting:inventory"
  | "accounting:ledger"
  | "accounting:payroll"
  | "accounting:projects"
  | "accounting:workspace"
  | "crm:records"
  | "growth:campaigns"
  | "website:content";

/** Every group each app can offer. Cross-app groups are added separately. */
const APP_GROUPS: Record<AppKey, readonly ToolGroup[]> = {
  accounting: [
    "accounting:sales",
    "accounting:inventory",
    "accounting:ledger",
    "accounting:payroll",
    "accounting:projects",
    "accounting:workspace",
  ],
  crm: ["crm:records"],
  growth: ["growth:campaigns"],
  website: ["website:content"],
};

/**
 * Tools that must always be present regardless of routing. These are the tools
 * the Phase 33 rules depend on ("before you say something doesn't exist, call
 * describe_app"), the generic reporting entry points, and the two protocol
 * tools.
 */
const ALWAYS_ON_TOOLS = new Set([
  "list_reports",
  "run_report",
  "find_items",
  "describe_app",
  "propose_action",
  "request_input",
  "draft_expense_from_receipt",
  "get_bill_split_preview",
  "run_accounting_review",
  "recommend_learning",
  "show_report_widget",
]);

/**
 * Tool name -> group. Every dashboard-mode read tool is listed so App Focus is
 * a real narrowing rather than a handful of exceptions; the list is data, and
 * the fallback in `routeTools` keeps an unlisted tool offered.
 */
const TOOL_GROUP_MAP: Record<string, ToolGroup> = {
  // ---- shared: always useful, whatever section the member is in ----
  get_setup_state: "shared",
  list_reports: "shared",
  run_report: "shared",
  list_saved_reports: "shared",
  show_report_widget: "shared",
  describe_app: "shared",
  navigate_to_feature: "shared",
  find_dashboard_feature: "shared",
  get_feature_details: "shared",
  start_guided_tour: "shared",
  recommend_learning: "shared",
  search_business_knowledge: "shared",
  get_branch_comparison: "shared",

  // ---- settings: data transfer, media, team, audit and backups ----
  search_kb_articles: "settings",
  list_kb_catalogue: "settings",
  list_audit_log: "settings",
  list_team_members: "settings",
  list_branches: "settings",
  list_devices: "settings",
  get_backup_status: "settings",
  get_backup_health: "settings",
  get_client_update_status: "settings",
  list_export_jobs: "settings",
  get_export_job: "settings",
  list_import_jobs: "settings",
  get_import_job: "settings",
  list_data_entities: "settings",
  list_data_templates: "settings",
  list_data_schedules: "settings",
  list_custom_fields: "settings",
  list_media_assets: "settings",
  get_media_asset: "settings",
  list_media_collections: "settings",
  list_media_folders: "settings",
  list_coworker_jobs: "settings",

  // ---- Accounting / sales, POS and hospitality operations ----
  list_orders: "accounting:sales",
  get_order: "accounting:sales",
  list_sales_invoices: "accounting:sales",
  get_sales_invoice: "accounting:sales",
  list_payments: "accounting:sales",
  get_menu_performance: "accounting:sales",
  get_void_pattern: "accounting:sales",
  get_table_turnover_rate: "accounting:sales",
  get_courier_performance: "accounting:sales",
  get_reservation_conflicts: "accounting:sales",
  get_gift_card_status: "accounting:sales",
  list_installment_plans: "accounting:sales",

  // ---- Accounting / inventory, purchasing and item catalogues ----
  get_menu_tree: "accounting:inventory",
  get_stock_count: "accounting:inventory",
  list_stock_counts: "accounting:inventory",
  list_inventory_transfers: "accounting:inventory",
  list_items_without_barcode: "accounting:inventory",
  list_item_barcodes: "accounting:inventory",
  list_barcode_templates: "accounting:inventory",
  list_suppliers: "accounting:inventory",
  get_supplier_performance: "accounting:inventory",
  get_stock_valuation: "accounting:inventory",
  get_waste_history: "accounting:inventory",
  get_near_expiry_items: "accounting:inventory",
  forecast_demand: "accounting:inventory",
  list_formulas: "accounting:inventory",
  list_warehouse_documents: "accounting:inventory",
  list_product_attributes: "accounting:inventory",
  list_cosmetic_items: "accounting:inventory",
  list_cosmetic_brands: "accounting:inventory",
  list_jewelry_items: "accounting:inventory",
  list_accessory_items: "accounting:inventory",
  list_trade_goods_items: "accounting:inventory",
  list_production_runs: "accounting:inventory",
  list_price_lists: "accounting:inventory",
  list_price_list_entries: "accounting:inventory",

  // ---- Accounting / ledger, tax and banking ----
  list_accounts: "accounting:ledger",
  get_account_statement: "accounting:ledger",
  list_journal_entries: "accounting:ledger",
  list_manual_journal_drafts: "accounting:ledger",
  list_reconciliations: "accounting:ledger",
  get_unreconciled_bank_lines: "accounting:ledger",
  get_ar_aging: "accounting:ledger",
  get_ap_upcoming: "accounting:ledger",
  list_expenses: "accounting:ledger",
  get_expense: "accounting:ledger",
  list_receipts: "accounting:ledger",
  list_cheques: "accounting:ledger",
  get_vat_liability: "accounting:ledger",
  get_fiscal_readiness: "accounting:ledger",
  list_fiscal_years: "accounting:ledger",
  list_fixed_assets: "accounting:ledger",
  run_accounting_review: "accounting:ledger",
  draft_expense_from_receipt: "accounting:ledger",
  get_bill_split_preview: "accounting:ledger",

  // ---- Accounting / payroll and shifts ----
  list_payroll_runs: "accounting:payroll",
  get_payroll_summary: "accounting:payroll",
  list_payroll_advances: "accounting:payroll",
  list_shifts: "accounting:payroll",

  // ---- Accounting / projects, contracts and construction ----
  list_site_issues: "accounting:projects",
  list_project_commercial_risks: "accounting:projects",
  list_change_orders: "accounting:projects",
  list_procurement_delays: "accounting:projects",
  list_payment_certificates: "accounting:projects",
  get_latest_drawing_revision: "accounting:projects",
  list_upcoming_milestones: "accounting:projects",
  list_pending_rfis: "accounting:projects",
  list_pending_submittals: "accounting:projects",
  get_aec_project_financial_health: "accounting:projects",
  list_delayed_project_activities: "accounting:projects",
  get_boq_variance: "accounting:projects",
  list_expiring_contracts: "accounting:projects",

  // ---- Accounting / workspace (the ledger's own project workspace) ----
  get_workspace_dashboard: "accounting:workspace",
  get_workspace_project_status: "accounting:workspace",
  get_workspace_project_report: "accounting:workspace",
  get_workspace_document: "accounting:workspace",
  get_workspace_contract: "accounting:workspace",
  get_workspace_insights: "accounting:workspace",
  list_workspace_tasks: "accounting:workspace",
  list_workspace_documents: "accounting:workspace",
  list_workspace_projects: "accounting:workspace",
  list_workspace_approvals: "accounting:workspace",
  list_workspace_comments: "accounting:workspace",
  list_workspace_calendar: "accounting:workspace",
  list_workspace_templates: "accounting:workspace",

  // ---- CRM ----
  list_crm_cases: "crm:records",
  list_crm_leads: "crm:records",
  list_crm_deals: "crm:records",
  list_crm_activities: "crm:records",
  list_crm_pipelines: "crm:records",
  list_crm_members: "crm:records",
  list_crm_automations: "crm:records",
  get_crm_queue: "crm:records",
  get_crm_overview: "crm:records",
  get_crm_data_quality: "crm:records",
  find_customers: "crm:records",
  get_customer_profile: "crm:records",
  get_customer_timeline: "crm:records",
  list_customer_notes: "crm:records",
  list_customer_segments: "crm:records",
  preview_customer_segment: "crm:records",
  get_at_risk_customers: "crm:records",

  // ---- Growth & Marketing ----
  list_message_templates: "growth:campaigns",
  list_message_campaigns: "growth:campaigns",
  get_repurchase_candidates: "growth:campaigns",
  get_staff_commission: "growth:campaigns",
  list_promotions: "growth:campaigns",

  // ---- Website Management (both managers) ----
  list_website_posts: "website:content",
  list_website_products: "website:content",
  get_website_status: "website:content",
  get_website_dns: "website:content",
  get_website_cdn: "website:content",
  list_cms_pages: "website:content",
  list_cms_media: "website:content",
  list_wp_queue: "website:content",
  get_wp_overview: "website:content",
  get_wp_queue_summary: "website:content",
};

/**
 * Section keywords, matched case-insensitively against the member's latest
 * instruction. Persian stems are matched as substrings because the language
 * agglutinates and conjugates ("فروش"، "فروختیم"، "فروشنده"), so both the
 * present and past stems are listed where they diverge.
 *
 * A keyword is a *hint*, never an authorization: it can only add a group the
 * member's permissions still have to allow, and a wrong hint costs tokens, not
 * safety.
 */
const GROUP_KEYWORDS: Record<Exclude<ToolGroup, "shared">, readonly string[]> = {
  settings: [
    "پشتیبان", "خروجی", "ورودی", "انتقال داده", "فایل", "رسانه", "تصویر", "آپلود",
    "ممیزی", "تیم", "کاربر", "اعضا", "شعبه", "شعب", "دستگاه", "فیلد سفارشی",
    "همکار", "راهنما", "دانش", "بازیابی",
    "backup", "export", "import", "media", "file", "audit", "team", "user",
    "branch", "device", "custom field", "coworker", "help", "knowledge",
  ],
  "accounting:sales": [
    "فروش", "فروخت", "فاکتور", "سفارش", "درآمد", "صندوق", "میز", "منو", "پیک",
    "ارسال", "تخفیف", "تراکنش", "کارت هدیه", "اقساط", "لغو", "مرجوع",
    "sales", "sell", "invoice", "order", "revenue", "pos", "discount", "menu",
  ],
  "accounting:inventory": [
    "موجودی", "انبار", "خرید", "تأمین", "تامین", "کالا", "ضایعات", "دستور پخت",
    "مواد اولیه", "قیمت تمام", "انقضا", "بارکد", "انتقال", "تولید", "قیمت‌گذاری",
    "inventory", "stock", "supplier", "purchase", "waste", "barcode", "expiry",
  ],
  "accounting:ledger": [
    "سند", "دفتر", "حساب", "تراز", "بدهی", "مطالبات", "مالیات", "ارزش افزوده",
    "چک", "مغایرت", "بودجه", "دارایی ثابت", "سال مالی", "هزینه", "رسید",
    "سرفصل", "بستانکار", "بدهکار", "دریافتنی", "پرداختنی",
    "ledger", "journal", "tax", "vat", "expense", "cheque", "reconciliation",
    "balance", "fiscal", "receivable", "payable",
  ],
  "accounting:payroll": [
    "حقوق", "دستمزد", "پرسنل", "کارکرد", "اضافه‌کاری", "مساعده", "کمیسیون",
    "شیفت", "پاداش", "بیمه",
    "payroll", "salary", "commission", "shift", "staff",
  ],
  "accounting:projects": [
    "پروژه", "پیمان", "صورت وضعیت", "متره", "فهرست بها", "صورتجلسه", "نقشه",
    "تأخیر", "تاخیر", "پیمانکار", "قرارداد", "مصالح", "کارگاه", "مطالبه", "ریسک",
    "project", "contract", "boq", "rfi", "submittal", "milestone", "variation",
  ],
  "accounting:workspace": [
    "فضای کار", "وظیفه", "وظایف", "تسک", "تقویم", "یادداشت", "جلسه", "کارها",
    "workspace", "task", "calendar", "note",
  ],
  "crm:records": [
    "مشتری", "سرنخ", "فرصت", "پیگیری", "تیکت", "پرونده", "ارتباط",
    "باشگاه مشتریان", "وفاداری",
    "customer", "lead", "deal", "pipeline", "crm", "case", "ticket", "loyalty",
  ],
  "growth:campaigns": [
    "کمپین", "پیامک", "بازگشت مشتری", "کد تخفیف", "پیشنهاد ویژه", "بازاریابی",
    "campaign", "sms", "marketing", "promotion", "repurchase",
  ],
  "website:content": [
    "سایت", "وبسایت", "وب‌سایت", "صفحه", "نوشته", "وردپرس", "ووکامرس",
    "دامنه", "محصول سایت", "مدیریت محتوا", "سئو",
    "website", "wordpress", "woocommerce", "cms", "dns", "cdn", "seo",
  ],
};

/**
 * The existing task lens (`AiTaskId`) → tool groups. Kept as plain strings so
 * this module stays framework-free and does not import the task registry.
 */
const TASK_GROUPS: Record<string, readonly ToolGroup[]> = {
  sales: ["accounting:sales"],
  inventory: ["accounting:inventory"],
  accounting: ["accounting:ledger"],
  menu: ["accounting:sales", "accounting:inventory"],
  customers: ["crm:records"],
  marketing: ["growth:campaigns"],
  operations: ["accounting:workspace", "accounting:inventory"],
  delivery: ["accounting:sales"],
  split: ["accounting:sales"],
};

/** Groups whose keywords appear in the instruction. Deterministic, no model. */
export function groupsMentionedIn(text: string | null | undefined): ToolGroup[] {
  const haystack = (text ?? "").toLowerCase();
  if (!haystack.trim()) return [];
  const matched: ToolGroup[] = [];
  for (const [group, keywords] of Object.entries(GROUP_KEYWORDS) as [Exclude<ToolGroup, "shared">, readonly string[]][]) {
    if (keywords.some((keyword) => haystack.includes(keyword))) matched.push(group);
  }
  return matched;
}

/** Context the turn already has; nothing here is model-generated. */
export interface ToolRoutingContext {
  /** The per-turn task lens (`AiTaskId`), e.g. `sales`, `customers`. */
  task?: string | null;
  /** The member's latest instruction, only ever used for keyword hints. */
  message?: string | null;
}

/**
 * Pure: filters tool names to the groups relevant for the given apps.
 *
 * Returns null when routing should be skipped (no app focus → send
 * everything), which keeps an unfocused turn byte-for-byte what it was.
 */
export function routeTools(
  allToolNames: string[],
  apps: AppKey[] | null | undefined,
  context?: ToolRoutingContext,
): string[] | null {
  // No apps specified → uncertain → send everything.
  if (!apps || apps.length === 0) return null;

  const appGroups = new Set<ToolGroup>();
  for (const app of apps) {
    for (const group of APP_GROUPS[app] ?? []) appGroups.add(group);
  }

  const allowed = new Set<ToolGroup>();
  const mentioned = groupsMentionedIn(context?.message);
  const taskGroups = context?.task ? (TASK_GROUPS[context.task] ?? []) : [];

  // Naming a section inside the focused app narrows to what was named, and any
  // other section named is exactly how legitimate cross-app work keeps its
  // tools. Mentioning no section at all widens to the whole focused app.
  const mentionsFocusedSection = mentioned.some((group) => appGroups.has(group));
  if (mentionsFocusedSection) {
    for (const group of mentioned) allowed.add(group);
  } else if (taskGroups.length > 0) {
    // The task lens is an explicit, server-validated choice, so it can select
    // the sections on its own when the message names none.
    for (const group of taskGroups) allowed.add(group);
  } else {
    for (const group of appGroups) allowed.add(group);
    // Nothing to go on: keep the cross-app settings surface too, so a vague
    // turn is only narrower by other apps' sections.
    allowed.add("settings");
  }
  for (const group of taskGroups) allowed.add(group);

  const result: string[] = [];
  for (const name of allToolNames) {
    if (ALWAYS_ON_TOOLS.has(name)) {
      result.push(name);
      continue;
    }
    const group = TOOL_GROUP_MAP[name];
    // Unclassified tools are general-purpose → always included, so a new tool
    // cannot silently vanish from an app-focused turn.
    if (!group) {
      result.push(name);
      continue;
    }
    if (group === "shared" || allowed.has(group)) result.push(name);
  }
  return result;
}

/** Pure: whether a tool is always-on (must never be filtered). */
export function isAlwaysOnTool(name: string): boolean {
  return ALWAYS_ON_TOOLS.has(name);
}

/** The group a tool belongs to, or null when it is unclassified. */
export function toolGroupOf(name: string): ToolGroup | null {
  return TOOL_GROUP_MAP[name] ?? null;
}

/** The distinct groups a list of tool names covers, sorted for stable output. */
export function toolGroupsOf(names: readonly string[]): string[] {
  const groups = new Set<string>();
  for (const name of names) {
    const group = TOOL_GROUP_MAP[name];
    if (group) groups.add(group);
  }
  return [...groups].sort();
}

/** The app that owns a tool's group, or null when it is shared/unclassified. */
export function appForTool(name: string): AppKey | null {
  const group = TOOL_GROUP_MAP[name];
  if (!group || !group.includes(":")) return null;
  return group.split(":")[0] as AppKey;
}
