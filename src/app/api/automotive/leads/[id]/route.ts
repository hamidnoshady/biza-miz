import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import {
  getLeadVehicleProfile,
  saveLeadVehiclePreferences,
  VehicleLeadError,
  type LeadCondition,
} from "@/lib/automotive-lead-service";
import { accessibleLocationsFor } from "@/lib/setup-state";
import { handleAutomotiveError, readBody } from "../../guard";

/**
 * §12 — one lead's car-shaped half: what they are looking for, and the cars
 * they have been shown.
 *
 * Automotive reads require `vehicles.view` and the trade check. The preference
 * write needs `crm.manage`, because it edits CRM-owned lead data. This keeps the
 * automotive read boundary consistent with the vehicle workspace while leaving
 * writes under the canonical CRM permission.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;

  try {
    const branchScope = await accessibleLocationsFor(session);
    const profile = await getLeadVehicleProfile(
      session.businessId,
      id,
      undefined,
      branchScope.locations.map(({ id: locationId }) => locationId),
    );
    if (!profile) return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
    return NextResponse.json({ profile });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

export const PUT = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readBody(request);

  const number = (key: string): number | null => {
    const value = body[key];
    if (value === "" || value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const text = (key: string): string | null => {
    const value = body[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const preferences = await saveLeadVehiclePreferences(client, {
      businessId: session.businessId,
      leadId: id,
      make: text("make"),
      model: text("model"),
      trim: text("trim"),
      condition: (body.condition as LeadCondition) ?? "any",
      vehicleYearCalendar: body.vehicleYearCalendar === "gregorian" ? "gregorian" : "jalali",
      modelYearFrom: number("modelYearFrom"),
      modelYearTo: number("modelYearTo"),
      budgetFromRial: number("budgetFromRial"),
      budgetToRial: number("budgetToRial"),
      tradeIn: body.tradeIn === true,
      tradeInDescription: text("tradeInDescription"),
      // Present-and-null clears it; absent leaves what was recorded alone.
      ...(Object.prototype.hasOwnProperty.call(body, "testDriveRequestedAt")
        ? { testDriveRequestedAt: text("testDriveRequestedAt") }
        : {}),
      notes: text("notes"),
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, preferences });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof VehicleLeadError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
