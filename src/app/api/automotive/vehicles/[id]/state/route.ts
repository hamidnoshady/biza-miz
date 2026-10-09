import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { archiveVehicle, setVehicleState } from "@/lib/automotive-service";
import type { VehicleState } from "@/lib/automotive";
import { handleAutomotiveError, readBody } from "../../../guard";

/**
 * §3 — the lifecycle's one door. Archiving is its own permission
 * (`vehicles.archive`, a high-risk act); the other transitions ride on the
 * permission of the act that causes them (`vehicles.reserve` for `reserved`,
 * the sale path for `sold`), so only the states with no owning act are settable
 * here through `vehicles.edit`.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesEdit);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readBody(request);

  const state = typeof body.state === "string" ? (body.state as VehicleState) : null;
  if (!state && body.action !== "archive") {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (body.action === "archive") {
      const archive = await requirePermission(PERMISSIONS.vehiclesArchive);
      if (archive.error) {
        await client.query("ROLLBACK");
        return archive.error;
      }
      await archiveVehicle(client, {
        businessId: session.businessId,
        serialId: id,
        reason: typeof body.reason === "string" ? body.reason : null,
        actorId: session.sub,
      });
      await client.query("COMMIT");
      return NextResponse.json({ ok: true });
    }

    const vehicle = await setVehicleState(client, {
      businessId: session.businessId,
      serialId: id,
      state: state!,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, vehicle });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
