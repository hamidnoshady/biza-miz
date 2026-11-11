/**
 * Phase 42 — the weight barcode patterns («الگوی بارکد وزنی») a shop's scale
 * prints. One row per two-digit prefix with the unit its five weight digits
 * are measured in; the check digit and item reference are computed at print
 * time (src/lib/weight-barcode.ts), so the record is exactly the two choices
 * the screen offers.
 */
import { query } from "./db";
import { isWeightUnit, validateBarcodePrefix, type WeightUnit } from "./weight-barcode";

export interface WeightBarcodeTemplate {
  id: string;
  locationId: string;
  prefix: string;
  weightUnit: WeightUnit;
  isActive: boolean;
}

interface TemplateRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  prefix: string;
  weight_unit: string;
  is_active: boolean;
}

function mapTemplate(row: TemplateRow): WeightBarcodeTemplate {
  return {
    id: row.id,
    locationId: row.location_id,
    prefix: row.prefix,
    weightUnit: isWeightUnit(row.weight_unit) ? row.weight_unit : "grams",
    isActive: row.is_active,
  };
}

export async function listWeightBarcodeTemplates(
  locationId: string,
): Promise<WeightBarcodeTemplate[]> {
  const { rows } = await query<TemplateRow>(
    `SELECT * FROM weight_barcode_templates WHERE location_id = $1 ORDER BY created_at`,
    [locationId],
  );
  return rows.map(mapTemplate);
}

export async function createWeightBarcodeTemplate(input: {
  locationId: string;
  prefix: string;
  weightUnit: string;
}): Promise<{ template?: WeightBarcodeTemplate; error?: string }> {
  const prefixError = validateBarcodePrefix(input.prefix);
  if (prefixError) return { error: "invalid_prefix" };
  if (!isWeightUnit(input.weightUnit)) return { error: "invalid_weight_unit" };
  try {
    const { rows } = await query<TemplateRow>(
      `INSERT INTO weight_barcode_templates (location_id, prefix, weight_unit)
       VALUES ($1, $2, $3) RETURNING *`,
      [input.locationId, input.prefix, input.weightUnit],
    );
    return { template: mapTemplate(rows[0]) };
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      return { error: "duplicate_prefix" };
    }
    throw err;
  }
}

export async function deleteWeightBarcodeTemplate(id: string, locationId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM weight_barcode_templates WHERE id = $1 AND location_id = $2`, [id, locationId]);
  return (rowCount ?? 0) > 0;
}
