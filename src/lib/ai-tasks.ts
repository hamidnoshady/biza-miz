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
 * `resolveEligibleTasks`, `resolveAccessibleFocuses`, `isFocusEligible`,
 * `resolveStarterPrompts`, `resolveTenantTaskFeatures`) used by `/dashboard`,
 * `/api/ai/chat`, and the client task/starter UI so industry, module, feature,
 * permission, focus, and project constraints cannot drift.
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
  | "stock"
  | "crm"
  | "accounting"
  | "ledger"
  | "reporting"
  | "reservations"
  | "delivery"
  | "workspace"
  | "growth"
  | "website"
  | "integrations";

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
  features?: Partial<Record<AiTaskFeatureKey, boolean>> | Record<string, boolean> | null;
  permissions?: Iterable<string> | null;
  eligibleTaskIds?: Iterable<AiTaskId> | null;
  accessibleFocuses?: Iterable<AiTaskAppFocus> | null;
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
  /** All of these permissions must be held when permissions are supplied. */
  requiredPermissions?: readonly string[];
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
 * Normalizes raw database feature flags (`effectiveFeatures(businessId)`) and
 * optional app availability states into the canonical `AiTaskFeatureKey` map.
 */
export function resolveTenantTaskFeatures(
  rawFeatures?: Record<string, boolean> | null,
  options?: {
    industry?: Industry | string | null;
    usableApps?: Partial<Record<"accounting" | "crm" | "growth" | "website", boolean>> | null;
  },
): Partial<Record<AiTaskFeatureKey, boolean>> {
  const raw = rawFeatures ?? {};
  const validIndustry =
    typeof options?.industry === "string" && isIndustry(options.industry)
      ? options.industry
      : null;
  const usableApps = options?.usableApps;

  // Retail trades with `stock` and without F&B `inventory` are not gated by
  // the F&B `inventory` feature flag (`defaultDisabledFeatures` in
  // industry-profile.ts seeds `inventory: false` for retail trades).
  const isRetailStockOnly =
    Boolean(validIndustry) &&
    hasModule(validIndustry!, "stock") &&
    !hasModule(validIndustry!, "inventory");

  const accountingAppUsable = usableApps?.accounting !== false;
  const crmAppUsable = usableApps?.crm !== false;
  const growthAppUsable = usableApps?.growth !== false;
  const websiteAppUsable = usableApps?.website !== false;

  return {
    inventory: isRetailStockOnly
      ? raw.stock !== false && accountingAppUsable
      : raw.inventory !== false && accountingAppUsable,
    stock: raw.stock !== false && accountingAppUsable,
    ledger: raw.ledger !== false && raw.accounting !== false && accountingAppUsable,
    accounting: raw.accounting !== false && raw.ledger !== false && accountingAppUsable,
    reporting: raw.reporting !== false && accountingAppUsable,
    reservations: raw.reservations !== false && accountingAppUsable,
    delivery: raw.delivery !== false && accountingAppUsable,
    crm: raw.crm !== false && crmAppUsable,
    growth: raw.growth !== false && growthAppUsable,
    website: raw.website !== false && websiteAppUsable,
    integrations: raw.integrations !== false && websiteAppUsable,
    workspace: raw.workspace !== false,
  };
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
    requiredFeatures: ["reporting"],
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
    requiredModules: ["ledger", "reports"],
    requiredFeatures: ["accounting", "ledger"],
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
    requiredAnyModules: ["loyalty", "promotions", "messaging"],
    requiredFeatures: ["growth"],
    requiredAnyPermissions: [
      "growth.view",
      "campaigns.view",
      "campaigns.manage",
      "loyalty.view",
      "loyalty.manage",
      "promotions.view",
      "promotions.edit",
      "messaging.view",
      "messaging.send",
    ],
    focusAffinity: ["all", "growth"],
    directive:
      "تمرکز این گفتگو رشد و بازاریابی است: از بخش‌بندی مشتریان، مشتریان در خطر ریزش و آمادهٔ خرید مجدد شروع کن و پیشنهاد کمپین بده. پیشنهادها را قابل اجرا، کوتاه و بدون وعدهٔ عددی اثبات‌نشده بنویس.",
    suggestions: [
      "بر اساس بخش‌بندی مشتریان یک کمپین پیشنهاد بده.",
      "برای برگرداندن مشتریان در خطر ریزش چه کنم؟",
      "عملکرد کدهای تخفیف و کمپین‌های اخیر را بررسی کن.",
    ],
  },
  {
    id: "operations",
    label: "رزرو و میزها",
    description: "تداخل رزرو و گردش میزها",
    modes: ["dashboard"],
    industries: ["food_service"],
    requiredAnyModules: ["tables", "reservations"],
    requiredFeatures: ["reservations"],
    requiredAnyPermissions: ["tables.manage", "tables.edit", "tables.view", "reservations.view", "reservations.manage"],
    focusAffinity: ["all", "accounting"],
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
    requiredFeatures: ["delivery"],
    requiredAnyPermissions: ["delivery.manage", "delivery.configure", "delivery.view"],
    focusAffinity: ["all", "accounting"],
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
    requiredFeatures: ["reservations"],
    requiredAnyPermissions: ["menu.view", "tables.manage", "orders.view"],
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

const GENERAL_ONLY_STARTER_PROMPTS: readonly string[] = [
  "امروز در چه زمینه‌ای می‌توانی به من کمک کنی؟",
  "یک متن یا پیام کاری کوتاه برایم پیش‌نویس کن.",
  "نکات کلیدی یک موضوع کاری را به زبان ساده خلاصه کن.",
];

const WORKSPACE_PERMISSIONS = [
  "workspace.view",
  "workspace.manage",
  "workspace.admin",
  "projects.view",
  "projects.manage",
  "tasks.view",
  "tasks.manage",
] as const;

const WEBSITE_PERMISSIONS = [
  "website.view",
  "website.manage",
  "integrations.manage",
] as const;

const TASKS_BY_ID = new Map(AI_TASKS.map((task) => [task.id, task]));

export function taskById(id: string): AiTask | undefined {
  return TASKS_BY_ID.get(id as AiTaskId);
}

function toSet<T>(items: Iterable<T> | null | undefined): Set<T> | null {
  if (!items) return null;
  return items instanceof Set ? items : new Set(items);
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

  const eligibleTaskSet = toSet(context?.eligibleTaskIds);
  if (
    eligibleTaskSet &&
    task.id !== "general" &&
    task.id !== "custom" &&
    !eligibleTaskSet.has(task.id)
  ) {
    return false;
  }

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
    const featuresRecord = context.features as Record<string, boolean | undefined>;
    for (const feat of task.requiredFeatures) {
      if (featuresRecord[feat] === false) return false;
    }
  }

  const permSet = toSet(context?.permissions);
  if (permSet) {
    if (task.requiredPermissions && task.requiredPermissions.length > 0) {
      const hasAll = task.requiredPermissions.every((perm) => permSet.has(perm));
      if (!hasAll) return false;
    }
    if (task.requiredAnyPermissions && task.requiredAnyPermissions.length > 0) {
      const hasAny = task.requiredAnyPermissions.some((perm) => permSet.has(perm));
      if (!hasAny) return false;
    }
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
 * Evaluates whether an app focus option (`all`, `workspace`, `accounting`,
 * `crm`, `growth`, `website`) is accessible and enabled for the caller.
 */
export function isFocusEligible(
  focus: AiTaskAppFocus,
  context?: AiTaskEligibilityContext,
): boolean {
  if (focus === "all") return true;

  const accessibleSet = toSet(context?.accessibleFocuses);
  if (accessibleSet && !accessibleSet.has(focus)) {
    return false;
  }

  const featuresRecord = (context?.features ?? null) as Record<
    string,
    boolean | undefined
  > | null;
  const permSet = toSet(context?.permissions);
  const validIndustry =
    typeof context?.industry === "string" && isIndustry(context.industry)
      ? context.industry
      : null;

  if (focus === "workspace") {
    if (featuresRecord?.workspace === false) return false;
    if (permSet) {
      return WORKSPACE_PERMISSIONS.some((perm) => permSet.has(perm));
    }
    if (accessibleSet) {
      return true;
    }
    if (context?.eligibleTaskIds && featuresRecord?.workspace !== true) {
      return false;
    }
    return true;
  }

  if (focus === "crm") {
    return isTaskEligible("customers", {
      ...context,
      mode: "dashboard",
      appFocus: "all",
    });
  }

  if (focus === "growth") {
    return isTaskEligible("marketing", {
      ...context,
      mode: "dashboard",
      appFocus: "all",
    });
  }

  if (focus === "website") {
    if (featuresRecord?.website === false) return false;
    if (
      validIndustry &&
      !hasModule(validIndustry, "website") &&
      !hasModule(validIndustry, "integrations")
    ) {
      return false;
    }
    if (permSet) {
      const hasWebsitePerm =
        permSet.has("website.view") || permSet.has("website.manage");
      const hasIntegrationsPerm =
        permSet.has("integrations.manage") &&
        featuresRecord?.integrations !== false;
      return hasWebsitePerm || hasIntegrationsPerm;
    }
    if (accessibleSet) {
      return true;
    }
    if (context?.eligibleTaskIds && featuresRecord?.website !== true) {
      return false;
    }
    return true;
  }

  if (focus === "accounting") {
    if (featuresRecord?.accounting === false) return false;
    const accountingTasks: readonly AiTaskId[] = [
      "sales",
      "inventory",
      "accounting",
      "menu",
      "operations",
      "delivery",
    ];
    return accountingTasks.some((taskId) =>
      isTaskEligible(taskId, {
        ...context,
        mode: "dashboard",
        appFocus: "all",
      }),
    );
  }

  return false;
}

/**
 * Returns the ordered list of app focuses accessible to this caller.
 */
export function resolveAccessibleFocuses(
  context?: AiTaskEligibilityContext | Iterable<string> | null,
): AiTaskAppFocus[] {
  const normalizedContext: AiTaskEligibilityContext | undefined =
    context &&
    (context instanceof Set ||
      Array.isArray(context) ||
      typeof (context as Iterable<string>)[Symbol.iterator] === "function")
      ? { permissions: context as Iterable<string> }
      : (context as AiTaskEligibilityContext | undefined);

  const allFocuses: readonly AiTaskAppFocus[] = [
    "all",
    "workspace",
    "accounting",
    "crm",
    "growth",
    "website",
  ];
  return allFocuses.filter((focus) => isFocusEligible(focus, normalizedContext));
}

/**
 * Returns the ordered list of tasks eligible for the given context.
 * Set `includeCustom: false` when rendering preset lists that already have a
 * dedicated custom-task editor row so "custom" is never rendered twice.
 */
export function resolveEligibleTasks(
  context?: AiTaskEligibilityContext,
  options?: { includeCustom?: boolean; respectAppFocus?: boolean },
): AiTask[] {
  const includeCustom = options?.includeCustom ?? true;
  const evalContext: AiTaskEligibilityContext | undefined =
    context && !options?.respectAppFocus
      ? { ...context, appFocus: "all" }
      : context;
  return AI_TASKS.filter((task) => {
    if (!includeCustom && task.id === "custom") return false;
    return isTaskEligible(task, evalContext);
  });
}

function appendUniquePrompts(
  target: string[],
  candidates: readonly string[],
  maxCount: number,
): void {
  for (const item of candidates) {
    if (target.length >= maxCount) break;
    if (!target.includes(item)) {
      target.push(item);
    }
  }
}

/**
 * Resolves up to `count` (default 3) starter prompts appropriate for the
 * caller's industry, enabled modules/features, permissions, active focus,
 * project context, and selected task. Restricted users never receive
 * suggestions for unavailable functions.
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

  // 1. Explicit preset task selected by user (when eligible for current context & focus)
  if (
    context?.task &&
    context.task !== "general" &&
    context.task !== "custom" &&
    isTaskEligible(context.task, context)
  ) {
    const task = taskById(context.task);
    if (task?.suggestions?.length) {
      return task.suggestions.slice(0, count);
    }
  }

  if (mode === "wizard") {
    return (context?.fallback ?? SUGGESTED_PROMPTS.wizard).slice(0, count);
  }

  const hasSpecificTenantContext =
    Boolean(context?.industry) ||
    Boolean(context?.features) ||
    Boolean(context?.permissions) ||
    Boolean(context?.eligibleTaskIds) ||
    Boolean(context?.accessibleFocuses);

  if (mode === "floor") {
    if (!hasSpecificTenantContext) {
      return (context?.fallback ?? SUGGESTED_PROMPTS.floor).slice(0, count);
    }
    const floorPrompts: string[] = [];
    if (isTaskEligible("menu", { ...context, mode: "floor", appFocus: "all" })) {
      floorPrompts.push("مواد اولیهٔ ثبت‌شدهٔ یک آیتم منو را بگو.");
    }
    if (isTaskEligible("split", { ...context, mode: "floor", appFocus: "all" })) {
      floorPrompts.push("صورت‌حساب میز ۳ را برای ۴ نفر تقسیم کن.");
    }
    if (isTaskEligible("menu", { ...context, mode: "floor", appFocus: "all" })) {
      floorPrompts.push("برای سؤال حساسیت غذایی چه داده‌ای ثبت شده است؟");
    }
    if (floorPrompts.length === 0) {
      return GENERAL_ONLY_STARTER_PROMPTS.slice(0, count);
    }
    return floorPrompts.slice(0, count);
  }

  const requestedFocus: AiTaskAppFocus = context?.appFocus ?? "all";
  const focus: AiTaskAppFocus = isFocusEligible(requestedFocus, context)
    ? requestedFocus
    : "all";
  const workspaceEligible = isFocusEligible("workspace", context);
  const websiteEligible = isFocusEligible("website", context);

  // 2. Project context (requires workspace eligibility)
  if (context?.projectId && workspaceEligible) {
    if (focus === "all" || focus === "workspace") {
      return PROJECT_STARTER_PROMPTS.slice(0, count);
    }
    // When both a project and a specific non-workspace focus are active and eligible,
    // combine project context with eligible prompts from that focus.
    const combined: string[] = [PROJECT_STARTER_PROMPTS[0]!];
    const focusPrompts = resolveStarterPrompts({
      ...context,
      projectId: null,
      appFocus: focus,
      count,
    });
    appendUniquePrompts(combined, focusPrompts, count);
    return combined.slice(0, count);
  }

  // 3. Specific app focus selected (validated for eligibility)
  if (focus !== "all") {
    if (focus === "workspace") {
      return FOCUS_STARTER_PROMPTS.workspace.slice(0, count);
    }
    if (focus === "website") {
      return FOCUS_STARTER_PROMPTS.website.slice(0, count);
    }
    if (focus === "crm") {
      return FOCUS_STARTER_PROMPTS.crm.slice(0, count);
    }
    if (focus === "growth") {
      return FOCUS_STARTER_PROMPTS.growth.slice(0, count);
    }
    if (focus === "accounting") {
      if (!hasSpecificTenantContext) {
        return FOCUS_STARTER_PROMPTS.accounting.slice(0, count);
      }
      const accountingPrompts: string[] = [];
      const accountingEligible = isTaskEligible("accounting", {
        ...context,
        mode: "dashboard",
        appFocus: "all",
      });
      const salesEligible = isTaskEligible("sales", {
        ...context,
        mode: "dashboard",
        appFocus: "all",
      });
      if (accountingEligible) {
        appendUniquePrompts(
          accountingPrompts,
          [
            "حساب‌هایم را کامل بررسی کن و یافته‌ها را بگو.",
            "مطالبات مشتریان و بدهی‌های آینده چقدر است؟",
          ],
          count,
        );
      }
      if (salesEligible) {
        appendUniquePrompts(
          accountingPrompts,
          ["فروش هفتهٔ اخیر را خلاصه و با هفتهٔ قبل مقایسه کن."],
          count,
        );
      }
      const accountingTasks = resolveEligibleTasks(
        { ...context, mode: "dashboard", appFocus: "accounting" },
        { includeCustom: false, respectAppFocus: true },
      );
      for (const task of accountingTasks) {
        if (accountingPrompts.length >= count) break;
        appendUniquePrompts(accountingPrompts, task.suggestions ?? [], count);
      }
      return accountingPrompts.length > 0
        ? accountingPrompts.slice(0, count)
        : GENERAL_ONLY_STARTER_PROMPTS.slice(0, count);
    }
  }

  // 4. Default "all" focus
  if (!hasSpecificTenantContext) {
    return (context?.fallback ?? SUGGESTED_PROMPTS.dashboard).slice(0, count);
  }

  const eligibleTasks = resolveEligibleTasks(context, { includeCustom: false });
  const eligibleIds = new Set(eligibleTasks.map((t) => t.id));
  const prompts: string[] = [];

  if (eligibleIds.has("sales")) {
    appendUniquePrompts(
      prompts,
      ["فروش هفتهٔ اخیر را خلاصه و با هفتهٔ قبل مقایسه کن."],
      count,
    );
  }
  if (eligibleIds.has("accounting")) {
    appendUniquePrompts(
      prompts,
      ["خلاصهٔ وضعیت مالی، مطالبات و هزینه‌های این ماه را نشان بده."],
      count,
    );
  }
  if (workspaceEligible) {
    appendUniquePrompts(
      prompts,
      ["وضعیت کارها، پروژه‌ها و پیگیری‌های باز امروز را مرور کن."],
      count,
    );
  }
  if (eligibleIds.has("inventory")) {
    appendUniquePrompts(
      prompts,
      ["کدام اقلام رو به اتمام‌اند و باید خرید شوند؟"],
      count,
    );
  }
  if (eligibleIds.has("customers")) {
    appendUniquePrompts(
      prompts,
      ["مشتریان در خطر ریزش چه کسانی‌اند؟"],
      count,
    );
  }
  if (eligibleIds.has("marketing")) {
    appendUniquePrompts(
      prompts,
      ["بر اساس بخش‌بندی مشتریان یک کمپین پیشنهاد بده."],
      count,
    );
  }
  if (eligibleIds.has("menu")) {
    appendUniquePrompts(prompts, ["عملکرد آیتم‌های منو را تحلیل کن."], count);
  }
  if (eligibleIds.has("operations")) {
    appendUniquePrompts(prompts, ["تداخل رزروهای امروز را بررسی کن."], count);
  }
  if (eligibleIds.has("delivery")) {
    appendUniquePrompts(prompts, ["عملکرد پیک‌ها را مقایسه کن."], count);
  }
  if (websiteEligible) {
    appendUniquePrompts(
      prompts,
      ["وضعیت صفحات، فرم‌ها و سفارش‌های آنلاین وب‌سایت را بررسی کن."],
      count,
    );
  }

  // Fill remaining slots from eligible task suggestions or eligible focus prompts
  for (const task of eligibleTasks) {
    if (prompts.length >= count) break;
    appendUniquePrompts(prompts, task.suggestions ?? [], count);
  }
  if (workspaceEligible && prompts.length < count) {
    appendUniquePrompts(prompts, FOCUS_STARTER_PROMPTS.workspace, count);
  }
  if (websiteEligible && prompts.length < count) {
    appendUniquePrompts(prompts, FOCUS_STARTER_PROMPTS.website, count);
  }

  if (prompts.length === 0) {
    return GENERAL_ONLY_STARTER_PROMPTS.slice(0, count);
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
    !isTaskEligible(task, { ...input.eligibility, mode: input.mode })
  ) {
    return null;
  }
  return task.directive;
}
