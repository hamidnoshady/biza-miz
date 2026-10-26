/**
 * The per-service setup wizard's *content* (issue #1041 §B).
 *
 * Every app, workspace capability and agent gets its own short wizard that
 * collects the operational facts that service needs before it can be switched
 * on. Three rules make this the right shape:
 *
 *  1. **It is not first-run onboarding.** This never touches
 *     `businesses.setup_progress/completedAt`; the answers live in
 *     `business_service_wizard_state`, one row per service identity, which is
 *     also the one dataset the retention purge deletes (§D). Reopening an app's
 *     wizard must never reopen the business's onboarding (PR #838).
 *  2. **It is resumable and versioned.** State is saved per step with a
 *     monotonically increasing `version` (the service layer's job), so a member
 *     can fill two of three steps, leave, and come back — on another device if
 *     they like. Nothing here stores anything.
 *  3. **It is pure.** The definitions are plain data plus small validators, so
 *     the dialog renders them, the API validates them and a unit test pins them
 *     without a database.
 *
 * The steps are deliberately *requirements*, not preferences: a preference is
 * edited later in the app's own settings, whereas these are the choices an
 * activation needs to exist at all (a fiscal start, a website address, the
 * channel a growth campaign sends through).
 */
import { SERVICE_KINDS, serviceDefinition, type ServiceKind } from "./catalog";

export type WizardFieldKind = "text" | "number" | "select";

export interface WizardField {
  key: string;
  label: string;
  kind: WizardFieldKind;
  /** Toman-free: these are settings, not money. */
  hint?: string;
  required?: boolean;
  maxLength?: number;
  options?: readonly { value: string; label: string }[];
}

export interface WizardStep {
  key: string;
  title: string;
  description: string;
  fields: readonly WizardField[];
}

/** Maximum stored characters per answer — a wizard is not a document store. */
export const WIZARD_VALUE_MAX_LENGTH = 240;

/**
 * The Jalali year a business may start a fiscal year in. Wide enough for a
 * back-dated opening and a next-year planning run, narrow enough that a typo
 * (14000, 140) is refused instead of silently creating a bogus year.
 */
export const FISCAL_YEAR_MIN = 1390;
export const FISCAL_YEAR_MAX = 1450;

function yearField(key: string, label: string, hint: string): WizardField {
  return { key, label, kind: "number", hint, required: true, maxLength: 4 };
}

// ---------------------------------------------------------------------------
// Per-service definitions
// ---------------------------------------------------------------------------

const APP_STEPS: Record<string, readonly WizardStep[]> = {
  accounting: [
    {
      key: "fiscal",
      title: "سال مالی",
      description: "سال مالی جاری و واحد نمایش مبلغ. تاریخ‌ها شمسی و مبالغ به تومان نمایش داده می‌شوند.",
      fields: [
        yearField("fiscalYear", "سال مالی (شمسی)", "مثلاً ۱۴۰۴. سندهای این سال در همین دوره ثبت می‌شوند."),
        {
          key: "moneyUnit",
          label: "واحد نمایش مبلغ",
          kind: "select",
          required: true,
          options: [
            { value: "toman", label: "تومان" },
            { value: "rial", label: "ریال" },
          ],
          hint: "مبالغ همیشه به ریال ذخیره می‌شوند؛ این فقط واحد نمایش است.",
        },
      ],
    },
    {
      key: "opening",
      title: "ماندهٔ افتتاحیه",
      description: "نحوهٔ ورود مانده‌های اولیه: از فایل، دستی، یا بدون ماندهٔ افتتاحیه.",
      fields: [
        {
          key: "openingMode",
          label: "روش ورود مانده‌ها",
          kind: "select",
          required: true,
          options: [
            { value: "none", label: "بدون ماندهٔ افتتاحیه" },
            { value: "manual", label: "ورود دستی" },
            { value: "import", label: "ورود از فایل (CSV/Excel)" },
          ],
        },
      ],
    },
  ],
  crm: [
    {
      key: "people",
      title: "پایهٔ مشتریان",
      description: "این برنامه از کدام مخزن اشخاص شروع کند.",
      fields: [
        {
          key: "customerSource",
          label: "منبع اولیهٔ مشتریان",
          kind: "select",
          required: true,
          options: [
            { value: "existing", label: "استفاده از اشخاص موجود در کسب‌وکار" },
            { value: "import", label: "ورود از فایل" },
            { value: "empty", label: "شروع خالی" },
          ],
        },
      ],
    },
    {
      key: "pipeline",
      title: "قیف فروش",
      description: "نام مرحلهٔ شروع فرصت‌های فروش؛ مراحل بعدی بعداً در تنظیمات قابل تغییر است.",
      fields: [
        {
          key: "firstStage",
          label: "نام مرحلهٔ اول",
          kind: "text",
          required: true,
          maxLength: 60,
          hint: "مثلاً «تماس اولیه».",
        },
      ],
    },
  ],
  growth: [
    {
      key: "channel",
      title: "کانال ارتباط",
      description: "کمپین‌ها و باشگاه مشتریان از کدام کانال پیام می‌فرستند.",
      fields: [
        {
          key: "channel",
          label: "کانال اصلی",
          kind: "select",
          required: true,
          options: [
            { value: "sms", label: "پیامک" },
            { value: "email", label: "ایمیل" },
            { value: "both", label: "هر دو" },
          ],
          hint: "هزینهٔ پیامک و ایمیل جداگانه و طبق مصرف از کیف پول کسر می‌شود.",
        },
      ],
    },
    {
      key: "loyalty",
      title: "باشگاه مشتریان",
      description: "تعداد سطوح وفاداری که از ابتدا تعریف شود (بعداً قابل تغییر است).",
      fields: [
        {
          key: "tierCount",
          label: "تعداد سطوح",
          kind: "number",
          required: true,
          maxLength: 2,
          hint: "عددی بین ۱ تا ۹.",
        },
      ],
    },
  ],
  website: [
    {
      key: "address",
      title: "نشانی سایت",
      description: "دامنه‌ای که سایت روی آن منتشر می‌شود. تا انتشار، سایت فقط در پیش‌نمایش دیده می‌شود.",
      fields: [
        {
          key: "domain",
          label: "دامنه",
          kind: "text",
          required: true,
          maxLength: 180,
          hint: "مثلاً shop.example.ir — بدون //:",
        },
      ],
    },
    {
      key: "publish",
      title: "انتشار",
      description: "سایت با چه وضعیتی راه‌اندازی شود.",
      fields: [
        {
          key: "publishMode",
          label: "وضعیت اولیه",
          kind: "select",
          required: true,
          options: [
            { value: "draft", label: "پیش‌نویس (فقط پیش‌نمایش)" },
            { value: "live", label: "منتشرشده" },
          ],
        },
      ],
    },
  ],
};

/** My Workspace capabilities share one short wizard: they add a module, not a business. */
const WORKSPACE_STEPS: readonly WizardStep[] = [
  {
    key: "workspace",
    title: "دامنهٔ فضای کار",
    description: "این قابلیت برای کدام بخش از کسب‌وکار فعال می‌شود.",
    fields: [
      {
        key: "scope",
        label: "دامنه",
        kind: "select",
        required: true,
        options: [
          { value: "business", label: "کل کسب‌وکار" },
          { value: "branch", label: "یک شعبه" },
        ],
      },
    ],
  },
];

/** A published agent's wizard is its runtime policy, not a business setup. */
const AGENT_STEPS: readonly WizardStep[] = [
  {
    key: "runtime",
    title: "اجرای پس‌زمینه",
    description: "این عامل در چه حالت و با چه تأییدی اجرا می‌شود.",
    fields: [
      {
        key: "runMode",
        label: "حالت اجرا",
        kind: "select",
        required: true,
        options: [
          { value: "suggest", label: "فقط پیشنهاد (بدون تغییر داده)" },
          { value: "confirm", label: "با تأیید کاربر" },
          { value: "auto", label: "خودکار" },
        ],
      },
      {
        key: "timezone",
        label: "منطقهٔ زمانی برنامه",
        kind: "select",
        required: true,
        options: [
          { value: "Asia/Tehran", label: "تهران" },
          { value: "UTC", label: "UTC" },
        ],
      },
    ],
  },
];

/** The wizard for one service identity. Apps are addressed by their key. */
export function wizardStepsFor(kind: ServiceKind, key: string): readonly WizardStep[] {
  if (!SERVICE_KINDS.includes(kind)) return [];
  if (kind === "app") return APP_STEPS[key] ?? GENERIC_APP_STEPS;
  if (kind === "workspace") return WORKSPACE_STEPS;
  return AGENT_STEPS;
}

/**
 * A newly registered app still gets a wizard rather than none: the service
 * layer must not depend on a hand-written definition existing for a key the
 * registry already accepts.
 */
const GENERIC_APP_STEPS: readonly WizardStep[] = [
  {
    key: "start",
    title: "شروع سرویس",
    description: "پیکربندی اولیهٔ این سرویس پیش از فعال‌سازی.",
    fields: [
      {
        key: "startMode",
        label: "وضعیت شروع",
        kind: "select",
        required: true,
        options: [
          { value: "empty", label: "شروع خالی" },
          { value: "existing", label: "استفاده از دادهٔ موجود" },
        ],
      },
    ],
  },
];

/** A human label for the service, for the wizard's own heading. */
export function wizardServiceLabel(kind: ServiceKind, key: string): string {
  return serviceDefinition(kind, key)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Validation and progress
// ---------------------------------------------------------------------------

function isOption(field: WizardField, value: string): boolean {
  return (field.options ?? []).some((option) => option.value === value);
}

function checkField(field: WizardField, raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
  if (!value) return field.required ? "required" : null;
  if (value.length > (field.maxLength ?? WIZARD_VALUE_MAX_LENGTH)) return "too_long";
  if (field.kind === "number" && !/^\d+$/.test(value)) return "not_a_number";
  if (field.kind === "select" && field.options && !isOption(field, value)) {
    return "invalid_option";
  }
  if (field.key === "fiscalYear") {
    const year = Number(value);
    if (year < FISCAL_YEAR_MIN || year > FISCAL_YEAR_MAX) return "invalid_year";
  }
  if (field.key === "tierCount") {
    const tiers = Number(value);
    if (tiers < 1 || tiers > 9) return "out_of_range";
  }
  if (field.key === "domain" && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(value)) {
    return "invalid_domain";
  }
  return null;
}

/**
 * Validates ONE step's answers. Returns the first fault as a code + the field,
 * so the dialog can put the message beside the input instead of a banner.
 */
export function validateWizardStep(
  step: WizardStep,
  progress: Record<string, unknown>,
): { field: string; code: string } | null {
  for (const field of step.fields) {
    const fault = checkField(field, progress[field.key]);
    if (fault) return { field: field.key, code: fault };
  }
  return null;
}

export interface WizardProgress {
  /** Steps whose answers are all valid, in definition order. */
  completedSteps: string[];
  /** The first incomplete step, or null when the whole wizard is done. */
  nextStep: WizardStep | null;
  complete: boolean;
}

/** Where a saved draft stands — what the dialog shows on reopen. */
export function wizardProgress(
  steps: readonly WizardStep[],
  progress: Record<string, unknown>,
): WizardProgress {
  const completedSteps: string[] = [];
  let nextStep: WizardStep | null = null;
  for (const step of steps) {
    if (validateWizardStep(step, progress) === null) {
      completedSteps.push(step.key);
    } else if (nextStep === null) {
      nextStep = step;
    }
  }
  return { completedSteps, nextStep, complete: nextStep === null };
}

/**
 * Keeps only the answers the wizard actually asks for, trimmed and bounded.
 *
 * This is the write-side filter: a client may post anything, and a purge deletes
 * this row on the retention deadline, so what is stored must be exactly the
 * wizard's own vocabulary — no free-form blob that could later be mistaken for
 * operational data the customer wanted to keep.
 */
export function normalizeWizardProgress(
  steps: readonly WizardStep[],
  progress: Record<string, unknown>,
): Record<string, string> {
  const known = new Set(steps.flatMap((step) => step.fields.map((field) => field.key)));
  const normalized: Record<string, string> = {};
  for (const [key, raw] of Object.entries(progress ?? {})) {
    if (!known.has(key)) continue;
    const value = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    if (!value) continue;
    normalized[key] = value.slice(0, WIZARD_VALUE_MAX_LENGTH);
  }
  return normalized;
}

/** The step key recorded with a save: the step just filled, or the last one. */
export function nextWizardStepKey(
  steps: readonly WizardStep[],
  progress: Record<string, unknown>,
): string {
  const state = wizardProgress(steps, progress);
  return state.nextStep?.key ?? steps[steps.length - 1]?.key ?? "start";
}

/** Persian messages for the validation codes, ready for the dialog. */
export const WIZARD_ERROR_MESSAGES: Record<string, string> = {
  required: "این مورد الزامی است.",
  too_long: "مقدار واردشده بیش از حد بلند است.",
  not_a_number: "فقط عدد وارد کنید.",
  invalid_option: "یکی از گزینه‌ها را انتخاب کنید.",
  invalid_year: `سال شمسی باید بین ${FISCAL_YEAR_MIN} و ${FISCAL_YEAR_MAX} باشد.`,
  out_of_range: "مقدار خارج از بازهٔ مجاز است.",
  invalid_domain: "نام دامنه معتبر نیست (بدون //: و بدون فاصله).",
};
