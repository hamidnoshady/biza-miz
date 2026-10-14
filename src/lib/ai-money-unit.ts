/**
 * Issue #812 §15 — the business's own money display unit, for the AI runtime.
 *
 * Storage is integer Rial everywhere in this platform and never changes. What
 * the owner chose in the setup wizard / settings is the *display* unit, and the
 * assistant must speak that unit: a business that picked «ریال» must never be
 * told «تومان», and the model must never be instructed to always divide by ten.
 *
 * Reads the same `settings` row every other product surface reads
 * (`SETTING_KEYS.businessPrefs`), so there is one source of truth and no second
 * preference to drift. Never throws — an unread preference is the historical
 * default (Toman), exactly what the rest of the product falls back to.
 */
import { query } from "./db";
import type { MoneyUnit } from "./money";

const DEFAULT_UNIT: MoneyUnit = "toman";

function isMoneyUnit(value: unknown): value is MoneyUnit {
  return value === "toman" || value === "rial";
}

/**
 * Reads the business's chosen money display unit. Returns `toman` when the
 * preference is absent, unreadable or unrecognised.
 */
export async function resolveBusinessMoneyUnit(businessId: string): Promise<MoneyUnit> {
  try {
    const { rows } = await query<{ value: { currencyDisplay?: unknown } | null }>(
      `SELECT value FROM settings
        WHERE business_id = $1 AND location_id IS NULL AND key = 'business.prefs'`,
      [businessId],
    );
    const currencyDisplay = rows[0]?.value?.currencyDisplay;
    return isMoneyUnit(currencyDisplay) ? currencyDisplay : DEFAULT_UNIT;
  } catch {
    return DEFAULT_UNIT;
  }
}
