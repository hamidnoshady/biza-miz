import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { IntangibleAssetError, getIntangibleAsset } from "@/lib/intangible-assets-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One intangible with its posted amortization history, impairment assessments
 * and the full projected schedule (posted months from history, future months
 * as pure projection — issue #1326 §4).
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "intangible_asset_not_found" }, { status: 404 });
  try {
    const data = await getIntangibleAsset(session.businessId, id);
    if (!data) return NextResponse.json({ error: "intangible_asset_not_found" }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof IntangibleAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
