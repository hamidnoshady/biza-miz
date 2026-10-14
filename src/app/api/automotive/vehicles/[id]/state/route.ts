import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { archiveVehicle } from "@/lib/automotive-service";
import { handleAutomotiveError, readBody, vehicleBranchContext } from "../../../guard";

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
  const { access, response: branchError } = await vehicleBranchContext(session, id, { mutation: true });
  if (branchError) return branchError;
  const locationId = access.activeLocationId!;
  const body = await readBody(request);

  if (body.action !== "archive") {
    if (typeof body.state !== "string") return NextResponse.json({ error: "invalid_state" }, { status: 400 });
    return NextResponse.json(
      {
        error: "state_command_required",
        message: "تغییر وضعیت خودرو فقط از فرمان عملیاتی متناظر امکان‌پذیر است.",
      },
      { status: 409 },
    );
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const archive = await requirePermission(PERMISSIONS.vehiclesArchive);
    if (archive.error) {
      await client.query("ROLLBACK");
      return archive.error;
    }
    await archiveVehicle(client, {
      businessId: session.businessId,
      serialId: id,
      locationId,
      reason: typeof body.reason === "string" ? body.reason : null,
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
