/**
 * Cost-plus pricing orchestration (DB-touching, not unit-tested directly per
 * repo convention — the math lives in pricing.ts and is what pricing.test.ts
 * covers). Ties together three things nothing in the codebase previously
 * connected: a menu item's recipe (menu_item_ingredients × inventory_items'
 * running avg_cost) for material cost, the ledger's P&L for an overhead
 * recovery rate, and a target gross margin (per-item override, else the
 * business default) — see computeSuggestedPrice.
 */
import type { Rial } from "./money";
import { query } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { getProfitAndLoss } from "./reports-service";
import { BUSINESS_WIDE_SCOPE } from "./report-scope";
import { addDays } from "./rollup";
import { computeSuggestedPrice } from "./pricing";
import { recipeCostDrift } from "./cost-drift";

export const OVERHEAD_LOOKBACK_DAYS = 30;

/** The default drift threshold, used only until an owner sets their own. */
export const DEFAULT_COST_DRIFT_THRESHOLD_PERCENT = 20;

/** Manual percentages use the same sanity ceiling in the service and API. */
export const MAX_OVERHEAD_PERCENT = 1000;
export const MAX_COST_DRIFT_THRESHOLD_PERCENT = 1000;

export interface PricingConfig {
  /** Business-wide target gross margin (%), applied to any item without its own override. Null until an owner sets one. */
  defaultMarginPercent: number | null;
  /**
   * Manually estimated overhead (%), used only until the ledger has 30 days
   * of real revenue to derive a rate from — a new business (or one that's
   * posted rent/setup expenses before its first sale) would otherwise get
   * suggestions with zero overhead baked in, since there's nothing to divide
   * by yet. In automatic mode it is used until the ledger-derived rate is
   * available; in manual mode it remains active indefinitely.
   */
  fallbackOverheadPercent: number | null;
  /** Selects whether a configured estimate remains in use after ledger data is available. */
  overheadMode?: "automatic" | "manual";
  /** Phase 27 Wave 12 — flag a recipe whose ingredient cost rose this many percent or more. Optional: absent = the default. */
  costDriftThresholdPercent?: number;
}

function storedPercent(value: unknown, options: { max: number; allowZero?: boolean }): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || (!options.allowZero && value === 0) || value >= options.max) return null;
  return value;
}

export async function getPricingConfig(businessId: string): Promise<PricingConfig> {
  const stored = await getSetting<PricingConfig>(businessId, SETTING_KEYS.pricing);
  return {
    // Settings predate the current API validation and can also be restored from
    // an old backup. Normalize them here as well as at the write boundary so a
    // malformed value can never turn a suggestion into Infinity/NaN.
    defaultMarginPercent: storedPercent(stored?.defaultMarginPercent, { max: 100, allowZero: true }),
    fallbackOverheadPercent: storedPercent(stored?.fallbackOverheadPercent, {
      max: MAX_OVERHEAD_PERCENT,
      allowZero: true,
    }),
    overheadMode: stored?.overheadMode === "manual" ? "manual" : "automatic",
    costDriftThresholdPercent:
      storedPercent(stored?.costDriftThresholdPercent, {
        max: MAX_COST_DRIFT_THRESHOLD_PERCENT,
      }) ?? DEFAULT_COST_DRIFT_THRESHOLD_PERCENT,
  };
}

export async function setPricingConfig(businessId: string, config: PricingConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.pricing, config);
}

export interface EffectiveOverheadRate {
  /** The rate suggestions currently use, or null when neither ledger data nor an estimate exists. */
  ratePercent: number | null;
  source: "ledger" | "fallback" | "none";
  /** Kept separately so the settings screen can explain why an automatic estimate is or is not active. */
  ledgerRatePercent: number | null;
  lookbackDays: number;
}

/**
 * Resolves the one overhead policy used by suggestions, drift reporting and
 * the settings status. Keeping this in one place prevents those three surfaces
 * from disagreeing about whether the ledger or the configured estimate wins.
 */
export async function getEffectiveOverheadRate(
  businessId: string,
  config?: PricingConfig,
): Promise<EffectiveOverheadRate> {
  const resolvedConfig = config ?? (await getPricingConfig(businessId));
  const dateTo = new Date().toISOString().slice(0, 10);
  /*
   * Business-wide on purpose (issue #819).
   *
   * Cost-plus pricing is *one policy for the business*, not a per-branch one:
   * `settings.pricing` stores a single margin and overhead for the whole
   * business, menu items inherit it, and the surfaces that read this rate are
   * the settings screen (`settings.manage`) and a menu item's suggested price.
   * A branch filter here would derive a rate from one branch's revenue and
   * expenses and then apply it to prices the other branches sell at — which is
   * not a stricter answer, it is a wrong one.
   *
   * It used to be `getProfitAndLoss(businessId, range)`: the same read, but
   * spelled as a forgotten argument. `BUSINESS_WIDE_SCOPE` says it out loud, so
   * an audit can tell a decision from an omission.
   */
  const pnl = await getProfitAndLoss(
    businessId,
    {
      dateFrom: addDays(dateTo, -(OVERHEAD_LOOKBACK_DAYS - 1)),
      dateTo,
    },
    BUSINESS_WIDE_SCOPE,
  );
  const rawLedgerRate =
    pnl.totalRevenue > 0 ? ((pnl.operatingExpenses + pnl.laborCost) / pnl.totalRevenue) * 100 : null;
  // Expense reversals can make a short window's net overhead negative. A
  // recovery rate below zero would price an item below its material cost, so
  // zero is the safe lower bound while still reporting the ledger as source.
  const ledgerRatePercent =
    rawLedgerRate != null && Number.isFinite(rawLedgerRate) ? Math.max(0, rawLedgerRate) : null;
  const useLedger = resolvedConfig.overheadMode !== "manual";
  const ratePercent = useLedger
    ? ledgerRatePercent ?? resolvedConfig.fallbackOverheadPercent
    : resolvedConfig.fallbackOverheadPercent;
  const source: EffectiveOverheadRate["source"] =
    useLedger && ledgerRatePercent != null
      ? "ledger"
      : resolvedConfig.fallbackOverheadPercent != null
        ? "fallback"
        : "none";

  return { ratePercent, source, ledgerRatePercent, lookbackDays: OVERHEAD_LOOKBACK_DAYS };
}

export interface SuggestedPriceBreakdown {
  materialCost: Rial;
  hasRecipe: boolean;
  /** Percent of material cost recovered as overhead — from the ledger when there's revenue to derive a rate from, else the manual fallback, else null. */
  overheadRatePercent: number | null;
  overheadSource: "ledger" | "fallback" | "none";
  loadedCost: Rial;
  marginPercent: number | null;
  marginSource: "item" | "default" | "none";
  /** Null whenever there's no recipe or no margin configured — a bare material cost of 0 is not a suggestion. */
  suggestedPrice: Rial | null;
  currentPrice: Rial;
}

export async function getSuggestedPrice(businessId: string, menuItemId: string): Promise<SuggestedPriceBreakdown | null> {
  const { rows: itemRows } = await query<{ price: string; target_margin_percent: string | null }>(
    `SELECT mi.price, mi.target_margin_percent
       FROM menu_items mi
       JOIN locations l ON l.id = mi.location_id
      WHERE mi.id = $1 AND l.business_id = $2`,
    [menuItemId, businessId],
  );
  const item = itemRows[0];
  if (!item) return null;

  const { rows: recipeRows } = await query<{ ingredient_count: string; cost: string }>(
    `SELECT count(*) AS ingredient_count, COALESCE(SUM(mi.quantity * ii.avg_cost), 0) AS cost
       FROM menu_item_ingredients mi
       JOIN inventory_items ii ON ii.id = mi.inventory_item_id
      WHERE mi.menu_item_id = $1`,
    [menuItemId],
  );
  const hasRecipe = Number(recipeRows[0].ingredient_count) > 0;
  const materialCost = Math.round(Number(recipeRows[0].cost));

  const config = await getPricingConfig(businessId);
  const overhead = await getEffectiveOverheadRate(businessId, config);
  const overheadRatePercent = overhead.ratePercent;
  const overheadSource = overhead.source;

  const itemMargin = item.target_margin_percent != null ? Number(item.target_margin_percent) : null;
  const marginPercent = itemMargin ?? config.defaultMarginPercent;
  const marginSource: SuggestedPriceBreakdown["marginSource"] =
    itemMargin != null ? "item" : config.defaultMarginPercent != null ? "default" : "none";

  const { loadedCost, suggestedPrice } = computeSuggestedPrice({ materialCost, overheadRatePercent, marginPercent });

  return {
    materialCost,
    hasRecipe,
    overheadRatePercent,
    overheadSource,
    loadedCost,
    marginPercent,
    marginSource,
    suggestedPrice: hasRecipe ? suggestedPrice : null,
    currentPrice: Number(item.price),
  };
}

export interface MenuCostDriftRow {
  menuItemId: string;
  name: string;
  /** Current loaded recipe cost (materials plus the active overhead policy), integer Rial. */
  currentCost: number;
  /** Loaded cost implied by the current price at the target margin, integer Rial. */
  referenceCost: number;
  price: number;
  costChangePercent: number;
  oldMarginPercent: number;
  newMarginPercent: number;
}

/**
 * Phase 27 Wave 12 — menu items whose ingredient cost has risen past the
 * business's threshold since they were priced. The reference cost is the
 * material cost the current price implies at the item's target margin (or
 * the business default), so no price-history snapshot is required.
 */
export async function listMenuCostDrift(businessId: string, locationId: string): Promise<MenuCostDriftRow[]> {
  const config = await getPricingConfig(businessId);
  const overhead = await getEffectiveOverheadRate(businessId, config);
  const { rows } = await query<{
    menu_item_id: string;
    name: string;
    price: string;
    target_margin_percent: string | null;
    current_cost: string;
  }>(
    `SELECT mi.id AS menu_item_id, mi.name, mi.price::text,
            mi.target_margin_percent::text,
            COALESCE(SUM(ing.quantity * ii.avg_cost), 0)::text AS current_cost
       FROM menu_items mi
       LEFT JOIN menu_item_ingredients ing ON ing.menu_item_id = mi.id
       LEFT JOIN inventory_items ii ON ii.id = ing.inventory_item_id
      WHERE mi.location_id = $1 AND mi.is_active
      GROUP BY mi.id, mi.name, mi.price, mi.target_margin_percent`,
    [locationId],
  );

  const out: MenuCostDriftRow[] = [];
  for (const r of rows) {
    const price = Number(r.price);
    // A free/invalid item has no selling-price basis from which to reverse a
    // target cost, and would otherwise produce an Infinity that JSON turns
    // into null while the TypeScript contract still claims it is a number.
    if (!Number.isFinite(price) || price <= 0) continue;
    const materialCost = Math.round(Number(r.current_cost));
    // Number(null) is 0. The previous implementation therefore treated every
    // item without an override as an explicit zero-margin item and silently
    // ignored the business default. Preserve null before converting.
    const itemMargin = r.target_margin_percent == null ? null : Number(r.target_margin_percent);
    const marginPercent = itemMargin ?? config.defaultMarginPercent;
    // Without either margin there is no pricing basis from which a reference
    // cost can be inferred. Inventing a 0% target made the report look precise
    // while measuring against a policy the business never selected.
    if (marginPercent == null) continue;

    // The target margin is applied to loaded cost, not bare recipe cost. Compare
    // like with like: current material cost with the active overhead folded in,
    // versus the loaded cost implied by the current price and target margin.
    const currentCost = computeSuggestedPrice({
      materialCost,
      overheadRatePercent: overhead.ratePercent,
      marginPercent: null,
    }).loadedCost;
    const referenceCost = Math.round(price * (1 - marginPercent / 100));
    const drift = recipeCostDrift({
      currentCost,
      referenceCost,
      price,
      thresholdPercent: config.costDriftThresholdPercent ?? DEFAULT_COST_DRIFT_THRESHOLD_PERCENT,
    });
    if (!drift.drifted) continue;
    out.push({
      menuItemId: r.menu_item_id,
      name: r.name,
      currentCost,
      referenceCost,
      price,
      costChangePercent: Math.round(drift.costChangePercent),
      oldMarginPercent: Math.round(drift.oldMarginPercent),
      newMarginPercent: Math.round(drift.newMarginPercent),
    });
  }
  return out.sort((a, b) => b.costChangePercent - a.costChangePercent);
}
