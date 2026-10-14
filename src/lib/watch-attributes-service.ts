/**
 * Issue #795 Phase 6 — structured watch attributes: the catalogue facts of
 * a model (reference, movement, case, water resistance, …) as data instead
 * of free text in the name. One optional 1:1 row per `items` entry; the
 * brand stays on items.brand_id (the shared registry).
 */
import { query } from "./db";

export const WATCH_MOVEMENTS = ["automatic", "quartz", "manual", "solar", "kinetic", "smart"] as const;
export type WatchMovement = (typeof WATCH_MOVEMENTS)[number];

export const WATCH_GENDERS = ["men", "women", "unisex"] as const;
export type WatchGender = (typeof WATCH_GENDERS)[number];

export interface WatchItemAttributes {
  referenceNo: string | null;
  movement: WatchMovement | null;
  caseMaterial: string | null;
  caseDiameterMm: number | null;
  waterResistanceM: number | null;
  dialColor: string | null;
  braceletMaterial: string | null;
  gender: WatchGender | null;
}

export interface WatchItemAttributesInput {
  referenceNo?: string | null;
  movement?: string | null;
  caseMaterial?: string | null;
  caseDiameterMm?: number | null;
  waterResistanceM?: number | null;
  dialColor?: string | null;
  braceletMaterial?: string | null;
  gender?: string | null;
}

export function validateWatchAttributes(input: WatchItemAttributesInput): string[] {
  const errors: string[] = [];
  if (input.movement != null && !(WATCH_MOVEMENTS as readonly string[]).includes(input.movement)) {
    errors.push("نوع موتور نامعتبر است.");
  }
  if (input.gender != null && !(WATCH_GENDERS as readonly string[]).includes(input.gender)) {
    errors.push("دسته‌بندی جنسیتی نامعتبر است.");
  }
  if (
    input.caseDiameterMm != null &&
    (!Number.isFinite(input.caseDiameterMm) || input.caseDiameterMm <= 0 || input.caseDiameterMm > 100)
  ) {
    errors.push("قطر قاب باید عددی بین ۰ و ۱۰۰ میلی‌متر باشد.");
  }
  if (
    input.waterResistanceM != null &&
    (!Number.isInteger(input.waterResistanceM) || input.waterResistanceM < 0 || input.waterResistanceM > 10000)
  ) {
    errors.push("مقاومت در برابر آب باید عددی صحیح و غیرمنفی (متر) باشد.");
  }
  return errors;
}

/** An all-empty row says nothing — treat it as "no attributes recorded". */
function isEmpty(input: WatchItemAttributesInput): boolean {
  return (
    !input.referenceNo?.trim() &&
    input.movement == null &&
    !input.caseMaterial?.trim() &&
    input.caseDiameterMm == null &&
    input.waterResistanceM == null &&
    !input.dialColor?.trim() &&
    !input.braceletMaterial?.trim() &&
    input.gender == null
  );
}

/** Records (or replaces) a model's structured attributes; all-empty input removes the row. */
export async function upsertWatchAttributes(
  itemId: string,
  input: WatchItemAttributesInput,
): Promise<WatchItemAttributes | null> {
  const errors = validateWatchAttributes(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  if (isEmpty(input)) {
    await query(`DELETE FROM watch_item_attributes WHERE item_id = $1`, [itemId]);
    return null;
  }

  await query(
    `INSERT INTO watch_item_attributes
       (item_id, reference_no, movement, case_material, case_diameter_mm,
        water_resistance_m, dial_color, bracelet_material, gender, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (item_id) DO UPDATE SET
       reference_no = EXCLUDED.reference_no,
       movement = EXCLUDED.movement,
       case_material = EXCLUDED.case_material,
       case_diameter_mm = EXCLUDED.case_diameter_mm,
       water_resistance_m = EXCLUDED.water_resistance_m,
       dial_color = EXCLUDED.dial_color,
       bracelet_material = EXCLUDED.bracelet_material,
       gender = EXCLUDED.gender,
       updated_at = now()`,
    [
      itemId,
      input.referenceNo?.trim() || null,
      input.movement ?? null,
      input.caseMaterial?.trim() || null,
      input.caseDiameterMm ?? null,
      input.waterResistanceM ?? null,
      input.dialColor?.trim() || null,
      input.braceletMaterial?.trim() || null,
      input.gender ?? null,
    ],
  );
  return (await getWatchAttributes(itemId))!;
}

type AttributesRow = {
  item_id: string;
  reference_no: string | null;
  movement: WatchMovement | null;
  case_material: string | null;
  case_diameter_mm: string | null;
  water_resistance_m: number | null;
  dial_color: string | null;
  bracelet_material: string | null;
  gender: WatchGender | null;
}

function mapRow(row: AttributesRow): WatchItemAttributes {
  return {
    referenceNo: row.reference_no,
    movement: row.movement,
    caseMaterial: row.case_material,
    caseDiameterMm: row.case_diameter_mm == null ? null : Number(row.case_diameter_mm),
    waterResistanceM: row.water_resistance_m,
    dialColor: row.dial_color,
    braceletMaterial: row.bracelet_material,
    gender: row.gender,
  };
}

export async function getWatchAttributes(itemId: string): Promise<WatchItemAttributes | null> {
  const { rows } = await query<AttributesRow>(
    `SELECT item_id, reference_no, movement, case_material, case_diameter_mm::text AS case_diameter_mm,
            water_resistance_m, dial_color, bracelet_material, gender
       FROM watch_item_attributes WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** All attribute rows for a branch's catalogue, keyed by item — one trip for the models list. */
export async function listWatchAttributes(locationId: string): Promise<Map<string, WatchItemAttributes>> {
  const { rows } = await query<AttributesRow>(
    `SELECT a.item_id, a.reference_no, a.movement, a.case_material,
            a.case_diameter_mm::text AS case_diameter_mm, a.water_resistance_m,
            a.dial_color, a.bracelet_material, a.gender
       FROM watch_item_attributes a JOIN items i ON i.id = a.item_id
      WHERE i.location_id = $1`,
    [locationId],
  );
  return new Map(rows.map((r) => [r.item_id, mapRow(r)]));
}
