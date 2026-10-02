/**
 * The setup wizard's step sequence — pure, framework-free (no db/next
 * imports) so it's safe to import from client components (`src/app/setup/
 * steps.ts`) as well as server code (`setup-state.ts`, which re-exports
 * these for its existing importers).
 */
import type { Industry } from "./industries";

export const WIZARD_STEPS = [
  "business",
  // Issue #799 Wave 2 — «پروفایل کسب‌وکار» for an AEC business: which of the
  // eight operating profiles (architecture office, contractor, individual, …)
  // it is. It follows `business` because that is where the industry was chosen,
  // and the issue's §2 asks for exactly that order. Optional: skipping it keeps
  // the default preset, which is a working state, and the same choice is
  // editable later in «تنظیمات ← کسب‌وکار و شعبه».
  "aec_profile",
  "accounts",
  "costing",
  "tax",
  "users",
  "menu",
  "hardware",
  "backup",
  "opening",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Steps that may be skipped and still allow finishing the wizard. */
export const OPTIONAL_STEPS: WizardStep[] = ["aec_profile", "users", "hardware", "backup", "opening"];

/**
 * Steps that only make sense for F&B: `costing` picks a method for
 * `inventory_items`/`stock_movements` (Phase 6), and `menu` enters
 * `menu_items`/`menu_categories` (Phase 2) -- neither table exists in a
 * jewelry business's data model (Phase 21's `items`/`item_weight_attributes`
 * are a parallel, separate primitive, never migrated onto or from the F&B
 * one -- see Phase-21's "Revised" scope decision). Any other enabled
 * industry gets the same reduced set until it has its own costing/catalog
 * step to add here.
 */
const FOOD_SERVICE_ONLY_STEPS: WizardStep[] = ["costing", "menu"];

/**
 * Steps only the AEC industry walks (issue #799). The mirror image of the F&B
 * pair above: an architecture/engineering/construction business is asked to
 * pick its operating profile, and no other trade is asked a question that has
 * no meaning for it.
 */
const AEC_ONLY_STEPS: WizardStep[] = ["aec_profile"];

/** The step sequence a business actually walks through, given its industry. */
export function wizardStepsForIndustry(industry: Industry): WizardStep[] {
  if (industry === "architecture_construction") return [...WIZARD_STEPS];
  if (industry === "food_service") {
    return WIZARD_STEPS.filter((s) => !AEC_ONLY_STEPS.includes(s));
  }
  return WIZARD_STEPS.filter(
    (s) => !FOOD_SERVICE_ONLY_STEPS.includes(s) && !AEC_ONLY_STEPS.includes(s),
  );
}
