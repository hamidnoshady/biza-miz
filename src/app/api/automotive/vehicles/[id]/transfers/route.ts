import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { listVehicleTransfers, startVehicleTransfer } from "@/lib/automotive-service";
import { handleAutomotiveError, readBody } from "../../../guard";

/** §11 — one car's transfer history, newest first. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;

  try {
    return NextResponse.json({ transfers: await listVehicleTransfers(session.businessId, { serialId: id }) });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

/**
 * Sends a car to another branch. The *source* branch is the car's own current
 * location — never a client-supplied one — so a caller cannot start a transfer
 * from a branch the car is not in, whatever the request says.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesTransfer);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readBody(request);

  const toLocationId = typeof body.toLocationId === "string" ? body.toLocationId : "";
  if (!toLocationId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ location_id: string }>(
      `SELECT location_id FROM automotive_vehicle_attributes
        WHERE business_id = $1 AND serial_id = $2`,
      [session.businessId, id],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "vehicle_not_found" }, { status: 404 });
    }
    const { transferId } = await startVehicleTransfer(client, {
      businessId: session.businessId,
      fromLocationId: rows[0].location_id,
      toLocationId,
      serialId: id,
      note: typeof body.note === "string" ? body.note : null,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, transferId });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
