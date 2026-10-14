import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { branchAccessForSession, canAccessLocation, canActInLocation } from "@/lib/automotive-access";
import { cancelVehicleTransfer, completeVehicleTransfer } from "@/lib/automotive-service";
import { handleAutomotiveError, readBody } from "../../guard";

/**
 * §11 — the receiving branch accepts the car, or the sending branch takes it
 * back. Both acts are `vehicles.transfer`: moving a car between branches is one
 * authority, and which end of the move you are at is not a second one.
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesTransfer);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const parsed = await readBody(request);
  const action = parsed.action;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (action !== "cancel" && action !== "complete") {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }
    const { rows: transferRows } = await client.query<{
      from_location_id: string;
      to_location_id: string;
    }>(
      `SELECT from_location_id, to_location_id FROM automotive_vehicle_transfers
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [id, session.businessId],
    );
    const transfer = transferRows[0];
    if (!transfer) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "transfer_not_found" }, { status: 404 });
    }
    const branchAccess = await branchAccessForSession(session);
    const actionLocationId = action === "cancel" ? transfer.from_location_id : transfer.to_location_id;
    if (!canAccessLocation(branchAccess, actionLocationId)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "transfer_not_found" }, { status: 404 });
    }
    if (!canActInLocation(branchAccess, actionLocationId)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "wrong_location" }, { status: 409 });
    }
    if (action === "cancel") {
      await cancelVehicleTransfer(client, {
        businessId: session.businessId,
        transferId: id,
        locationId: actionLocationId,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        actorId: session.sub,
      });
    } else {
      await completeVehicleTransfer(client, {
        businessId: session.businessId,
        transferId: id,
        locationId: actionLocationId,
        actorId: session.sub,
      });
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
