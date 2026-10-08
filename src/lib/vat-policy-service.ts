import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { businessVatPercent, type TaxConfig } from "@/lib/vat-policy";

/** The business's default VAT percent, read from its own `tax.config` (0 when unset). */
export async function getBusinessVatPercent(businessId: string): Promise<number> {
  return businessVatPercent(await getSetting<TaxConfig>(businessId, SETTING_KEYS.tax));
}
