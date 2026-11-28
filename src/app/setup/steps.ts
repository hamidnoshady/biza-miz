import type { AppKey } from "@/lib/apps";
import type { Industry } from "@/lib/industries";
import { setupStepRequired } from "@/lib/setup-apps";
import { WIZARD_STEPS, wizardStepsForIndustry, type WizardStep } from "@/lib/wizard-steps";

export interface StepMeta {
  id: WizardStep;
  path: string;
  title: string;
  short: string;
  optional?: boolean;
}

/** Every step that exists, in wizard order — filter with `stepsFor` for the sequence one business actually walks. */
export const STEPS: StepMeta[] = [
  { id: "business", path: "/setup/business", title: "اطلاعات کسب‌وکار", short: "کسب‌وکار" },
  {
    id: "aec_profile",
    path: "/setup/aec-profile",
    title: "پروفایل کسب‌وکار",
    short: "پروفایل",
    optional: true,
  },
  {
    id: "apps",
    path: "/setup/apps",
    title: "انتخاب برنامه‌های کسب‌وکار",
    short: "برنامه‌ها",
    optional: true,
  },
  {
    id: "app_setup",
    path: "/setup/app-setup",
    title: "راه‌اندازی برنامه‌های انتخاب‌شده",
    short: "راه‌اندازی برنامه",
    optional: true,
  },
  {
    id: "import",
    path: "/setup/import",
    title: "ورود اطلاعات اولیه",
    short: "ورود اطلاعات",
    optional: true,
  },
  { id: "accounts", path: "/setup/accounts", title: "سرفصل حساب‌ها", short: "حساب‌ها" },
  { id: "costing", path: "/setup/costing", title: "روش قیمت‌گذاری موجودی", short: "قیمت‌گذاری" },
  { id: "tax", path: "/setup/tax", title: "تنظیم مالیات", short: "مالیات" },
  { id: "users", path: "/setup/users", title: "نقش‌ها و کاربران", short: "کاربران", optional: true },
  // GitHub #1580 — `menu` is deliberately absent: the restaurant menu is a
  // section of «ورود اطلاعات» now. The id stays in `WIZARD_STEPS` for stored
  // progress markers, the F&B domain API and engine action maps, and
  // `/setup/menu` redirects to the unified step.
  { id: "hardware", path: "/setup/hardware", title: "اتصال سخت‌افزار", short: "سخت‌افزار", optional: true },
  { id: "backup", path: "/setup/backup", title: "مقصد پشتیبان‌گیری", short: "پشتیبان", optional: true },
  { id: "opening", path: "/setup/opening", title: "مانده‌های افتتاحیه", short: "افتتاحیه", optional: true },
];

/**
 * The step sequence for one business, in order — `wizardStepsForIndustry`
 * decides which ids, this resolves them back to their metadata.
 *
 * `selectedApps` narrows the sequence to the apps the owner actually chose:
 * the accounting steps disappear when Accounting was not selected. Leaving it
 * `undefined`/`null` keeps the legacy behaviour (every industry-required step),
 * which is what a business that predates the gallery must still see.
 */
export function stepsFor(
  industry: Industry,
  selectedApps?: readonly AppKey[] | null,
): StepMeta[] {
  const ids = new Set(wizardStepsForIndustry(industry));
  return STEPS.filter((s) => ids.has(s.id) && setupStepRequired(s.id, selectedApps));
}

export function stepIndex(id: string, steps: StepMeta[] = STEPS): number {
  return steps.findIndex((s) => s.id === id);
}

export function nextPath(id: string, steps: StepMeta[] = STEPS): string {
  const i = stepIndex(id, steps);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1].path : "/setup/finish";
}

export function prevPath(id: string, steps: StepMeta[] = STEPS): string | null {
  const i = stepIndex(id, steps);
  return i > 0 ? steps[i - 1].path : null;
}

/**
 * Where to send a business that lands (direct link, back button) on a step
 * its industry doesn't walk (`id` isn't in `steps`): the first step *after*
 * it, in the full sequence, that the business's filtered `steps` does
 * include -- e.g. a jewelry business hitting `/setup/costing` lands on
 * `/setup/tax`, the same place `accounts`'s own "next" already sends it.
 *
 * Order comes from `WIZARD_STEPS` rather than the page metadata table so a
 * legacy id with no page any more (`menu`, #1580) still resolves to the step
 * after it instead of falling back to the first step.
 */
export function skipToPath(id: WizardStep, steps: StepMeta[]): string {
  const fullIndex = WIZARD_STEPS.indexOf(id);
  if (fullIndex < 0) return "/setup/finish";
  const remaining = new Set<WizardStep>(WIZARD_STEPS.slice(fullIndex + 1));
  for (const step of STEPS) {
    if (remaining.has(step.id) && steps.some((s) => s.id === step.id)) return step.path;
  }
  return "/setup/finish";
}
