/**
 * The setup wizard's step sequence — pure, framework-free (no db/next
 * imports) so it's safe to import from client components (`src/app/setup/
 * steps.ts`) as well as server code (`setup-state.ts`, which re-exports
 * these for its existing importers).
 */
import type { Industry } from "./industries";

export const WIZARD_STEPS = [
  "business",
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
export const OPTIONAL_STEPS: WizardStep[] = ["users", "hardware", "backup", "opening"];

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

/** The step sequence a business actually walks through, given its industry. */
export function wizardStepsForIndustry(industry: Industry): WizardStep[] {
  if (industry === "food_service") return [...WIZARD_STEPS];
  return WIZARD_STEPS.filter((s) => !FOOD_SERVICE_ONLY_STEPS.includes(s));
}

export function isAecIndustry(industry: Industry): boolean {
  return industry === "architecture_construction";
}
