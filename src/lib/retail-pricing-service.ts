/**
 * Persistence for the New Product price-suggestion policy (DB-touching, so not
 * unit-tested directly — the rules are in retail-pricing-policy.ts).
 */
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import {
  normalizeRetailPricingPolicy,
  type RetailPricingPolicy,
} from "./retail-pricing-policy";

export async function getRetailPricingPolicy(businessId: string): Promise<RetailPricingPolicy> {
  return normalizeRetailPricingPolicy(await getSetting<unknown>(businessId, SETTING_KEYS.retailPricing));
}

export async function setRetailPricingPolicy(businessId: string, policy: RetailPricingPolicy): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.retailPricing, policy);
}

/**
 * The business's default VAT rate, as the tax settings hold it. The suggestion
 * reads it rather than keeping a rate of its own, so changing the rate in one
 * place changes every suggestion. Null when none has been set; zero is a real
 * rate and is returned as zero.
 */
export async function getDefaultTaxPercent(businessId: string): Promise<number | null> {
  const stored = await getSetting<{ defaultRate?: unknown }>(businessId, SETTING_KEYS.tax);
  const rate = stored?.defaultRate;
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : null;
}
