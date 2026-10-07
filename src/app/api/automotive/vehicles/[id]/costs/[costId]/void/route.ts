import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { voidVehicleCost } from "@/lib/automotive-service";
import { handleAutomotiveError, readBody } from "../../../../../guard";

/**
 * §5 — a cost is voided, never edited. The row stays with its reason and the
 * ledger entry it posted is reversed, so the car's history shows both the
 * mistake and the correction.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; costId: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.vehiclesExpenseRecord);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "automotive");
    if (industryError) return industryError;
    const { costId } = await context.params;
    const body = await readBody(request);

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await voidVehicleCost(client, {
        businessId: session.businessId,
        costId,
        reason: typeof body.reason === "string" ? body.reason : "",
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
  },
);
