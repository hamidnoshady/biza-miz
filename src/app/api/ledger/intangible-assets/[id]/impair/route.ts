import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  assessIntangibleImpairment,
  IntangibleAssetError,
  reverseIntangibleImpairment,
} from "@/lib/intangible-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { MissingLedgerAccountError } from "@/lib/ledger-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Records an impairment assessment (write-down to the recoverable amount) or
 * reverses one (`{ action: "reverse", impairmentId, amount?, reason }`).
 *
 * This is the review path for an indefinite-life intangible: it is never
 * amortized, and this route is how its carrying amount is adjusted, with the
 * reason and evidence stored beside the journaled effect (issue #1326 §2–3).
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "intangible_asset_not_found" }, { status: 404 });

  let body: {
    action?: "post" | "reverse";
    assessmentDate?: string;
    effectiveDate?: string;
    recoverableAmount?: number;
    reason?: string;
    evidenceReference?: string;
    impairmentId?: string;
    amount?: number | null;
    reversalDate?: string;
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
      const result = await reverseIntangibleImpairment({
        businessId: session.businessId,
        intangibleAssetId: id,
        impairmentId: String(body.impairmentId ?? ""),
        amount: body.amount === undefined || body.amount === null ? null : Number(body.amount),
        reversalDate: typeof body.reversalDate === "string" ? body.reversalDate : null,
        reason: String(body.reason ?? ""),
        createdBy: session.sub,
      });
      return NextResponse.json(result);
    }
    const result = await assessIntangibleImpairment({
      businessId: session.businessId,
      intangibleAssetId: id,
      assessmentDate: typeof body.assessmentDate === "string" ? body.assessmentDate : null,
      effectiveDate: String(body.effectiveDate ?? ""),
      recoverableAmount: Number(body.recoverableAmount),
      reason: String(body.reason ?? ""),
      evidenceReference: typeof body.evidenceReference === "string" ? body.evidenceReference : null,
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
