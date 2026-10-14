import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { FixedAssetError, transferFixedAsset } from "@/lib/fixed-assets-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Moves an asset to another branch (issue #833): the transfer is recorded —
 * from, to, effective date, reason, actor — and the asset's location is
 * updated in the same transaction, so depreciation after the transfer posts
 * to the new branch (the journal's location is always the asset's own).
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "fixed_asset_not_found" }, { status: 404 });
  let body: { toLocationId?: string; effectiveDate?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.toLocationId !== "string" || !body.toLocationId) {
    return NextResponse.json({ error: "location_required" }, { status: 400 });
  }

  try {
    const result = await transferFixedAsset({
      businessId: session.businessId,
      fixedAssetId: id,
      toLocationId: body.toLocationId,
      effectiveDate: typeof body.effectiveDate === "string" ? body.effectiveDate : null,
      reason: String(body.reason ?? ""),
      createdBy: session.sub,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
