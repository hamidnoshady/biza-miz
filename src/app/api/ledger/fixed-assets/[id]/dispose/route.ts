import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { FixedAssetError, disposeFixedAsset, type FixedAssetDisposalKind } from "@/lib/fixed-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { MissingLedgerAccountError } from "@/lib/ledger-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Disposes of an asset — `sale` (with proceeds and a settlement account),
 * `retirement` or `write_off` (both zero-proceeds). Posts the entry that
 * removes cost and live accumulated depreciation from the Balance Sheet and
 * realises the gain or loss; from here on the asset can never depreciate
 * again (issue #833).
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { kind?: string; disposalDate?: string; proceeds?: number; proceedsAccountId?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await disposeFixedAsset({
      businessId: session.businessId,
      fixedAssetId: id,
      kind: body.kind as FixedAssetDisposalKind,
      disposalDate: typeof body.disposalDate === "string" ? body.disposalDate : null,
      proceeds: body.proceeds === undefined || body.proceeds === null ? null : Number(body.proceeds),
      proceedsAccountId: typeof body.proceedsAccountId === "string" && body.proceedsAccountId ? body.proceedsAccountId : null,
      reason: typeof body.reason === "string" ? body.reason : null,
      createdBy: session.sub,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) return NextResponse.json({ error: "ledger_account_missing" }, { status: 400 });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
