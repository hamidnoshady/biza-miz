import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { FixedAssetError, changeFixedAssetEstimate } from "@/lib/fixed-assets-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Changes an asset's useful life or salvage value *prospectively* (issue
 * #833): posted periods are never rewritten; the change and the remaining
 * schedule it implies are recorded together, with a mandatory reason, and
 * every later period spreads what was left over the life that was left.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { usefulLifeMonths?: number; salvageValue?: number; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await changeFixedAssetEstimate({
      businessId: session.businessId,
      fixedAssetId: id,
      usefulLifeMonths: body.usefulLifeMonths === undefined || body.usefulLifeMonths === null ? null : Number(body.usefulLifeMonths),
      salvageValue: body.salvageValue === undefined || body.salvageValue === null ? null : Number(body.salvageValue),
      reason: String(body.reason ?? ""),
      createdBy: session.sub,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
