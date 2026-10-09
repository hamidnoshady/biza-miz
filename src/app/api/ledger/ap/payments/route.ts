import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ApError, MissingLedgerAccountError, payBill } from "@/lib/ap-service";
import { listPayments } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/iso-date";
import { PayablesInputError } from "@/lib/payables-input";

/** The «پرداخت‌ها» ledger slice — every payment voucher, newest first. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const q = request.nextUrl.searchParams.get("q") ?? undefined;
  const payments = await listPayments(session.businessId, q);
  return NextResponse.json({ payments });
});

interface PaymentBody {
  supplierId?: string;
  method?: string;
  amount?: number;
  paymentDate?: string;
  memo?: string;
  clientRequestId?: string;
  cashAccountId?: string | null;
  bankReference?: string | null;
}

const METHODS = ["cash", "bank"] as const;

/** Records the business paying down a supplier's AP balance. Same access as posting a manual journal entry. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financePayablesManage);
  if (error) return error;

  let body: PaymentBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const supplierId = body.supplierId?.trim();
  if (!supplierId) return NextResponse.json({ error: "supplier_required" }, { status: 400 });
  const clientRequestId = body.clientRequestId?.trim();
  if (!clientRequestId || clientRequestId.length > 200) {
    return NextResponse.json({ error: "idempotency_key_required" }, { status: 400 });
  }
  if (!METHODS.includes(body.method as (typeof METHODS)[number])) {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }
  // Same guard as the receipts route: an unparseable or impossible date must
  // be a 400 here, not Postgres's datetime error surfacing as a 500.
  const paymentDate = body.paymentDate?.trim() || null;
  if (paymentDate && !isValidIsoDate(paymentDate)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const payment = await payBill({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      supplierId,
      method: body.method as "cash" | "bank",
      amount,
      paymentDate,
      memo: body.memo,
      clientRequestId,
      createdBy: session.sub,
      cashAccountId: typeof body.cashAccountId === "string" ? body.cashAccountId : null,
      bankReference: typeof body.bankReference === "string" ? body.bankReference : null,
    });
    return NextResponse.json({ payment }, { status: payment.duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof ApError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof PayablesInputError) return NextResponse.json({ error: err.code }, { status: 400 });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
