import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { FixedAssetError, getFixedAssetDepreciationSchedule } from "@/lib/fixed-assets-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The asset-level projected depreciation schedule (issue #1325): one row per
 * Jalali month, posted months carrying the live posting's amount and future
 * months the approved method's projection. Forecast rows are arithmetic only —
 * this endpoint writes nothing and the ledger never reads it.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "fixed_asset_not_found" }, { status: 404 });

  try {
    const schedule = await getFixedAssetDepreciationSchedule(session.businessId, id, {
      throughPeriodKey: request.nextUrl.searchParams.get("through"),
    });
    return NextResponse.json(schedule);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
