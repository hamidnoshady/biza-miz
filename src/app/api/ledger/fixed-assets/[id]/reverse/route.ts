import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { FixedAssetError, reverseDepreciation } from "@/lib/fixed-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses one posted depreciation entry for this asset (issue #833): the
 * exact mirror of the original entry's effect, with a mandatory reason. When
 * the original period is locked, the caller must send `reversalDate` in an
 * open period — the fiscal lock is the authority on which dates are
 * permitted, exactly as for any other posting.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { depreciationEntryId?: string; reversalDate?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.depreciationEntryId !== "string" || !body.depreciationEntryId) {
    return NextResponse.json({ error: "depreciation_entry_required" }, { status: 400 });
  }

  try {
    const result = await reverseDepreciation({
      businessId: session.businessId,
      fixedAssetId: id,
      depreciationEntryId: body.depreciationEntryId,
      reversalDate: typeof body.reversalDate === "string" ? body.reversalDate : null,
      reason: String(body.reason ?? ""),
      createdBy: session.sub,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
