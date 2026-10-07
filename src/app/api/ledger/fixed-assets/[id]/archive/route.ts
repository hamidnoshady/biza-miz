import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { FixedAssetError, archiveFixedAsset } from "@/lib/fixed-assets-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Archives (cancels) an asset instead of deleting it (issue #833): the row,
 * its history and every journal link stay; it leaves the working register and
 * can no longer depreciate, transfer or change estimate. Deletion remains
 * only for an asset with no accounting history at all.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await archiveFixedAsset({
      businessId: session.businessId,
      fixedAssetId: id,
      reason: String(body.reason ?? ""),
      createdBy: session.sub,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
