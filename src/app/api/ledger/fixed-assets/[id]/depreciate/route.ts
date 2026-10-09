import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { FixedAssetError, postDepreciation } from "@/lib/fixed-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { MissingLedgerAccountError } from "@/lib/ledger-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Posts one Jalali month's straight-line depreciation for this asset
 * (`periodKey` = `YYYY-MM`).
 *
 * The journal entry's branch is the asset's own location — never the
 * operator's currently active one (issue #833): an asset registered at Branch
 * A keeps posting to Branch A until a recorded transfer moves it, so this
 * route deliberately never resolves the caller's active location.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "fixed_asset_not_found" }, { status: 404 });
  let body: { periodKey?: string; periodLabel?: string; entryDate?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await postDepreciation({
      businessId: session.businessId,
      fixedAssetId: id,
      periodKey: typeof body.periodKey === "string" ? body.periodKey : null,
      periodLabel: typeof body.periodLabel === "string" ? body.periodLabel : null,
      entryDate: body.entryDate,
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
