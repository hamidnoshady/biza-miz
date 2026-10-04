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
 * The three onboarding shapes the enabled industries fall into. Named shapes
 * (rather than "F&B, and everything else") so the review the setup audit asked
 * for — "does every enabled industry have an intentional path?" — has one
 * explicit answer per industry, assertable in a table-driven test
 * (wizard-steps.test.ts) and readable here without following a filter
 * expression.
 */
export type SetupShape = "food_service" | "retail" | "service";

/**
 * Which shape each *enabled* industry walks. A new industry must be added here
 * deliberately; TypeScript's `Record<Industry, …>` makes forgetting one a
 * compile error, so no industry can silently inherit F&B's steps.
 */
const SETUP_SHAPE: Record<Industry, SetupShape> = {
  food_service: "food_service",
  // Trade-goods retail: a catalogue of `items` (Phase 21/42), not `menu_items`,
  // whose costing follows the item model rather than inventory.costing — so
  // neither `costing` nor `menu` applies. That catalogue deliberately has no
  // wizard step: the products workspace (/accounting/products, or the trade's
  // own «کالاها» page) is its one door, and the wizard points at it instead of
  // growing a second, weaker item-entry form (see catalogueHrefFor below).
  jewelry: "retail",
  watch: "retail",
  accessories: "retail",
  cosmetics: "retail",
  wholesale: "retail",
  tools_fittings: "retail",
  haberdashery: "retail",
  // Service companies have no stock model and no sellable catalogue in the
  // POS sense; their invoices are written from the services they configure in
  // the normal app. They keep the accounting/admin skeleton only.
  service_saas: "service",
};

/**
 * Steps that only make sense for F&B: `costing` picks a method for
 * `inventory_items`/`stock_movements` (Phase 6), and `menu` enters
 * `menu_items`/`menu_categories` (Phase 2). Neither table is used by a
 * trade-goods business, whose catalogue is `items`/`item_stock` with its own
 * batches and per-item costing (Phase 21/42), nor by a service company.
 */
const FOOD_SERVICE_ONLY_STEPS: WizardStep[] = ["costing", "menu"];

export function setupShapeForIndustry(industry: Industry): SetupShape {
  return SETUP_SHAPE[industry] ?? "food_service";
}

/** The step sequence a business actually walks through, given its industry. */
export function wizardStepsForIndustry(industry: Industry): WizardStep[] {
  if (setupShapeForIndustry(industry) === "food_service") return [...WIZARD_STEPS];
  return WIZARD_STEPS.filter((s) => !FOOD_SERVICE_ONLY_STEPS.includes(s));
}

/** The steps that must be satisfied before the wizard can be finished. */
export function requiredStepsForIndustry(industry: Industry): WizardStep[] {
  return wizardStepsForIndustry(industry).filter((s) => !OPTIONAL_STEPS.includes(s));
}

/**
 * Where a non-F&B trade enters the things it sells, for the wizard's
 * "your catalogue lives here" pointer on the finish page. `null` means the
 * trade has no separate catalogue door (service companies).
 *
 * Kept next to the step map because it is the answer to the same question the
 * step map answers — "where does this trade's onboarding actually send you?"
 * The strings are the app's canonical routes; the products workspace's own
 * helper (lib/product-workspace.ts) covers the same five retail trades for the
 * sidebar, and this only fills the gap the wizard has.
 */
export function catalogueHrefFor(industry: Industry): string | null {
  switch (industry) {
    case "accessories":
    case "cosmetics":
    case "wholesale":
    case "tools_fittings":
    case "haberdashery":
      return "/accounting/products";
    case "jewelry":
      return "/accounting/jewelry";
    case "watch":
      return "/accounting/watch";
    default:
      return null;
  }
}
