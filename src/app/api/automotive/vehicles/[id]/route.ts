import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import {
  getVehicle,
  listVehiclePriceHistory,
  listVehicleTransfers,
  updateVehicle,
} from "@/lib/automotive-service";
import { redactVehicleCostSensitive, type VehicleBodyType, type VehicleDrivetrain, type VehicleFuelType, type VehicleTransmission } from "@/lib/automotive";
import { handleAutomotiveError, holdsPermission, readBody, vehicleBranchContext } from "../../guard";

function text(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value.trim() || null : null;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function present(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/**
 * One car's full record. Cost columns follow the same rule as the list: the
 * row is readable with `vehicles.view`, the money on it needs
 * `vehicles.cost_view` (§2's "cost and minimum price hidden from cashier/sales").
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const { access, response: branchError } = await vehicleBranchContext(session, id);
  if (branchError) return branchError;
  const locationIds = access.allowedLocationIds;

  try {
    const vehicle = await getVehicle(session.businessId, id, undefined, { locationIds });
    if (!vehicle) return NextResponse.json({ error: "vehicle_not_found" }, { status: 404 });

    const [canSeeCost, canSeePriceHistory] = await Promise.all([
      holdsPermission(session, PERMISSIONS.vehiclesCostView),
      holdsPermission(session, PERMISSIONS.vehiclesPriceEdit),
    ]);
    const [priceHistory, transfers] = await Promise.all([
      canSeeCost || canSeePriceHistory
        ? listVehiclePriceHistory(session.businessId, id, undefined, { locationIds })
        : Promise.resolve([]),
      listVehicleTransfers(session.businessId, {
        serialId: id,
        locationIds,
        limit: 20,
      }),
    ]);

    const payload = {
      vehicle,
      canSeeCost,
      canSeePriceHistory: canSeeCost || canSeePriceHistory,
      priceHistory,
      transfers,
    };
    if (canSeeCost) return NextResponse.json(payload);

    return NextResponse.json(
      canSeeCost
        ? payload
        : {
            ...payload,
            vehicle: redactVehicleCostSensitive(vehicle),
            priceHistory: priceHistory.map((entry) => redactVehicleCostSensitive(entry)),
          },
    );
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

/**
 * Edits the physical facts of one car. VIN and chassis number are accepted here
 * (a typo at intake must be correctable) but the service records both values in
 * the audit log on every change — §20's "VIN/chassis change".
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesEdit);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const { access, response: branchError } = await vehicleBranchContext(session, id, { mutation: true });
  if (branchError) return branchError;
  const locationId = access.activeLocationId!;
  const body = await readBody(request);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const vehicle = await updateVehicle(client, {
      businessId: session.businessId,
      serialId: id,
      locationId,
      vin: present(body, "vin") ? text(body, "vin") : undefined,
      chassisNumber: present(body, "chassisNumber") ? text(body, "chassisNumber") : undefined,
      engineNumber: present(body, "engineNumber") ? text(body, "engineNumber") : undefined,
      plateNumber: present(body, "plateNumber") ? text(body, "plateNumber") : undefined,
      registrationDate: present(body, "registrationDate") ? text(body, "registrationDate") : undefined,
      mileageKm: present(body, "mileageKm") ? optionalNumber(body, "mileageKm") : undefined,
      priorOwners: present(body, "priorOwners") ? optionalNumber(body, "priorOwners") : undefined,
      inspectionNotes: present(body, "inspectionNotes") ? text(body, "inspectionNotes") : undefined,
      bodyConditionNotes: present(body, "bodyConditionNotes") ? text(body, "bodyConditionNotes") : undefined,
      mechanicalNotes: present(body, "mechanicalNotes") ? text(body, "mechanicalNotes") : undefined,
      serviceHistory: present(body, "serviceHistory") ? text(body, "serviceHistory") : undefined,
      exteriorColor: present(body, "exteriorColor") ? text(body, "exteriorColor") : undefined,
      interiorColor: present(body, "interiorColor") ? text(body, "interiorColor") : undefined,
      bodyType: present(body, "bodyType") ? (text(body, "bodyType") as VehicleBodyType | null) : undefined,
      transmission: present(body, "transmission") ? (text(body, "transmission") as VehicleTransmission | null) : undefined,
      fuelType: present(body, "fuelType") ? (text(body, "fuelType") as VehicleFuelType | null) : undefined,
      drivetrain: present(body, "drivetrain") ? (text(body, "drivetrain") as VehicleDrivetrain | null) : undefined,
      engineSpec: present(body, "engineSpec") ? text(body, "engineSpec") : undefined,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    return NextResponse.json({
      ok: true,
      vehicle: canSeeCost ? vehicle : redactVehicleCostSensitive(vehicle),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
