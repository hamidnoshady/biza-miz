import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getPool } from "@/lib/db";
import {
  releaseSerialReservation,
  SerialReservationError,
} from "@/lib/watch-reservation-service";

/**
 * Releases a hold (issue #795 item 20): the promise is withdrawn with the
 * reason recorded, and the unit — if still reserved — returns to the
 * sellable pool. Breaking a promise made to a customer takes orders.void,
 * the same manager gate the other unwind actions use.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const { session, error } = await requirePermission(PERMISSIONS.ordersVoid);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    let body: { reason?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body.reason?.trim()) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await releaseSerialReservation(client, {
        businessId: session.businessId,
        reservationId: id,
        reason: body.reason,
        actorId: session.sub,
      });
      await client.query("COMMIT");
      return NextResponse.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof SerialReservationError) {
        return NextResponse.json(
          { error: "release_failed", message: err.message },
          { status: err.status },
        );
      }
      throw err;
    } finally {
      client.release();
    }
  },
);
