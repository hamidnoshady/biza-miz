/**
 * Issue #839 §19 / Wave 6 — the contract between the cloud and a paired
 * dealership desktop for **vehicle stock reads**.
 *
 * The cloud serves one branch's vehicle stock as a whole snapshot
 * (`GET /api/server-sync/automotive-stock`), exactly the way Phase 45 serves the
 * branch profile from `GET /api/server-sync/site-profile`. The desktop replaces
 * its read-only mirror with it. That shape is deliberate:
 *
 *   * **A snapshot cannot diverge.** There is no per-field merge, no clock
 *     comparison and no "who wrote last" question anywhere on this path — the
 *     site holds the cloud's row or nothing. Re-applying an identical snapshot
 *     is a no-op (`contentHash`), and an out-of-order response is harmless
 *     because a later one simply replaces it whole.
 *   * **Nothing the mirror carries can move money.** The payload is the
 *     operational board: identity, condition, state, the branch it sits on, the
 *     asking price and the active hold. **Acquisition cost, capitalized costs,
 *     minimum price and the sale documents are not in it at all** — so a
 *     cashier's laptop cannot leak a margin, and no offline path can invent a
 *     ledger effect from mirrored data.
 *   * **Ambiguity is refused, not mirrored.** A payload that names the same VIN,
 *     chassis or stock number twice is rejected whole: a mirror that cannot say
 *     which row is which car is worse than an empty one.
 *
 * Pure: shape validation, a stable hash, the state transitions. The DB halves
 * live in `automotive-stock-service.ts`; the replay/conflict vocabulary in
 * `automotive-offline.ts`.
 */
import { createHash } from "node:crypto";
import { nextAttemptAt } from "./sync-backoff";
import { isUuid } from "./uuid";
import {
  AUTOMOTIVE_OFFLINE_CONFLICT_CODES,
  type AutomotiveOfflineConflictCode,
  type AutomotiveOfflineRequestStatus,
  AUTOMOTIVE_OFFLINE_REQUEST_STATUSES,
  AUTOMOTIVE_OFFLINE_REQUEST_TYPES,
  type AutomotiveOfflineRequestType,
} from "./automotive-offline";
import { VEHICLE_CONDITIONS, VEHICLE_STATES, type VehicleCondition, type VehicleState } from "./automotive";
// The board's vocabulary lives in its own module so the `"use client"` desktop
// screen can import it without dragging `node:crypto` (this file's snapshot
// hash) into the browser bundle — see `automotive-board.ts`.
import {
  availabilityForVehicle,
  mirrorDaysInStock,
  VEHICLE_AVAILABILITY_VALUES,
  type VehicleAvailability,
} from "./automotive-board";

export const AUTOMOTIVE_STOCK_PROJECTION_SCHEMA_VERSION = 1 as const;

// Re-exported for the server-side importers that already read them from the wire
// contract; the desktop screen imports `automotive-board.ts` directly.
export {
  availabilityForVehicle,
  mirrorDaysInStock,
  VEHICLE_AVAILABILITY_LABELS,
  VEHICLE_AVAILABILITY_VALUES,
  type VehicleAvailability,
} from "./automotive-board";

export interface AutomotiveStockVehicle {
  serialId: string;
  /** The catalogue row, when the desktop already holds it (items travels on the master feed). */
  itemId: string | null;
  stockNumber: string;
  make: string;
  model: string;
  trim: string | null;
  condition: VehicleCondition;
  state: VehicleState;
  vehicleYearCalendar: string;
  modelYear: number | null;
  mileageKm: number | null;
  vin: string | null;
  chassisNumber: string | null;
  plateNumber: string | null;
  bodyType: string | null;
  transmission: string | null;
  fuelType: string | null;
  exteriorColor: string | null;
  /** Business-local ISO date the branch took the car in; drives days-in-stock offline. */
  acquiredOn: string | null;
  askingPriceRial: number | null;
  availability: VehicleAvailability;
  /** The active hold on this unit, when there is one. */
  reservationId: string | null;
  reservationCustomerName: string | null;
  reservationExpiresAt: string | null;
  /** `updated_at` of the cloud row, as epoch ms — the version an operator saw. */
  sourceVersion: number;
  cloudUpdatedAt: string;
}

/** The cloud's answer to a queued request, as this site reads it back. */
export interface AutomotiveStockRequest {
  id: string;
  requestType: AutomotiveOfflineRequestType;
  serialId: string;
  stockNumber: string;
  customerName: string | null;
  status: AutomotiveOfflineRequestStatus;
  conflictCode: AutomotiveOfflineConflictCode | null;
  reservationId: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  /** Version of the *cloud* row this answer was produced against. */
  sourceVersion: number | null;
}

export interface AutomotiveStockProjection {
  schemaVersion: typeof AUTOMOTIVE_STOCK_PROJECTION_SCHEMA_VERSION;
  locationId: string;
  generatedAt: string;
  vehicles: AutomotiveStockVehicle[];
  requests: AutomotiveStockRequest[];
}

export interface AutomotiveStockState {
  /** Hash of the last snapshot applied; an unchanged snapshot is not re-applied. */
  hash: string | null;
  appliedAt: string | null;
  checkedAt: string | null;
  lastError: string | null;
  failures: number;
  nextAttemptAt: string | null;
  /** How many vehicles the last applied snapshot carried. */
  vehicleCount: number;
}

export const EMPTY_AUTOMOTIVE_STOCK_STATE: AutomotiveStockState = {
  hash: null,
  appliedAt: null,
  checkedAt: null,
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
  vehicleCount: 0,
};

export function automotiveStockSucceeded(
  previous: AutomotiveStockState,
  hash: string,
  applied: boolean,
  vehicleCount: number,
  now: Date,
): AutomotiveStockState {
  return {
    hash,
    appliedAt: applied ? now.toISOString() : previous.appliedAt,
    checkedAt: now.toISOString(),
    lastError: null,
    failures: 0,
    nextAttemptAt: null,
    vehicleCount: applied ? vehicleCount : previous.vehicleCount,
  };
}

/** The last applied snapshot stays in force; only the error and the backoff move. */
export function automotiveStockFailed(
  previous: AutomotiveStockState,
  error: string,
  now: Date,
  random: () => number = Math.random,
): AutomotiveStockState {
  const failures = previous.failures + 1;
  return {
    ...previous,
    checkedAt: now.toISOString(),
    lastError: error.slice(0, 300),
    failures,
    nextAttemptAt: nextAttemptAt(failures, now, random),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableInteger(value: unknown, minimum: number): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= minimum);
}

function nullableDate(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function nullableInstant(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

/** The identity a mirror row cannot share with another row in the same branch. */
export const VEHICLE_MIRROR_IDENTITY_FIELDS = ["vin", "chassisNumber", "stockNumber"] as const;
export type VehicleMirrorIdentityField = (typeof VEHICLE_MIRROR_IDENTITY_FIELDS)[number];

/**
 * Case-insensitive duplicate identities inside one snapshot — the local half of
 * "a duplicate VIN cannot create ambiguous stock". The cloud's partial unique
 * indexes make this unreachable in practice; refusing it here means a bug (or a
 * hand-crafted payload) stops at the sync boundary instead of producing two
 * rows a salesman could sell from.
 */
export function duplicateVehicleIdentities(
  vehicles: readonly Pick<AutomotiveStockVehicle, "serialId" | "vin" | "chassisNumber" | "stockNumber">[],
): Array<{ field: VehicleMirrorIdentityField; value: string; serialIds: string[] }> {
  const problems: Array<{ field: VehicleMirrorIdentityField; value: string; serialIds: string[] }> = [];
  const seenSerials = new Set<string>();
  for (const vehicle of vehicles) {
    if (seenSerials.has(vehicle.serialId)) problems.push({ field: "stockNumber", value: vehicle.serialId, serialIds: [vehicle.serialId] });
    seenSerials.add(vehicle.serialId);
  }
  for (const field of VEHICLE_MIRROR_IDENTITY_FIELDS) {
    const byValue = new Map<string, string[]>();
    for (const vehicle of vehicles) {
      const raw = vehicle[field];
      if (typeof raw !== "string") continue;
      const key = raw.trim().toUpperCase();
      if (!key) continue;
      byValue.set(key, [...(byValue.get(key) ?? []), vehicle.serialId]);
    }
    for (const [value, serialIds] of byValue) {
      if (serialIds.length > 1) problems.push({ field, value, serialIds });
    }
  }
  return problems;
}

/**
 * A shape check, deliberately not a trust check — the same posture
 * `validateSnapshot` and `validateSiteProfile` take. The credential already
 * named the business and the branch; this stops a truncated response, a version
 * skew, or an issuing-side bug from writing nonsense into a local database.
 */
export function validateAutomotiveStockProjection(raw: unknown): AutomotiveStockProjection | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== AUTOMOTIVE_STOCK_PROJECTION_SCHEMA_VERSION) return null;
  if (!isUuid(raw.locationId)) return null;
  if (typeof raw.generatedAt !== "string" || !Number.isFinite(Date.parse(raw.generatedAt))) return null;
  if (!Array.isArray(raw.vehicles) || !Array.isArray(raw.requests)) return null;
  if (raw.vehicles.length > 20_000 || raw.requests.length > 2_000) return null;

  const vehicles: AutomotiveStockVehicle[] = [];
  for (const entry of raw.vehicles) {
    if (!isRecord(entry)) return null;
    if (!isUuid(entry.serialId)) return null;
    if (!nullableText(entry.itemId) || (entry.itemId !== null && !isUuid(entry.itemId))) return null;
    if (typeof entry.stockNumber !== "string" || !entry.stockNumber.trim()) return null;
    if (typeof entry.make !== "string" || !entry.make.trim()) return null;
    if (typeof entry.model !== "string" || !entry.model.trim()) return null;
    if (!nullableText(entry.trim)) return null;
    if (!(VEHICLE_CONDITIONS as readonly string[]).includes(String(entry.condition))) return null;
    if (!(VEHICLE_STATES as readonly string[]).includes(String(entry.state))) return null;
    if (typeof entry.vehicleYearCalendar !== "string" || !entry.vehicleYearCalendar) return null;
    if (!nullableInteger(entry.modelYear, 0) || !nullableInteger(entry.mileageKm, 0)) return null;
    if (!nullableText(entry.vin) || !nullableText(entry.chassisNumber) || !nullableText(entry.plateNumber)) return null;
    if (!nullableText(entry.bodyType) || !nullableText(entry.transmission) || !nullableText(entry.fuelType)) return null;
    if (!nullableText(entry.exteriorColor)) return null;
    if (!nullableDate(entry.acquiredOn)) return null;
    if (!nullableInteger(entry.askingPriceRial, 0)) return null;
    if (!(VEHICLE_AVAILABILITY_VALUES as readonly string[]).includes(String(entry.availability))) return null;
    if (!nullableText(entry.reservationId) || (entry.reservationId !== null && !isUuid(entry.reservationId))) return null;
    if (!nullableText(entry.reservationCustomerName) || !nullableInstant(entry.reservationExpiresAt)) return null;
    if (!Number.isSafeInteger(entry.sourceVersion) || (entry.sourceVersion as number) < 1) return null;
    if (typeof entry.cloudUpdatedAt !== "string" || !Number.isFinite(Date.parse(entry.cloudUpdatedAt))) return null;
    vehicles.push({
      serialId: entry.serialId,
      itemId: entry.itemId,
      stockNumber: entry.stockNumber,
      make: entry.make,
      model: entry.model,
      trim: entry.trim,
      condition: entry.condition as VehicleCondition,
      state: entry.state as VehicleState,
      vehicleYearCalendar: entry.vehicleYearCalendar,
      modelYear: entry.modelYear,
      mileageKm: entry.mileageKm,
      vin: entry.vin,
      chassisNumber: entry.chassisNumber,
      plateNumber: entry.plateNumber,
      bodyType: entry.bodyType,
      transmission: entry.transmission,
      fuelType: entry.fuelType,
      exteriorColor: entry.exteriorColor,
      acquiredOn: entry.acquiredOn,
      askingPriceRial: entry.askingPriceRial,
      availability: entry.availability as VehicleAvailability,
      reservationId: entry.reservationId,
      reservationCustomerName: entry.reservationCustomerName,
      reservationExpiresAt: entry.reservationExpiresAt,
      sourceVersion: entry.sourceVersion as number,
      cloudUpdatedAt: entry.cloudUpdatedAt,
    });
  }
  // Ambiguity is refused whole, never mirrored.
  if (duplicateVehicleIdentities(vehicles).length > 0) return null;

  const requests: AutomotiveStockRequest[] = [];
  for (const entry of raw.requests) {
    if (!isRecord(entry)) return null;
    if (!isUuid(entry.id) || !isUuid(entry.serialId)) return null;
    if (!(AUTOMOTIVE_OFFLINE_REQUEST_TYPES as readonly string[]).includes(String(entry.requestType))) return null;
    if (typeof entry.stockNumber !== "string" || !entry.stockNumber.trim()) return null;
    if (!nullableText(entry.customerName)) return null;
    if (!(AUTOMOTIVE_OFFLINE_REQUEST_STATUSES as readonly string[]).includes(String(entry.status))) return null;
    const conflict = entry.conflictCode ?? null;
    if (!nullableText(conflict) || (conflict !== null && !(AUTOMOTIVE_OFFLINE_CONFLICT_CODES as readonly string[]).includes(conflict))) {
      return null;
    }
    if (!nullableText(entry.reservationId) || (entry.reservationId !== null && !isUuid(entry.reservationId))) return null;
    if (typeof entry.requestedAt !== "string" || !Number.isFinite(Date.parse(entry.requestedAt))) return null;
    if (!nullableInstant(entry.resolvedAt)) return null;
    if (entry.sourceVersion !== null && entry.sourceVersion !== undefined) {
      if (!Number.isSafeInteger(entry.sourceVersion) || (entry.sourceVersion as number) < 1) return null;
    }
    requests.push({
      id: entry.id,
      requestType: entry.requestType as AutomotiveOfflineRequestType,
      serialId: entry.serialId,
      stockNumber: entry.stockNumber,
      customerName: entry.customerName,
      status: entry.status as AutomotiveOfflineRequestStatus,
      conflictCode: conflict as AutomotiveOfflineConflictCode | null,
      reservationId: entry.reservationId,
      requestedAt: entry.requestedAt,
      resolvedAt: entry.resolvedAt,
      sourceVersion: (entry.sourceVersion ?? null) as number | null,
    });
  }

  return {
    schemaVersion: AUTOMOTIVE_STOCK_PROJECTION_SCHEMA_VERSION,
    locationId: raw.locationId,
    generatedAt: raw.generatedAt,
    vehicles,
    requests,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function automotiveStockProjectionHash(projection: AutomotiveStockProjection): string {
  return createHash("sha256").update(JSON.stringify(canonical(projection))).digest("hex");
}

/** Stable per-row hash: equal hashes mean the mirror row already matches the cloud's. */
export function vehicleMirrorRowHash(vehicle: AutomotiveStockVehicle): string {
  return createHash("sha256").update(JSON.stringify(canonical(vehicle))).digest("hex");
}

/**
 * Apply the cloud's answer to a local request row, monotonic: the answer is
 * final, and an older snapshot that still says `pending` never revives a
 * resolved request. Returns `null` when the local row already matches.
 */
export function planRequestStatusApply(input: {
  local: {
    status: AutomotiveOfflineRequestStatus;
    conflictCode: string | null;
    reservationId: string | null;
  };
  remote: AutomotiveStockRequest;
}): { status: AutomotiveOfflineRequestStatus; conflictCode: string | null; reservationId: string | null } | null {
  const { local, remote } = input;
  if (local.status !== "pending") return null;
  if (remote.status === "pending") {
    // The cloud has not answered yet. A hold id it already knows about is
    // informative but not a confirmation — the row stays pending.
    return null;
  }
  if (remote.status === "confirmed" || remote.status === "conflict") {
    return {
      status: remote.status,
      conflictCode: remote.status === "conflict" ? remote.conflictCode : null,
      reservationId: remote.reservationId ?? local.reservationId,
    };
  }
  return null;
}
