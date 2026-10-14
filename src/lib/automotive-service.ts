/**
 * Issue #839 Wave 2 — the vehicle stock, acquisition and cost service.
 *
 * The issue's architecture rule, restated as code: a car is **not** a new
 * inventory engine. `items` is the make/model/trim catalogue entry (one row per
 * model per branch, exactly as a watch model is), `item_serials` is one row per
 * physical car, and `automotive_vehicle_attributes` (migration 0212) is that
 * serial's 1:1 automotive extension — VIN, condition, lifecycle state, the
 * acquisition story, pricing and the frozen sale facts. Everything here writes
 * those three tables and nothing else; there is no second stock table, no
 * second party directory and no second ledger.
 *
 * Three invariants this module owns:
 *
 *   1. **Identity is the stock number, and the dangerous fields are unique per
 *      business.** VIN, chassis, engine number and stock number are indexed
 *      case-insensitively per `business_id` in the migration, so a duplicate is
 *      a constraint violation rather than a service bug — but the service
 *      normalises and pre-checks them anyway, because the useful error is the
 *      Persian sentence naming the field, not a 23505.
 *   2. **Cost and price never touch each other.** `purchase_cost_rial` and the
 *      `automotive_vehicle_costs` rows are the car's basis; the asking /
 *      minimum / wholesale / promotional figures are what the dealership hopes
 *      to get. Nothing in `updateVehiclePrice` reads a cost, and nothing in the
 *      cost paths writes a price. §6 states it, and the separation is the whole
 *      reason `frozen_effective_cost_rial` exists.
 *   3. **A cost is voided, never edited** (migration 0212). A wrong
 *      reconditioning figure leaves the original row, a void row's reason and a
 *      mirror journal entry — three facts an accountant can reconcile — instead
 *      of a mutated number nobody can audit.
 *
 * Every mutation function takes the caller's `PoolClient` and does all of its
 * work inside that transaction: the vehicle row, the serial status, the ledger
 * posting and the domain event commit together or not at all. Reads use the
 * pooled `query` when no client is supplied.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import {
  checkMinimumPrice,
  computeEffectiveCost,
  daysInStock,
  normalizeChassis,
  normalizeStockNumber,
  normalizeVin,
  nextStockNumber,
  vehicleDisplayName,
  validateChassisNumber,
  validateMileage,
  validatePlateNumber,
  validatePriorOwners,
  validateStockNumber,
  validateVehicleStateCommand,
  validateVehicleStateTransition,
  validateVehicleYears,
  validateVin,
  wholeRial,
  VEHICLE_MEDIA_CATEGORIES,
  VEHICLE_BODY_TYPES,
  VEHICLE_TRANSMISSIONS,
  VEHICLE_FUEL_TYPES,
  VEHICLE_DRIVETRAINS,
  type VehicleMediaCategory,
  type VehicleAcquisitionSource,
  type VehicleBodyType,
  type VehicleCondition,
  type VehicleDrivetrain,
  type VehicleExpenseCategory,
  type VehicleExpensePosting,
  type VehicleFuelType,
  type VehicleState,
  type VehicleStateCommand,
  type VehicleTransmission,
  type VehicleYearCalendar,
} from "./automotive";
import { emitDomainEvent, recordDomainEvent } from "./posting-engine";
import { rialBigInt, rialText, type RialText } from "./inventory-exact";
import type { VehicleSettlement } from "./automotive-posting-rules";
// Side-effect import: registers the automotive.* posting rules with the engine.
import "./automotive-posting-rules";

export class VehicleError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* ===========================================================================
 * Input shapes
 * ===========================================================================
 */

export interface VehicleCostInput {
  category: VehicleExpenseCategory;
  posting: VehicleExpensePosting;
  amountRial: number;
  /** ISO date (YYYY-MM-DD). */
  incurredOn: string;
  vendorPartyId?: string | null;
  documentRef?: string | null;
  notes?: string | null;
  /** What settled it — see `VehicleSettlement`. Defaults to `payable`. */
  settlement?: VehicleSettlement;
}

export interface VehicleAcquisitionInput {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  source: VehicleAcquisitionSource;
  partyId?: string | null;
  /** The base price agreed for the car itself, Rial — costs are separate rows. */
  costRial: number;
  settlement: VehicleSettlement;
  note?: string | null;
}

export interface CreateVehicleInput {
  businessId: string;
  locationId: string;
  make: string;
  model: string;
  trim?: string | null;
  vehicleYearCalendar?: VehicleYearCalendar;
  modelYear?: number | null;
  productionYear?: number | null;
  vin?: string | null;
  chassisNumber?: string | null;
  engineNumber?: string | null;
  plateNumber?: string | null;
  /** Omit to have the next number in the branch's own sequence generated. */
  stockNumber?: string | null;
  bodyType?: VehicleBodyType | null;
  transmission?: VehicleTransmission | null;
  fuelType?: VehicleFuelType | null;
  engineSpec?: string | null;
  drivetrain?: VehicleDrivetrain | null;
  exteriorColor?: string | null;
  interiorColor?: string | null;
  condition: VehicleCondition;
  mileageKm?: number | null;
  priorOwners?: number | null;
  registrationDate?: string | null;
  inspectionNotes?: string | null;
  bodyConditionNotes?: string | null;
  mechanicalNotes?: string | null;
  serviceHistory?: string | null;
  provenanceSource?: VehicleAcquisitionSource | null;
  provenancePartyId?: string | null;
  provenanceNote?: string | null;
  /** Present = the car is acquired in this call and lands `in_stock`; absent = a `draft` shell. */
  acquisition?: VehicleAcquisitionInput | null;
  askingPriceRial?: number;
  minimumPriceRial?: number | null;
  wholesalePriceRial?: number | null;
  promotionalPriceRial?: number | null;
  /** Landed costs recorded with the car — each one posts its own entry. */
  initialCosts?: VehicleCostInput[];
  createdBy?: string | null;
}

export interface VehicleIdentity {
  serialId: string;
  itemId: string;
  stockNumber: string;
  state: VehicleState;
  effectiveCostRial: number;
}

/* ===========================================================================
 * Small shared helpers
 * ===========================================================================
 */

function trimmedOrNull(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function assertWholeRial(value: number, label: string): number {
  try {
    return wholeRial(value, label);
  } catch (err) {
    throw new VehicleError("invalid_amount", (err as Error).message);
  }
}

function assertIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new VehicleError("invalid_date", `${label} باید به شکل ۱۴۰۳/۰۵/۱۲ (YYYY-MM-DD) باشد.`);
  }
  return value;
}

/** The branch's own business-local day — never the UTC calendar day (§10/§12). */
export async function businessToday(client: PoolClient, locationId: string): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT app_business_date(now(), coalesce(timezone, 'Asia/Tehran'), business_day_start_minutes)::text AS today
       FROM locations WHERE id = $1`,
    [locationId],
  );
  return rows[0]?.today ?? new Date().toISOString().slice(0, 10);
}

/**
 * The next stock number in the branch's own sequence: the last one issued plus
 * one when it parses (`nextStockNumber`), the next unused plain number
 * otherwise. A human-typed number always wins — the auto value only fills a
 * blank.
 *
 * The fallback used to be `count(*) + 1`, which is wrong the moment a tenant's
 * numbering has a gap: a lot holding «1» and «3» was told its next number was
 * «3», and the unique index (`uq_automotive_vehicle_stock_number`) then
 * rejected a car whose stock number the user had deliberately left blank. It
 * is also reached whenever the newest car carries a human number that does not
 * end in digits («ویژه»), so the path is not exotic. `max(numeric) + 1` is
 * free by construction and keeps a tenant's zero padding: «007» → «008».
 */
export async function nextStockNumberFor(client: PoolClient, businessId: string): Promise<string> {
  const { rows } = await client.query<{ stock_number: string }>(
    `SELECT stock_number FROM automotive_vehicle_attributes
      WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [businessId],
  );
  const next = nextStockNumber(rows[0]?.stock_number);
  if (next) return next;
  // Only wholly numeric numbers take part: «1403-001» is a scheme of its own
  // and is continued by `nextStockNumber` above, never folded into this count.
  const { rows: maxRows } = await client.query<{ next: string }>(
    `SELECT (coalesce(max(stock_number::bigint), 0) + 1)::text AS next
       FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND stock_number ~ '^[0-9]+$'`,
    [businessId],
  );
  return maxRows[0]?.next ?? "1";
}

/* ===========================================================================
 * The catalogue half: `items` is the model, `item_serials` is the car
 * ===========================================================================
 */

/**
 * Finds the branch-scoped catalogue row for this model, creating it when the
 * model is new to the branch — exactly the match `watch-transfer-service.ts`
 * makes (SKU when the model has one, exact name otherwise), so a car can only
 * ever land under the model row the trade already uses.
 *
 * The advisory lock is deliberate. `items` has no unique constraint on
 * `(location_id, tracking, name)`, so two cars of the same model registered
 * concurrently would otherwise race between the SELECT and the INSERT into two
 * catalogue rows — the sort of duplicate that surfaces months later as two
 * half-empty model reports. The lock is transaction-scoped and keyed on the
 * branch plus the display name, so it serialises exactly the colliding pair and
 * nothing else.
 */
async function findOrCreateVehicleModel(
  client: PoolClient,
  input: { locationId: string; displayName: string; sku?: string | null },
): Promise<string> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    input.locationId,
    input.displayName,
  ]);

  const { rows: existing } = await client.query<{ id: string }>(
    input.sku
      ? `SELECT id FROM items WHERE location_id = $1 AND tracking = 'serial' AND sku = $2 LIMIT 1`
      : `SELECT id FROM items WHERE location_id = $1 AND tracking = 'serial' AND name = $2 LIMIT 1`,
    [input.locationId, input.sku ?? input.displayName],
  );
  if (existing[0]) return existing[0].id;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO items (location_id, name, sku, kind, tracking)
     VALUES ($1, $2, $3, 'simple', 'serial') RETURNING id`,
    [input.locationId, input.displayName, input.sku ?? null],
  );
  return rows[0].id;
}

/* ===========================================================================
 * Reading one car back
 * ===========================================================================
 */

export interface VehicleCostRow {
  id: string;
  category: VehicleExpenseCategory;
  posting: VehicleExpensePosting;
  amountRial: number;
  incurredOn: string;
  vendorPartyId: string | null;
  vendorName: string | null;
  documentRef: string | null;
  notes: string | null;
  status: "active" | "void";
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string;
}

export interface VehicleDetail {
  serialId: string;
  itemId: string;
  locationId: string;
  stockNumber: string;
  make: string;
  model: string;
  trim: string | null;
  displayName: string;
  vehicleYearCalendar: VehicleYearCalendar;
  modelYear: number | null;
  productionYear: number | null;
  vin: string | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  plateNumber: string | null;
  bodyType: string | null;
  transmission: string | null;
  fuelType: string | null;
  engineSpec: string | null;
  drivetrain: string | null;
  exteriorColor: string | null;
  interiorColor: string | null;
  condition: VehicleCondition;
  mileageKm: number | null;
  priorOwners: number | null;
  registrationDate: string | null;
  inspectionNotes: string | null;
  bodyConditionNotes: string | null;
  mechanicalNotes: string | null;
  serviceHistory: string | null;
  provenanceSource: string | null;
  provenancePartyId: string | null;
  provenanceNote: string | null;
  state: VehicleState;
  serialStatus: string;
  acquisitionDate: string | null;
  acquisitionSource: string | null;
  acquisitionPartyId: string | null;
  purchaseCostRial: number;
  askingPriceRial: number;
  minimumPriceRial: number | null;
  wholesalePriceRial: number | null;
  promotionalPriceRial: number | null;
  priceChangedAt: string | null;
  soldOrderId: string | null;
  soldCustomerId: string | null;
  soldOn: string | null;
  salePriceRial: number | null;
  frozenEffectiveCostRial: number | null;
  createdAt: string;
  updatedAt: string;
  costs: VehicleCostRow[];
  /** acquisition + capitalized — the number the UI shows as «بهای تمام‌شده مؤثر». */
  effectiveCostRial: number;
  capitalizedCostRial: number;
  periodExpenseRial: number;
}

interface VehicleRow {
  [key: string]: unknown;
  serial_id: string;
  item_id: string;
  location_id: string;
  stock_number: string;
  make: string;
  model: string;
  trim: string | null;
  vehicle_year_calendar: string;
  model_year: number | null;
  production_year: number | null;
  vin: string | null;
  chassis_number: string | null;
  engine_number: string | null;
  plate_number: string | null;
  body_type: string | null;
  transmission: string | null;
  fuel_type: string | null;
  engine_spec: string | null;
  drivetrain: string | null;
  exterior_color: string | null;
  interior_color: string | null;
  condition: VehicleCondition;
  mileage_km: number | null;
  prior_owners: number | null;
  registration_date: string | null;
  inspection_notes: string | null;
  body_condition_notes: string | null;
  mechanical_notes: string | null;
  service_history: string | null;
  provenance_source: string | null;
  provenance_party_id: string | null;
  provenance_note: string | null;
  state: VehicleState;
  serial_status: string;
  acquisition_date: string | null;
  acquisition_source: string | null;
  acquisition_party_id: string | null;
  purchase_cost_rial: string;
  asking_price_rial: string;
  minimum_price_rial: string | null;
  wholesale_price_rial: string | null;
  promotional_price_rial: string | null;
  price_changed_at: string | null;
  sold_order_id: string | null;
  sold_customer_id: string | null;
  sold_on: string | null;
  sale_price_rial: string | null;
  frozen_effective_cost_rial: string | null;
  created_at: string;
  updated_at: string;
  capitalized_cost_rial: string;
  period_expense_rial: string;
}

const VEHICLE_SELECT = `
  SELECT v.serial_id, s.item_id, v.location_id, v.stock_number, v.make, v.model, v.trim,
         v.vehicle_year_calendar, v.model_year, v.production_year, v.vin, v.chassis_number,
         v.engine_number, v.plate_number, v.body_type, v.transmission, v.fuel_type, v.engine_spec,
         v.drivetrain, v.exterior_color, v.interior_color, v.condition, v.mileage_km, v.prior_owners,
         v.registration_date, v.inspection_notes, v.body_condition_notes, v.mechanical_notes,
         v.service_history, v.provenance_source, v.provenance_party_id, v.provenance_note,
         v.state, s.status AS serial_status, v.acquisition_date::text AS acquisition_date,
         v.acquisition_source, v.acquisition_party_id, v.purchase_cost_rial::text AS purchase_cost_rial,
         v.asking_price_rial::text AS asking_price_rial, v.minimum_price_rial::text AS minimum_price_rial,
         v.wholesale_price_rial::text AS wholesale_price_rial,
         v.promotional_price_rial::text AS promotional_price_rial,
         v.price_changed_at::text AS price_changed_at, v.sold_order_id, v.sold_customer_id,
         v.sold_on::text AS sold_on, v.sale_price_rial::text AS sale_price_rial,
         v.frozen_effective_cost_rial::text AS frozen_effective_cost_rial,
         v.created_at::text AS created_at, v.updated_at::text AS updated_at,
         coalesce(c.capitalized_cost_rial, 0)::text AS capitalized_cost_rial,
         coalesce(c.period_expense_rial, 0)::text AS period_expense_rial
    FROM automotive_vehicle_attributes v
    JOIN item_serials s ON s.id = v.serial_id
    LEFT JOIN (
      SELECT business_id, serial_id,
             sum(amount_rial) FILTER (WHERE posting = 'capitalized') AS capitalized_cost_rial,
             sum(amount_rial) FILTER (WHERE posting = 'period_expense') AS period_expense_rial
        FROM automotive_vehicle_costs WHERE status = 'active' GROUP BY business_id, serial_id
    ) c ON c.business_id = v.business_id AND c.serial_id = v.serial_id`;

function mapVehicle(row: VehicleRow, costs: VehicleCostRow[] = []): VehicleDetail {
  const breakdown = computeEffectiveCost({
    acquisitionCostRial: Number(row.purchase_cost_rial),
    capitalizedCostRial: Number(row.capitalized_cost_rial),
    periodExpenseRial: Number(row.period_expense_rial),
  });
  return {
    serialId: row.serial_id,
    itemId: row.item_id,
    locationId: row.location_id,
    stockNumber: row.stock_number,
    make: row.make,
    model: row.model,
    trim: row.trim,
    displayName: vehicleDisplayName({
      make: row.make,
      model: row.model,
      trim: row.trim,
      modelYear: row.model_year,
    }),
    vehicleYearCalendar: row.vehicle_year_calendar as VehicleYearCalendar,
    modelYear: row.model_year,
    productionYear: row.production_year,
    vin: row.vin,
    chassisNumber: row.chassis_number,
    engineNumber: row.engine_number,
    plateNumber: row.plate_number,
    bodyType: row.body_type,
    transmission: row.transmission,
    fuelType: row.fuel_type,
    engineSpec: row.engine_spec,
    drivetrain: row.drivetrain,
    exteriorColor: row.exterior_color,
    interiorColor: row.interior_color,
    condition: row.condition,
    mileageKm: row.mileage_km,
    priorOwners: row.prior_owners,
    registrationDate: row.registration_date,
    inspectionNotes: row.inspection_notes,
    bodyConditionNotes: row.body_condition_notes,
    mechanicalNotes: row.mechanical_notes,
    serviceHistory: row.service_history,
    provenanceSource: row.provenance_source,
    provenancePartyId: row.provenance_party_id,
    provenanceNote: row.provenance_note,
    state: row.state,
    serialStatus: row.serial_status,
    acquisitionDate: row.acquisition_date,
    acquisitionSource: row.acquisition_source,
    acquisitionPartyId: row.acquisition_party_id,
    purchaseCostRial: Number(row.purchase_cost_rial),
    askingPriceRial: Number(row.asking_price_rial),
    minimumPriceRial: row.minimum_price_rial == null ? null : Number(row.minimum_price_rial),
    wholesalePriceRial: row.wholesale_price_rial == null ? null : Number(row.wholesale_price_rial),
    promotionalPriceRial: row.promotional_price_rial == null ? null : Number(row.promotional_price_rial),
    priceChangedAt: row.price_changed_at,
    soldOrderId: row.sold_order_id,
    soldCustomerId: row.sold_customer_id,
    soldOn: row.sold_on,
    salePriceRial: row.sale_price_rial == null ? null : Number(row.sale_price_rial),
    frozenEffectiveCostRial:
      row.frozen_effective_cost_rial == null ? null : Number(row.frozen_effective_cost_rial),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    costs,
    effectiveCostRial: breakdown.effectiveCostRial,
    capitalizedCostRial: breakdown.capitalizedCostRial,
    periodExpenseRial: breakdown.periodExpenseRial,
  };
}

/** Branch filters for vehicle detail/read models, always sourced from membership, never a request body. */
export interface VehicleReadScope {
  locationId?: string | null;
  locationIds?: string[];
}

function vehicleBranchFilter(alias: string, params: unknown[], scope?: VehicleReadScope): string | null {
  if (!scope) return "";
  if (scope.locationIds !== undefined) {
    if (scope.locationIds.length === 0) return null;
    return ` AND ${alias}.location_id = ANY($${params.push(scope.locationIds)}::uuid[])`;
  }
  if (scope.locationId) return ` AND ${alias}.location_id = $${params.push(scope.locationId)}`;
  return "";
}

/** Lock the physical unit before any branch-scoped mutation and re-check its location under that lock. */
async function lockVehicleAtBranch(
  client: PoolClient,
  businessId: string,
  serialId: string,
  locationId: string,
): Promise<{ state: VehicleState; locationId: string; stockNumber: string }> {
  const { rows } = await client.query<{ state: VehicleState; location_id: string; stock_number: string }>(
    `SELECT state, location_id, stock_number FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND serial_id = $2 FOR UPDATE`,
    [businessId, serialId],
  );
  const vehicle = rows[0];
  if (!vehicle) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.location_id !== locationId) {
    throw new VehicleError("wrong_location", "این خودرو در شعبهٔ فعال نیست.", 409);
  }
  return { state: vehicle.state, locationId: vehicle.location_id, stockNumber: vehicle.stock_number };
}

/** One car, with its active cost rows — the vehicle detail screen's payload. */
export async function getVehicle(
  businessId: string,
  serialId: string,
  client?: PoolClient,
  scope?: VehicleReadScope,
): Promise<VehicleDetail | null> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params as never);
  const params: unknown[] = [businessId, serialId];
  const branchFilter = vehicleBranchFilter("v", params, scope);
  if (branchFilter === null) return null;
  const { rows } = await run<VehicleRow>(
    `${VEHICLE_SELECT} WHERE v.business_id = $1 AND v.serial_id = $2${branchFilter}`,
    params,
  );
  if (!rows[0]) return null;
  const costs = await listVehicleCosts(businessId, serialId, client, scope);
  return mapVehicle(rows[0], costs);
}

export async function listVehicleCosts(
  businessId: string,
  serialId: string,
  client?: PoolClient,
  scope?: VehicleReadScope,
): Promise<VehicleCostRow[]> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params as never);
  const params: unknown[] = [businessId, serialId];
  const branchFilter = vehicleBranchFilter("v", params, scope);
  if (branchFilter === null) return [];
  const { rows } = await run<{
    id: string;
    category: VehicleExpenseCategory;
    posting: VehicleExpensePosting;
    amount_rial: string;
    incurred_on: string;
    vendor_party_id: string | null;
    vendor_name: string | null;
    document_ref: string | null;
    notes: string | null;
    status: "active" | "void";
    void_reason: string | null;
    voided_at: string | null;
    created_at: string;
  }>(
    `SELECT c.id, c.category, c.posting, c.amount_rial::text AS amount_rial, c.incurred_on::text AS incurred_on,
            c.vendor_party_id, p.name AS vendor_name, c.document_ref, c.notes, c.status, c.void_reason,
            c.voided_at::text AS voided_at, c.created_at::text AS created_at
       FROM automotive_vehicle_costs c
       JOIN automotive_vehicle_attributes v
         ON v.business_id = c.business_id AND v.serial_id = c.serial_id
       LEFT JOIN parties p ON p.id = c.vendor_party_id AND p.business_id = c.business_id
      WHERE c.business_id = $1 AND c.serial_id = $2${branchFilter}
      ORDER BY c.incurred_on DESC, c.created_at DESC`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    posting: r.posting,
    amountRial: Number(r.amount_rial),
    incurredOn: r.incurred_on,
    vendorPartyId: r.vendor_party_id,
    vendorName: r.vendor_name,
    documentRef: r.document_ref,
    notes: r.notes,
    status: r.status,
    voidReason: r.void_reason,
    voidedAt: r.voided_at,
    createdAt: r.created_at,
  }));
}

/* ===========================================================================
 * Creating a car: the catalogue row, the unit, the extension, the money
 * ===========================================================================
 */

/** Validates everything 0212's CHECKs also enforce, so the caller gets a sentence rather than a 23505. */
function validateVehicleInput(input: CreateVehicleInput): {
  vin: string | null;
  chassis: string | null;
  plate: string | null;
  stockNumber: string;
  calendar: VehicleYearCalendar;
} {
  const calendar = input.vehicleYearCalendar ?? "jalali";
  const errors = [
    validateVin(input.vin),
    validateChassisNumber(input.chassisNumber),
    validatePlateNumber(input.plateNumber),
    // A blank stock number is generated below from the branch's own sequence;
    // only a number a human typed is validated here.
    input.stockNumber?.trim() ? validateStockNumber(input.stockNumber) : null,
    validateVehicleYears({
      modelYear: input.modelYear,
      productionYear: input.productionYear,
      calendar,
    }),
    validateMileage(input.mileageKm, input.condition),
    validatePriorOwners(input.priorOwners, input.condition),
  ].filter((error): error is string => Boolean(error));
  if (!input.make?.trim()) errors.push("نام سازنده (برند) الزامی است.");
  if (!input.model?.trim()) errors.push("نام مدل الزامی است.");
  if (errors.length > 0) throw new VehicleError("invalid_vehicle", errors.join(" "));

  return {
    vin: trimmedOrNull(normalizeVin(input.vin ?? "")),
    chassis: trimmedOrNull(normalizeChassis(input.chassisNumber ?? "")),
    plate: trimmedOrNull(input.plateNumber ?? ""),
    stockNumber: normalizeStockNumber(input.stockNumber ?? ""),
    calendar,
  };
}

/**
 * Registers one physical car — with its acquisition, its landed costs and its
 * opening price, all in the caller's transaction.
 *
 * The car's state follows what the caller actually knows: with an `acquisition`
 * it is `in_stock` (it is here, it is ours, it can be reserved and sold
 * immediately — the 95% case at the counter), without one it is `draft`, a
 * shell waiting for its purchase to be recorded. §4's opening stock is the
 * same call with `source: "opening_stock"` and `settlement: "opening_equity"`,
 * which is why opening inventory needs no fake purchase document.
 */
export async function createVehicle(
  client: PoolClient,
  input: CreateVehicleInput,
): Promise<VehicleIdentity> {
  const identity = validateVehicleInput(input);
  const stockNumber = input.stockNumber?.trim()
    ? identity.stockNumber
    : await nextStockNumberFor(client, input.businessId);

  const modelDisplay = vehicleDisplayName({
    make: input.make,
    model: input.model,
    trim: input.trim,
    modelYear: input.modelYear,
  });
  const itemId = await findOrCreateVehicleModel(client, {
    locationId: input.locationId,
    displayName: modelDisplay,
  });

  for (const cost of input.initialCosts ?? []) {
    assertWholeRial(cost.amountRial, "مبلغ هزینه");
    assertIsoDate(cost.incurredOn, "تاریخ هزینه");
  }
  const acquisitionCost = input.acquisition ? assertWholeRial(input.acquisition.costRial, "بهای خرید") : 0;
  const capitalized = (input.initialCosts ?? [])
    .filter((cost) => cost.posting === "capitalized")
    .reduce((sum, cost) => sum + cost.amountRial, 0);
  const askingPrice = assertWholeRial(input.askingPriceRial ?? 0, "قیمت فروش");

  const state: VehicleState = input.acquisition ? "in_stock" : "draft";

  // The unit first: one serial = one car, its `serial_number` being the stock
  // number the lot calls it by. `unit_cost` carries the *effective* cost so the
  // shared retail valuation and COGS paths read a car like any other serialized
  // unit; the automotive-specific breakdown stays in the attribute and cost rows.
  const effectiveCost = acquisitionCost + capitalized;
  // The serial's own status vocabulary (0050, widened by 0200/0201) has no
  // "not acquired yet" value, so a `draft` car is stored `in_stock` at this
  // layer and the automotive `state` is what the sale path re-checks. That is
  // safe because no other sellable-unit path is reachable for an automotive
  // tenant: the watch quick-sell panel and `/api/watch/*` are industry-gated,
  // and the retail invoice route for this trade goes through the automotive
  // sale service (Wave 4), which refuses anything but `in_stock`/`reserved`.
  const { rows: serialRows } = await client.query<{ id: string }>(
    `INSERT INTO item_serials (item_id, serial_number, unit_cost, status)
     VALUES ($1, $2, $3, 'in_stock') RETURNING id`,
    [itemId, stockNumber, effectiveCost > 0 ? effectiveCost : null],
  );
  const serialId = serialRows[0].id;

  await client.query(
    `INSERT INTO automotive_vehicle_attributes
       (serial_id, business_id, location_id, make, model, trim, vehicle_year_calendar, model_year,
        production_year, vin, chassis_number, engine_number, plate_number, stock_number, body_type,
        transmission, fuel_type, engine_spec, drivetrain, exterior_color, interior_color, condition,
        mileage_km, prior_owners, registration_date, inspection_notes, body_condition_notes,
        mechanical_notes, service_history, provenance_source, provenance_party_id, provenance_note,
        state, acquisition_date, acquisition_source, acquisition_party_id, purchase_cost_rial,
        asking_price_rial, minimum_price_rial, wholesale_price_rial, promotional_price_rial,
        price_changed_at, price_changed_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
             $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44)`,
    [
      serialId,
      input.businessId,
      input.locationId,
      input.make.trim(),
      input.model.trim(),
      trimmedOrNull(input.trim),
      identity.calendar,
      input.modelYear ?? null,
      input.productionYear ?? null,
      identity.vin,
      identity.chassis,
      trimmedOrNull(input.engineNumber),
      identity.plate,
      stockNumber,
      input.bodyType ?? null,
      input.transmission ?? null,
      input.fuelType ?? null,
      trimmedOrNull(input.engineSpec),
      input.drivetrain ?? null,
      trimmedOrNull(input.exteriorColor),
      trimmedOrNull(input.interiorColor),
      input.condition,
      input.mileageKm ?? null,
      input.priorOwners ?? null,
      input.registrationDate ?? null,
      trimmedOrNull(input.inspectionNotes),
      trimmedOrNull(input.bodyConditionNotes),
      trimmedOrNull(input.mechanicalNotes),
      trimmedOrNull(input.serviceHistory),
      input.provenanceSource ?? input.acquisition?.source ?? null,
      input.provenancePartyId ?? input.acquisition?.partyId ?? null,
      trimmedOrNull(input.provenanceNote),
      state,
      input.acquisition?.date ?? null,
      input.acquisition?.source ?? null,
      input.acquisition?.partyId ?? null,
      acquisitionCost,
      askingPrice,
      input.minimumPriceRial ?? null,
      input.wholesalePriceRial ?? null,
      input.promotionalPriceRial ?? null,
      askingPrice > 0 ? new Date() : null,
      askingPrice > 0 ? (input.createdBy ?? null) : null,
      input.createdBy ?? null,
    ],
  );

  // The acquisition itself: Dr vehicle inventory / Cr whatever settled it.
  if (input.acquisition) {
    await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: "automotive.vehicle_acquired",
      payload: {
        serialId,
        stockNumber,
        baseCost: rialText(String(acquisitionCost)),
        settlement: input.acquisition.settlement,
        source: input.acquisition.source,
      },
      sourceType: "automotive_vehicle",
      sourceId: serialId,
      createdBy: input.createdBy ?? null,
    });
  }

  for (const cost of input.initialCosts ?? []) {
    await insertVehicleCost(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      serialId,
      stockNumber,
      cost,
      createdBy: input.createdBy ?? null,
    });
  }

  // The opening price is a price *change* from zero, and 0212 keeps history for
  // every one of them — including the first, so the screen can show «از ۰ به X».
  if (askingPrice > 0 || input.minimumPriceRial != null) {
    await client.query(
      `INSERT INTO automotive_vehicle_price_history
         (business_id, location_id, serial_id, previous_asking_price_rial, asking_price_rial,
          minimum_price_rial, wholesale_price_rial, promotional_price_rial, reason, changed_by)
       VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9)`,
      [
        input.businessId,
        input.locationId,
        serialId,
        askingPrice,
        input.minimumPriceRial ?? null,
        input.wholesalePriceRial ?? null,
        input.promotionalPriceRial ?? null,
        "ثبت اولیه",
        input.createdBy ?? null,
      ],
    );
  }

  return {
    serialId,
    itemId,
    stockNumber,
    state,
    effectiveCostRial: acquisitionCost + capitalized,
  };
}

/* ===========================================================================
 * The cost path — §5's capitalize-or-period decision, void not edit
 * ===========================================================================
 */

/**
 * Recomputes `item_serials.unit_cost` from the car's own rows. Called after any
 * change to the base cost or a capitalized cost so the shared retail/valuation
 * paths (which read `unit_cost`, not the automotive extension) see the same
 * number the vehicle screen shows. A car with no cost at all keeps `NULL` —
 * `unit_cost` has a `> 0` CHECK and, more importantly, "no cost recorded" is
 * not "a free car".
 */
async function syncSerialUnitCost(client: PoolClient, serialId: string): Promise<void> {
  const { rows } = await client.query<{ effective: string }>(
    `SELECT (v.purchase_cost_rial + coalesce(sum(c.amount_rial) FILTER (WHERE c.posting = 'capitalized'), 0))::text AS effective
       FROM automotive_vehicle_attributes v
       LEFT JOIN automotive_vehicle_costs c ON c.serial_id = v.serial_id AND c.status = 'active'
      WHERE v.serial_id = $1
      GROUP BY v.serial_id, v.purchase_cost_rial`,
    [serialId],
  );
  const effective = Number(rows[0]?.effective ?? 0);
  await client.query(`UPDATE item_serials SET unit_cost = $2 WHERE id = $1`, [
    serialId,
    effective > 0 ? effective : null,
  ]);
}

async function insertVehicleCost(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    serialId: string;
    stockNumber: string;
    cost: VehicleCostInput;
    createdBy: string | null;
  },
): Promise<{ id: string; entryId: string | null }> {
  const amount = assertWholeRial(input.cost.amountRial, "مبلغ هزینه");
  if (amount === 0) throw new VehicleError("invalid_amount", "مبلغ هزینه باید بزرگ‌تر از صفر باشد.");
  const incurredOn = assertIsoDate(input.cost.incurredOn, "تاریخ هزینه");
  const settlement = input.cost.settlement ?? "payable";

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO automotive_vehicle_costs
       (business_id, location_id, serial_id, category, posting, amount_rial, incurred_on,
        vendor_party_id, document_ref, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      input.businessId,
      input.locationId,
      input.serialId,
      input.cost.category,
      input.cost.posting,
      amount,
      incurredOn,
      input.cost.vendorPartyId ?? null,
      trimmedOrNull(input.cost.documentRef),
      trimmedOrNull(input.cost.notes),
      input.createdBy,
    ],
  );
  const costId = rows[0].id;

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "automotive.vehicle_cost",
    payload: {
      serialId: input.serialId,
      costId,
      stockNumber: input.stockNumber,
      amount: rialText(String(amount)),
      posting: input.cost.posting,
      settlement,
    },
    sourceType: "automotive_vehicle_cost",
    sourceId: costId,
    createdBy: input.createdBy,
  });

  if (entryId) {
    await client.query(`UPDATE automotive_vehicle_costs SET ledger_entry_id = $2 WHERE id = $1`, [
      costId,
      entryId,
    ]);
  }
  if (input.cost.posting === "capitalized") {
    await syncSerialUnitCost(client, input.serialId);
  }
  return { id: costId, entryId };
}

/** §5 — one expense against one car, with its own capitalize-or-period choice. */
export async function recordVehicleCost(
  client: PoolClient,
  input: {
    businessId: string;
    serialId: string;
    locationId: string;
    cost: VehicleCostInput;
    createdBy?: string | null;
  },
): Promise<{ id: string; entryId: string | null; effectiveCostRial: number }> {
  await lockVehicleAtBranch(client, input.businessId, input.serialId, input.locationId);
  const vehicle = await getVehicle(input.businessId, input.serialId, client, { locationId: input.locationId });
  if (!vehicle) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.state === "sold") {
    throw new VehicleError(
      "vehicle_sold",
      "این خودرو فروخته شده است؛ هزینهٔ پس از فروش را روی واحد ثبت نکنید.",
      409,
    );
  }

  const { id, entryId } = await insertVehicleCost(client, {
    businessId: input.businessId,
    locationId: vehicle.locationId,
    serialId: vehicle.serialId,
    stockNumber: vehicle.stockNumber,
    cost: input.cost,
    createdBy: input.createdBy ?? null,
  });

  const { rows } = await client.query<{ effective: string }>(
    `SELECT (v.purchase_cost_rial + coalesce(sum(c.amount_rial) FILTER (WHERE c.posting = 'capitalized'), 0))::text AS effective
       FROM automotive_vehicle_attributes v
       LEFT JOIN automotive_vehicle_costs c ON c.serial_id = v.serial_id AND c.status = 'active'
      WHERE v.serial_id = $1
      GROUP BY v.serial_id, v.purchase_cost_rial`,
    [input.serialId],
  );
  return { id, entryId, effectiveCostRial: Number(rows[0]?.effective ?? 0) };
}

/**
 * Voids a cost and reverses its ledger entry. The row stays (0212: voided,
 * never edited), so the car's history shows both the mistake and its
 * correction, and `unit_cost` is rebuilt from the *active* rows only.
 */
export async function voidVehicleCost(
  client: PoolClient,
  input: {
    businessId: string;
    serialId: string;
    locationId: string;
    costId: string;
    reason: string;
    /** Required: 0212's CHECK requires `voided_by`, because a void is an act somebody performed. */
    actorId: string;
  },
): Promise<void> {
  const reason = input.reason?.trim();
  if (!reason) throw new VehicleError("reason_required", "دلیل ابطال هزینه الزامی است.");
  if (!input.actorId) throw new VehicleError("actor_required", "ثبت‌کنندهٔ ابطال الزامی است.");
  await lockVehicleAtBranch(client, input.businessId, input.serialId, input.locationId);

  const { rows } = await client.query<{
    id: string;
    serial_id: string;
    location_id: string;
    status: string;
    ledger_entry_id: string | null;
    stock_number: string;
  }>(
    `SELECT c.id, c.serial_id, c.location_id, c.status, c.ledger_entry_id, v.stock_number
       FROM automotive_vehicle_costs c
       JOIN automotive_vehicle_attributes v ON v.serial_id = c.serial_id AND v.business_id = c.business_id
      WHERE c.id = $1 AND c.business_id = $2 AND c.serial_id = $3 AND v.location_id = $4
      FOR UPDATE OF c`,
    [input.costId, input.businessId, input.serialId, input.locationId],
  );
  const cost = rows[0];
  if (!cost) throw new VehicleError("cost_not_found", "هزینه یافت نشد.", 404);
  if (cost.status === "void") {
    throw new VehicleError("cost_already_void", "این هزینه قبلاً ابطال شده است.", 409);
  }

  await client.query(
    `UPDATE automotive_vehicle_costs
        SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3
      WHERE id = $1 AND business_id = $4 AND serial_id = $5`,
    [cost.id, reason, input.actorId ?? null, input.businessId, input.serialId],
  );

  // The mirror is built from what the original entry actually posted, so a
  // reversal always undoes the entry that exists rather than a re-derivation of
  // what "should" have been posted from the cost row.
  const { rows: originalLines } = await client.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, debit::text AS debit, credit::text AS credit
       FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
    [cost.ledger_entry_id],
  );

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: cost.location_id,
    eventType: "automotive.vehicle_cost_void",
    payload: {
      serialId: cost.serial_id,
      costId: cost.id,
      stockNumber: cost.stock_number,
      voidReason: reason,
      lines: originalLines.map((line) => ({
        accountId: line.account_id,
        debit: line.debit,
        credit: line.credit,
      })),
    },
    sourceType: "automotive_vehicle_cost_void",
    sourceId: cost.id,
    createdBy: input.actorId ?? null,
  });

  await syncSerialUnitCost(client, cost.serial_id);
}

/* ===========================================================================
 * Pricing — §6, and never a cost write
 * ===========================================================================
 */

export interface UpdateVehiclePriceInput {
  businessId: string;
  serialId: string;
  locationId: string;
  askingPriceRial?: number;
  minimumPriceRial?: number | null;
  wholesalePriceRial?: number | null;
  promotionalPriceRial?: number | null;
  reason?: string | null;
  actorId?: string | null;
}

/**
 * Changes what the dealership is asking — and *only* that. Every change writes
 * a price-history row (§6: "maintain complete price history"), because the
 * question a dealership asks about a car that has not sold is "how many times
 * have we moved it, and by how much".
 */
export async function updateVehiclePrice(
  client: PoolClient,
  input: UpdateVehiclePriceInput,
): Promise<{ previousAskingPriceRial: number; askingPriceRial: number }> {
  await lockVehicleAtBranch(client, input.businessId, input.serialId, input.locationId);
  const vehicle = await getVehicle(input.businessId, input.serialId, client, { locationId: input.locationId });
  if (!vehicle) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.state === "archived") {
    throw new VehicleError("vehicle_archived", "خودروی بایگانی‌شده قابل قیمت‌گذاری نیست.", 409);
  }
  if (vehicle.state === "sold") {
    throw new VehicleError("vehicle_sold", "قیمت خودروی فروخته‌شده تغییرپذیر نیست.", 409);
  }

  const askingPrice = assertWholeRial(input.askingPriceRial ?? vehicle.askingPriceRial, "قیمت فروش");
  const minimumPrice =
    input.minimumPriceRial === undefined
      ? vehicle.minimumPriceRial
      : input.minimumPriceRial == null
        ? null
        : assertWholeRial(input.minimumPriceRial, "حداقل قیمت");
  const wholesale =
    input.wholesalePriceRial === undefined
      ? vehicle.wholesalePriceRial
      : input.wholesalePriceRial == null
        ? null
        : assertWholeRial(input.wholesalePriceRial, "قیمت عمده");
  const promotional =
    input.promotionalPriceRial === undefined
      ? vehicle.promotionalPriceRial
      : input.promotionalPriceRial == null
        ? null
        : assertWholeRial(input.promotionalPriceRial, "قیمت تبلیغاتی");

  if (
    askingPrice === vehicle.askingPriceRial &&
    minimumPrice === vehicle.minimumPriceRial &&
    wholesale === vehicle.wholesalePriceRial &&
    promotional === vehicle.promotionalPriceRial
  ) {
    return { previousAskingPriceRial: vehicle.askingPriceRial, askingPriceRial: askingPrice };
  }

  await client.query(
    `UPDATE automotive_vehicle_attributes
        SET asking_price_rial = $2, minimum_price_rial = $3, wholesale_price_rial = $4,
            promotional_price_rial = $5, price_changed_at = now(), price_changed_by = $6,
            updated_at = now()
      WHERE business_id = $7 AND serial_id = $1 AND location_id = $8`,
    [input.serialId, askingPrice, minimumPrice, wholesale, promotional, input.actorId ?? null, input.businessId, input.locationId],
  );

  await client.query(
    `INSERT INTO automotive_vehicle_price_history
       (business_id, location_id, serial_id,
        previous_asking_price_rial, asking_price_rial,
        previous_minimum_price_rial, minimum_price_rial,
        previous_wholesale_price_rial, wholesale_price_rial,
        previous_promotional_price_rial, promotional_price_rial, reason, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      input.businessId,
      vehicle.locationId,
      input.serialId,
      vehicle.askingPriceRial,
      askingPrice,
      vehicle.minimumPriceRial,
      minimumPrice,
      vehicle.wholesalePriceRial,
      wholesale,
      vehicle.promotionalPriceRial,
      promotional,
      trimmedOrNull(input.reason),
      input.actorId ?? null,
    ],
  );

  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: vehicle.locationId,
    eventType: "automotive.vehicle_price_changed",
    payload: {
      serialId: input.serialId,
      stockNumber: vehicle.stockNumber,
      previousAskingPriceRial: vehicle.askingPriceRial,
      askingPriceRial: askingPrice,
      previousMinimumPriceRial: vehicle.minimumPriceRial,
      minimumPriceRial: minimumPrice,
      previousWholesalePriceRial: vehicle.wholesalePriceRial,
      wholesalePriceRial: wholesale,
      previousPromotionalPriceRial: vehicle.promotionalPriceRial,
      promotionalPriceRial: promotional,
      reason: trimmedOrNull(input.reason),
    },
    sourceType: "automotive_vehicle",
    sourceId: input.serialId,
    createdBy: input.actorId ?? null,
  });

  return { previousAskingPriceRial: vehicle.askingPriceRial, askingPriceRial: askingPrice };
}

export interface VehiclePriceHistoryEntry {
  id: string;
  previousAskingPriceRial: number;
  askingPriceRial: number;
  previousMinimumPriceRial: number | null;
  minimumPriceRial: number | null;
  previousWholesalePriceRial: number | null;
  wholesalePriceRial: number | null;
  previousPromotionalPriceRial: number | null;
  promotionalPriceRial: number | null;
  reason: string | null;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: string;
}

export async function listVehiclePriceHistory(
  businessId: string,
  serialId: string,
  client?: PoolClient,
  scope?: VehicleReadScope,
): Promise<VehiclePriceHistoryEntry[]> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params as never);
  const params: unknown[] = [businessId, serialId];
  const branchFilter = vehicleBranchFilter("v", params, scope);
  if (branchFilter === null) return [];
  const { rows } = await run<{
    id: string;
    previous_asking_price_rial: string;
    asking_price_rial: string;
    previous_minimum_price_rial: string | null;
    minimum_price_rial: string | null;
    previous_wholesale_price_rial: string | null;
    wholesale_price_rial: string | null;
    previous_promotional_price_rial: string | null;
    promotional_price_rial: string | null;
    reason: string | null;
    changed_by: string | null;
    changed_by_name: string | null;
    changed_at: string;
  }>(
    `SELECT h.id, h.previous_asking_price_rial::text AS previous_asking_price_rial,
            h.asking_price_rial::text AS asking_price_rial,
            h.previous_minimum_price_rial::text AS previous_minimum_price_rial,
            h.minimum_price_rial::text AS minimum_price_rial,
            h.previous_wholesale_price_rial::text AS previous_wholesale_price_rial,
            h.wholesale_price_rial::text AS wholesale_price_rial,
            h.previous_promotional_price_rial::text AS previous_promotional_price_rial,
            h.promotional_price_rial::text AS promotional_price_rial, h.reason, h.changed_by,
            u.full_name AS changed_by_name, h.changed_at::text AS changed_at
       FROM automotive_vehicle_price_history h
       JOIN automotive_vehicle_attributes v
         ON v.business_id = h.business_id AND v.serial_id = h.serial_id
       LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.business_id = $1 AND h.serial_id = $2${branchFilter}
      ORDER BY h.changed_at DESC`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    previousAskingPriceRial: Number(r.previous_asking_price_rial),
    askingPriceRial: Number(r.asking_price_rial),
    previousMinimumPriceRial: r.previous_minimum_price_rial == null ? null : Number(r.previous_minimum_price_rial),
    minimumPriceRial: r.minimum_price_rial == null ? null : Number(r.minimum_price_rial),
    previousWholesalePriceRial: r.previous_wholesale_price_rial == null ? null : Number(r.previous_wholesale_price_rial),
    wholesalePriceRial: r.wholesale_price_rial == null ? null : Number(r.wholesale_price_rial),
    previousPromotionalPriceRial: r.previous_promotional_price_rial == null ? null : Number(r.previous_promotional_price_rial),
    promotionalPriceRial: r.promotional_price_rial == null ? null : Number(r.promotional_price_rial),
    reason: r.reason,
    changedBy: r.changed_by,
    changedByName: r.changed_by_name,
    changedAt: r.changed_at,
  }));
}

/* ===========================================================================
 * Vehicle files — canonical media bytes, vehicle-owned links and labels
 * ===========================================================================
 */

export interface VehicleMediaAttachment {
  id: string;
  mediaAssetId: string;
  fileName: string;
  mimeType: string;
  mediaKind: "image" | "video" | "document";
  category: VehicleMediaCategory;
  title: string;
  description: string | null;
  displayOrder: number;
  deletedAt: string | null;
  createdAt: string;
}

export async function listVehicleMedia(
  businessId: string,
  serialId: string,
  client?: PoolClient,
  scope?: VehicleReadScope,
): Promise<VehicleMediaAttachment[]> {
  const params: unknown[] = [businessId, serialId];
  const branchFilter = vehicleBranchFilter("v", params, scope);
  if (branchFilter === null) return [];
  const run = <T extends Record<string, unknown>>(text: string, values: unknown[]) =>
    client ? client.query<T>(text, values as never) : query<T>(text, values as never);
  const { rows } = await run<{
    id: string;
    media_asset_id: string;
    file_name: string;
    mime_type: string;
    media_kind: "image" | "video" | "document";
    category: VehicleMediaCategory;
    title: string;
    description: string | null;
    display_order: number;
    deleted_at: string | null;
    created_at: string;
  }>(
    `SELECT vm.id, vm.media_asset_id, a.file_name, a.mime_type, a.kind AS media_kind,
            vm.category, vm.title, vm.description, vm.display_order,
            a.deleted_at::text AS deleted_at, vm.created_at::text AS created_at
       FROM automotive_vehicle_media vm
       JOIN automotive_vehicle_attributes v
         ON v.business_id = vm.business_id AND v.serial_id = vm.serial_id
       JOIN media_assets a
         ON a.business_id = vm.business_id AND a.id = vm.media_asset_id
      WHERE vm.business_id = $1 AND vm.serial_id = $2${branchFilter}
      ORDER BY vm.display_order, vm.created_at DESC, vm.id`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    mediaAssetId: row.media_asset_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    mediaKind: row.media_kind,
    category: row.category,
    title: row.title,
    description: row.description,
    displayOrder: row.display_order,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  }));
}

export async function attachVehicleMedia(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    serialId: string;
    mediaAssetId: string;
    category: VehicleMediaCategory;
    title: string;
    description?: string | null;
    actorId?: string | null;
  },
): Promise<VehicleMediaAttachment> {
  await lockVehicleAtBranch(client, input.businessId, input.serialId, input.locationId);
  if (!(VEHICLE_MEDIA_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new VehicleError("invalid_media_category", "دسته‌بندی فایل خودرو معتبر نیست.");
  }
  const title = input.title.trim();
  if (!title || title.length > 200) {
    throw new VehicleError("invalid_vehicle_media", "عنوان فایل باید بین ۱ تا ۲۰۰ نویسه باشد.");
  }
  const description = trimmedOrNull(input.description ?? null);
  if (description && description.length > 2000) {
    throw new VehicleError("invalid_vehicle_media", "توضیح فایل نباید بیش از ۲۰۰۰ نویسه باشد.");
  }
  const { rows: assets } = await client.query<{ id: string; file_name: string }>(
    `SELECT id, file_name FROM media_assets
      WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL
      FOR SHARE`,
    [input.businessId, input.mediaAssetId],
  );
  if (!assets[0]) throw new VehicleError("media_not_found", "فایل در کتابخانهٔ این کسب‌وکار یافت نشد.", 404);

  const { rows: existingRows } = await client.query<{
    id: string;
    title: string;
    category: VehicleMediaCategory;
    description: string | null;
  }>(
    `SELECT id, title, category, description FROM automotive_vehicle_media
      WHERE business_id = $1 AND serial_id = $2 AND media_asset_id = $3
      FOR UPDATE`,
    [input.businessId, input.serialId, input.mediaAssetId],
  );
  let relationId: string;
  let changed = true;
  if (existingRows[0]) {
    relationId = existingRows[0].id;
    changed = existingRows[0].title !== title || existingRows[0].category !== input.category || existingRows[0].description !== description;
    if (changed) {
      await client.query(
        `UPDATE automotive_vehicle_media SET title = $4, category = $5, description = $6
          WHERE business_id = $1 AND serial_id = $2 AND media_asset_id = $3`,
        [input.businessId, input.serialId, input.mediaAssetId, title, input.category, description],
      );
    }
  } else {
    const { rows: orderRows } = await client.query<{ next_order: number }>(
      `SELECT coalesce(max(display_order) + 1, 0)::int AS next_order
         FROM automotive_vehicle_media WHERE business_id = $1 AND serial_id = $2`,
      [input.businessId, input.serialId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO automotive_vehicle_media
         (business_id, serial_id, media_asset_id, category, title, description, display_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.businessId, input.serialId, input.mediaAssetId, input.category, title, description, orderRows[0].next_order, input.actorId ?? null],
    );
    relationId = rows[0].id;
  }
  if (changed) {
    await recordDomainEvent(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: "automotive.vehicle_media_attached",
      payload: { serialId: input.serialId, mediaAssetId: input.mediaAssetId, category: input.category, title },
      sourceType: "automotive_vehicle_media",
      sourceId: relationId,
      createdBy: input.actorId ?? null,
    });
  }
  const attachment = (await listVehicleMedia(input.businessId, input.serialId, client, { locationId: input.locationId }))
    .find((entry) => entry.id === relationId);
  if (!attachment) throw new VehicleError("media_not_found", "فایل پیوست‌شده یافت نشد.", 404);
  return attachment;
}

export async function detachVehicleMedia(
  client: PoolClient,
  input: { businessId: string; locationId: string; serialId: string; mediaAssetId: string; actorId?: string | null },
): Promise<boolean> {
  await lockVehicleAtBranch(client, input.businessId, input.serialId, input.locationId);
  const { rows } = await client.query<{ id: string; category: VehicleMediaCategory; title: string }>(
    `DELETE FROM automotive_vehicle_media
      WHERE business_id = $1 AND serial_id = $2 AND media_asset_id = $3
      RETURNING id, category, title`,
    [input.businessId, input.serialId, input.mediaAssetId],
  );
  if (!rows[0]) return false;
  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "automotive.vehicle_media_detached",
    payload: { serialId: input.serialId, mediaAssetId: input.mediaAssetId, category: rows[0].category, title: rows[0].title },
    sourceType: "automotive_vehicle_media",
    sourceId: rows[0].id,
    createdBy: input.actorId ?? null,
  });
  return true;
}

/* ===========================================================================
 * Details, state and archive
 * ===========================================================================
 */

export interface UpdateVehicleInput {
  businessId: string;
  serialId: string;
  locationId: string;
  plateNumber?: string | null;
  engineNumber?: string | null;
  registrationDate?: string | null;
  mileageKm?: number | null;
  priorOwners?: number | null;
  inspectionNotes?: string | null;
  bodyConditionNotes?: string | null;
  mechanicalNotes?: string | null;
  serviceHistory?: string | null;
  exteriorColor?: string | null;
  interiorColor?: string | null;
  bodyType?: VehicleBodyType | null;
  transmission?: VehicleTransmission | null;
  fuelType?: VehicleFuelType | null;
  drivetrain?: VehicleDrivetrain | null;
  engineSpec?: string | null;
  /** Identity changes are audited in their own right (§20). */
  vin?: string | null;
  chassisNumber?: string | null;
  actorId?: string | null;
}

/**
 * Edits the physical facts of a car. VIN and chassis number are the two fields
 * a dealership must be able to correct (a typo at intake) *and* must never be
 * able to change quietly, so a change to either records its own domain event
 * with both values — §20's "VIN/chassis change" audit, in the log the rest of
 * the platform audits through.
 */
export async function updateVehicle(
  client: PoolClient,
  input: UpdateVehicleInput,
): Promise<VehicleDetail> {
  await lockVehicleAtBranch(client, input.businessId, input.serialId, input.locationId);
  const vehicle = await getVehicle(input.businessId, input.serialId, client, { locationId: input.locationId });
  if (!vehicle) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.state === "sold") {
    throw new VehicleError("vehicle_sold", "خودروی فروخته‌شده قابل ویرایش نیست.", 409);
  }

  const identityChanges: Record<string, { from: string | null; to: string | null }> = {};
  const patch: Record<string, unknown> = {};

  if (input.vin !== undefined) {
    const error = validateVin(input.vin);
    if (error) throw new VehicleError("invalid_vin", error);
    const vin = trimmedOrNull(normalizeVin(input.vin ?? ""));
    if (vin !== vehicle.vin) identityChanges.vin = { from: vehicle.vin, to: vin };
    patch.vin = vin;
  }
  if (input.chassisNumber !== undefined) {
    const error = validateChassisNumber(input.chassisNumber);
    if (error) throw new VehicleError("invalid_chassis", error);
    const chassis = trimmedOrNull(normalizeChassis(input.chassisNumber ?? ""));
    if (chassis !== vehicle.chassisNumber) identityChanges.chassisNumber = { from: vehicle.chassisNumber, to: chassis };
    patch.chassis_number = chassis;
  }
  if (input.engineNumber !== undefined) patch.engine_number = trimmedOrNull(input.engineNumber);
  if (input.plateNumber !== undefined) {
    const error = validatePlateNumber(input.plateNumber);
    if (error) throw new VehicleError("invalid_plate", error);
    patch.plate_number = trimmedOrNull(input.plateNumber);
  }
  if (input.mileageKm !== undefined) {
    const error = validateMileage(input.mileageKm, vehicle.condition);
    if (error) throw new VehicleError("invalid_mileage", error);
    patch.mileage_km = input.mileageKm;
  }
  if (input.priorOwners !== undefined) {
    const error = validatePriorOwners(input.priorOwners, vehicle.condition);
    if (error) throw new VehicleError("invalid_prior_owners", error);
    patch.prior_owners = input.priorOwners;
  }
  if (input.registrationDate !== undefined) {
    patch.registration_date = input.registrationDate == null ? null : assertIsoDate(input.registrationDate, "تاریخ ثبت");
  }
  if (input.inspectionNotes !== undefined) patch.inspection_notes = trimmedOrNull(input.inspectionNotes);
  if (input.bodyConditionNotes !== undefined) patch.body_condition_notes = trimmedOrNull(input.bodyConditionNotes);
  if (input.mechanicalNotes !== undefined) patch.mechanical_notes = trimmedOrNull(input.mechanicalNotes);
  if (input.serviceHistory !== undefined) patch.service_history = trimmedOrNull(input.serviceHistory);
  if (input.exteriorColor !== undefined) patch.exterior_color = trimmedOrNull(input.exteriorColor);
  if (input.interiorColor !== undefined) patch.interior_color = trimmedOrNull(input.interiorColor);
  if (input.bodyType !== undefined) {
    if (input.bodyType !== null && !(VEHICLE_BODY_TYPES as readonly string[]).includes(input.bodyType)) {
      throw new VehicleError("invalid_vehicle", "نوع بدنهٔ خودرو معتبر نیست.");
    }
    patch.body_type = input.bodyType;
  }
  if (input.transmission !== undefined) {
    if (input.transmission !== null && !(VEHICLE_TRANSMISSIONS as readonly string[]).includes(input.transmission)) {
      throw new VehicleError("invalid_vehicle", "نوع گیربکس خودرو معتبر نیست.");
    }
    patch.transmission = input.transmission;
  }
  if (input.fuelType !== undefined) {
    if (input.fuelType !== null && !(VEHICLE_FUEL_TYPES as readonly string[]).includes(input.fuelType)) {
      throw new VehicleError("invalid_vehicle", "نوع سوخت خودرو معتبر نیست.");
    }
    patch.fuel_type = input.fuelType;
  }
  if (input.drivetrain !== undefined) {
    if (input.drivetrain !== null && !(VEHICLE_DRIVETRAINS as readonly string[]).includes(input.drivetrain)) {
      throw new VehicleError("invalid_vehicle", "نوع محور محرک خودرو معتبر نیست.");
    }
    patch.drivetrain = input.drivetrain;
  }
  if (input.engineSpec !== undefined) patch.engine_spec = trimmedOrNull(input.engineSpec);

  const columns = Object.keys(patch);
  if (columns.length > 0) {
    const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
    await client.query(
      `UPDATE automotive_vehicle_attributes SET ${assignments.join(", ")}, updated_at = now()
        WHERE business_id = $${columns.length + 1} AND serial_id = $${columns.length + 2} AND location_id = $${columns.length + 3}`,
      [...columns.map((c) => patch[c]), input.businessId, input.serialId, input.locationId],
    );
  }

  if (Object.keys(identityChanges).length > 0) {
    await recordDomainEvent(client, {
      businessId: input.businessId,
      locationId: vehicle.locationId,
      eventType: "automotive.vehicle_identity_changed",
      payload: { serialId: input.serialId, stockNumber: vehicle.stockNumber, changes: identityChanges },
      sourceType: "automotive_vehicle",
      sourceId: input.serialId,
      createdBy: input.actorId ?? null,
    });
  }

  const updated = await getVehicle(input.businessId, input.serialId, client, { locationId: input.locationId });
  if (!updated) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  return updated;
}

/** The serial status that mirrors an automotive state. */
const SERIAL_STATUS_FOR_VEHICLE_STATE: Record<VehicleState, string> = {
  draft: "in_stock",
  acquired: "in_stock",
  in_stock: "in_stock",
  reserved: "reserved",
  sold: "sold",
  // Off the sellable shelf while it is away, comes back when it lands.
  returned: "in_stock",
  transferred: "in_stock",
  archived: "in_stock",
};

/**
 * The lifecycle's one guarded door (§3): every state change goes through the
 * pure state machine, so an illegal edge (`sold → in_stock`) is refused here
 * rather than written by whichever screen got there first.
 *
 * `onlyIfState` is the conditional form every automatic caller wants ("if the
 * car is still reserved, put it back on the shelf") — a release or an expiry
 * must never drag a car that has since sold back to `in_stock`.
 */
export async function ensureVehicleState(
  client: PoolClient,
  input: {
    businessId: string;
    serialId: string;
    state: VehicleState;
    locationId?: string;
    actorId?: string | null;
    /** Defaults to the generic state-change event; callers name the act that caused it. */
    eventType?: string;
    onlyIfState?: VehicleState;
    /** State transitions are owned by a domain command, never a generic status setter. */
    command?: VehicleStateCommand;
    /** Additional command facts for the audit event, never authoritative state fields. */
    eventPayload?: Record<string, unknown>;
  },
): Promise<void> {
  const { rows } = await client.query<{ state: VehicleState; location_id: string; stock_number: string }>(
    `SELECT state, location_id, stock_number FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND serial_id = $2 FOR UPDATE`,
    [input.businessId, input.serialId],
  );
  const vehicle = rows[0];
  if (!vehicle) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (input.locationId && vehicle.location_id !== input.locationId) {
    throw new VehicleError("wrong_location", "این خودرو در شعبهٔ فعال نیست.", 409);
  }
  if (input.onlyIfState && vehicle.state !== input.onlyIfState) return;
  if (vehicle.state === input.state) return;

  const error = validateVehicleStateTransition(vehicle.state, input.state);
  if (error) throw new VehicleError("invalid_state_transition", error, 409);
  const commandError = validateVehicleStateCommand(vehicle.state, input.state, input.command);
  if (commandError) throw new VehicleError("state_command_required", commandError, 409);

  await client.query(
    `UPDATE automotive_vehicle_attributes SET state = $2, updated_at = now()
      WHERE business_id = $1 AND serial_id = $3`,
    [input.businessId, input.state, input.serialId],
  );
  // The shared serial status follows the automotive state so the generic stock
  // paths (the retail board, the transfer service) never disagree with it.
  await client.query(`UPDATE item_serials SET status = $2 WHERE id = $1`, [
    input.serialId,
    SERIAL_STATUS_FOR_VEHICLE_STATE[input.state],
  ]);

  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: vehicle.location_id,
    eventType: input.eventType ?? "automotive.vehicle_state_changed",
    payload: {
      ...input.eventPayload,
      serialId: input.serialId,
      stockNumber: vehicle.stock_number,
      from: vehicle.state,
      to: input.state,
    },
    sourceType: "automotive_vehicle",
    sourceId: input.serialId,
    createdBy: input.actorId ?? null,
  });
}

export async function setVehicleState(
  client: PoolClient,
  input: { businessId: string; serialId: string; state: VehicleState; actorId?: string | null },
): Promise<VehicleDetail> {
  await ensureVehicleState(client, input);
  const updated = await getVehicle(input.businessId, input.serialId, client);
  if (!updated) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  return updated;
}

/** Moves a returned car back onto the sellable shelf after an explicit inspection decision. */
export async function relistReturnedVehicle(
  client: PoolClient,
  input: { businessId: string; serialId: string; locationId: string; reason: string; actorId?: string | null },
): Promise<void> {
  const reason = input.reason?.trim();
  if (!reason) throw new VehicleError("reason_required", "دلیل بازگشت خودرو به موجودی الزامی است.");
  await ensureVehicleState(client, {
    businessId: input.businessId,
    serialId: input.serialId,
    locationId: input.locationId,
    state: "in_stock",
    actorId: input.actorId ?? null,
    command: "sale_relisted",
    eventType: "automotive.vehicle_relisted",
    eventPayload: { reason },
  });
}

/** Archives a car off the board. A sold car keeps its sale; nothing is deleted. */
export async function archiveVehicle(
  client: PoolClient,
  input: { businessId: string; serialId: string; locationId: string; reason?: string | null; actorId?: string | null },
): Promise<void> {
  // Lock the vehicle before checking holds/transfers, matching every other
  // lifecycle command's lock order and closing the reservation/archive race.
  const { rows: vehicleRows } = await client.query<{ state: VehicleState; location_id: string; stock_number: string }>(
    `SELECT state, location_id, stock_number FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND serial_id = $2 FOR UPDATE`,
    [input.businessId, input.serialId],
  );
  const vehicle = vehicleRows[0];
  if (!vehicle) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.location_id !== input.locationId) {
    throw new VehicleError("wrong_location", "این خودرو در شعبهٔ فعال نیست.", 409);
  }
  if (vehicle.state === "sold") {
    throw new VehicleError("vehicle_sold", "خودروی فروخته‌شده بایگانی نمی‌شود؛ سابقهٔ فروش آن سند حسابداری است.", 409);
  }
  if (vehicle.state === "archived") throw new VehicleError("vehicle_archived", "این خودرو قبلاً بایگانی شده است.", 409);
  const { rows: openRows } = await client.query<{ held: boolean; transferring: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM serial_reservations
                     WHERE business_id = $1 AND serial_id = $2 AND status = 'active') AS held,
            EXISTS (SELECT 1 FROM automotive_vehicle_transfers
                     WHERE business_id = $1 AND serial_id = $2 AND status = 'in_transit') AS transferring`,
    [input.businessId, input.serialId],
  );
  if (openRows[0]?.held) throw new VehicleError("vehicle_reserved", "ابتدا رزرو فعال را تعیین تکلیف کنید.", 409);
  if (openRows[0]?.transferring) throw new VehicleError("already_in_transit", "خودروی در حال انتقال بایگانی نمی‌شود.", 409);
  await ensureVehicleState(client, {
    businessId: input.businessId,
    serialId: input.serialId,
    locationId: input.locationId,
    state: "archived",
    actorId: input.actorId ?? null,
    command: "archived",
  });
  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: vehicle.location_id,
    eventType: "automotive.vehicle_archived",
    payload: { serialId: input.serialId, stockNumber: vehicle.stock_number, reason: trimmedOrNull(input.reason) },
    sourceType: "automotive_vehicle",
    sourceId: input.serialId,
    createdBy: input.actorId ?? null,
  });
}

/* ===========================================================================
 * The stock list — §10's table, filters and search
 * ===========================================================================
 */

export interface VehicleListFilters {
  businessId: string;
  /** One branch when the UI is on a specific lot. */
  locationId?: string | null;
  /** Explicit authorized branch set for a multi-branch view (empty means no rows). */
  locationIds?: string[];
  condition?: VehicleCondition | null;
  states?: VehicleState[];
  make?: string | null;
  model?: string | null;
  modelYearFrom?: number | null;
  modelYearTo?: number | null;
  minPriceRial?: number | null;
  maxPriceRial?: number | null;
  minMileageKm?: number | null;
  maxMileageKm?: number | null;
  /** §10's stock-age filter, in days in stock. */
  minAgeDays?: number | null;
  maxAgeDays?: number | null;
  /** VIN, chassis, stock number, plate, make/model, customer — one box, §10. */
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface VehicleListItem {
  serialId: string;
  stockNumber: string;
  displayName: string;
  make: string;
  model: string;
  trim: string | null;
  modelYear: number | null;
  condition: VehicleCondition;
  mileageKm: number | null;
  state: VehicleState;
  locationId: string;
  locationName: string | null;
  purchaseCostRial: number;
  effectiveCostRial: number;
  askingPriceRial: number;
  minimumPriceRial: number | null;
  potentialMarginRial: number;
  acquiredOn: string;
  daysInStock: number;
  vin: string | null;
  chassisNumber: string | null;
  plateNumber: string | null;
  /** The live hold's customer, when the car is reserved — so the board says who. */
  reservedForName: string | null;
  /**
   * The hold's customer id and the deposit it took. Both travel because the
   * sale path needs them and cannot guess them: a reserved car sells only to
   * the customer the hold names (the server refuses anybody else), and the
   * deposit the customer already paid is applied to the invoice rather than
   * collected a second time — the screen has to know how much that is before
   * it can say what is still due.
   */
  reservedForCustomerId: string | null;
  reservedDepositRial: number;
  reservedUntil: string | null;
  /** The day it sold, for the sold list; null while it is still stock. */
  soldOn: string | null;
  /** What the sale's invoice totalled (VAT included), preserved by the sale. */
  soldPriceRial: number | null;
}

/**
 * The stock table's query. Every filter is applied in SQL (a dealership's lot
 * is large and the screen pages), and the search box matches identity fields
 * case-insensitively through their upper-case indexes plus make/model — the
 * fields §10 lists by name.
 */
export async function listVehicles(
  filters: VehicleListFilters,
  client?: PoolClient,
): Promise<{ vehicles: VehicleListItem[]; total: number }> {
  const params: unknown[] = [filters.businessId];
  const where: string[] = ["v.business_id = $1"];

  if (filters.locationIds !== undefined) {
    if (filters.locationIds.length === 0) where.push("FALSE");
    else where.push(`v.location_id = ANY($${params.push(filters.locationIds)}::uuid[])`);
  } else if (filters.locationId) {
    where.push(`v.location_id = $${params.push(filters.locationId)}`);
  }
  if (filters.condition) where.push(`v.condition = $${params.push(filters.condition)}`);
  if (filters.states && filters.states.length > 0) {
    where.push(`v.state = ANY($${params.push(filters.states)}::text[])`);
  }
  if (filters.make) where.push(`v.make ILIKE $${params.push(`%${filters.make}%`)}`);
  if (filters.model) where.push(`v.model ILIKE $${params.push(`%${filters.model}%`)}`);
  if (filters.modelYearFrom != null) where.push(`v.model_year >= $${params.push(filters.modelYearFrom)}`);
  if (filters.modelYearTo != null) where.push(`v.model_year <= $${params.push(filters.modelYearTo)}`);
  if (filters.minPriceRial != null) where.push(`v.asking_price_rial >= $${params.push(filters.minPriceRial)}`);
  if (filters.maxPriceRial != null) where.push(`v.asking_price_rial <= $${params.push(filters.maxPriceRial)}`);
  if (filters.minMileageKm != null) {
    where.push(`coalesce(v.mileage_km, 0) >= $${params.push(filters.minMileageKm)}`);
  }
  if (filters.maxMileageKm != null) {
    where.push(`coalesce(v.mileage_km, 0) <= $${params.push(filters.maxMileageKm)}`);
  }
  const branchToday = "app_business_date(statement_timestamp(), coalesce(nullif(l.timezone, ''), 'Asia/Tehran'), l.business_day_start_minutes)";
  if (filters.minAgeDays != null) {
    where.push(
      `(${branchToday} - coalesce(v.acquisition_date, v.created_at::date)) >= $${params.push(filters.minAgeDays)}::int`,
    );
  }
  if (filters.maxAgeDays != null) {
    where.push(
      `(${branchToday} - coalesce(v.acquisition_date, v.created_at::date)) <= $${params.push(filters.maxAgeDays)}::int`,
    );
  }

  const search = filters.search?.trim();
  if (search) {
    // `normalizeVehicleSearch` folds Persian digits and upper-cases the Latin
    // identity fields; the SQL upper-cases the columns to match its indexes.
    const term = `%${search.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))}%`;
    const index = params.push(term);
    where.push(
      `(upper(v.vin) LIKE upper($${index}) OR upper(v.chassis_number) LIKE upper($${index})
        OR upper(v.engine_number) LIKE upper($${index}) OR upper(v.stock_number) LIKE upper($${index})
        OR v.plate_number LIKE $${index} OR v.make ILIKE $${index} OR v.model ILIKE $${index}
        OR v.trim ILIKE $${index} OR hold.customer_name ILIKE $${index})`,
    );
  }

  const whereSql = where.join(" AND ");
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const run = <T extends Record<string, unknown>>(text: string, values: unknown[]) =>
    client ? client.query<T>(text, values as never) : query<T>(text, values as never);

  // The lateral join carries the live hold — the board's «رزرو برای …» column and
  // the customer-name half of the search box both read it, so the count query
  // needs it too (a filtered count must agree with the rows it counts).
  const FROM_SQL = `
    FROM automotive_vehicle_attributes v
    LEFT JOIN locations l ON l.id = v.location_id AND l.business_id = v.business_id
    LEFT JOIN (
      SELECT business_id, serial_id,
             sum(amount_rial) FILTER (WHERE posting = 'capitalized') AS capitalized_cost_rial
        FROM automotive_vehicle_costs WHERE status = 'active'
       GROUP BY business_id, serial_id
    ) c ON c.business_id = v.business_id AND c.serial_id = v.serial_id
    LEFT JOIN LATERAL (
      SELECT p.name AS customer_name, sr.customer_id, sr.expires_at::text AS expires_until,
             sr.deposit_amount_rial
        FROM serial_reservations sr
        LEFT JOIN parties p ON p.id = sr.customer_id AND p.business_id = sr.business_id
       WHERE sr.business_id = v.business_id AND sr.serial_id = v.serial_id AND sr.status = 'active'
       ORDER BY sr.created_at DESC LIMIT 1
    ) hold ON true`;

  const { rows } = await run<{
    serial_id: string;
    stock_number: string;
    make: string;
    model: string;
    trim: string | null;
    model_year: number | null;
    condition: VehicleCondition;
    mileage_km: number | null;
    state: VehicleState;
    location_id: string;
    location_name: string | null;
    purchase_cost_rial: string;
    effective_cost_rial: string;
    asking_price_rial: string;
    minimum_price_rial: string | null;
    acquired_on: string;
    business_today: string;
    vin: string | null;
    chassis_number: string | null;
    plate_number: string | null;
    reserved_for_name: string | null;
    reserved_for_customer_id: string | null;
    reserved_until: string | null;
    reserved_deposit_rial: string | null;
    sold_on: string | null;
    sale_price_rial: string | null;
    vat_rial: string;
  }>(
    `SELECT v.serial_id, v.stock_number, v.make, v.model, v.trim, v.model_year, v.condition,
            v.mileage_km, v.state, v.location_id, l.name AS location_name,
            v.purchase_cost_rial::text AS purchase_cost_rial,
            -- For a sold car the *frozen* number is the effective cost: that is
            -- the figure COGS posted, and a cost row recorded after the sale
            -- must not make the board disagree with the ledger about a car that
            -- has already gone.
            coalesce(
              v.frozen_effective_cost_rial,
              v.purchase_cost_rial + coalesce(c.capitalized_cost_rial, 0)
            )::text AS effective_cost_rial,
            v.asking_price_rial::text AS asking_price_rial,
            v.minimum_price_rial::text AS minimum_price_rial,
            coalesce(v.acquisition_date, v.created_at::date)::text AS acquired_on,
            app_business_date(statement_timestamp(), coalesce(nullif(l.timezone, ''), 'Asia/Tehran'), l.business_day_start_minutes)::text AS business_today,
            v.vin, v.chassis_number, v.plate_number,
            hold.customer_name AS reserved_for_name, hold.customer_id AS reserved_for_customer_id,
            hold.deposit_amount_rial::text AS reserved_deposit_rial,
            hold.expires_until AS reserved_until, v.sold_on::text AS sold_on,
            v.sale_price_rial::text AS sale_price_rial
       ${FROM_SQL}
      WHERE ${whereSql}
      ORDER BY v.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  const { rows: countRows } = await run<{ count: string }>(
    `SELECT count(*)::text AS count ${FROM_SQL} WHERE ${whereSql}`,
    params,
  );

  return {
    vehicles: rows.map((row) => {
      const effective = Number(row.effective_cost_rial);
      const asking = Number(row.asking_price_rial);
      const acquiredOn = row.acquired_on;
      return {
        serialId: row.serial_id,
        stockNumber: row.stock_number,
        displayName: vehicleDisplayName({
          make: row.make,
          model: row.model,
          trim: row.trim,
          modelYear: row.model_year,
        }),
        make: row.make,
        model: row.model,
        trim: row.trim,
        modelYear: row.model_year,
        condition: row.condition,
        mileageKm: row.mileage_km,
        state: row.state,
        locationId: row.location_id,
        locationName: row.location_name,
        purchaseCostRial: Number(row.purchase_cost_rial),
        effectiveCostRial: effective,
        askingPriceRial: asking,
        minimumPriceRial: row.minimum_price_rial == null ? null : Number(row.minimum_price_rial),
        potentialMarginRial: asking - effective,
        acquiredOn,
        daysInStock: daysInStock({ acquiredOn }, row.business_today),
        vin: row.vin,
        chassisNumber: row.chassis_number,
        plateNumber: row.plate_number,
        reservedForName: row.reserved_for_name,
        reservedForCustomerId: row.reserved_for_customer_id,
        reservedDepositRial: Number(row.reserved_deposit_rial ?? 0),
        reservedUntil: row.reserved_until,
        soldOn: row.sold_on,
        soldPriceRial: row.sale_price_rial == null ? null : Number(row.sale_price_rial),
      };
    }),
    total: Number(countRows[0]?.count ?? 0),
  };
}

/**
 * §16's dashboard numbers, computed from the same rows the list shows. The
 * arithmetic itself is `summarizeVehicleStock` in `automotive.ts` — pure, so
 * the dashboard and the report cannot disagree about what "in stock" counts.
 */
export async function summarizeVehicles(
  businessId: string,
  options: { locationId?: string | null; locationIds?: string[]; onDate: string },
  client?: PoolClient,
): Promise<{
  inStock: number;
  reserved: number;
  sold: number;
  stockValueRial: number;
  askingValueRial: number;
  potentialMarginRial: number;
  averageAgeDays: number | null;
  slowCount: number;
  deadCount: number;
  soldThisMonth: number;
  revenueThisMonthRial: number;
  grossProfitThisMonthRial: number;
  averageMarginThisMonth: number | null;
}> {
  const { summarizeVehicleStock } = await import("./automotive");
  const params: unknown[] = [businessId];
  let where = "v.business_id = $1";
  if (options.locationIds !== undefined) {
    if (options.locationIds.length === 0) where += " AND FALSE";
    else where += ` AND v.location_id = ANY($${params.push(options.locationIds)}::uuid[])`;
  } else if (options.locationId) {
    where += ` AND v.location_id = $${params.push(options.locationId)}`;
  }
  const run = <T extends Record<string, unknown>>(text: string, values: unknown[]) =>
    client ? client.query<T>(text, values as never) : query<T>(text, values as never);
  const { rows } = await run<{
    state: VehicleState;
    condition: VehicleCondition;
    effective_cost_rial: string;
    asking_price_rial: string;
    acquired_on: string;
    business_today: string;
    sold_on: string | null;
    sale_price_rial: string | null;
    vat_rial: string;
  }>(
    `SELECT v.state, v.condition,
            -- For a sold car the *frozen* number is the effective cost: that is
            -- the figure COGS posted, and a cost row recorded after the sale
            -- must not make the board disagree with the ledger about a car that
            -- has already gone.
            coalesce(
              sale.frozen_effective_cost_rial,
              v.frozen_effective_cost_rial,
              v.purchase_cost_rial + coalesce(c.capitalized_cost_rial, 0)
            )::text AS effective_cost_rial,
            v.asking_price_rial::text AS asking_price_rial,
            coalesce(v.acquisition_date, v.created_at::date)::text AS acquired_on,
            app_business_date(statement_timestamp(), coalesce(nullif(l.timezone, ''), 'Asia/Tehran'), l.business_day_start_minutes)::text AS business_today,
            sale.sold_on::text AS sold_on, sale.sale_price_rial::text AS sale_price_rial,
            -- The active sale occurrence owns the correct per-sale ledger key;
            -- summing by serial id would mix returns and later resales.
            coalesce((
              SELECT sum(jl.credit) FROM journal_entries e
                JOIN journal_lines jl ON jl.entry_id = e.id
                JOIN accounts a ON a.id = jl.account_id
               WHERE e.business_id = sale.business_id AND e.source_id = sale.sale_id
                 AND e.posting_kind = 'automotive_sale_revenue' AND a.code = '2200'
            ), 0)::text AS vat_rial
       FROM automotive_vehicle_attributes v
       LEFT JOIN locations l ON l.id = v.location_id AND l.business_id = v.business_id
       LEFT JOIN automotive_vehicle_sales sale
         ON sale.business_id = v.business_id AND sale.serial_id = v.serial_id AND sale.status = 'active'
       LEFT JOIN (
         SELECT business_id, serial_id,
                sum(amount_rial) FILTER (WHERE posting = 'capitalized') AS capitalized_cost_rial
           FROM automotive_vehicle_costs WHERE status = 'active'
          GROUP BY business_id, serial_id
       ) c ON c.business_id = v.business_id AND c.serial_id = v.serial_id
      WHERE ${where}`,
    params,
  );

  const summary = summarizeVehicleStock(
    rows.map((row) => ({
      state: row.state,
      condition: row.condition,
      effectiveCostRial: Number(row.effective_cost_rial),
      askingPriceRial: Number(row.asking_price_rial),
      acquiredOn: row.acquired_on,
      businessToday: row.business_today,
      soldOn: row.sold_on,
      salePriceRial: row.sale_price_rial == null ? null : Number(row.sale_price_rial),
      // Net of VAT, and at the frozen cost — the same two numbers the ledger
      // recorded for this sale, so the dashboard's margin is the report's.
      saleNetRial:
        row.sale_price_rial == null ? null : Math.max(0, Number(row.sale_price_rial) - Number(row.vat_rial)),
      soldCostRial: row.sold_on == null ? null : Number(row.effective_cost_rial),
    })),
    options.onDate,
  );
  return {
    ...summary,
    potentialMarginRial: summary.askingValueRial - summary.stockValueRial,
  };
}

/* ===========================================================================
 * §11 — moving a car between branches
 * ===========================================================================
 * A physically moving car is a *liability to the lot that has not received it
 * yet*: it is on neither lot's sellable board while it travels, which is why
 * the state becomes `transferred` rather than staying `in_stock`.
 */

export async function startVehicleTransfer(
  client: PoolClient,
  input: {
    businessId: string;
    fromLocationId: string;
    toLocationId: string;
    serialId: string;
    note?: string | null;
    actorId?: string | null;
  },
): Promise<{ transferId: string }> {
  if (input.fromLocationId === input.toLocationId) {
    throw new VehicleError("same_location", "مبدأ و مقصد انتقال یکی است.", 400);
  }
  const { rows: locRows } = await client.query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [input.businessId, [input.fromLocationId, input.toLocationId]],
  );
  if (locRows.length !== 2) throw new VehicleError("location_not_found", "شعبهٔ مقصد یافت نشد.", 404);

  // Lock the car before the live-hold check so sale, reserve, archive and
  // transfer all serialize on the same physical unit.
  const { rows: lockedVehicleRows } = await client.query<{ serial_id: string }>(
    `SELECT serial_id FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND serial_id = $2 FOR UPDATE`,
    [input.businessId, input.serialId],
  );
  if (!lockedVehicleRows[0]) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  const vehicle = await getVehicle(input.businessId, input.serialId, client);
  if (!vehicle) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.locationId !== input.fromLocationId) {
    throw new VehicleError("wrong_location", "این خودرو در شعبهٔ مبدأ نیست.", 409);
  }
  // §11: a sold car cannot move (the sale is a completed legal fact), and a
  // reserved car moves only with an explicit decision, which is the caller
  // cancelling the hold first — never a silent transfer that strands a customer.
  if (vehicle.state === "sold") {
    throw new VehicleError("vehicle_sold", "خودروی فروخته‌شده قابل انتقال نیست.", 409);
  }
  if (vehicle.state === "reserved") {
    throw new VehicleError(
      "vehicle_reserved",
      "این خودرو رزرو است؛ برای انتقال، ابتدا رزرو را آزاد کنید یا سیاست فروش شعبهٔ مقصد را روشن کنید.",
      409,
    );
  }
  if (vehicle.state === "transferred") {
    throw new VehicleError("already_in_transit", "این خودرو در حال انتقال است.", 409);
  }
  const { rows: holdRows } = await client.query<{ active: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM serial_reservations
                     WHERE business_id = $1 AND serial_id = $2 AND status = 'active') AS active`,
    [input.businessId, input.serialId],
  );
  if (holdRows[0]?.active) throw new VehicleError("vehicle_reserved", "ابتدا رزرو فعال را تعیین تکلیف کنید.", 409);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO automotive_vehicle_transfers
       (business_id, serial_id, from_location_id, to_location_id, note, started_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      input.businessId,
      input.serialId,
      input.fromLocationId,
      input.toLocationId,
      trimmedOrNull(input.note),
      input.actorId ?? null,
    ],
  );

  const { event } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.fromLocationId,
    eventType: "automotive.vehicle_transfer_started",
    payload: {
      serialId: input.serialId,
      transferId: rows[0].id,
      stockNumber: vehicle.stockNumber,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
    },
    sourceType: "automotive_vehicle_transfer",
    sourceId: rows[0].id,
    createdBy: input.actorId ?? null,
  });
  await client.query(`UPDATE automotive_vehicle_transfers SET domain_event_id = $2 WHERE id = $1`, [
    rows[0].id,
    event.id,
  ]);

  await ensureVehicleState(client, {
    businessId: input.businessId,
    serialId: input.serialId,
    locationId: input.fromLocationId,
    state: "transferred",
    actorId: input.actorId ?? null,
    command: "transfer_started",
  });
  return { transferId: rows[0].id };
}

/**
 * The receiving branch accepts the car: the transfer closes, the car's
 * `location_id` becomes the destination and its state returns to `in_stock`.
 * The catalogue row moves with it — `findOrCreateVehicleModel` at the
 * destination, exactly as `transferSerialUnit` re-points a watch's serial — so
 * the receiving branch's own stock reports see a car under a model that branch
 * owns.
 */
export async function completeVehicleTransfer(
  client: PoolClient,
  input: {
    businessId: string;
    transferId: string;
    locationId: string;
    /** Required: the transfer row records who accepted it. */
    actorId: string;
  },
): Promise<{ serialId: string; toLocationId: string }> {
  const { rows: transferRefs } = await client.query<{ serial_id: string }>(
    `SELECT serial_id FROM automotive_vehicle_transfers
      WHERE id = $1 AND business_id = $2 AND to_location_id = $3`,
    [input.transferId, input.businessId, input.locationId],
  );
  if (!transferRefs[0]) throw new VehicleError("transfer_not_found", "انتقال یافت نشد.", 404);
  const { rows: lockedVehicles } = await client.query<{ serial_id: string }>(
    `SELECT serial_id FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND serial_id = $2 FOR UPDATE`,
    [input.businessId, transferRefs[0].serial_id],
  );
  if (!lockedVehicles[0]) throw new VehicleError("transfer_not_found", "انتقال یافت نشد.", 404);

  const { rows } = await client.query<{
    id: string;
    serial_id: string;
    from_location_id: string;
    to_location_id: string;
    status: string;
    stock_number: string;
    make: string;
    model: string;
    trim: string | null;
    model_year: number | null;
  }>(
    `SELECT t.id, t.serial_id, t.from_location_id, t.to_location_id, t.status, v.stock_number,
            v.make, v.model, v.trim, v.model_year
       FROM automotive_vehicle_transfers t
       JOIN automotive_vehicle_attributes v ON v.serial_id = t.serial_id AND v.business_id = t.business_id
      WHERE t.id = $1 AND t.business_id = $2 AND t.to_location_id = $3
      FOR UPDATE OF t, v`,
    [input.transferId, input.businessId, input.locationId],
  );
  const transfer = rows[0];
  if (!transfer) throw new VehicleError("transfer_not_found", "انتقال یافت نشد.", 404);
  if (transfer.status !== "in_transit") {
    throw new VehicleError("transfer_closed", "این انتقال قبلاً بسته شده است.", 409);
  }

  const displayName = vehicleDisplayName({
    make: transfer.make,
    model: transfer.model,
    trim: transfer.trim,
    modelYear: transfer.model_year,
  });
  const destinationItemId = await findOrCreateVehicleModel(client, {
    locationId: transfer.to_location_id,
    displayName,
  });

  await client.query(
    `UPDATE automotive_vehicle_attributes
        SET location_id = $2, updated_at = now()
      WHERE business_id = $3 AND serial_id = $1 AND state = 'transferred'`,
    [transfer.serial_id, transfer.to_location_id, input.businessId],
  );
  await client.query(`UPDATE item_serials SET item_id = $2 WHERE id = $1`, [
    transfer.serial_id,
    destinationItemId,
  ]);
  await client.query(
    `UPDATE automotive_vehicle_transfers
        SET status = 'completed', completed_at = now(), completed_by = $2
      WHERE id = $1`,
    [transfer.id, input.actorId ?? null],
  );
  await ensureVehicleState(client, {
    businessId: input.businessId,
    serialId: transfer.serial_id,
    locationId: transfer.to_location_id,
    state: "in_stock",
    actorId: input.actorId,
    command: "transfer_completed",
  });

  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: transfer.to_location_id,
    eventType: "automotive.vehicle_transfer_completed",
    payload: {
      serialId: transfer.serial_id,
      transferId: transfer.id,
      stockNumber: transfer.stock_number,
      fromLocationId: transfer.from_location_id,
      toLocationId: transfer.to_location_id,
      destinationItemId,
    },
    sourceType: "automotive_vehicle_transfer",
    sourceId: transfer.id,
    createdBy: input.actorId ?? null,
  });

  return { serialId: transfer.serial_id, toLocationId: transfer.to_location_id };
}

/** The sending branch changes its mind: the car snaps back to `in_stock` where it already is. */
export async function cancelVehicleTransfer(
  client: PoolClient,
  input: { businessId: string; transferId: string; locationId: string; reason: string; /** Required: 0212 requires `cancelled_by`. */ actorId: string },
): Promise<void> {
  const reason = input.reason?.trim();
  if (!reason) throw new VehicleError("reason_required", "دلیل لغو انتقال الزامی است.");
  if (!input.actorId) throw new VehicleError("actor_required", "لغوکنندهٔ انتقال الزامی است.");

  const { rows: transferRefs } = await client.query<{ serial_id: string }>(
    `SELECT serial_id FROM automotive_vehicle_transfers
      WHERE id = $1 AND business_id = $2 AND from_location_id = $3`,
    [input.transferId, input.businessId, input.locationId],
  );
  if (!transferRefs[0]) throw new VehicleError("transfer_not_found", "انتقال یافت نشد.", 404);
  const { rows: lockedVehicles } = await client.query<{ serial_id: string }>(
    `SELECT serial_id FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND serial_id = $2 FOR UPDATE`,
    [input.businessId, transferRefs[0].serial_id],
  );
  if (!lockedVehicles[0]) throw new VehicleError("transfer_not_found", "انتقال یافت نشد.", 404);
  const { rows } = await client.query<{ id: string; serial_id: string; from_location_id: string; status: string }>(
    `SELECT t.id, t.serial_id, t.from_location_id, t.status
       FROM automotive_vehicle_transfers t
       JOIN automotive_vehicle_attributes v ON v.serial_id = t.serial_id AND v.business_id = t.business_id
      WHERE t.id = $1 AND t.business_id = $2 AND t.from_location_id = $3 FOR UPDATE OF t`,
    [input.transferId, input.businessId, input.locationId],
  );
  const transfer = rows[0];
  if (!transfer) throw new VehicleError("transfer_not_found", "انتقال یافت نشد.", 404);
  if (transfer.status !== "in_transit") {
    throw new VehicleError("transfer_closed", "این انتقال قبلاً بسته شده است.", 409);
  }

  await client.query(
    `UPDATE automotive_vehicle_transfers
        SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
      WHERE id = $1`,
    [transfer.id, input.actorId ?? null, reason],
  );
  await ensureVehicleState(client, {
    businessId: input.businessId,
    serialId: transfer.serial_id,
    locationId: transfer.from_location_id,
    state: "in_stock",
    actorId: input.actorId,
    command: "transfer_cancelled",
  });
  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: transfer.from_location_id,
    eventType: "automotive.vehicle_transfer_cancelled",
    payload: { serialId: transfer.serial_id, transferId: transfer.id, reason },
    sourceType: "automotive_vehicle_transfer",
    sourceId: transfer.id,
    createdBy: input.actorId ?? null,
  });
}

export interface VehicleTransferRow {
  id: string;
  serialId: string;
  stockNumber: string;
  displayName: string;
  fromLocationId: string | null;
  fromLocationName: string | null;
  toLocationId: string | null;
  toLocationName: string | null;
  status: "in_transit" | "completed" | "cancelled";
  note: string | null;
  cancelReason: string | null;
  startedAt: string;
  completedAt: string | null;
}

export async function listVehicleTransfers(
  businessId: string,
  options: { serialId?: string | null; status?: string | null; locationId?: string | null; locationIds?: string[]; limit?: number } = {},
): Promise<VehicleTransferRow[]> {
  const params: unknown[] = [businessId];
  const where = ["t.business_id = $1"];
  if (options.serialId) where.push(`t.serial_id = $${params.push(options.serialId)}`);
  if (options.status) where.push(`t.status = $${params.push(options.status)}`);
  if (options.locationIds !== undefined) {
    if (options.locationIds.length === 0) where.push("FALSE");
    else {
      const index = params.push(options.locationIds);
      where.push(`(t.from_location_id = ANY($${index}::uuid[]) OR t.to_location_id = ANY($${index}::uuid[]))`);
    }
  } else if (options.locationId) {
    const index = params.push(options.locationId);
    where.push(`(t.from_location_id = $${index} OR t.to_location_id = $${index})`);
  }
  const { rows } = await query<{
    id: string;
    serial_id: string;
    stock_number: string;
    make: string;
    model: string;
    trim: string | null;
    model_year: number | null;
    from_location_id: string;
    from_location_name: string | null;
    to_location_id: string;
    to_location_name: string | null;
    status: "in_transit" | "completed" | "cancelled";
    note: string | null;
    cancel_reason: string | null;
    started_at: string;
    completed_at: string | null;
  }>(
    `SELECT t.id, t.serial_id, v.stock_number, v.make, v.model, v.trim, v.model_year,
            t.from_location_id, fl.name AS from_location_name,
            t.to_location_id, tl.name AS to_location_name, t.status, t.note, t.cancel_reason,
            t.started_at::text AS started_at, t.completed_at::text AS completed_at
       FROM automotive_vehicle_transfers t
       JOIN automotive_vehicle_attributes v ON v.serial_id = t.serial_id AND v.business_id = t.business_id
       LEFT JOIN locations fl ON fl.id = t.from_location_id AND fl.business_id = t.business_id
       LEFT JOIN locations tl ON tl.id = t.to_location_id AND tl.business_id = t.business_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.started_at DESC
      LIMIT ${Math.min(Math.max(options.limit ?? 100, 1), 500)}`,
    params,
  );
  const authorized = options.locationIds === undefined ? null : new Set(options.locationIds);
  return rows.map((row) => {
    const canSeeFrom = authorized === null || authorized.has(row.from_location_id);
    const canSeeTo = authorized === null || authorized.has(row.to_location_id);
    return {
      id: row.id,
      serialId: row.serial_id,
      stockNumber: row.stock_number,
      displayName: vehicleDisplayName({
        make: row.make,
        model: row.model,
        trim: row.trim,
        modelYear: row.model_year,
      }),
      fromLocationId: canSeeFrom ? row.from_location_id : null,
      fromLocationName: canSeeFrom ? row.from_location_name : null,
      toLocationId: canSeeTo ? row.to_location_id : null,
      toLocationName: canSeeTo ? row.to_location_name : null,
      status: row.status,
      note: row.note,
      cancelReason: row.cancel_reason,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  });
}

/* ===========================================================================
 * Price floors — the one check the sale path needs from this module
 * ===========================================================================
 */

/**
 * Whether a proposed sale price crosses the car's recorded floor without an
 * override. Lives here (not in the sale service) because the floor is the
 * *vehicle's* own number, and the sale path must not be the second place that
 * decides what "the floor" means.
 */
export function checkVehicleSalePrice(input: {
  priceRial: number;
  minimumPriceRial: number | null | undefined;
  overrideAllowed: boolean;
}): { allowed: boolean; shortfallRial: number } {
  return checkMinimumPrice(input);
}

/** Rial text helper re-exported for the sale/invoice paths that join this module's events. */
export function vehicleRialText(value: number | string): RialText {
  return rialText(String(value));
}

export { rialBigInt };
