import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { resolveAutomotiveOfflineCapability } from "@/lib/automotive-offline";
import { redactVehicleCostSensitive } from "@/lib/automotive";
import { reverseTradeIn } from "@/lib/automotive-trade-in-service";
import { handleAutomotiveError, holdsPermission, readBody } from "../../../guard";

/**
 * Issue #963 — unwind a whole trade-in deal: A's sale mirrors through the
 * ordinary vehicle-sale reversal, B's acquisition mirrors and B is
 * archived for return to the customer. The service refuses, legibly, when
 * B has been sold, is in transit, is reserved, or carries reconditioning
 * costs. Needs the trade-in key plus `vehicles.sell` (the key that let A
 * leave), a reason, the deal's own branch, and cloud authority.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesTradeIn);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  if (!(await holdsPermission(session, PERMISSIONS.vehiclesSell))) {
    return NextResponse.json(
      { error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesSell },
      { status: 403 },
    );
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const profile = await readDeploymentProfile(session.businessId);
  const capability = resolveAutomotiveOfflineCapability({
    profile: profile.profile,
    runtimeRole: deploymentRole(),
  });
  if (capability.mode === "read_only_mirror") {
    return NextResponse.json(
      {
        error: "trade_in_cloud_only",
        message: "برگشت معاوضه فقط روی سرور مرکزی انجام می‌شود.",
      },
      { status: 409 },
    );
  }

  const { id } = await context.params;
  const body = await readBody(request);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json({ error: "reason_required", message: "دلیل برگشت معاوضه الزامی است." }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reverseTradeIn(client, {
      businessId: session.businessId,
      locationId: location.id,
      tradeInId: id,
      reason,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    return NextResponse.json({
      ok: true,
      canSeeCost,
      tradeIn: canSeeCost ? result.tradeIn : redactVehicleCostSensitive(result.tradeIn),
      reversalEntryIds: result.reversalEntryIds,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
