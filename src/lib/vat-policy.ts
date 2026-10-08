/**
 * Where a VAT rate comes from — audit F05.
 *
 * There is no platform-wide assumed rate. A business may be exempt (0%) or
 * liable at whatever rate its trade carries, so the one source of the default
 * is that business's own «تنظیمات مالیات» (`tax.config` → `defaultRate`, kept by
 * the setup wizard and Settings → Tax). A party's stored rate is an override
 * (`parties.ts`, `null` = follows this), a menu category carries its own rate,
 * and a retail line or repair bill can still be edited before it is issued.
 *
 * An unset or unreadable setting resolves to 0 rather than to a guessed rate:
 * charging tax the business never configured is worse than charging none, and
 * the till shows the rate on every line where it can be corrected.
 *
 * Pure on purpose (client components import it); the database read is
 * `getBusinessVatPercent` in `vat-policy-service.ts`.
 */

/** `tax.config` as stored. */
export interface TaxConfig {
  defaultRate?: unknown;
}

/** The business's default VAT percent from its stored `tax.config`. */
export function businessVatPercent(config: TaxConfig | null | undefined): number {
  const raw = config?.defaultRate;
  if (raw === null || raw === undefined || raw === "") return 0;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return 0;
  return Math.round(value * 100) / 100;
}
