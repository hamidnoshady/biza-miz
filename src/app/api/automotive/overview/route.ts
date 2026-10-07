import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { businessToday, summarizeVehicles } from "@/lib/automotive-service";
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
  const location = await resolveActiveLocation(session);
  const client = await getPool().connect();
  try {
    const onDate = location ? await businessToday(client, location.id) : new Date().toISOString().slice(0, 10);
    const summary = await summarizeVehicles(session.businessId, {
      locationId: url.searchParams.get("allBranches") === "1" ? null : (location?.id ?? null),
      onDate,
    });

    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    if (canSeeCost) return NextResponse.json({ ok: true, onDate, summary });
    const { stockValueRial, askingValueRial, potentialMarginRial, ...visible } = summary;
    return NextResponse.json({ ok: true, onDate, canSeeCost, summary: visible });
  } catch (err) {
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
