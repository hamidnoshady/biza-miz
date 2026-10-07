import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  expireVehicleReservations,
  listVehicleReservations,
  reserveVehicle,
} from "@/lib/automotive-reservation-service";
import type { VehicleHoldStatus } from "@/lib/automotive";
import { handleAutomotiveError, readBody } from "../guard";

/** §7 — the branch's holds, live ones first. Expiries are healed on read. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;

  const url = new URL(request.url);
  const location = await resolveActiveLocation(session);
  try {
    if (location) {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await expireVehicleReservations(client, { businessId: session.businessId, locationId: location.id });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    const reservations = await listVehicleReservations(session.businessId, {
      locationId: location?.id ?? null,
      serialId: url.searchParams.get("serialId"),
      status: (url.searchParams.get("status") as VehicleHoldStatus | null) ?? null,
    });
    return NextResponse.json({ reservations });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

/**
 * §7 — reserves one exact car for one exact customer. A deposit, where taken,
 * posts against the shared customer-advance liability in the same transaction:
 * the hold and the money it took cannot half-exist.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesReserve);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const body = await readBody(request);

  const serialId = typeof body.serialId === "string" ? body.serialId : "";
  const customerId = typeof body.customerId === "string" ? body.customerId : "";
  if (!serialId || !customerId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reserveVehicle(client, {
      businessId: session.businessId,
      locationId: location.id,
      serialId,
      customerId,
      expiresAt: typeof body.expiresAt === "string" && body.expiresAt ? body.expiresAt : null,
      expiresAtTime: typeof body.expiresAtTime === "string" && body.expiresAtTime ? body.expiresAtTime : null,
      depositRial: Number(body.depositRial ?? 0),
      depositMethod: (body.depositMethod as never) ?? null,
      depositRefundable: body.depositRefundable !== false,
      depositNote: typeof body.depositNote === "string" ? body.depositNote : null,
      note: typeof body.note === "string" ? body.note : null,
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
