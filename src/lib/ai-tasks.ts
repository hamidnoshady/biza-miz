/**
 * The chat's task lens (ChatGPT's "GPTs"-style selector, requested in the
 * Phase 36c chat redesign and hardened in Issue #905).
 *
 * One catalog shared by the browser (the composer dropdown and welcome starter
 * cards) and the server (capability hydration + validation + the system-prompt
 * directive for the turn). The browser maps icons per id in
 * `ai-task-selector.tsx`; this module deliberately imports nothing UI-related
 * so the server bundle never pulls lucide-react.
 *
 * Eligibility is evaluated from a single shared definition (`isTaskEligible`,
 * `resolveEligibleTasks`, `resolveStarterPrompts`) used by both `/dashboard`,
 * `/api/ai/chat`, and the client task/starter UI so industry, module, feature,
 * permission, and focus constraints cannot drift.
 */

import type { AgentMode } from "./ai";
import { MAX_CUSTOM_TASK_CHARS } from "./ai-attachment-limits";
import { isIndustry, type Industry } from "./industries";
import { hasModule, type ModuleKey } from "./industry-profile";

export type AiTaskId =
  | "general"
  | "sales"
  | "inventory"
  | "accounting"
  | "menu"
  | "customers"
  | "marketing"
  | "operations"
  | "delivery"
  | "split"
  | "custom";

export type AiTaskFeatureKey =
  | "inventory"
  | "crm"
  | "accounting"
  | "workspace"
  | "growth"
  | "website";

export type AiTaskAppFocus =
  | "all"
  | "workspace"
  | "accounting"
  | "crm"
  | "growth"
  | "website";

export interface AiTaskEligibilityContext {
  mode?: AgentMode;
  industry?: Industry | string | null;
  features?: Partial<Record<AiTaskFeatureKey, boolean>> | null;
  permissions?: Iterable<string> | null;
  appFocus?: AiTaskAppFocus | null;
  projectId?: string | null;
}

export interface AiTask {
  id: AiTaskId;
  /** Short Persian label for the dropdown and the header. */
  label: string;
  /** One-line description shown under the label in the dropdown. */
  description: string;
  /** Which assistant modes the task makes sense in. */
  modes: AgentMode[];
  /** Optional industry allowlist (e.g. hospitality-only menu/tables/courier). */
  industries?: readonly Industry[];
  /** Industry modules required for this task (all must be enabled). */
  requiredModules?: readonly ModuleKey[];
  /** At least one of these industry modules must be enabled when industry is known. */
  requiredAnyModules?: readonly ModuleKey[];
  /** Tenant feature flags required for this task. */
  requiredFeatures?: readonly AiTaskFeatureKey[];
  /** At least one of these permissions must be held when permissions are supplied. */
  requiredAnyPermissions?: readonly string[];
  /** Optional app focus affinity used to rank/filter contextual starters. */
  focusAffinity?: readonly AiTaskAppFocus[];
  /** Appended to the system prompt for the turn. Absent = default behaviour. */
  directive?: string;
  /** Starter chips while the conversation is empty (per-mode fallbacks below). */
  suggestions?: string[];
}

/**
 * The classic starter chips per assistant mode, used when the selected task
 * has no suggestions of its own (and by the wizard, which has no selector).
 * `dashboard` defaults are universal across industries (no restaurant-only
 * menu/table/courier prompts).
 */
export const SUGGESTED_PROMPTS: Record<"wizard" | "dashboard" | "floor", string[]> = {
  wizard: [
    "برای تکمیل این مرحله چه اطلاعاتی لازم است؟",
    "یک ساختار اولیهٔ ساده برای کسب‌وکار پیشنهاد بده.",
    "تنظیمات مالیات و روش قیمت‌گذاری را بررسی کن.",
  ],
  dashboard: [
    "فروش هفتهٔ اخیر را خلاصه و با هفتهٔ قبل مقایسه کن.",
    "خلاصهٔ وضعیت مالی، مطالبات و هزینه‌های این ماه را نشان بده.",
    "وضعیت کارها، پروژه‌ها و پیگیری‌های باز امروز را مرور کن.",
  ],
  floor: [
    "مواد اولیهٔ ثبت‌شدهٔ یک آیتم منو را بگو.",
    "صورت‌حساب میز ۳ را برای ۴ نفر تقسیم کن.",
    "برای سؤال حساسیت غذایی چه داده‌ای ثبت شده است؟",
  ],
};

export const AI_TASKS: AiTask[] = [
  {
    id: "general",
    label: "دستیار عمومی",
    description: "پرسش آزاد دربارهٔ فروش، امور مالی، مشتریان و کارهای روزمره",
    modes: ["dashboard", "floor"],
  },
  {
    id: "sales",
    label: "تحلیل فروش",
    description: "روندها، مقایسهٔ بازه‌ها، پرفروش‌ها و عملکرد فروش",
    modes: ["dashboard"],
    requiredModules: ["reports"],
    requiredAnyPermissions: ["reports.view", "orders.view", "ledger.view", "accounting.view"],
    focusAffinity: ["all", "accounting"],
    directive:
      "تمرکز این گفتگو تحلیل فروش و درآمد است: روند و مقایسهٔ بازه‌ها، پرفروش‌ترین و ضعیف‌ترین آیتم‌ها، ساعات اوج، و الگوی باطل‌شدن سفارش‌ها. از list_reports/run_report، get_menu_performance و get_void_pattern استفاده کن و یافته‌ها را با عدد، درصد و پیشنهاد کوتاه خلاصه کن.",
    suggestions: [
      "فروش امروز را با دیروز و هفتهٔ قبل مقایسه کن.",
      "پرفروش‌ترین و ضعیف‌ترین اقلام این هفته کدام‌اند؟",
      "روند درآمد و فاکتورهای اخیر را تحلیل کن.",
    ],
  },
  {
    id: "inventory",
    label: "موجودی و خرید",
    description: "ارزش موجودی، اقلام رو به اتمام، انقضا و تأمین‌کنندگان",
    modes: ["dashboard"],
    requiredAnyModules: ["inventory", "stock"],
    requiredFeatures: ["inventory"],
    requiredAnyPermissions: ["inventory.view", "inventory.adjust", "inventory.edit", "purchases.manage", "purchases.view"],
    focusAffinity: ["all", "accounting"],
    directive:
      "تمرکز این گفتگو موجودی و خرید است: ارزش موجودی (get_stock_valuation)، اقلام رو به اتمام، اقلام نزدیک انقضا (get_near_expiry_items)، عملکرد تأمین‌کنندگان (get_supplier_performance) و تخمین تقاضا (forecast_demand — همیشه صریح بگو تخمین است). پیشنهاد خرید را فقط بر اساس دادهٔ همین ابزارها بده.",
    suggestions: [
      "کدام اقلام رو به اتمام‌اند و باید خرید شوند؟",
      "ارزش موجودی فعلی انبار چقدر است؟",
      "اقلام نزدیک به انقضا را فهرست کن.",
    ],
  },
  {
    id: "accounting",
    label: "حسابداری و هزینه‌ها",
    description: "مطالبات، بدهی‌ها، مغایرت بانکی، حقوق، مالیات و ممیزی",
    modes: ["dashboard"],
    requiredModules: ["reports"],
    requiredFeatures: ["accounting"],
    requiredAnyPermissions: ["ledger.view", "ledger.post", "accounting.view", "accounting.post", "reports.view"],
    focusAffinity: ["all", "accounting"],
    directive:
      "تمرکز این گفتگو حسابداری و هزینه‌ها است: مطالبات (get_ar_aging)، بدهی‌های آینده (get_ap_upcoming)، مغایرت بانکی (get_unreconciled_bank_lines)، حقوق (get_payroll_summary)، مالیات (get_vat_liability) و بررسی جامع حساب‌ها (run_accounting_review). هرگز موردی به یافته‌های ابزارها اضافه نکن.",
    suggestions: [
      "حساب‌هایم را کامل بررسی کن و یافته‌ها را بگو.",
      "مطالبات مشتریان و بدهی‌های آینده چقدر است؟",
      "مالیات بر ارزش افزودهٔ این دوره چقدر است؟",
    ],
  },
  {
    id: "menu",
    label: "منو و قیمت‌گذاری",
    description: "تحلیل عملکرد آیتم‌ها و مواد اولیهٔ ثبت‌شده",
    modes: ["dashboard", "floor"],
    industries: ["food_service"],
    requiredModules: ["menu"],
    requiredAnyPermissions: ["menu.view", "menu.edit"],
    focusAffinity: ["all", "accounting"],
    directive:
      "تمرکز این گفتگو منو و قیمت‌گذاری است: با find_items و گزارش‌های منو تحلیل کن که کدام آیتم‌ها می‌فروشند و کدام نه. پیشنهاد قیمت را محتاطانه و فقط بر اساس دادهٔ واقعی بده و همیشه بگو که تصمیم نهایی با کاربر است.",
    suggestions: [
      "عملکرد آیتم‌های منو را تحلیل کن.",
      "مواد اولیهٔ ثبت‌شدهٔ یک آیتم منو را بگو.",
    ],
  },
  {
    id: "customers",
    label: "مشتریان و وفاداری",
    description: "پروفایل مشتری، ریزش، بخش‌بندی و خرید مجدد",
    modes: ["dashboard"],
    requiredModules: ["customers"],
    requiredFeatures: ["crm"],
    requiredAnyPermissions: ["parties.view", "parties.manage", "customers.view", "customers.edit", "crm.view", "crm.manage"],
    focusAffinity: ["all", "crm"],
    directive:
      "تمرکز این گفتگو مشتریان و وفاداری است: get_customer_profile، find_customers، get_customer_timeline، get_at_risk_customers، list_customer_segments، preview_customer_segment و get_repurchase_candidates. بخش‌ها را با نام و معیار فارسی توضیح بده.",
    suggestions: [
      "مشتریان در خطر ریزش چه کسانی‌اند؟",
      "کدام مشتری‌ها آمادهٔ خرید مجدد هستند؟",
      "بخش‌بندی مشتریانم را نشان بده.",
    ],
  },
  {
    id: "marketing",
    label: "رشد و بازاریابی",
    description: "ایدهٔ کمپین بر اساس بخش‌های مشتریان و ریزش",
    modes: ["dashboard"],
    requiredAnyModules: ["promotions", "messaging", "crm"],
    requiredFeatures: ["growth"],
    requiredAnyPermissions: [
      "growth.view",
      "campaigns.view",
      "campaigns.manage",
      "loyalty.view",
      "promotions.view",
      "promotions.edit",
      "messaging.view",
      "messaging.send",
      "customers.view",
    ],
    focusAffinity: ["all", "growth"],
    directive:
      "تمرکز این گفتگو رشد و بازاریابی است: از بخش‌بندی مشتریان، مشتریان در خطر ریزش و آمادهٔ خرید مجدد شروع کن و پیشنهاد کمپین بده. پیشنهادها را قابل اجرا، کوتاه و بدون وعدهٔ عددی اثبات‌نشده بنویس.",
    suggestions: [
      "بر اساس بخش‌بندی مشتریان یک کمپین پیشنهاد بده.",
      "برای برگرداندن مشتریان در خطر ریزش چه کنم؟",
    ],
  },
  {
    id: "operations",
    label: "رزرو و میزها",
    description: "تداخل رزرو و گردش میزها",
    modes: ["dashboard"],
    industries: ["food_service"],
    requiredAnyModules: ["tables", "reservations"],
    requiredAnyPermissions: ["tables.manage", "tables.edit", "tables.view", "reservations.view", "reservations.manage", "orders.view"],
    focusAffinity: ["all"],
    directive:
      "تمرکز این گفتگو رزرو و میزها است: get_reservation_conflicts و get_table_turnover_rate. تداخل‌ها را با زمان و نام میز گزارش کن و پیشنهاد ساده بده.",
    suggestions: [
      "تداخل رزروهای امروز را بررسی کن.",
      "گردش میزها این هفته چطور بوده است؟",
    ],
  },
  {
    id: "delivery",
    label: "پیک و تحویل",
    description: "عملکرد پیک‌ها و زمان تحویل",
    modes: ["dashboard"],
    industries: ["food_service"],
    requiredModules: ["delivery"],
    requiredAnyPermissions: ["delivery.manage", "delivery.configure", "delivery.view", "orders.view"],
    focusAffinity: ["all"],
    directive:
      "تمرکز این گفتگو پیک و تحویل سفارش است: از get_courier_performance استفاده کن و مقایسهٔ پیک‌ها را با زمان تحویل و تعداد سفارش خلاصه کن.",
    suggestions: ["عملکرد پیک‌ها را مقایسه کن."],
  },
  {
    id: "split",
    label: "تقسیم صورتحساب",
    description: "پیش‌نمایش تقسیم برابر صورتحساب میز بین نفرات",
    modes: ["floor"],
    industries: ["food_service"],
    requiredModules: ["tables"],
    directive:
      "تمرکز این گفتگو تقسیم صورتحساب میز است: فقط پیش‌نمایشِ تقسیم بده، همیشه بگو پیش‌نمایش است و هرگز چیزی ثبت نکن.",
    suggestions: [
      "صورتحساب میز ۳ را برای ۴ نفر مساوی تقسیم کن.",
      "انعام را هم در تقسیم حساب کن.",
    ],
  },
  {
    id: "custom",
    label: "سفارشی…",
    description: "هر وظیفه‌ای که می‌خواهید برای دستیار تعریف کنید",
    modes: ["dashboard", "floor"],
  },
];

const FOCUS_STARTER_PROMPTS: Record<AiTaskAppFocus, readonly string[]> = {
  all: SUGGESTED_PROMPTS.dashboard,
  workspace: [
    "وضعیت پروژه‌ها، وظایف باز و تأییدیه‌های منتظر تصمیم من را خلاصه کن.",
    "کدام وظایف در میز کار عقب افتاده‌اند یا اولویت فوری دارند؟",
    "اسناد و قراردادهای اخیر مرتبط با کارهای جاری را مرور کن.",
  ],
  accounting: [
    "حساب‌هایم را کامل بررسی کن و یافته‌ها را بگو.",
    "مطالبات مشتریان و بدهی‌های آینده چقدر است؟",
    "فروش هفتهٔ اخیر را خلاصه و با هفتهٔ قبل مقایسه کن.",
  ],
  crm: [
    "مشتریان در خطر ریزش چه کسانی‌اند؟",
    "کدام مشتری‌ها آمادهٔ خرید مجدد هستند؟",
    "بخش‌بندی مشتریانم را نشان بده.",
  ],
  growth: [
    "بر اساس بخش‌بندی مشتریان یک کمپین پیشنهاد بده.",
    "برای برگرداندن مشتریان در خطر ریزش چه کنم؟",
    "عملکرد کدهای تخفیف و کمپین‌های اخیر را بررسی کن.",
  ],
  website: [
    "وضعیت صفحات، فرم‌ها و سفارش‌های آنلاین وب‌سایت را بررسی کن.",
    "کدام بخش‌های وب‌سایت نیاز به بهینه‌سازی دارند؟",
    "خلاصهٔ پیام‌ها و سفارش‌های دریافتی از وب‌سایت را نشان بده.",
  ],
};

const PROJECT_STARTER_PROMPTS: readonly string[] = [
  "وضعیت وظایف و موانع این پروژه را خلاصه کن.",
  "کدام کارها در این پروژه عقب افتاده‌اند یا اولویت فوری دارند؟",
  "اسناد، قراردادها و تصمیم‌های باز این پروژه را مرور کن.",
];

const TASKS_BY_ID = new Map(AI_TASKS.map((task) => [task.id, task]));

export function taskById(id: string): AiTask | undefined {
  return TASKS_BY_ID.get(id as AiTaskId);
}

/**
 * Evaluates whether a preset task is eligible for the caller's mode, industry,
 * enabled modules, tenant feature flags, permissions, and app focus.
 */
export function isTaskEligible(
  taskOrId: AiTask | string | null | undefined,
  context?: AiTaskEligibilityContext,
): boolean {
  const task =
    typeof taskOrId === "string" || taskOrId == null
      ? TASKS_BY_ID.get((taskOrId ?? "") as AiTaskId)
      : taskOrId;
  if (!task) return false;

  const mode: AgentMode = context?.mode ?? "dashboard";
  if (!task.modes.includes(mode)) return false;

  const industryRaw = context?.industry;
  const validIndustry: Industry | null =
    typeof industryRaw === "string" && isIndustry(industryRaw)
      ? industryRaw
      : null;

  if (task.industries && task.industries.length > 0) {
    if (!validIndustry || !task.industries.includes(validIndustry)) {
      return false;
    }
  }

  if (validIndustry && task.requiredModules && task.requiredModules.length > 0) {
    for (const mod of task.requiredModules) {
      if (!hasModule(validIndustry, mod)) return false;
    }
  }

  if (
    validIndustry &&
    task.requiredAnyModules &&
    task.requiredAnyModules.length > 0
  ) {
    const hasAnyMod = task.requiredAnyModules.some((mod) =>
      hasModule(validIndustry, mod),
    );
    if (!hasAnyMod) return false;
  }

  if (context?.features && task.requiredFeatures && task.requiredFeatures.length > 0) {
    for (const feat of task.requiredFeatures) {
      if (context.features[feat] === false) return false;
    }
  }

  if (
    context?.permissions &&
    task.requiredAnyPermissions &&
    task.requiredAnyPermissions.length > 0
  ) {
    const permSet =
      context.permissions instanceof Set
        ? context.permissions
        : new Set(context.permissions);
    const hasAny = task.requiredAnyPermissions.some((perm) => permSet.has(perm));
    if (!hasAny) return false;
  }

  if (
    context?.appFocus &&
    context.appFocus !== "all" &&
    task.focusAffinity &&
    task.focusAffinity.length > 0 &&
    !task.focusAffinity.includes(context.appFocus)
  ) {
    return false;
  }

  return true;
}

/**
 * Returns the ordered list of tasks eligible for the given context.
 * Set `includeCustom: false` when rendering preset lists that already have a
 * dedicated custom-task editor row so "custom" is never rendered twice.
 */
export function resolveEligibleTasks(
  context?: AiTaskEligibilityContext,
  options?: { includeCustom?: boolean },
): AiTask[] {
  const includeCustom = options?.includeCustom ?? true;
  const baseContext: AiTaskEligibilityContext | undefined = context
    ? { ...context, appFocus: "all" }
    : undefined;
  return AI_TASKS.filter((task) => {
    if (!includeCustom && task.id === "custom") return false;
    return isTaskEligible(task, baseContext);
  });
}

/**
 * Resolves up to `count` (default 3) starter prompts appropriate for the
 * caller's industry, enabled modules/features, permissions, active focus,
 * project context, and selected task.
 */
export function resolveStarterPrompts(
  context?: AiTaskEligibilityContext & {
    task?: AiTaskId | string | null;
    fallback?: readonly string[];
    count?: number;
  },
): string[] {
  const count = Math.max(1, Math.min(context?.count ?? 3, 6));
  const mode: AgentMode = context?.mode ?? "dashboard";

  if (
    context?.task &&
    context.task !== "general" &&
    context.task !== "custom" &&
    isTaskEligible(context.task, { ...context, appFocus: "all" })
  ) {
    const task = taskById(context.task);
    if (task?.suggestions?.length) {
      return task.suggestions.slice(0, count);
    }
  }

  if (context?.projectId) {
    return PROJECT_STARTER_PROMPTS.slice(0, count);
  }

  if (mode === "wizard") {
    return (context?.fallback ?? SUGGESTED_PROMPTS.wizard).slice(0, count);
  }
  if (mode === "floor") {
    return (context?.fallback ?? SUGGESTED_PROMPTS.floor).slice(0, count);
  }

  const focus = context?.appFocus ?? "all";
  if (focus !== "all" && FOCUS_STARTER_PROMPTS[focus]) {
    return FOCUS_STARTER_PROMPTS[focus].slice(0, count);
  }

  const hasSpecificTenantContext =
    Boolean(context?.industry) ||
    Boolean(context?.features) ||
    Boolean(context?.permissions);

  if (!hasSpecificTenantContext) {
    return (context?.fallback ?? SUGGESTED_PROMPTS.dashboard).slice(0, count);
  }

  const eligibleTasks = resolveEligibleTasks(context, { includeCustom: false });
  const eligibleIds = new Set(eligibleTasks.map((t) => t.id));

  const prompts: string[] = [];
  if (eligibleIds.has("sales")) {
    prompts.push("فروش هفتهٔ اخیر را خلاصه و با هفتهٔ قبل مقایسه کن.");
  } else {
    prompts.push("وضعیت کارها، پروژه‌ها و پیگیری‌های باز امروز را مرور کن.");
  }

  if (eligibleIds.has("accounting")) {
    prompts.push("خلاصهٔ وضعیت مالی، مطالبات و هزینه‌های این ماه را نشان بده.");
  } else if (eligibleIds.has("customers")) {
    prompts.push("مشتریان در خطر ریزش و فرصت‌های خرید مجدد را نشان بده.");
  } else {
    prompts.push("مهم‌ترین اولویت‌ها و هشدارهای امروز کسب‌وکار چیست؟");
  }

  if (eligibleIds.has("inventory")) {
    prompts.push("کدام اقلام رو به اتمام‌اند و باید خرید شوند؟");
  } else if (eligibleIds.has("menu")) {
    prompts.push("عملکرد آیتم‌های منو را تحلیل کن.");
  } else {
    prompts.push("کدام وظایف یا پیگیری‌ها نیاز به تصمیم فوری من دارند؟");
  }

  return prompts.slice(0, count);
}

/**
 * Starter chips for an empty conversation. Per-task suggestions when the task
 * defines them (and is eligible), otherwise the surface's contextual list.
 */
export function taskSuggestions(
  taskId: AiTaskId | undefined,
  mode: AgentMode,
  fallback: string[],
  eligibility?: AiTaskEligibilityContext,
): string[] {
  if (!eligibility) {
    const task = taskId ? taskById(taskId) : undefined;
    return task?.suggestions?.length ? task.suggestions : fallback;
  }
  return resolveStarterPrompts({
    ...eligibility,
    mode,
    task: taskId,
    fallback,
    count: 3,
  });
}

/** Removes control characters and caps the length of a custom task description. */
export function sanitizeCustomTask(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CUSTOM_TASK_CHARS);
}

/**
 * The custom task frame: the safety rules stay absolute even when the owner
 * redefines the assistant's job for a conversation.
 */
export const CUSTOM_TASK_FRAME =
  "دستورالعمل موقتِ تعیین‌شده توسط کاربر برای همین گفتگو (همیشه رعایتش کن، اما قواعد ایمنی — تأیید دستی هر تغییر، منع جعل عدد و تاریخ، و ننوشتن شناسهٔ خام — بر آن مقدم‌اند):\n";

/**
 * Server-side resolution of one turn's task directive.
 *
 * A non-empty custom description wins over a preset id; an unknown id, an id
 * that does not belong to this mode, an id ineligible for this tenant/member,
 * or a preset without a directive all resolve to null. Never throws — a garbage
 * `task` field is ignored, not fatal.
 */
export function taskDirectiveFor(input: {
  task?: unknown;
  customTask?: unknown;
  mode: AgentMode;
  eligibility?: AiTaskEligibilityContext;
}): string | null {
  const custom =
    typeof input.customTask === "string" ? sanitizeCustomTask(input.customTask) : "";
  if (custom) return CUSTOM_TASK_FRAME + custom;

  const id = typeof input.task === "string" ? input.task : "general";
  const task = taskById(id);
  if (!task || !task.modes.includes(input.mode) || !task.directive) return null;
  if (
    input.eligibility &&
    !isTaskEligible(task, { ...input.eligibility, mode: input.mode, appFocus: "all" })
  ) {
    return null;
  }
  return task.directive;
}
