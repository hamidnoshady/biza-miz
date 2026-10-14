import type { Industry } from "@/lib/industries";
import { wizardStepsForIndustry, type WizardStep } from "@/lib/wizard-steps";

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
  { id: "accounts", path: "/setup/accounts", title: "سرفصل حساب‌ها", short: "حساب‌ها" },
  { id: "costing", path: "/setup/costing", title: "روش قیمت‌گذاری موجودی", short: "قیمت‌گذاری" },
  { id: "tax", path: "/setup/tax", title: "تنظیم مالیات", short: "مالیات" },
  { id: "users", path: "/setup/users", title: "نقش‌ها و کاربران", short: "کاربران", optional: true },
  { id: "menu", path: "/setup/menu", title: "ورود منو", short: "منو" },
  { id: "hardware", path: "/setup/hardware", title: "اتصال سخت‌افزار", short: "سخت‌افزار", optional: true },
  { id: "backup", path: "/setup/backup", title: "مقصد پشتیبان‌گیری", short: "پشتیبان", optional: true },
  { id: "opening", path: "/setup/opening", title: "مانده‌های افتتاحیه", short: "افتتاحیه", optional: true },
];

/** The step sequence for one business, in order — `setup-state.ts`'s `wizardStepsForIndustry` decides which ids, this resolves them back to their metadata. */
export function stepsFor(industry: Industry): StepMeta[] {
  const ids = new Set(wizardStepsForIndustry(industry));
  return STEPS.filter((s) => ids.has(s.id));
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
 */
export function skipToPath(id: WizardStep, steps: StepMeta[]): string {
  const fullIndex = stepIndex(id, STEPS);
  for (let i = fullIndex + 1; i < STEPS.length; i++) {
    if (steps.some((s) => s.id === STEPS[i].id)) return STEPS[i].path;
  }
  return "/setup/finish";
}
