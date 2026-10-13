import type { SessionPayload } from "@/lib/auth";
import { query } from "@/lib/db";
import { accessibleLocationsFor, resolveActiveLocation } from "@/lib/setup-state";

export async function branchAccessForSession(session: SessionPayload): Promise<{
  activeLocationId: string | null;
  allowedLocationIds: string[];
}> {
  const [scope, active] = await Promise.all([
    accessibleLocationsFor(session),
    resolveActiveLocation(session),
  ]);
  return {
    activeLocationId: active?.id ?? null,
    allowedLocationIds: scope.locations.map((location) => location.id),
  };
}

export function canAccessLocation(
  access: Awaited<ReturnType<typeof branchAccessForSession>>,
  locationId: string | null | undefined,
): boolean {
  return locationId != null && access.allowedLocationIds.includes(locationId);
}

export function canActInLocation(
  access: Awaited<ReturnType<typeof branchAccessForSession>>,
  locationId: string | null | undefined,
): boolean {
  return canAccessLocation(access, locationId) && locationId === access.activeLocationId;
}

/**
 * Resolve one car's authorized branch from live membership data. A vehicle id
 * is not itself an authorization token: every detail/mutation route must scope
 * it to the caller's allowed branches, and mutations additionally bind to the
 * request's active branch.
 */
export async function vehicleBranchAccess(
  session: SessionPayload,
  serialId: string,
): Promise<{
  locationId: string | null;
  activeLocationId: string | null;
  allowedLocationIds: string[];
}> {
  const [{ rows }, branchAccess] = await Promise.all([
    query<{ location_id: string }>(
      `SELECT location_id FROM automotive_vehicle_attributes
        WHERE business_id = $1 AND serial_id = $2`,
      [session.businessId, serialId],
    ),
    branchAccessForSession(session),
  ]);
  return {
    locationId: rows[0]?.location_id ?? null,
    ...branchAccess,
  };
}

export function canAccessVehicleBranch(
  access: Awaited<ReturnType<typeof vehicleBranchAccess>>,
): boolean {
  return access.locationId != null && access.allowedLocationIds.includes(access.locationId);
}

export function canMutateVehicleInActiveBranch(
  access: Awaited<ReturnType<typeof vehicleBranchAccess>>,
): boolean {
  return canAccessVehicleBranch(access) && access.locationId === access.activeLocationId;
}
