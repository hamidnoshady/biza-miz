import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getPool } from "@/lib/db";
import {
  listSerialReservations,
  reserveSerialUnit,
  SerialReservationError,
} from "@/lib/watch-reservation-service";

/**
 * Issue #795 item 20 — reservations (holds) on serialized units: an exact
 * unit promised to an exact customer, with an optional lapse date. The
 * hold converts automatically when that customer's invoice sells the unit.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ reservations: [] });

  const reservations = await listSerialReservations(session.businessId, location.id);
  return NextResponse.json({ reservations });
});

/** Places a hold: in_stock → reserved, one live hold per unit. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { serialId?: string; customerId?: string; expiresAt?: string | null; note?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.serialId || !body.customerId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reserveSerialUnit(client, {
      businessId: session.businessId,
      locationId: location.id,
      serialId: body.serialId,
      customerId: body.customerId,
      expiresAt: body.expiresAt ?? null,
      note: body.note ?? null,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: result.id });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof SerialReservationError) {
      return NextResponse.json(
        { error: "reservation_failed", message: err.message },
        { status: err.status },
      );
    }
    throw err;
  } finally {
    client.release();
  }
});
