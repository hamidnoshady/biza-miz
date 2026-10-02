/**
 * Reads and writes the Growth-wide settings row (migration 0192). The rules
 * live in `growth-settings.ts`; this file is only the storage half.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { GROWTH_SETTINGS_DEFAULTS, type GrowthSettings } from "./growth-settings";

interface Row extends Record<string, unknown> {
  attribution_window_days: number | null;
  discount_budget_rial: string | null;
}

function fromRow(row: Row | undefined): GrowthSettings {
  if (!row) return { ...GROWTH_SETTINGS_DEFAULTS };
  return {
    attributionWindowDays: row.attribution_window_days,
    discountBudgetRial: row.discount_budget_rial === null ? null : Number(row.discount_budget_rial),
  };
}

/** The business's settings, or the code defaults when it has never saved any. */
export async function getGrowthSettings(businessId: string, client?: PoolClient): Promise<GrowthSettings> {
  const sql = `SELECT attribution_window_days, discount_budget_rial::text AS discount_budget_rial
                 FROM growth_settings WHERE business_id = $1`;
  const { rows } = client ? await client.query<Row>(sql, [businessId]) : await query<Row>(sql, [businessId]);
  return fromRow(rows[0]);
}

/**
 * Applies a validated partial update. Keys the patch does not name keep their
 * stored (or default) value — never a full-body rewrite from a partial one.
 */
export async function updateGrowthSettings(
  businessId: string,
  patch: Partial<GrowthSettings>,
  updatedBy: string,
): Promise<GrowthSettings> {
  const next = { ...(await getGrowthSettings(businessId)), ...patch };
  const { rows } = await query<Row>(
    `INSERT INTO growth_settings (business_id, attribution_window_days, discount_budget_rial, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (business_id) DO UPDATE
       SET attribution_window_days = EXCLUDED.attribution_window_days,
           discount_budget_rial = EXCLUDED.discount_budget_rial,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING attribution_window_days, discount_budget_rial::text AS discount_budget_rial`,
    [businessId, next.attributionWindowDays, next.discountBudgetRial, updatedBy],
  );
  return fromRow(rows[0]);
}
