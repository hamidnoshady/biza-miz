import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getVehicleReservation, releaseVehicleReservation } from "@/lib/automotive-reservation-service";
import { handleAutomotiveError, readBody } from "../../guard";

/** One hold, with its deposit and its own ledger entries. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;

  try {
    const reservation = await getVehicleReservation(session.businessId, id);
    if (!reservation) return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
    return NextResponse.json({ reservation });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

/**
 * §7 — releasing a hold. `refund` is the operator's explicit decision and
 * defaults to the hold's own refundability: a non-refundable deposit stays on
 * the customer's advance account, a refundable one leaves with a reversing
 * entry. The release reason is required, because "why did we let this car go"
 * is the question the owner asks.
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesReservationCancel);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readBody(request);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await releaseVehicleReservation(client, {
      businessId: session.businessId,
      reservationId: id,
      reason: typeof body.reason === "string" ? body.reason : "",
      refund: typeof body.refund === "boolean" ? body.refund : undefined,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
