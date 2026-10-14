import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { accessibleLocationsFor, resolveActiveLocation } from "@/lib/setup-state";
import { createVehicle, listVehicles, type CreateVehicleInput, type VehicleCostInput, type VehicleListFilters } from "@/lib/automotive-service";
import {
  redactVehicleCostSensitive,
  type VehicleState,
  VEHICLE_CONDITIONS,
  VEHICLE_STATES,
  type VehicleAcquisitionSource,
  type VehicleBodyType,
  type VehicleDrivetrain,
  type VehicleExpenseCategory,
  type VehicleFuelType,
  type VehicleTransmission,
  type VehicleYearCalendar,
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
  const allBranches = url.searchParams.get("allBranches") === "1";
  const requestedLocationId = url.searchParams.get("locationId");
  if (allBranches && requestedLocationId) {
    return NextResponse.json({ error: "conflicting_location_scope" }, { status: 400 });
  }
  const [location, branchScope] = await Promise.all([
    resolveActiveLocation(session),
    accessibleLocationsFor(session),
  ]);
  const allowedLocationIds = branchScope.locations.map(({ id }) => id);
  if (requestedLocationId && !allowedLocationIds.includes(requestedLocationId)) {
    return NextResponse.json({ error: "location_not_found" }, { status: 404 });
  }
  if (!allBranches && !requestedLocationId && !location) {
    return NextResponse.json({ error: "no_location" }, { status: 409 });
  }
  if (!allBranches && !requestedLocationId && !allowedLocationIds.includes(location!.id)) {
    return NextResponse.json({ error: "location_not_found" }, { status: 404 });
  }

  const parsedNumbers: Record<string, number | null> = {};
  for (const key of [
    "modelYearFrom", "modelYearTo", "minPriceRial", "maxPriceRial",
    "minMileageKm", "maxMileageKm", "minAgeDays", "maxAgeDays", "limit", "offset",
  ]) {
    const raw = url.searchParams.get(key);
    if (raw == null) {
      parsedNumbers[key] = null;
      continue;
    }
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return NextResponse.json({ error: "invalid_filter", field: key }, { status: 400 });
    }
    parsedNumbers[key] = Number(raw);
  }
  if (parsedNumbers.limit != null && (parsedNumbers.limit < 1 || parsedNumbers.limit > 500)) {
    return NextResponse.json({ error: "invalid_filter", field: "limit" }, { status: 400 });
  }
  if (parsedNumbers.modelYearFrom != null && parsedNumbers.modelYearTo != null && parsedNumbers.modelYearFrom > parsedNumbers.modelYearTo) {
    return NextResponse.json({ error: "invalid_filter", field: "modelYear" }, { status: 400 });
  }
  if (parsedNumbers.minPriceRial != null && parsedNumbers.maxPriceRial != null && parsedNumbers.minPriceRial > parsedNumbers.maxPriceRial) {
    return NextResponse.json({ error: "invalid_filter", field: "price" }, { status: 400 });
  }
  if (parsedNumbers.minMileageKm != null && parsedNumbers.maxMileageKm != null && parsedNumbers.minMileageKm > parsedNumbers.maxMileageKm) {
    return NextResponse.json({ error: "invalid_filter", field: "mileage" }, { status: 400 });
  }
  if (parsedNumbers.minAgeDays != null && parsedNumbers.maxAgeDays != null && parsedNumbers.minAgeDays > parsedNumbers.maxAgeDays) {
    return NextResponse.json({ error: "invalid_filter", field: "age" }, { status: 400 });
  }

  const rawCondition = url.searchParams.get("condition");
  if (rawCondition !== null && !VEHICLE_CONDITIONS.includes(rawCondition as (typeof VEHICLE_CONDITIONS)[number])) {
    return NextResponse.json({ error: "invalid_filter", field: "condition" }, { status: 400 });
  }
  const rawStates = url.searchParams.get("states");
  let states: VehicleState[] | undefined;
  if (rawStates !== null) {
    const requestedStates = rawStates.split(",").map((state) => state.trim()).filter(Boolean);
    if (requestedStates.length === 0 || requestedStates.some((state) => !VEHICLE_STATES.includes(state as VehicleState))) {
      return NextResponse.json({ error: "invalid_filter", field: "states" }, { status: 400 });
    }
    states = [...new Set(requestedStates as VehicleState[])];
  }
  const make = url.searchParams.get("make")?.trim() || null;
  const model = url.searchParams.get("model")?.trim() || null;
  if (make && make.length > 120 || model && model.length > 120) {
    return NextResponse.json({ error: "invalid_filter", field: "make_model" }, { status: 400 });
  }

  try {
    const locationIds = allBranches ? allowedLocationIds : undefined;
    const selectedLocationId = allBranches ? null : requestedLocationId ?? location!.id;
    const result = await listVehicles({
      businessId: session.businessId,
      // Every scope is derived from the authenticated member. A requested
      // branch is checked against that live set before it reaches the query.
      locationId: locationIds ? undefined : selectedLocationId,
      locationIds,
      condition: rawCondition as VehicleListFilters["condition"],
      states,
      make,
      model,
      modelYearFrom: parsedNumbers.modelYearFrom,
      modelYearTo: parsedNumbers.modelYearTo,
      minPriceRial: parsedNumbers.minPriceRial,
      maxPriceRial: parsedNumbers.maxPriceRial,
      minMileageKm: parsedNumbers.minMileageKm,
      maxMileageKm: parsedNumbers.maxMileageKm,
      minAgeDays: parsedNumbers.minAgeDays,
      maxAgeDays: parsedNumbers.maxAgeDays,
      search: url.searchParams.get("q")?.slice(0, 160) ?? null,
      limit: parsedNumbers.limit ?? undefined,
      offset: parsedNumbers.offset ?? undefined,
    });

    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    return NextResponse.json({
      total: result.total,
      canSeeCost,
      locations: branchScope.locations.map(({ id, name }) => ({ id, name })),
      activeLocationId: location?.id ?? null,
      selectedLocationId,
      allBranches,
      vehicles: result.vehicles.map((vehicle) =>
        canSeeCost ? vehicle : redactVehicleCostSensitive(vehicle),
      ),
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

  // §6: the asking price travels with the acquisition, but the *floor* is the
  // owner's number — naming one while registering a car is a price decision,
  // not an inventory one.
  if (body.minimumPriceRial != null && body.minimumPriceRial !== "") {
    if (!(await holdsPermission(session, PERMISSIONS.vehiclesOverrideMinPrice))) {
      return NextResponse.json(
        { error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesOverrideMinPrice },
        { status: 403 },
      );
    }
  }
  if (
    (body.wholesalePriceRial != null && body.wholesalePriceRial !== "") ||
    (body.promotionalPriceRial != null && body.promotionalPriceRial !== "")
  ) {
    if (!(await holdsPermission(session, PERMISSIONS.vehiclesPriceEdit))) {
      return NextResponse.json(
        { error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesPriceEdit },
        { status: 403 },
      );
    }
  }

  // Registering an acquisition writes purchase cost and ledger settlement; it
  // is the distinct high-risk cost-edit act, not an incidental part of vehicle
  // creation. A draft vehicle without acquisition remains available to creators.
  if (acquisition && !(await holdsPermission(session, PERMISSIONS.vehiclesCostEdit))) {
    return NextResponse.json(
      { error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesCostEdit },
      { status: 403 },
    );
  }

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
    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    return NextResponse.json({
      ok: true,
      vehicle: canSeeCost ? created : redactVehicleCostSensitive(created),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
