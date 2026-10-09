/**
 * Issue #839 §12 — the dealership's half of the CRM: what a lead is looking
 * for, and which cars on the lot they have been shown.
 *
 * The lead itself is **not** re-implemented here. `crm-lead-service.ts` owns
 * leads, their source, owner, follow-up and conversion; `parties` stays
 * canonical for the person once the lead converts. This service adds only the
 * car-shaped facts a dealership needs to work a lead list — and it adds them
 * where 0213 put them:
 *
 *   * **preferences** (make/model/trim interest, condition, year and budget
 *     ranges, trade-in interest, test-driven-at) are one row per lead;
 *   * **links** are "this exact stock number was shown to this lead", with the
 *     reason it was shown (interest, a test drive, an offer, or the customer's
 *     own car being valued for trade-in).
 *
 * The most useful read here is `matchesForVehicle`: given a car on the lot,
 * which open leads are actually looking for it. That is a query over typed
 * ranges rather than a text search, which is the entire reason the preferences
 * are columns instead of a note.
 */
import type { PoolClient } from "pg";
import { query } from "./db";

export class VehicleLeadError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const LEAD_CONDITIONS = ["new", "used", "any"] as const;
export type LeadCondition = (typeof LEAD_CONDITIONS)[number];

export const LEAD_VEHICLE_LINK_PURPOSES = ["interest", "test_drive", "offer", "trade_in"] as const;
export type LeadVehicleLinkPurpose = (typeof LEAD_VEHICLE_LINK_PURPOSES)[number];

export const LEAD_VEHICLE_LINK_PURPOSE_LABELS: Record<LeadVehicleLinkPurpose, string> = {
  interest: "مورد علاقه",
  test_drive: "تست درایو",
  offer: "پیشنهاد قیمت",
  trade_in: "معاوضه (خودروی مشتری)",
};

export interface LeadVehiclePreferences {
  leadId: string;
  make: string | null;
  model: string | null;
  trim: string | null;
  condition: LeadCondition;
  vehicleYearCalendar: "jalali" | "gregorian";
  modelYearFrom: number | null;
  modelYearTo: number | null;
  budgetFromRial: number | null;
  budgetToRial: number | null;
  tradeIn: boolean;
  tradeInDescription: string | null;
  testDriveRequestedAt: string | null;
  notes: string | null;
  updatedAt: string | null;
}

export interface LeadVehicleLink {
  id: string;
  serialId: string;
  stockNumber: string;
  displayName: string;
  purpose: LeadVehicleLinkPurpose;
  note: string | null;
  createdAt: string;
}

export interface LeadVehicleProfile {
  leadId: string;
  leadName: string | null;
  leadStatus: string | null;
  phone: string | null;
  preferences: LeadVehiclePreferences | null;
  links: LeadVehicleLink[];
}

/** The empty preference row, so a reader never has to tell `null` from "not filled in yet". */
function emptyPreferences(leadId: string): LeadVehiclePreferences {
  return {
    leadId,
    make: null,
    model: null,
    trim: null,
    condition: "any",
    vehicleYearCalendar: "jalali",
    modelYearFrom: null,
    modelYearTo: null,
    budgetFromRial: null,
    budgetToRial: null,
    tradeIn: false,
    tradeInDescription: null,
    testDriveRequestedAt: null,
    notes: null,
    updatedAt: null,
  };
}

interface PreferencesRow {
  lead_id: string;
  make: string | null;
  model: string | null;
  trim: string | null;
  condition: LeadCondition;
  vehicle_year_calendar: "jalali" | "gregorian";
  model_year_from: number | null;
  model_year_to: number | null;
  budget_from_rial: string | null;
  budget_to_rial: string | null;
  trade_in: boolean;
  trade_in_description: string | null;
  test_drive_requested_at: string | null;
  notes: string | null;
  updated_at: string;
}

function mapPreferences(row: PreferencesRow): LeadVehiclePreferences {
  return {
    leadId: row.lead_id,
    make: row.make,
    model: row.model,
    trim: row.trim,
    condition: row.condition,
    vehicleYearCalendar: row.vehicle_year_calendar,
    modelYearFrom: row.model_year_from,
    modelYearTo: row.model_year_to,
    budgetFromRial: row.budget_from_rial == null ? null : Number(row.budget_from_rial),
    budgetToRial: row.budget_to_rial == null ? null : Number(row.budget_to_rial),
    tradeIn: row.trade_in,
    tradeInDescription: row.trade_in_description,
    testDriveRequestedAt: row.test_drive_requested_at,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

/** One lead, tenant-checked, with its car preferences and the cars it was shown. */
export async function getLeadVehicleProfile(
  businessId: string,
  leadId: string,
  client?: PoolClient,
): Promise<LeadVehicleProfile | null> {
  const run = <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
    client ? client.query<T>(sql, params as never) : query<T>(sql, params as never);

  const { rows: leadRows } = await run<{
    id: string;
    name: string;
    status: string;
    phone: string | null;
  }>(`SELECT id, name, status, phone FROM crm_leads WHERE id = $1 AND business_id = $2`, [leadId, businessId]);
  const lead = leadRows[0];
  if (!lead) return null;

  // Strongly-typed row shapes do not satisfy `query`'s index-signature
  // constraint, so the cast goes through `unknown` deliberately and locally.
  const { rows: preferenceRows } = (await run(
    `SELECT lead_id, make, model, trim, condition, vehicle_year_calendar, model_year_from, model_year_to,
            budget_from_rial::text AS budget_from_rial, budget_to_rial::text AS budget_to_rial,
            trade_in, trade_in_description, test_drive_requested_at::text AS test_drive_requested_at,
            notes, updated_at::text AS updated_at
       FROM crm_lead_vehicle_preferences WHERE business_id = $1 AND lead_id = $2`,
    [businessId, leadId],
  )) as unknown as { rows: PreferencesRow[] };

  const { rows: linkRows } = await run<{
    id: string;
    serial_id: string;
    stock_number: string;
    make: string;
    model: string;
    trim: string | null;
    model_year: number | null;
    purpose: LeadVehicleLinkPurpose;
    note: string | null;
    created_at: string;
  }>(
    `SELECT k.id, k.serial_id, v.stock_number, v.make, v.model, v.trim, v.model_year,
            k.purpose, k.note, k.created_at::text AS created_at
       FROM crm_lead_vehicle_links k
       JOIN automotive_vehicle_attributes v ON v.serial_id = k.serial_id
      WHERE k.business_id = $1 AND k.lead_id = $2
      ORDER BY k.created_at DESC`,
    [businessId, leadId],
  );

  return {
    leadId: lead.id,
    leadName: lead.name,
    leadStatus: lead.status,
    phone: lead.phone,
    preferences: preferenceRows[0] ? mapPreferences(preferenceRows[0]) : emptyPreferences(leadId),
    links: linkRows.map((row) => ({
      id: row.id,
      serialId: row.serial_id,
      stockNumber: row.stock_number,
      displayName: [row.make, row.model, row.trim, row.model_year]
        .filter((part) => part != null && String(part).trim() !== "")
        .join(" "),
      purpose: row.purpose,
      note: row.note,
      createdAt: row.created_at,
    })),
  };
}

export interface SaveLeadVehiclePreferencesInput {
  businessId: string;
  leadId: string;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  condition?: LeadCondition;
  vehicleYearCalendar?: "jalali" | "gregorian";
  modelYearFrom?: number | null;
  modelYearTo?: number | null;
  budgetFromRial?: number | null;
  budgetToRial?: number | null;
  tradeIn?: boolean;
  tradeInDescription?: string | null;
  /** ISO timestamp; omitted leaves the existing value, `null` clears it. */
  testDriveRequestedAt?: string | null;
  notes?: string | null;
  actorId?: string | null;
}

/**
 * Writes the lead's car preferences. The lead is re-checked against the active
 * tenant first — a client-supplied id is a claim, not a fact — and the ranges
 * are validated here *and* by 0213's CHECKs, so a backwards range is refused
 * with a Persian message rather than a constraint violation.
 */
export async function saveLeadVehiclePreferences(
  client: PoolClient,
  input: SaveLeadVehiclePreferencesInput,
): Promise<LeadVehiclePreferences> {
  const { rows: leadRows } = await client.query<{ id: string }>(
    `SELECT id FROM crm_leads WHERE id = $1 AND business_id = $2`,
    [input.leadId, input.businessId],
  );
  if (!leadRows[0]) throw new VehicleLeadError("lead_not_found", "سرنخ یافت نشد.", 404);

  const condition = input.condition ?? "any";
  if (!LEAD_CONDITIONS.includes(condition)) {
    throw new VehicleLeadError("invalid_condition", "نوع خودروی مورد نظر نامعتبر است.");
  }
  const calendar = input.vehicleYearCalendar ?? "jalali";
  const yearFrom = wholeOrNull(input.modelYearFrom, "سال مدل");
  const yearTo = wholeOrNull(input.modelYearTo, "سال مدل");
  if (yearFrom != null && yearTo != null && yearFrom > yearTo) {
    throw new VehicleLeadError("invalid_year_range", "بازهٔ سال مدل برعکس وارد شده است.");
  }
  const budgetFrom = wholeOrNull(input.budgetFromRial, "بودجه");
  const budgetTo = wholeOrNull(input.budgetToRial, "بودجه");
  if (budgetFrom != null && budgetTo != null && budgetFrom > budgetTo) {
    throw new VehicleLeadError("invalid_budget_range", "بازهٔ بودجه برعکس وارد شده است.");
  }
  const tradeIn = input.tradeIn === true;
  const tradeInDescription = input.tradeInDescription?.trim() || null;
  if (tradeIn && !tradeInDescription) {
    throw new VehicleLeadError("trade_in_required", "برای معاوضه، خودروی مشتری را توضیح دهید.");
  }

  const { rows } = await client.query<PreferencesRow>(
    `INSERT INTO crm_lead_vehicle_preferences
       (lead_id, business_id, make, model, trim, condition, vehicle_year_calendar,
        model_year_from, model_year_to, budget_from_rial, budget_to_rial,
        trade_in, trade_in_description, test_drive_requested_at, notes, created_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     ON CONFLICT (lead_id) DO UPDATE SET
       make = EXCLUDED.make,
       model = EXCLUDED.model,
       trim = EXCLUDED.trim,
       condition = EXCLUDED.condition,
       vehicle_year_calendar = EXCLUDED.vehicle_year_calendar,
       model_year_from = EXCLUDED.model_year_from,
       model_year_to = EXCLUDED.model_year_to,
       budget_from_rial = EXCLUDED.budget_from_rial,
       budget_to_rial = EXCLUDED.budget_to_rial,
       trade_in = EXCLUDED.trade_in,
       trade_in_description = EXCLUDED.trade_in_description,
       -- An omitted timestamp leaves the one already recorded alone: "they
       -- asked for a test drive last Tuesday" must not be erased by the next
       -- save of an unrelated field.
       test_drive_requested_at = CASE
         WHEN $17 THEN EXCLUDED.test_drive_requested_at
         ELSE crm_lead_vehicle_preferences.test_drive_requested_at
       END,
       notes = EXCLUDED.notes,
       updated_at = now()
     RETURNING lead_id, make, model, trim, condition, vehicle_year_calendar, model_year_from, model_year_to,
               budget_from_rial::text AS budget_from_rial, budget_to_rial::text AS budget_to_rial,
               trade_in, trade_in_description, test_drive_requested_at::text AS test_drive_requested_at,
               notes, updated_at::text AS updated_at`,
    [
      input.leadId,
      input.businessId,
      clean(input.make),
      clean(input.model),
      clean(input.trim),
      condition,
      calendar,
      yearFrom,
      yearTo,
      budgetFrom,
      budgetTo,
      tradeIn,
      tradeInDescription,
      input.testDriveRequestedAt ?? null,
      clean(input.notes),
      input.actorId ?? null,
      Object.prototype.hasOwnProperty.call(input, "testDriveRequestedAt"),
    ],
  );
  return mapPreferences(rows[0]);
}

export interface LinkLeadVehicleInput {
  businessId: string;
  leadId: string;
  serialId: string;
  purpose?: LeadVehicleLinkPurpose;
  note?: string | null;
  actorId?: string | null;
}

/**
 * Records that this exact car was shown to this lead. Both sides are
 * re-checked against the tenant, and the pair is unique in the database: a
 * second link for the same car updates the reason instead of stacking rows.
 */
export async function linkLeadVehicle(
  client: PoolClient,
  input: LinkLeadVehicleInput,
): Promise<{ id: string }> {
  const purpose = input.purpose ?? "interest";
  if (!LEAD_VEHICLE_LINK_PURPOSES.includes(purpose)) {
    throw new VehicleLeadError("invalid_purpose", "دلیل ارتباط خودرو با سرنخ نامعتبر است.");
  }
  const { rows: leadRows } = await client.query<{ id: string }>(
    `SELECT id FROM crm_leads WHERE id = $1 AND business_id = $2`,
    [input.leadId, input.businessId],
  );
  if (!leadRows[0]) throw new VehicleLeadError("lead_not_found", "سرنخ یافت نشد.", 404);
  const { rows: vehicleRows } = await client.query<{ serial_id: string }>(
    `SELECT serial_id FROM automotive_vehicle_attributes WHERE business_id = $1 AND serial_id = $2`,
    [input.businessId, input.serialId],
  );
  if (!vehicleRows[0]) throw new VehicleLeadError("vehicle_not_found", "خودرو یافت نشد.", 404);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO crm_lead_vehicle_links (business_id, lead_id, serial_id, purpose, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (lead_id, serial_id) DO UPDATE
       SET purpose = EXCLUDED.purpose, note = EXCLUDED.note
     RETURNING id`,
    [input.businessId, input.leadId, input.serialId, purpose, clean(input.note), input.actorId ?? null],
  );
  return { id: rows[0].id };
}

/** Removes one link. The lead and the car are both re-checked against the tenant. */
export async function unlinkLeadVehicle(
  client: PoolClient,
  input: { businessId: string; leadId: string; serialId: string },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `DELETE FROM crm_lead_vehicle_links
      WHERE business_id = $1 AND lead_id = $2 AND serial_id = $3`,
    [input.businessId, input.leadId, input.serialId],
  );
  return rowCount === 1;
}

/**
 * §12's payoff: given a car, which open leads are looking for it.
 *
 * Two ways in, and both are deliberate:
 *
 *   1. **Shown it.** A link is a person's explicit action — they put this
 *      customer in this car — and it outranks any inference, so a linked lead
 *      is returned *first* and is returned even when the lead has no
 *      preferences recorded at all.
 *   2. **Asked for it.** Otherwise the match is over the typed ranges 0213
 *      stores, and it is conservative: a blank criterion matches anything, a
 *      stated one must match. So a lead who asked for «پژو ۲۰۷ کارکرده تا ۸
 *      میلیارد» comes back for that car and not for a new ۲۰۷ at a 12-billion
 *      asking price. Only the budget *ceiling* is compared — a customer whose
 *      budget starts above a car's price is a different conversation, not a
 *      match.
 *
 * A lead with neither a link nor a preference row never appears: the query is
 * not a mailing list, it is an answer to "who wants this car".
 */
export async function listLeadsInterestedInVehicle(
  businessId: string,
  serialId: string,
  client?: PoolClient,
): Promise<
  {
    leadId: string;
    leadName: string;
    status: string;
    phone: string | null;
    bestPurpose: LeadVehicleLinkPurpose | null;
    budgetToRial: number | null;
    note: string | null;
  }[]
> {
  const params = [businessId, serialId];
  const run = <T extends Record<string, unknown>>(sql: string, values: unknown[]) =>
    client ? client.query<T>(sql, values as never) : query<T>(sql, values as never);
  const { rows } = await run<{
    lead_id: string;
    lead_name: string;
    status: string;
    phone: string | null;
    purpose: LeadVehicleLinkPurpose | null;
    budget_to_rial: string | null;
    note: string | null;
  }>(
    `WITH vehicle AS (
       SELECT make, model, condition, model_year, asking_price_rial
         FROM automotive_vehicle_attributes WHERE business_id = $1 AND serial_id = $2
     )
     SELECT l.id AS lead_id, l.name AS lead_name, l.status, l.phone,
            k.purpose, p.budget_to_rial::text AS budget_to_rial, p.notes AS note
       FROM crm_leads l
       CROSS JOIN vehicle v
       LEFT JOIN crm_lead_vehicle_preferences p
              ON p.lead_id = l.id AND p.business_id = l.business_id
       LEFT JOIN crm_lead_vehicle_links k
              ON k.lead_id = l.id AND k.serial_id = $2 AND k.business_id = l.business_id
      WHERE l.business_id = $1
        AND l.status NOT IN ('converted', 'unqualified')
        AND (
          -- Shown this exact car: a person's action, taken as given.
          k.id IS NOT NULL
          -- Or looking for it, judged only on what they actually stated.
          OR (
            p.lead_id IS NOT NULL
            AND (p.make IS NULL OR v.make ILIKE '%' || p.make || '%')
            AND (p.model IS NULL OR v.model ILIKE '%' || p.model || '%')
            AND (p.condition = 'any' OR p.condition = v.condition)
            AND (p.model_year_from IS NULL OR v.model_year IS NULL OR v.model_year >= p.model_year_from)
            AND (p.model_year_to IS NULL OR v.model_year IS NULL OR v.model_year <= p.model_year_to)
            AND (p.budget_to_rial IS NULL OR v.asking_price_rial <= p.budget_to_rial)
          )
        )
      ORDER BY (k.purpose IS NOT NULL) DESC, l.updated_at DESC
      LIMIT 50`,
    params,
  );
  return rows.map((row) => ({
    leadId: row.lead_id,
    leadName: row.lead_name,
    status: row.status,
    phone: row.phone,
    bestPurpose: row.purpose,
    budgetToRial: row.budget_to_rial == null ? null : Number(row.budget_to_rial),
    note: row.note,
  }));
}

function wholeOrNull(value: number | null | undefined, label: string): number | null {
  if (value == null) return null;
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new VehicleLeadError("invalid_number", `${label} باید عددی نامنفی باشد.`);
  }
  return parsed;
}

/** Trims, and turns an empty string into "nothing recorded" rather than ''. */
function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export type { PreferencesRow as LeadVehiclePreferencesRow };
