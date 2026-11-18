/**
 * The required setup prerequisites, derived from persisted domain data.
 *
 * Kept separate from setup-state.ts so platform provisioning and industry
 * transitions can use exactly the same contract without importing the
 * server-component/auth/database helpers in that module.
 */
import type { AppKey } from "./apps";
import type { Industry } from "./industries";
import { setupStepRequired } from "./setup-apps";
import { requiredStepsForIndustry } from "./wizard-steps";

export interface SetupReadiness {
  /** Required step id → is its domain prerequisite actually present? */
  steps: Record<string, boolean>;
  /** Owner-facing messages for whatever is still missing, in wizard order. */
  missing: string[];
  ready: boolean;
}

/**
 * Readiness is deliberately independent of progress markers: a stale marker
 * cannot make an absent menu, costing choice, or other required prerequisite
 * appear ready.
 */
export function setupReadiness(input: {
  industry: Industry;
  hasBusiness: boolean;
  hasLocation: boolean;
  hasPrefs: boolean;
  hasCosting: boolean;
  hasTax: boolean;
  accounts: number;
  /** Active items in menu_items across the business's branches. F&B only. */
  sellableMenuItems: number;
  /**
   * The owner's explicit app choice. `null`/absent = the legacy state (no
   * gallery save yet), which keeps every industry-required step. An explicit
   * list drops the steps owned by an app that was not selected — a zero-app
   * onboarding is complete without a chart of accounts or a menu.
   */
  selectedApps?: readonly AppKey[] | null;
}): SetupReadiness {
  const required = requiredStepsForIndustry(input.industry).filter((step) =>
    setupStepRequired(step, input.selectedApps),
  );
  const satisfied: Record<string, boolean> = {
    business: input.hasBusiness && input.hasLocation && input.hasPrefs,
    accounts: input.accounts > 0,
    costing: input.hasCosting,
    tax: input.hasTax,
    menu: input.sellableMenuItems > 0,
  };

  const messages: Record<string, string> = {
    business: "اطلاعات کسب‌وکار ثبت نشده است.",
    accounts: "سرفصل حساب‌ها ایجاد نشده است.",
    costing: "روش قیمت‌گذاری موجودی انتخاب نشده است.",
    tax: "نرخ مالیات تنظیم نشده است.",
    menu: "منو باید حداقل یک آیتم فعال و قابل فروش داشته باشد.",
  };

  const steps: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const step of required) {
    steps[step] = satisfied[step] ?? false;
    if (!steps[step]) missing.push(messages[step] ?? step);
  }
  return { steps, missing, ready: missing.length === 0 };
}
