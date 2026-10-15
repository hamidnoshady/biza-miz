/**
 * Issue #839 §19 / Wave 6 — the DB halves of the automotive offline/hybrid
 * path. Two directions, one contract, no new synchronisation engine:
 *
 *  * **The cloud side** (`buildAutomotiveStockProjection`) serves one branch's
 *    vehicle board as a whole snapshot, exactly as Phase 45 serves the branch
 *    profile. The payload deliberately carries no acquisition cost, no
 *    capitalized costs and no minimum price (see the header of
 *    `automotive-stock-projection.ts`).
 *  * **The site side** (`applyAutomotiveStockProjection`, `runAutomotiveStockSync`)
 *    replaces its read-only mirror with that snapshot on the ordinary sync tick,
 *    at most once per interval, with backoff — the same shape as
 *    `site-profile-service.ts`.
 *  * **The queue** (`recordVehicleReservationRequest`, `recordVehicleReleaseRequest`)
 *    writes the only two offline-capable operations as durable *requests* in the
 *    site's own transaction and hands them to the shipped `sync_events` outbox,
 *    so the existing push delivers them. The cloud applies each one through the
 *    canonical `reserveVehicle` / `releaseVehicleReservation` inside a
 *    transaction it controls (`applyVehicleOfflineRequest`), or records a named
 *    conflict. A pending request is never a hold.
 *
 * DB-touching, so — per repo convention — the decisions worth unit-testing are
 * pure and live elsewhere: capability and replay classification in
 * `automotive-offline.ts`, shape/hash/reconcile planning in
 * `automotive-stock-projection.ts`.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import type { Role } from "./auth";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { attemptDue } from "./sync-backoff";
import type { ServerSyncConfig } from "./server-sync-config";
import { businessToday, VehicleError } from "./automotive-service";
import { releaseVehicleReservation, reserveVehicle } from "./automotive-reservation-service";
import type { VehicleState } from "./automotive";
import {
  classifyVehicleRequestReplay,
  conflictCodeForVehicleError,
  planMirrorReconcile,
  type AutomotiveOfflineConflictCode,
  type AutomotiveOfflineRequestStatus,
  type AutomotiveOfflineRequestType,
} from "./automotive-offline";
import {
  AUTOMOTIVE_STOCK_PROJECTION_SCHEMA_VERSION,
  automotiveStockFailed,
  automotiveStockProjectionHash,
  automotiveStockSucceeded,
  availabilityForVehicle,
  EMPTY_AUTOMOTIVE_STOCK_STATE,
  planRequestStatusApply,
  validateAutomotiveStockProjection,
  vehicleMirrorRowHash,
  type AutomotiveStockProjection,
  type AutomotiveStockState,
  type AutomotiveStockVehicle,
} from "./automotive-stock-projection";

/** The states a car may be held in — the same pair `reserveVehicle` accepts. */
const RESERVABLE_STATES: readonly VehicleState[] = ["in_stock", "acquired"];

/** The states a queued hold may name — the counter's form and the service agree. */
export const AUTOMOTIVE_RESERVABLE_STATES = RESERVABLE_STATES;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEPOSIT_METHODS = ["cash", "card", "card_to_card", "online"] as const;
type DepositMethod = (typeof DEPOSIT_METHODS)[number];

// ---------------------------------------------------------------------------
// Cloud: build the snapshot
// ---------------------------------------------------------------------------

interface ProjectionVehicleRow {
  /** Index signature so `query<Row>` accepts it, as every row type in this repo does. */
  [key: string]: unknown;
  serial_id: string;
  item_id: string | null;
  stock_number: string;
  make: string;
  model: string;
  trim: string | null;
  condition: string;
  state: string;
  vehicle_year_calendar: string;
  model_year: number | null;
  mileage_km: number | null;
  vin: string | null;
  chassis_number: string | null;
  plate_number: string | null;
  body_type: string | null;
  transmission: string | null;
  fuel_type: string | null;
  exterior_color: string | null;
  acquired_on: string | null;
  asking_price_rial: string | null;
  reservation_id: string | null;
  reservation_customer_name: string | null;
  reservation_expires_at: Date | null;
  source_version: string;
  cloud_updated_at: Date;
}

/**
 * One branch's vehicle board, as the cloud states it. Returns `null` when the
 * branch is not this business's, or when the business is not the automotive
 * trade — the same "not yours, not found" answer `buildSiteProfile` gives, so a
 * credential cannot probe another tenant and a paired café is never told to
 * start mirroring a vehicle board it does not have.
 *
 * `sourceVersion` is the row's `updated_at` in epoch milliseconds: the version
 * of this car an operator was looking at, which a queued request quotes back as
 * `expected_version`.
 */
export async function buildAutomotiveStockProjection(
  businessId: string,
  locationId: string,
): Promise<AutomotiveStockProjection | null> {
  const location = await query<{ id: string }>(
    `SELECT l.id
       FROM locations l
       JOIN businesses b ON b.id = l.business_id
      WHERE l.id = $1 AND l.business_id = $2 AND b.industry = 'automotive'`,
    [locationId, businessId],
  );
  if (!location.rows[0]) return null;

  const { rows } = await query<ProjectionVehicleRow>(
    `SELECT v.serial_id, s.item_id, v.stock_number, v.make, v.model, v.trim, v.condition, v.state,
            v.vehicle_year_calendar, v.model_year, v.mileage_km, v.vin, v.chassis_number, v.plate_number,
            v.body_type, v.transmission, v.fuel_type, v.exterior_color,
            v.acquisition_date::text AS acquired_on, v.asking_price_rial::text AS asking_price_rial,
            r.id AS reservation_id, p.name AS reservation_customer_name, r.expires_at AS reservation_expires_at,
            (extract(epoch FROM v.updated_at) * 1000)::bigint::text AS source_version,
            v.updated_at AS cloud_updated_at
       FROM automotive_vehicle_attributes v
       LEFT JOIN item_serials s ON s.id = v.serial_id
       LEFT JOIN serial_reservations r
              ON r.business_id = v.business_id AND r.serial_id = v.serial_id AND r.status = 'active'
       LEFT JOIN parties p ON p.id = r.customer_id AND p.business_id = r.business_id
      WHERE v.business_id = $1 AND v.location_id = $2
        -- Archived cars are deliberately off the board: the branch said so, and
        -- keeping them would grow the mirror forever with rows nobody works
        -- from. Everything else stays — including a sold car, because «this one
        -- is gone and here is why» is exactly the answer a counter needs, and
        -- hiding it would have the offline board claim a car is available when
        -- it is not.
        AND v.state <> 'archived'
      ORDER BY v.stock_number`,
    [businessId, locationId],
  );

  const vehicles: AutomotiveStockVehicle[] = rows.map((row) => ({
    serialId: row.serial_id,
    itemId: row.item_id,
    stockNumber: row.stock_number,
    make: row.make,
    model: row.model,
    trim: row.trim,
    condition: row.condition as AutomotiveStockVehicle["condition"],
    state: row.state as VehicleState,
    vehicleYearCalendar: row.vehicle_year_calendar,
    modelYear: row.model_year,
    mileageKm: row.mileage_km,
    vin: row.vin,
    chassisNumber: row.chassis_number,
    plateNumber: row.plate_number,
    bodyType: row.body_type,
    transmission: row.transmission,
    fuelType: row.fuel_type,
    exteriorColor: row.exterior_color,
    acquiredOn: row.acquired_on,
    askingPriceRial: row.asking_price_rial === null ? null : Number(row.asking_price_rial),
    availability: availabilityForVehicle({
      state: row.state as VehicleState,
      hasActiveReservation: row.reservation_id !== null,
    }),
    reservationId: row.reservation_id,
    reservationCustomerName: row.reservation_customer_name,
    reservationExpiresAt: row.reservation_expires_at ? row.reservation_expires_at.toISOString() : null,
    sourceVersion: Number(row.source_version),
    cloudUpdatedAt: row.cloud_updated_at.toISOString(),
  }));

  const requests = await query<{
    id: string;
    request_type: string;
    serial_id: string;
    stock_number: string;
    customer_name: string | null;
    status: string;
    conflict_code: string | null;
    reservation_id: string | null;
    requested_at: Date;
    resolved_at: Date | null;
    source_version: string | null;
  }>(
    `SELECT id, request_type, serial_id, stock_number, customer_name, status, conflict_code,
            reservation_id, requested_at, resolved_at, (outcome->>'sourceVersion') AS source_version
       FROM automotive_vehicle_offline_requests
      WHERE business_id = $1 AND location_id = $2
      ORDER BY requested_at DESC
      LIMIT 200`,
    [businessId, locationId],
  );

  return {
    schemaVersion: AUTOMOTIVE_STOCK_PROJECTION_SCHEMA_VERSION,
    locationId,
    generatedAt: new Date().toISOString(),
    vehicles,
    requests: requests.rows.map((row) => ({
      id: row.id,
      requestType: row.request_type as AutomotiveOfflineRequestType,
      serialId: row.serial_id,
      stockNumber: row.stock_number,
      customerName: row.customer_name,
      status: row.status as AutomotiveOfflineRequestStatus,
      conflictCode: row.conflict_code as AutomotiveOfflineConflictCode | null,
      reservationId: row.reservation_id,
      requestedAt: row.requested_at.toISOString(),
      resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
      sourceVersion: row.source_version === null ? null : Number(row.source_version),
    })),
  };
}

// ---------------------------------------------------------------------------
// Site: apply the snapshot into the read-only mirror
// ---------------------------------------------------------------------------

const MIRROR_COLUMNS = [
  "business_id",
  "location_id",
  "serial_id",
  "item_id",
  "stock_number",
  "make",
  "model",
  "trim",
  "condition",
  "state",
  "vehicle_year_calendar",
  "model_year",
  "mileage_km",
  "vin",
  "chassis_number",
  "plate_number",
  "body_type",
  "transmission",
  "fuel_type",
  "exterior_color",
  "acquired_on",
  "asking_price_rial",
  "availability",
  "reservation_id",
  "reservation_customer_name",
  "reservation_expires_at",
  "source_version",
  "cloud_updated_at",
] as const;

function mirrorValues(businessId: string, locationId: string, vehicle: AutomotiveStockVehicle): unknown[] {
  return [
    businessId,
    locationId,
    vehicle.serialId,
    vehicle.itemId,
    vehicle.stockNumber,
    vehicle.make,
    vehicle.model,
    vehicle.trim,
    vehicle.condition,
    vehicle.state,
    vehicle.vehicleYearCalendar,
    vehicle.modelYear,
    vehicle.mileageKm,
    vehicle.vin,
    vehicle.chassisNumber,
    vehicle.plateNumber,
    vehicle.bodyType,
    vehicle.transmission,
    vehicle.fuelType,
    vehicle.exteriorColor,
    vehicle.acquiredOn,
    vehicle.askingPriceRial,
    vehicle.availability,
    vehicle.reservationId,
    vehicle.reservationCustomerName,
    vehicle.reservationExpiresAt,
    vehicle.sourceVersion,
    vehicle.cloudUpdatedAt,
  ];
}

/** The mirror row as PostgreSQL returns it, for the equality check below. */
interface MirrorRow extends Record<string, unknown> {
  serial_id: string;
  source_version: string;
  cloud_updated_at: Date;
  reservation_expires_at: Date | null;
  /** node-postgres hands a `date` back as a Date; the projection carries a plain ISO day. */
  acquired_on: Date | string | null;
  asking_price_rial: string | null;
}

/**
 * The stored row read back as the cloud-shaped object `vehicleMirrorRowHash`
 * hashes. Kept beside the writer on purpose: the two must agree exactly, or a
 * snapshot would look "changed" on every tick.
 */
function mirrorRowToVehicle(row: MirrorRow): AutomotiveStockVehicle {
  return {
    serialId: row.serial_id,
    itemId: (row.item_id as string | null) ?? null,
    stockNumber: row.stock_number as string,
    make: row.make as string,
    model: row.model as string,
    trim: (row.trim as string | null) ?? null,
    condition: row.condition as AutomotiveStockVehicle["condition"],
    state: row.state as AutomotiveStockVehicle["state"],
    vehicleYearCalendar: row.vehicle_year_calendar as string,
    modelYear: (row.model_year as number | null) ?? null,
    mileageKm: (row.mileage_km as number | null) ?? null,
    vin: (row.vin as string | null) ?? null,
    chassisNumber: (row.chassis_number as string | null) ?? null,
    plateNumber: (row.plate_number as string | null) ?? null,
    bodyType: (row.body_type as string | null) ?? null,
    transmission: (row.transmission as string | null) ?? null,
    fuelType: (row.fuel_type as string | null) ?? null,
    exteriorColor: (row.exterior_color as string | null) ?? null,
    // `date` comes back as a JS Date from node-postgres, not as the string the
    // projection carries — `toISOString().slice(0, 10)` is the same calendar day.
    acquiredOn:
      row.acquired_on === null
        ? null
        : row.acquired_on instanceof Date
          ? row.acquired_on.toISOString().slice(0, 10)
          : String(row.acquired_on).slice(0, 10),
    askingPriceRial: row.asking_price_rial === null ? null : Number(row.asking_price_rial),
    availability: row.availability as AutomotiveStockVehicle["availability"],
    reservationId: (row.reservation_id as string | null) ?? null,
    reservationCustomerName: (row.reservation_customer_name as string | null) ?? null,
    reservationExpiresAt:
      row.reservation_expires_at === null ? null : new Date(row.reservation_expires_at).toISOString(),
    sourceVersion: Number(row.source_version),
    cloudUpdatedAt: new Date(row.cloud_updated_at).toISOString(),
  };
}

function mirrorRowHash(row: MirrorRow): string {
  return vehicleMirrorRowHash(mirrorRowToVehicle(row));
}

export interface AppliedAutomotiveProjection {
  inserted: number;
  updated: number;
  /** Rows the cloud still lists that already matched, row for row. */
  unchanged: number;
  removed: number;
  requestsApplied: number;
}

/**
 * One transaction: the branch's mirror becomes exactly what the cloud said, and
 * the cloud's answers to this branch's queued requests move those rows from
 * `pending` to their final status.
 *
 * The replace-whole shape is the point. There is no per-field merge and no clock
 * comparison anywhere on this path, so a row can never be "half the cloud's and
 * half the site's"; a snapshot that arrives twice changes nothing the second
 * time (identical hash at the caller), and a snapshot that arrives late is
 * simply replaced by the newer one.
 *
 * Requests are handled two ways on purpose:
 *   * a row this site already holds is **updated** monotonically
 *     (`planRequestStatusApply`): a confirmation is final, and an older snapshot
 *     that still says `pending` never revives it;
 *   * a request the site does not hold is **not inserted** — a queued request's
 *     local row is the site's own record (the customer, the deposit intent, the
 *     operator who made it), and inventing one from the cloud's answer would
 *     hand the counter a request nobody made.
 */
export async function applyAutomotiveStockProjection(
  businessId: string,
  locationId: string,
  projection: AutomotiveStockProjection,
): Promise<AppliedAutomotiveProjection> {
  if (projection.locationId !== locationId) throw new Error("automotive_projection_location_mismatch");
  const client = await getPool().connect();
  const result: AppliedAutomotiveProjection = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    requestsApplied: 0,
  };
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query<MirrorRow>(
      `SELECT ${MIRROR_COLUMNS.join(",")} FROM automotive_vehicle_stock_mirror
        WHERE business_id = $1 AND location_id = $2 FOR UPDATE`,
      [businessId, locationId],
    );
    const known = new Map(
      existing.map((row) => [row.serial_id, { sourceVersion: Number(row.source_version), hash: mirrorRowHash(row) }]),
    );
    const snapshotIds = projection.vehicles.map((vehicle) => vehicle.serialId);

    const columns = MIRROR_COLUMNS.join(",");
    const placeholders = MIRROR_COLUMNS.map((_, index) => `$${index + 1}`).join(",");
    const updates = MIRROR_COLUMNS.filter(
      (column) => column !== "business_id" && column !== "location_id" && column !== "serial_id",
    )
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(", ");
    for (const vehicle of projection.vehicles) {
      const local = known.get(vehicle.serialId);
      // `planMirrorReconcile` decides, from the content hash alone, whether this
      // row is already the cloud's row. An unchanged row is not rewritten — so
      // re-checking a board that has not moved costs no write and no `updated_at`
      // churn, and the counters below mean what they say.
      const action = planMirrorReconcile({
        local: local ? { serialId: vehicle.serialId, sourceVersion: local.sourceVersion, contentHash: local.hash } : null,
        remote: {
          serialId: vehicle.serialId,
          sourceVersion: vehicle.sourceVersion,
          contentHash: vehicleMirrorRowHash(vehicle),
        },
      });
      if (action === "skip") {
        result.unchanged += 1;
        continue;
      }
      await client.query(
        `INSERT INTO automotive_vehicle_stock_mirror (${columns}, synced_at)
         VALUES (${placeholders}, now())
         ON CONFLICT (business_id, serial_id) DO UPDATE SET ${updates}, synced_at = now()`,
        mirrorValues(businessId, locationId, vehicle),
      );
      if (action === "insert") result.inserted += 1;
      else result.updated += 1;
    }

    // A car the cloud no longer lists for this branch (sold, transferred away,
    // archived) must leave the board: a stale "available" row is how a salesman
    // promises a car that is gone.
    const removal = await client.query(
      `DELETE FROM automotive_vehicle_stock_mirror
        WHERE business_id = $1 AND location_id = $2 AND NOT (serial_id = ANY($3::uuid[]))`,
      [businessId, locationId, snapshotIds],
    );
    result.removed = removal.rowCount ?? 0;

    for (const request of projection.requests) {
      const { rows } = await client.query<{
        status: AutomotiveOfflineRequestStatus;
        conflict_code: string | null;
        reservation_id: string | null;
      }>(
        `SELECT status, conflict_code, reservation_id FROM automotive_vehicle_offline_requests
          WHERE business_id = $1 AND id = $2 FOR UPDATE`,
        [businessId, request.id],
      );
      const local = rows[0];
      if (!local) continue;
      const next = planRequestStatusApply({
        local: { status: local.status, conflictCode: local.conflict_code, reservationId: local.reservation_id },
        remote: request,
      });
      if (!next) continue;
      await client.query(
        `UPDATE automotive_vehicle_offline_requests
            SET status = $3, conflict_code = $4, reservation_id = coalesce($5, reservation_id),
                resolved_at = coalesce($6, now()), synced_at = now(), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [businessId, request.id, next.status, next.conflictCode, next.reservationId, request.resolvedAt],
      );
      result.requestsApplied += 1;
    }

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Site: the sync tick
// ---------------------------------------------------------------------------

/**
 * At most one attempt per interval. Ticks also run on a NOTIFY wake (~1.5 s
 * after each local commit), so this is a rate-limit guard rather than the
 * refresh cadence. Shorter than the branch profile's 30 s because a queued hold
 * is answered through this same feed: a clerk should see «تأییدشده» while the
 * customer is still at the desk. ponytail: process-local, so a restart may
 * attempt early once; that is fine.
 */
const AUTOMOTIVE_STOCK_INTERVAL_MS = 10_000;
const lastAttemptAt = new Map<string, number>();

/** Tests only: forget the per-business interval gate. */
export function resetAutomotiveStockGate(): void {
  lastAttemptAt.clear();
}

/** Whether this business sells cars — a non-automotive hybrid never calls the feed. */
export async function businessIsAutomotive(businessId: string): Promise<boolean> {
  const { rows } = await query<{ industry: string }>(`SELECT industry FROM businesses WHERE id = $1`, [businessId]);
  return rows[0]?.industry === "automotive";
}

/** One desktop tick. Never throws for a cloud-side failure; it records it and backs off. */
export async function runAutomotiveStockSync(
  businessId: string,
  now: Date = new Date(),
): Promise<AutomotiveStockState> {
  const previous =
    (await getSetting<AutomotiveStockState>(businessId, SETTING_KEYS.automotiveStockState)) ??
    EMPTY_AUTOMOTIVE_STOCK_STATE;
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim() || !config.locationId) return previous;
  if (!(await businessIsAutomotive(businessId))) return previous;
  if (!attemptDue(previous.nextAttemptAt, now)) return previous;
  const last = lastAttemptAt.get(businessId);
  if (last !== undefined && now.getTime() - last >= 0 && now.getTime() - last < AUTOMOTIVE_STOCK_INTERVAL_MS) {
    return previous;
  }
  lastAttemptAt.set(businessId, now.getTime());

  const store = async (state: AutomotiveStockState): Promise<AutomotiveStockState> => {
    await setSetting(businessId, SETTING_KEYS.automotiveStockState, state);
    return state;
  };

  let projection: AutomotiveStockProjection | null;
  try {
    const response = await fetch(
      `${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/automotive-stock`,
      { headers: { Authorization: `Bearer ${config.token.trim()}` }, signal: AbortSignal.timeout(30_000) },
    );
    // A central that predates the feed, or a business that is not automotive, is
    // not a failure: there is simply nothing to mirror.
    if (response.status === 404) return store(automotiveStockSucceeded(previous, "absent", false, previous.vehicleCount, now));
    if (!response.ok) return store(automotiveStockFailed(previous, `remote_rejected: HTTP ${response.status}`, now));
    projection = validateAutomotiveStockProjection(await response.json());
  } catch (error) {
    return store(
      automotiveStockFailed(previous, `unreachable: ${error instanceof Error ? error.message : String(error)}`, now),
    );
  }
  if (!projection) return store(automotiveStockFailed(previous, "invalid_projection", now));
  if (projection.locationId !== config.locationId) return store(automotiveStockFailed(previous, "location_mismatch", now));

  const hash = automotiveStockProjectionHash(projection);
  if (hash === previous.hash) {
    return store(automotiveStockSucceeded(previous, hash, false, projection.vehicles.length, now));
  }
  try {
    await applyAutomotiveStockProjection(businessId, config.locationId, projection);
  } catch (error) {
    return store(
      automotiveStockFailed(previous, `apply_failed: ${error instanceof Error ? error.message : String(error)}`, now),
    );
  }
  return store(automotiveStockSucceeded(previous, hash, true, projection.vehicles.length, now));
}

export interface AutomotiveMirrorStatus {
  state: AutomotiveStockState;
  vehicles: number;
  reserved: number;
  pendingRequests: number;
  conflicts: number;
  lastSyncedAt: string | null;
}

/** Everything the sync panel and the board's header need, in one round trip. */
export async function automotiveMirrorStatus(
  businessId: string,
  locationId: string,
): Promise<AutomotiveMirrorStatus> {
  const state =
    (await getSetting<AutomotiveStockState>(businessId, SETTING_KEYS.automotiveStockState)) ??
    EMPTY_AUTOMOTIVE_STOCK_STATE;
  const { rows } = await query<{ vehicles: string; reserved: string; synced_at: Date | null }>(
    `SELECT count(*)::text AS vehicles,
            count(*) FILTER (WHERE availability = 'reserved')::text AS reserved,
            max(synced_at) AS synced_at
       FROM automotive_vehicle_stock_mirror
      WHERE business_id = $1 AND location_id = $2`,
    [businessId, locationId],
  );
  const { rows: requestCounts } = await query<{ pending: string; conflicts: string }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
            count(*) FILTER (WHERE status = 'conflict' AND acknowledged_at IS NULL)::text AS conflicts
       FROM automotive_vehicle_offline_requests
      WHERE business_id = $1 AND location_id = $2`,
    [businessId, locationId],
  );
  return {
    state,
    vehicles: Number(rows[0]?.vehicles ?? 0),
    reserved: Number(rows[0]?.reserved ?? 0),
    pendingRequests: Number(requestCounts[0]?.pending ?? 0),
    conflicts: Number(requestCounts[0]?.conflicts ?? 0),
    lastSyncedAt: rows[0]?.synced_at ? rows[0].synced_at.toISOString() : null,
  };
}

export interface MirrorVehicleFilters {
  condition?: "new" | "used" | null;
  state?: string | null;
  search?: string | null;
}

/** The board's rows, straight from the mirror — never a write. */
export async function listMirrorVehicles(
  businessId: string,
  locationId: string,
  filters: MirrorVehicleFilters = {},
): Promise<Array<Record<string, unknown>>> {
  const conditions = ["business_id = $1", "location_id = $2"];
  const params: unknown[] = [businessId, locationId];
  if (filters.condition) {
    params.push(filters.condition);
    conditions.push(`condition = $${params.length}`);
  }
  if (filters.state) {
    params.push(filters.state);
    conditions.push(`state = $${params.length}`);
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    conditions.push(
      `(stock_number ILIKE $${params.length} OR vin ILIKE $${params.length} OR chassis_number ILIKE $${params.length}
        OR plate_number ILIKE $${params.length} OR make ILIKE $${params.length} OR model ILIKE $${params.length})`,
    );
  }
  const { rows } = await query<Record<string, unknown>>(
    `SELECT serial_id, item_id, stock_number, make, model, trim, condition, state, vehicle_year_calendar,
            model_year, mileage_km, vin, chassis_number, plate_number, body_type, transmission, fuel_type,
            exterior_color, acquired_on::text AS acquired_on, asking_price_rial::text AS asking_price_rial,
            availability, reservation_id, reservation_customer_name, reservation_expires_at,
            source_version::text AS source_version, cloud_updated_at, synced_at
       FROM automotive_vehicle_stock_mirror
      WHERE ${conditions.join(" AND ")}
      ORDER BY stock_number`,
    params,
  );
  return rows;
}

/** The queued and resolved requests of this branch, newest first. */
export async function listVehicleOfflineRequests(
  businessId: string,
  locationId: string,
  status?: AutomotiveOfflineRequestStatus,
  options: { unacknowledgedOnly?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [businessId, locationId];
  const filters: string[] = [];
  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (options.unacknowledgedOnly) filters.push("acknowledged_at IS NULL");
  const where = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, request_type, serial_id, stock_number, customer_id, customer_name, reservation_id,
            deposit_amount_rial::text AS deposit_amount_rial, deposit_method, deposit_refundable,
            note, expires_at::text AS expires_at, expires_at_time::text AS expires_at_time,
            reason, refund_deposit, expected_version::text AS expected_version, expected_state,
            status, conflict_code, acknowledged_at, requested_by, requested_at, resolved_at, synced_at
       FROM automotive_vehicle_offline_requests
      WHERE business_id = $1 AND location_id = $2 ${where}
      ORDER BY requested_at DESC
      LIMIT 200`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Site: queue a request (durable, idempotent, never a hold)
// ---------------------------------------------------------------------------

export interface VehicleReservationRequestInput {
  businessId: string;
  locationId: string;
  requestId: string;
  serialId: string;
  stockNumber: string;
  customerId: string;
  customerName: string;
  expiresAt: string | null;
  expiresAtTime: string | null;
  depositRial: number;
  depositMethod: DepositMethod | null;
  depositRefundable: boolean;
  depositNote: string | null;
  note: string | null;
  expectedVersion: number;
  expectedState: VehicleState;
  actorId: string | null;
  actorRole: Role;
}

/**
 * Record the counter's intent and hand it to the outbox **in one transaction**,
 * so there is no window in which the site believes it queued a hold and the
 * cloud never hears about it. Idempotent on `requestId`: a double-tapped button
 * writes one row (`uq_automotive_offline_request_open` refuses a second open
 * request for the same car and operation) and one event (`sync_events` is
 * unique per location + client_event_id).
 *
 * The row is `pending`. It is not a hold, no deposit posts, and the UI says so.
 */
export async function recordVehicleReservationRequest(
  input: VehicleReservationRequestInput,
): Promise<{ requestId: string; duplicate: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO automotive_vehicle_offline_requests
         (id, business_id, location_id, request_type, serial_id, stock_number, customer_id, customer_name,
          deposit_amount_rial, deposit_method, deposit_refundable, deposit_note, note,
          expires_at, expires_at_time, expected_version, expected_state, requested_by)
       VALUES ($1,$2,$3,'reserve',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT DO NOTHING`,
      [
        input.requestId,
        input.businessId,
        input.locationId,
        input.serialId,
        input.stockNumber,
        input.customerId,
        input.customerName,
        input.depositRial,
        input.depositMethod,
        input.depositRefundable,
        input.depositNote,
        input.note,
        input.expiresAt,
        input.expiresAtTime,
        input.expectedVersion,
        input.expectedState,
        input.actorId,
      ],
    );
    const duplicate = (inserted.rowCount ?? 0) === 0;
    if (!duplicate) {
      await appendSyncOutboxEvent(client, {
        locationId: input.locationId,
        clientEventId: input.requestId,
        eventType: "automotive.vehicle.reservation.requested",
        payload: {
          requestId: input.requestId,
          serialId: input.serialId,
          stockNumber: input.stockNumber,
          customerId: input.customerId,
          customerName: input.customerName,
          expiresAt: input.expiresAt,
          expiresAtTime: input.expiresAtTime,
          depositRial: input.depositRial,
          depositMethod: input.depositMethod,
          depositRefundable: input.depositRefundable,
          depositNote: input.depositNote,
          note: input.note,
          expectedVersion: input.expectedVersion,
          expectedState: input.expectedState,
          requestedAt: new Date().toISOString(),
        },
        actorUserId: input.actorId,
        actorRole: input.actorRole,
      });
    }
    await client.query("COMMIT");
    return { requestId: input.requestId, duplicate };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface VehicleReleaseRequestInput {
  businessId: string;
  locationId: string;
  requestId: string;
  reservationId: string;
  serialId: string;
  stockNumber: string;
  reason: string;
  refundDeposit?: boolean;
  expectedVersion: number;
  expectedState: VehicleState;
  actorId: string | null;
  actorRole: Role;
}

/** The other offline-capable operation: release a hold this branch placed. */
export async function recordVehicleReleaseRequest(
  input: VehicleReleaseRequestInput,
): Promise<{ requestId: string; duplicate: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO automotive_vehicle_offline_requests
         (id, business_id, location_id, request_type, serial_id, stock_number, reservation_id, reason,
          refund_deposit, expected_version, expected_state, requested_by)
       VALUES ($1,$2,$3,'release',$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [
        input.requestId,
        input.businessId,
        input.locationId,
        input.serialId,
        input.stockNumber,
        input.reservationId,
        input.reason,
        input.refundDeposit ?? null,
        input.expectedVersion,
        input.expectedState,
        input.actorId,
      ],
    );
    const duplicate = (inserted.rowCount ?? 0) === 0;
    if (!duplicate) {
      await appendSyncOutboxEvent(client, {
        locationId: input.locationId,
        clientEventId: input.requestId,
        eventType: "automotive.vehicle.reservation.released",
        payload: {
          requestId: input.requestId,
          reservationId: input.reservationId,
          serialId: input.serialId,
          stockNumber: input.stockNumber,
          reason: input.reason,
          refundDeposit: input.refundDeposit ?? null,
          expectedVersion: input.expectedVersion,
          expectedState: input.expectedState,
          requestedAt: new Date().toISOString(),
        },
        actorUserId: input.actorId,
        actorRole: input.actorRole,
      });
    }
    await client.query("COMMIT");
    return { requestId: input.requestId, duplicate };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Mark a recorded refusal as read and handled.
 *
 * The cloud's answer is final and stays in the history — the counter cannot
 * delete a refusal — but the desk must stop showing it as needing a decision
 * once a person has dealt with it. Only a `conflict` row can be acknowledged
 * (0223's CHECK says so too), and acknowledging one twice is a no-op that
 * reports `false`, so a double-clicked button cannot rewrite the audit trail's
 * timestamps.
 */
export async function acknowledgeVehicleOfflineRequest(input: {
  businessId: string;
  locationId: string;
  requestId: string;
  actorId: string | null;
}): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE automotive_vehicle_offline_requests
        SET acknowledged_at = now(), acknowledged_by = $4, updated_at = now()
      WHERE business_id = $1 AND location_id = $2 AND id = $3
        AND status = 'conflict' AND acknowledged_at IS NULL`,
    [input.businessId, input.locationId, input.requestId, input.actorId],
  );
  return (rowCount ?? 0) === 1;
}

/** Withdraw a request the cloud has not answered yet. A decided row is untouched. */
export async function cancelVehicleOfflineRequest(input: {
  businessId: string;
  locationId: string;
  requestId: string;
  actorId: string | null;
}): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE automotive_vehicle_offline_requests
        SET status = 'cancelled', resolved_at = now(), updated_at = now()
      WHERE business_id = $1 AND location_id = $2 AND id = $3 AND status = 'pending'`,
    [input.businessId, input.locationId, input.requestId],
  );
  return (rowCount ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Cloud: validate, then apply a queued request through the canonical services
// ---------------------------------------------------------------------------

export interface ParsedVehicleOfflineRequest {
  requestId: string;
  requestType: AutomotiveOfflineRequestType;
  payload: Record<string, unknown>;
}

/**
 * Validate an incoming request event's payload before anything touches a car.
 *
 * The strictness is the point: a queued hold is applied by the cloud, so a
 * malformed request must be refused at the boundary rather than half-applied
 * inside the reservation service. `requestId` must be a UUID because it doubles
 * as the row's key and the event's idempotency key — an identity that can be
 * written twice is not an identity.
 */
export function parseVehicleOfflineRequestPayload(
  payload: Record<string, unknown>,
  handler: string,
): ParsedVehicleOfflineRequest {
  const requestType: AutomotiveOfflineRequestType = handler.endsWith(".released") ? "release" : "reserve";
  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!UUID_RE.test(requestId)) throw new VehicleError("invalid_request", "شناسهٔ درخواست آفلاین نامعتبر است.");
  const serialId = typeof payload.serialId === "string" ? payload.serialId : "";
  if (!UUID_RE.test(serialId)) throw new VehicleError("invalid_vehicle", "خودروی درخواست نامعتبر است.");
  if (
    payload.expectedVersion !== undefined &&
    (!Number.isSafeInteger(payload.expectedVersion) || (payload.expectedVersion as number) < 1)
  ) {
    throw new VehicleError("invalid_request", "نسخهٔ خودرو در درخواست نامعتبر است.");
  }
  if (payload.expiresAt != null && (typeof payload.expiresAt !== "string" || !ISO_DATE.test(payload.expiresAt))) {
    throw new VehicleError("invalid_date", "تاریخ انقضای رزرو نامعتبر است.");
  }
  if (
    payload.depositRial !== undefined &&
    (!Number.isSafeInteger(payload.depositRial) || (payload.depositRial as number) < 0)
  ) {
    throw new VehicleError("invalid_amount", "مبلغ ودیعه نامعتبر است.");
  }
  if (requestType === "reserve") {
    const customerId = typeof payload.customerId === "string" ? payload.customerId : "";
    if (!UUID_RE.test(customerId)) throw new VehicleError("customer_required", "رزرو بدون مشتری معنا ندارد.");
  } else {
    const reservationId = typeof payload.reservationId === "string" ? payload.reservationId : "";
    if (!UUID_RE.test(reservationId)) throw new VehicleError("reservation_not_found", "رزرو موردنظر یافت نشد.");
    if (typeof payload.reason !== "string" || !payload.reason.trim()) {
      throw new VehicleError("reason_required", "دلیل آزادسازی رزرو الزامی است.");
    }
  }
  return { requestId, requestType, payload };
}

/** Insert (idempotently) one request row from an event's payload. */
async function insertOfflineRequestRow(params: {
  client: PoolClient;
  businessId: string;
  locationId: string;
  requestType: AutomotiveOfflineRequestType;
  requestId: string;
  payload: Record<string, unknown>;
  actorId: string | null;
}): Promise<void> {
  const { client, businessId, locationId, requestType, requestId, payload, actorId } = params;
  await client.query(
    `INSERT INTO automotive_vehicle_offline_requests
       (id, business_id, location_id, request_type, serial_id, stock_number, customer_id, customer_name,
        reservation_id, deposit_amount_rial, deposit_method, deposit_refundable, deposit_note, note,
        expires_at, expires_at_time, reason, refund_deposit, expected_version, expected_state, requested_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'pending')
     ON CONFLICT (business_id, id) DO NOTHING`,
    [
      requestId,
      businessId,
      locationId,
      requestType,
      typeof payload.serialId === "string" ? payload.serialId : "",
      typeof payload.stockNumber === "string" ? payload.stockNumber : "",
      typeof payload.customerId === "string" ? payload.customerId : null,
      typeof payload.customerName === "string" ? payload.customerName : null,
      typeof payload.reservationId === "string" ? payload.reservationId : null,
      Number.isSafeInteger(payload.depositRial) ? (payload.depositRial as number) : 0,
      typeof payload.depositMethod === "string" ? payload.depositMethod : null,
      payload.depositRefundable === undefined ? true : payload.depositRefundable === true,
      typeof payload.depositNote === "string" ? payload.depositNote : null,
      typeof payload.note === "string" ? payload.note : null,
      typeof payload.expiresAt === "string" ? payload.expiresAt : null,
      typeof payload.expiresAtTime === "string" ? payload.expiresAtTime : null,
      typeof payload.reason === "string" ? payload.reason : null,
      payload.refundDeposit === undefined ? null : payload.refundDeposit === true,
      Number.isSafeInteger(payload.expectedVersion) ? (payload.expectedVersion as number) : 0,
      typeof payload.expectedState === "string" ? payload.expectedState : "",
      actorId,
    ],
  );
}

/**
 * The site-side intake: a request event that reached this install by another
 * route (a client flush through POST /api/sync/events, say) still lands as one
 * durable `pending` row, so the counter sees the same intent either way. No
 * hold, no posting — the ordinary push carries it to the cloud, which decides.
 */
export async function recordVehicleOfflineRequestIntent(input: {
  /** The caller's transaction client: the intent must land with the event that carries it, or not at all. */
  client: PoolClient;
  businessId: string;
  locationId: string;
  requestType: AutomotiveOfflineRequestType;
  requestId: string;
  payload: Record<string, unknown>;
  actorId: string | null;
}): Promise<void> {
  await insertOfflineRequestRow({
    client: input.client,
    businessId: input.businessId,
    locationId: input.locationId,
    requestType: input.requestType,
    requestId: input.requestId,
    payload: input.payload,
    actorId: input.actorId,
  });
}

export interface VehicleRequestApplyOutcome {
  requestId: string;
  status: AutomotiveOfflineRequestStatus;
  conflictCode: AutomotiveOfflineConflictCode | null;
  reservationId: string | null;
  duplicate: boolean;
  /** The version of the cloud row the decision was made against. */
  sourceVersion: number | null;
}

export interface ApplyVehicleOfflineRequestContext {
  client: PoolClient;
  businessId: string;
  locationId: string;
  requestId: string;
  actorId: string | null;
  payload: Record<string, unknown>;
}

async function loadRemoteFacts(
  context: ApplyVehicleOfflineRequestContext,
  serialId: string,
): Promise<{
  found: boolean;
  state: VehicleState | null;
  locationId: string | null;
  sourceVersion: number | null;
  blockingHoldId: string | null;
}> {
  const { rows } = await context.client.query<{
    state: string;
    location_id: string;
    updated_at: Date;
    hold_id: string | null;
  }>(
    `SELECT v.state, v.location_id, v.updated_at,
            (SELECT r.id FROM serial_reservations r
              WHERE r.business_id = v.business_id AND r.serial_id = v.serial_id AND r.status = 'active'
              LIMIT 1) AS hold_id
       FROM automotive_vehicle_attributes v
      WHERE v.business_id = $1 AND v.serial_id = $2`,
    [context.businessId, serialId],
  );
  const row = rows[0];
  if (!row) return { found: false, state: null, locationId: null, sourceVersion: null, blockingHoldId: null };
  return {
    found: true,
    state: row.state as VehicleState,
    locationId: row.location_id,
    sourceVersion: row.updated_at.valueOf(),
    blockingHoldId: row.hold_id,
  };
}

async function resolveRequestOutcome(
  context: ApplyVehicleOfflineRequestContext,
  outcome: VehicleRequestApplyOutcome,
  errorCode: string | null,
): Promise<VehicleRequestApplyOutcome> {
  await context.client.query(
    `UPDATE automotive_vehicle_offline_requests
        SET status = $3, conflict_code = $4, reservation_id = coalesce($5, reservation_id),
            outcome = $6::jsonb, resolved_at = now(), synced_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      context.businessId,
      context.requestId,
      outcome.status,
      outcome.conflictCode,
      outcome.reservationId,
      JSON.stringify({
        status: outcome.status,
        conflictCode: outcome.conflictCode,
        reservationId: outcome.reservationId,
        sourceVersion: outcome.sourceVersion,
        error: errorCode,
        appliedAt: new Date().toISOString(),
      }),
    ],
  );
  return outcome;
}

/**
 * Apply one queued request, on the cloud, inside the caller's transaction.
 *
 * The order of operations is the safety argument:
 *   1. the request row is upserted from the event's payload (the site's intent
 *      travels with the event) and locked `FOR UPDATE`, so two deliveries of the
 *      same idempotency key serialise and the second sees a decided row;
 *   2. a decided row returns immediately — a retried push or a replayed event is
 *      a duplicate, never a second hold;
 *   3. the car's live facts are re-validated (`classifyVehicleRequestReplay`),
 *      and a refusal is **recorded as a conflict** rather than thrown, so the
 *      counter learns why instead of watching a request vanish;
 *   4. the canonical service is called inside a `SAVEPOINT`: any partial effect
 *      (a hold row inserted before a posting failed) is rolled back whole, and
 *      the request becomes a conflict. A hold is never half-applied.
 */
export async function applyVehicleOfflineRequest(
  context: ApplyVehicleOfflineRequestContext,
): Promise<VehicleRequestApplyOutcome> {
  const { client, businessId, locationId, requestId, actorId, payload } = context;
  const requestType: AutomotiveOfflineRequestType = payload.requestType === "release" ? "release" : "reserve";
  const serialId = typeof payload.serialId === "string" ? payload.serialId : "";

  await insertOfflineRequestRow({ client, businessId, locationId, requestType, requestId, payload, actorId });

  const locked = await client.query<{
    status: AutomotiveOfflineRequestStatus;
    conflict_code: string | null;
    reservation_id: string | null;
  }>(
    `SELECT status, conflict_code, reservation_id FROM automotive_vehicle_offline_requests
      WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [businessId, requestId],
  );
  const row = locked.rows[0];
  if (!row) throw new VehicleError("invalid_vehicle", "درخواست آفلاین یافت نشد.");
  if (row.status !== "pending") {
    // Already decided: report the original answer, idempotently.
    return {
      requestId,
      status: row.status,
      conflictCode: row.conflict_code as AutomotiveOfflineConflictCode | null,
      reservationId: row.reservation_id,
      duplicate: true,
      sourceVersion: null,
    };
  }

  const conflict = (
    code: AutomotiveOfflineConflictCode,
    sourceVersion: number | null,
    reservationId: string | null = null,
  ): Promise<VehicleRequestApplyOutcome> =>
    resolveRequestOutcome(
      context,
      { requestId, status: "conflict", conflictCode: code, reservationId, duplicate: false, sourceVersion },
      code,
    );

  if (requestType === "reserve") {
    const expectedVersion = Number.isSafeInteger(payload.expectedVersion) ? (payload.expectedVersion as number) : 0;
    const expectedState = (typeof payload.expectedState === "string" ? payload.expectedState : "in_stock") as VehicleState;
    const facts = await loadRemoteFacts(context, serialId);
    const decision = classifyVehicleRequestReplay({
      request: { serialId, locationId, expectedVersion, expectedState },
      remote: {
        found: facts.found,
        state: facts.state,
        locationId: facts.locationId,
        sourceVersion: facts.sourceVersion,
        blockingHoldId: facts.blockingHoldId,
        ownReservationId: row.reservation_id,
      },
      reservableStates: RESERVABLE_STATES,
    });
    if (decision.outcome === "duplicate") {
      return resolveRequestOutcome(
        context,
        {
          requestId,
          status: "confirmed",
          conflictCode: null,
          reservationId: decision.reservationId,
          duplicate: true,
          sourceVersion: facts.sourceVersion,
        },
        null,
      );
    }
    if (decision.outcome === "conflict") return conflict(decision.code, facts.sourceVersion);

    const customerId = typeof payload.customerId === "string" ? payload.customerId : "";
    if (!customerId) return conflict("invalid_request", facts.sourceVersion);
    const today = await businessToday(client, locationId);
    const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : null;
    // A hold whose expiry already passed could only ever be born expired; the
    // counter is told rather than handed a hold the clock has already released.
    if (expiresAt && expiresAt < today) return conflict("invalid_request", facts.sourceVersion);

    const depositRial = Number.isSafeInteger(payload.depositRial) ? (payload.depositRial as number) : 0;
    await client.query("SAVEPOINT automotive_request_apply");
    try {
      const reservation = await reserveVehicle(client, {
        businessId,
        locationId,
        serialId,
        customerId,
        expiresAt,
        expiresAtTime: typeof payload.expiresAtTime === "string" ? payload.expiresAtTime : null,
        depositRial,
        depositMethod:
          depositRial > 0 && typeof payload.depositMethod === "string" && (DEPOSIT_METHODS as readonly string[]).includes(payload.depositMethod)
            ? (payload.depositMethod as DepositMethod)
            : null,
        depositRefundable: payload.depositRefundable === undefined ? true : payload.depositRefundable === true,
        depositNote: typeof payload.depositNote === "string" ? payload.depositNote : null,
        note: typeof payload.note === "string" ? payload.note : null,
        actorId,
      });
      await client.query("RELEASE SAVEPOINT automotive_request_apply");
      return resolveRequestOutcome(
        context,
        {
          requestId,
          status: "confirmed",
          conflictCode: null,
          reservationId: reservation.id,
          duplicate: false,
          sourceVersion: facts.sourceVersion,
        },
        null,
      );
    } catch (error) {
      // Any partial effect of the attempt goes away whole — a hold is never
      // half-applied, and a posting failure leaves no orphan row behind.
      await client.query("ROLLBACK TO SAVEPOINT automotive_request_apply");
      const rawCode =
        error instanceof VehicleError
          ? error.code
          : (error as { code?: string }).code === "23505"
            ? "vehicle_reserved_by_other"
            : "invalid_request";
      const after = await loadRemoteFacts(context, serialId);
      const code = after.blockingHoldId ? "vehicle_reserved_by_other" : conflictCodeForVehicleError(rawCode);
      return conflict(code, after.sourceVersion);
    }
  }

  // Release: the canonical service owns the policy (a reason is required, a
  // refundable deposit is refunded, and a car that has moved on is not dragged
  // back to the shelf by a release that arrived late).
  const reservationId = typeof payload.reservationId === "string" ? payload.reservationId : "";
  if (!reservationId) return conflict("invalid_request", null);
  const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : null;
  if (!reason) return conflict("invalid_request", null, reservationId);

  await client.query("SAVEPOINT automotive_request_apply");
  try {
    await releaseVehicleReservation(client, {
      businessId,
      locationId,
      reservationId,
      reason,
      actorId,
      refund: payload.refundDeposit === undefined ? undefined : payload.refundDeposit === true,
    });
    await client.query("RELEASE SAVEPOINT automotive_request_apply");
    return resolveRequestOutcome(
      context,
      { requestId, status: "confirmed", conflictCode: null, reservationId, duplicate: false, sourceVersion: null },
      null,
    );
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT automotive_request_apply");
    const rawCode = error instanceof VehicleError ? error.code : "invalid_request";
    return conflict(conflictCodeForVehicleError(rawCode), null, reservationId);
  }
}
