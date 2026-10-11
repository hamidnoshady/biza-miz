import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { accessibleLocationsFor, resolveActiveLocation } from "@/lib/setup-state";
import { businessToday, summarizeVehicles } from "@/lib/automotive-service";
import { redactVehicleCostSensitive } from "@/lib/automotive";
import { getPool } from "@/lib/db";
import { handleAutomotiveError, holdsPermission } from "../guard";

/**
 * §16's dashboard, and nothing else: the automotive KPIs only — no café
 * operations, no menu, no tables. The arithmetic is `summarizeVehicleStock`
 * (pure, in `automotive.ts`), so this screen and the reports cannot disagree.
 *
 * The margin figures are cost-derived, so they follow `vehicles.cost_view`:
 * a cashier sees the lot's size and sellable state, never its money.
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
  const selectedLocation = requestedLocationId
    ? branchScope.locations.find(({ id }) => id === requestedLocationId) ?? null
    : location;
  if (!allBranches && !selectedLocation) {
    return NextResponse.json({ error: "no_location" }, { status: 409 });
  }
  const dateLocation = allBranches ? location ?? branchScope.locations[0] ?? null : selectedLocation;
  const client = await getPool().connect();
  try {
    const onDate = dateLocation
      ? await businessToday(client, dateLocation.id)
      : new Date().toISOString().slice(0, 10);
    const summary = await summarizeVehicles(session.businessId, {
      locationId: allBranches ? undefined : selectedLocation?.id,
      locationIds: allBranches ? allowedLocationIds : undefined,
      onDate,
    });

    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    if (canSeeCost) return NextResponse.json({ ok: true, onDate, summary });
    // Counts and age remain useful to the lot; all valuation/profit fields
    // share the domain's tested cost-redaction policy.
    return NextResponse.json({
      ok: true,
      onDate,
      canSeeCost,
      summary: redactVehicleCostSensitive({ ...summary }),
    });
  } catch (err) {
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
