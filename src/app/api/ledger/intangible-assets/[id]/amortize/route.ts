import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  IntangibleAssetError,
  postIntangibleAmortization,
  reverseIntangibleAmortization,
} from "@/lib/intangible-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { MissingLedgerAccountError } from "@/lib/ledger-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Posts one Jalali month's amortization for a finite-life intangible
 * (`periodKey` = `YYYY-MM`), or reverses a posted month
 * (`{ action: "reverse", amortizationEntryId, reason }`).
 *
 * An indefinite-life asset is refused here — it is reviewed through the
 * impairment route instead (issue #1326 §2). The entry goes to the asset's own
 * branch, never the operator's active one.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "intangible_asset_not_found" }, { status: 404 });

  let body: {
    action?: "post" | "reverse";
    periodKey?: string;
    periodLabel?: string;
    entryDate?: string;
    amortizationEntryId?: string;
    reversalDate?: string;
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (body.action === "reverse") {
      const result = await reverseIntangibleAmortization({
        businessId: session.businessId,
        intangibleAssetId: id,
        amortizationEntryId: String(body.amortizationEntryId ?? ""),
        reversalDate: typeof body.reversalDate === "string" ? body.reversalDate : null,
        reason: String(body.reason ?? ""),
        createdBy: session.sub,
      });
      return NextResponse.json(result);
    }
    const result = await postIntangibleAmortization({
      businessId: session.businessId,
      intangibleAssetId: id,
      periodKey: typeof body.periodKey === "string" ? body.periodKey : null,
      periodLabel: typeof body.periodLabel === "string" ? body.periodLabel : null,
      entryDate: typeof body.entryDate === "string" ? body.entryDate : null,
      createdBy: session.sub,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof IntangibleAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing" }, { status: 400 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
