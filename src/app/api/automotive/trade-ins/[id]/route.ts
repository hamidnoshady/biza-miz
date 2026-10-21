import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { accessibleLocationsFor } from "@/lib/setup-state";
import { redactVehicleCostSensitive } from "@/lib/automotive";
import { getTradeIn } from "@/lib/automotive-trade-in-service";
import { handleAutomotiveError, holdsPermission } from "../../guard";

/** Issue #963 — one recorded trade-in deal, allowance cost-gated like any vehicle cost. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;

  try {
    const tradeIn = await getTradeIn(session.businessId, id);
    if (!tradeIn) return NextResponse.json({ error: "trade_in_not_found" }, { status: 404 });
    // A deal belongs to its branch: a member with no access to that branch
    // gets the same answer as for a deal that does not exist.
    const branchScope = await accessibleLocationsFor(session);
    if (!branchScope.locations.some(({ id: locationId }) => locationId === tradeIn.locationId)) {
      return NextResponse.json({ error: "trade_in_not_found" }, { status: 404 });
    }
    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    return NextResponse.json({
      ok: true,
      canSeeCost,
      tradeIn: canSeeCost ? tradeIn : redactVehicleCostSensitive(tradeIn),
    });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});
