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
import type { VehicleBodyType, VehicleDrivetrain, VehicleFuelType, VehicleTransmission } from "@/lib/automotive";
import { handleAutomotiveError, holdsPermission, readBody } from "../../guard";

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

  try {
    const vehicle = await getVehicle(session.businessId, id);
    if (!vehicle) return NextResponse.json({ error: "vehicle_not_found" }, { status: 404 });

    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    const [priceHistory, transfers] = await Promise.all([
      listVehiclePriceHistory(session.businessId, id),
      listVehicleTransfers(session.businessId, { serialId: id, limit: 20 }),
    ]);

    const payload = {
      vehicle,
      canSeeCost,
      priceHistory,
      transfers,
    };
    if (canSeeCost) return NextResponse.json(payload);

    const {
      purchaseCostRial,
      effectiveCostRial,
      capitalizedCostRial,
      periodExpenseRial,
      minimumPriceRial,
      costs,
      ...visible
    } = vehicle;
    return NextResponse.json({
      ...payload,
      vehicle: {
        ...visible,
        // The cost *rows* are money too: hidden wholesale, never half-shown.
        costs: [],
      },
      priceHistory: priceHistory.map(({ minimumPriceRial: _floor, ...entry }) => entry),
    });
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
  const body = await readBody(request);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const vehicle = await updateVehicle(client, {
      businessId: session.businessId,
      serialId: id,
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
    return NextResponse.json({ ok: true, vehicle });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
