import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createVehicle, listVehicles, type CreateVehicleInput, type VehicleCostInput } from "@/lib/automotive-service";
import type {
  VehicleState,
  VehicleAcquisitionSource,
  VehicleBodyType,
  VehicleDrivetrain,
  VehicleExpenseCategory,
  VehicleFuelType,
  VehicleTransmission,
  VehicleYearCalendar,
} from "@/lib/automotive";
import { handleAutomotiveError, holdsPermission, readBody } from "../guard";

const SETTLEMENTS = new Set(["cash", "bank", "payable", "clearing", "opening_equity", "trade_in"]);

function text(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * §10's stock list. Readable by every role that may see the lot
 * (`vehicles.view`) — but the *cost* and *minimum price* columns are the
 * caller's own permission, not the row's: a cashier or salesperson reads the
 * same board without the acquisition cost, effective cost, potential margin or
 * the owner's floor, exactly as §2 requires. The response says which shape it
 * is (`canSeeCost`) so the screen renders what it was given rather than
 * guessing from a missing field.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;

  const url = new URL(request.url);
  const location = await resolveActiveLocation(session);
  const states = url.searchParams.get("states");
  const numeric = (key: string) => {
    const raw = url.searchParams.get(key);
    if (raw == null || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const condition = url.searchParams.get("condition");

  try {
    const result = await listVehicles({
      businessId: session.businessId,
      // `allBranches=1` is the §15 "branch inventory" view; without it the
      // caller's own active branch is the scope, never a client-named one.
      locationId: url.searchParams.get("allBranches") === "1" ? null : (location?.id ?? null),
      condition: condition === "new" || condition === "used" ? condition : null,
      states: states ? (states.split(",").filter(Boolean) as VehicleState[]) : undefined,
      make: url.searchParams.get("make"),
      model: url.searchParams.get("model"),
      modelYearFrom: numeric("modelYearFrom"),
      modelYearTo: numeric("modelYearTo"),
      minPriceRial: numeric("minPriceRial"),
      maxPriceRial: numeric("maxPriceRial"),
      maxMileageKm: numeric("maxMileageKm"),
      minAgeDays: numeric("minAgeDays"),
      maxAgeDays: numeric("maxAgeDays"),
      search: url.searchParams.get("q"),
      limit: numeric("limit") ?? undefined,
      offset: numeric("offset") ?? undefined,
    });

    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    const total = result.total;
    return NextResponse.json({
      total,
      canSeeCost,
      vehicles: result.vehicles.map((vehicle) => {
        if (canSeeCost) return vehicle;
        const { purchaseCostRial, effectiveCostRial, potentialMarginRial, minimumPriceRial, ...visible } = vehicle;
        return visible;
      }),
    });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

/**
 * §4's "add / acquire" — one transaction: the catalogue row, the physical unit,
 * its own record, the acquisition posting and any costs recorded with it.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesCreate);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const body = await readBody(request);
  const condition = body.condition === "used" ? "used" : body.condition === "new" ? "new" : null;
  if (!condition) return NextResponse.json({ error: "invalid_condition" }, { status: 400 });
  if (!text(body, "make") || !text(body, "model")) {
    return NextResponse.json({ error: "missing_fields", message: "برند و مدل الزامی است." }, { status: 400 });
  }

  const acquisitionBody = (body.acquisition ?? null) as Record<string, unknown> | null;
  const settlement = String(acquisitionBody?.settlement ?? "payable");
  const acquisition: CreateVehicleInput["acquisition"] = acquisitionBody
    ? {
        date: String(acquisitionBody.date ?? ""),
        source: String(acquisitionBody.source ?? "dealer_purchase") as VehicleAcquisitionSource,
        partyId: (acquisitionBody.partyId as string | null) ?? null,
        costRial: Number(acquisitionBody.costRial ?? 0),
        settlement: (SETTLEMENTS.has(settlement) ? settlement : "payable") as never,
        note: (acquisitionBody.note as string | null) ?? null,
      }
    : null;

  const initialCosts: VehicleCostInput[] = Array.isArray(body.initialCosts)
    ? (body.initialCosts as Record<string, unknown>[]).map((cost) => {
        const costSettlement = String(cost.settlement ?? "payable");
        return {
          category: String(cost.category ?? "other") as VehicleExpenseCategory,
          posting: cost.posting === "period_expense" ? "period_expense" : "capitalized",
          amountRial: Number(cost.amountRial ?? 0),
          incurredOn: String(cost.incurredOn ?? ""),
          vendorPartyId: (cost.vendorPartyId as string | null) ?? null,
          documentRef: (cost.documentRef as string | null) ?? null,
          notes: (cost.notes as string | null) ?? null,
          settlement: (SETTLEMENTS.has(costSettlement) ? costSettlement : "payable") as never,
        };
      })
    : [];

  // One permission per act: recording money against a car needs
  // `vehicles.expense_record` on top of the create permission that got us here.
  if (initialCosts.length > 0 && !(await holdsPermission(session, PERMISSIONS.vehiclesExpenseRecord))) {
    return NextResponse.json(
      { error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesExpenseRecord },
      { status: 403 },
    );
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await createVehicle(client, {
      businessId: session.businessId,
      locationId: location.id,
      make: text(body, "make")!,
      model: text(body, "model")!,
      trim: text(body, "trim"),
      vehicleYearCalendar: (body.vehicleYearCalendar === "gregorian" ? "gregorian" : "jalali") as VehicleYearCalendar,
      modelYear: optionalNumber(body, "modelYear"),
      productionYear: optionalNumber(body, "productionYear"),
      vin: text(body, "vin"),
      chassisNumber: text(body, "chassisNumber"),
      engineNumber: text(body, "engineNumber"),
      plateNumber: text(body, "plateNumber"),
      stockNumber: text(body, "stockNumber"),
      bodyType: text(body, "bodyType") as VehicleBodyType | null,
      transmission: text(body, "transmission") as VehicleTransmission | null,
      fuelType: text(body, "fuelType") as VehicleFuelType | null,
      engineSpec: text(body, "engineSpec"),
      drivetrain: text(body, "drivetrain") as VehicleDrivetrain | null,
      exteriorColor: text(body, "exteriorColor"),
      interiorColor: text(body, "interiorColor"),
      condition,
      mileageKm: optionalNumber(body, "mileageKm"),
      priorOwners: optionalNumber(body, "priorOwners"),
      registrationDate: text(body, "registrationDate"),
      inspectionNotes: text(body, "inspectionNotes"),
      bodyConditionNotes: text(body, "bodyConditionNotes"),
      mechanicalNotes: text(body, "mechanicalNotes"),
      serviceHistory: text(body, "serviceHistory"),
      provenanceSource: text(body, "provenanceSource") as VehicleAcquisitionSource | null,
      provenancePartyId: text(body, "provenancePartyId"),
      provenanceNote: text(body, "provenanceNote"),
      acquisition,
      askingPriceRial: optionalNumber(body, "askingPriceRial") ?? 0,
      minimumPriceRial: optionalNumber(body, "minimumPriceRial"),
      wholesalePriceRial: optionalNumber(body, "wholesalePriceRial"),
      promotionalPriceRial: optionalNumber(body, "promotionalPriceRial"),
      initialCosts,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, vehicle: created });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
