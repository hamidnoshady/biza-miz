/**
 * Growth-wide configuration (issue #764, «تنظیمات رشد و بازاریابی»).
 *
 * The settings page used to be a second dashboard: counts of programs,
 * campaigns and templates with links back to the screens that own them. It
 * now owns two genuinely app-wide decisions, and only two, because each one is
 * read by something real:
 *
 *   - `attributionWindowDays` — how long after a message campaign starts a
 *     sale using its dedicated promotion still counts toward that campaign's
 *     return. Read by `listMessageCampaignRoiReport`. `null` = no limit, the
 *     previous behaviour.
 *   - `discountBudgetRial` — the most campaign discount the business wants to
 *     give away in any rolling 30 days. Read by the Growth dashboard, which
 *     shows usage against it and raises a recommendation when it is exceeded.
 *     It is a *threshold*, not a hard stop: the promotion engine never refuses
 *     a sale on its account. `null` = no budget.
 *
 * Module-specific settings (a loyalty program's rates, a campaign's schedule,
 * a commission rule) stay on their own screens. Framework-free; the service
 * and the form both validate through `parseGrowthSettingsInput`.
 */

export interface GrowthSettings {
  attributionWindowDays: number | null;
  discountBudgetRial: number | null;
}

/**
 * No limit and no budget: exactly what a business got before these settings
 * existed, so saving nothing changes no report.
 */
export const GROWTH_SETTINGS_DEFAULTS: GrowthSettings = {
  attributionWindowDays: null,
  discountBudgetRial: null,
};

export const ATTRIBUTION_WINDOW_LIMITS = { min: 1, max: 365 } as const;

/** A trillion Toman (10^13 Rial): far above any real budget, far below bigint trouble. */
export const MAX_DISCOUNT_BUDGET_RIAL = 10_000_000_000_000;

export type GrowthSettingsParse =
  | { ok: true; value: Partial<GrowthSettings> }
  | { ok: false; errors: string[] };

/**
 * Validates a PATCH body. A key the body does not name is left alone; `null`
 * clears it to "no limit". Unknown keys are ignored rather than rejected, so a
 * newer form cannot break an older server.
 */
export function parseGrowthSettingsInput(body: unknown): GrowthSettingsParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["درخواست نامعتبر است."] };
  }
  const input = body as Record<string, unknown>;
  const value: Partial<GrowthSettings> = {};
  const errors: string[] = [];

  if ("attributionWindowDays" in input) {
    const raw = input.attributionWindowDays;
    if (raw === null) value.attributionWindowDays = null;
    else if (
      typeof raw === "number" &&
      Number.isInteger(raw) &&
      raw >= ATTRIBUTION_WINDOW_LIMITS.min &&
      raw <= ATTRIBUTION_WINDOW_LIMITS.max
    ) {
      value.attributionWindowDays = raw;
    } else {
      errors.push(`بازهٔ انتساب باید عددی صحیح بین ${ATTRIBUTION_WINDOW_LIMITS.min} تا ${ATTRIBUTION_WINDOW_LIMITS.max} روز باشد.`);
    }
  }

  if ("discountBudgetRial" in input) {
    const raw = input.discountBudgetRial;
    if (raw === null) value.discountBudgetRial = null;
    else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 && raw <= MAX_DISCOUNT_BUDGET_RIAL) {
      value.discountBudgetRial = raw;
    } else {
      errors.push("سقف تخفیف باید مبلغی مثبت باشد.");
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Share of the 30-day discount budget already given away, or null without a budget. */
export function discountBudgetUsage(
  discountRial: number,
  budgetRial: number | null,
): { percent: number; exceeded: boolean } | null {
  if (budgetRial === null || budgetRial <= 0) return null;
  const percent = Math.round((discountRial / budgetRial) * 100);
  return { percent, exceeded: discountRial > budgetRial };
}
