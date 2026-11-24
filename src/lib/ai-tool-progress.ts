/**
 * Issue #1546 — safe, label-only tool progress.
 *
 * A multi-round turn used to show nothing between the member's question and the
 * final answer: the client saw `reset` and then silence while tools ran. This
 * module is the one vocabulary for telling the member that work is happening,
 * which approved tool is running, and whether it finished — without ever
 * sending a tool name, an argument, a prompt or a record to the browser.
 *
 * The label is derived from the tool's own section (see
 * `ai-tool-routing.ts`), so a new tool inherits a correct, non-revealing label
 * without anyone remembering to add one.
 *
 * Framework-free, safe for the client bundle.
 */
import { toolGroupOf, type ToolGroup } from "./ai-tool-routing";

export type AiToolProgressStatus = "running" | "completed" | "failed";

export interface AiToolProgressEvent {
  status: AiToolProgressStatus;
  /** The internal tool name. Not rendered; kept for logs and tests. */
  tool: string;
  /** The Persian label the member sees. Never contains arguments or data. */
  label: string;
  /** 1-based round the tool ran in. */
  round: number;
}

/** Section-level labels — the default for every tool in a group. */
const GROUP_LABELS: Record<ToolGroup, string> = {
  shared: "در حال بررسی اطلاعات کسب‌وکار",
  settings: "در حال بررسی تنظیمات و داده‌ها",
  "accounting:sales": "در حال بررسی فروش و سفارش‌ها",
  "accounting:inventory": "در حال بررسی موجودی و کالاها",
  "accounting:ledger": "در حال بررسی اسناد و حساب‌ها",
  "accounting:payroll": "در حال بررسی حقوق و کارکرد",
  "accounting:projects": "در حال بررسی پروژه‌ها و قراردادها",
  "accounting:workspace": "در حال بررسی فضای کار",
  "crm:records": "در حال بررسی مشتریان",
  "growth:campaigns": "در حال بررسی کمپین‌ها",
  "website:content": "در حال بررسی سایت",
};

/** Tools worth naming exactly, because the wait is longer and more specific. */
const TOOL_LABELS: Record<string, string> = {
  run_report: "در حال اجرای گزارش",
  list_reports: "در حال خواندن فهرست گزارش‌ها",
  find_items: "در حال جست‌وجوی کالاها",
  describe_app: "در حال بررسی امکانات این بخش",
  get_ar_aging: "در حال بررسی مطالبات",
  get_ap_upcoming: "در حال بررسی بدهی به تأمین‌کنندگان",
  get_vat_liability: "در حال محاسبهٔ مالیات ارزش افزوده",
  get_menu_performance: "در حال بررسی عملکرد منو",
  get_stock_valuation: "در حال محاسبهٔ ارزش موجودی",
  find_customers: "در حال جست‌وجوی مشتریان",
  get_customer_profile: "در حال خواندن پروندهٔ مشتری",
  list_message_campaigns: "در حال بررسی کمپین‌ها",
  search_business_knowledge: "در حال جست‌وجو در دانش کسب‌وکار",
  draft_expense_from_receipt: "در حال خواندن رسید",
  run_accounting_review: "در حال بررسی حساب‌ها",
  get_workspace_dashboard: "در حال خواندن فضای کار",
};

const FALLBACK_LABEL = "در حال بررسی داده‌ها";

/**
 * The label for a tool. Never derived from arguments, results or the prompt —
 * only from the tool's own name and section.
 */
export function toolProgressLabel(tool: string): string {
  const exact = TOOL_LABELS[tool];
  if (exact) return exact;
  const group = toolGroupOf(tool);
  return group ? GROUP_LABELS[group] : FALLBACK_LABEL;
}

/** One progress event for the stream. */
export function toolProgressEvent(
  tool: string,
  status: AiToolProgressStatus,
  round: number,
): AiToolProgressEvent {
  return { status, tool, label: toolProgressLabel(tool), round };
}
