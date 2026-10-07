import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { InstallmentError, MissingLedgerAccountError, payInstallmentItem } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isSettlementMethod, SETTLEMENT_METHODS } from "@/lib/voucher-shared";

/** Settles one slice of a plan — posts the subledger pair atomically. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeInstallmentsManage);
  if (error) return error;
  const { id: planId } = await context.params;

  let body: { itemId?: string; method?: string; memo?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.itemId) return NextResponse.json({ error: "item_required" }, { status: 400 });
  if (!isSettlementMethod(body.method)) {
    return NextResponse.json({ error: "invalid_method", allowed: [...SETTLEMENT_METHODS] }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    await payInstallmentItem({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      planId,
      itemId: body.itemId,
      method: body.method,
      memo: body.memo,
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InstallmentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
