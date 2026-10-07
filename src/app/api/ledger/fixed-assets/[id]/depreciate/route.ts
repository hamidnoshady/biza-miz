import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { FixedAssetError, postDepreciation } from "@/lib/fixed-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { MissingLedgerAccountError } from "@/lib/ledger-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Posts one Jalali month's straight-line depreciation for this asset (`periodKey` = `YYYY-MM`). */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { periodKey?: string; periodLabel?: string; entryDate?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const result = await postDepreciation({
      businessId: session.businessId,
      locationId: location?.id ?? null,
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
