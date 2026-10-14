import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { relistReturnedVehicle } from "@/lib/automotive-service";
import { handleAutomotiveError, readBody, vehicleBranchContext } from "../../../guard";

/** Returned vehicles re-enter the sellable shelf only through an audited inspection decision. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesEdit);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;

  const { id } = await context.params;
  const { access, response: branchError } = await vehicleBranchContext(session, id, { mutation: true });
  if (branchError) return branchError;
  const locationId = access.activeLocationId!;
  const body = await readBody(request);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return NextResponse.json({ error: "reason_required" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await relistReturnedVehicle(client, {
      businessId: session.businessId,
      serialId: id,
      locationId,
      reason,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
