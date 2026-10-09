import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ArError, MissingLedgerAccountError, receivePayment } from "@/lib/ar-service";
import { listReceipts } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/iso-date";
import { PayablesInputError } from "@/lib/payables-input";

/** The «دریافت‌ها» ledger slice — every receipt voucher, newest first. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const q = request.nextUrl.searchParams.get("q") ?? undefined;
  const receipts = await listReceipts(session.businessId, q);
  return NextResponse.json({ receipts });
});

interface ReceiptBody {
  customerId?: string;
  method?: string;
  amount?: number;
  receiptDate?: string;
  memo?: string;
  /** Audit F11 — the cash/bank account (an active cash or bank account of the chosen method); omitted = the method's default. */
  cashAccountId?: string | null;
  /** Audit F11 — the bank's tracking/reference number. */
  bankReference?: string | null;
}

const METHODS = ["cash", "bank"] as const;

/** Records a customer paying down their AR balance. Same access as posting a manual journal entry. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReceivablesManage);
  if (error) return error;

  let body: ReceiptBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const customerId = body.customerId?.trim();
  if (!customerId) return NextResponse.json({ error: "customer_required" }, { status: 400 });
  if (!METHODS.includes(body.method as (typeof METHODS)[number])) {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }
  // `receiptDate` goes straight into a `date` column, so a malformed value is
  // a Postgres `22007` error — an unhandled 500 — rather than the 400 a bad
  // input is. (Date.parse wouldn't do: it normalises «2024-02-30» to March 1st.)
  const receiptDate = body.receiptDate?.trim() || null;
  if (receiptDate && !isValidIsoDate(receiptDate)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const receipt = await receivePayment({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      customerId,
      method: body.method as "cash" | "bank",
      amount,
      receiptDate,
      memo: body.memo,
      createdBy: session.sub,
      cashAccountId: typeof body.cashAccountId === "string" ? body.cashAccountId : null,
      bankReference: typeof body.bankReference === "string" ? body.bankReference : null,
    });
    return NextResponse.json({ receipt }, { status: 201 });
  } catch (err) {
    if (err instanceof ArError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof PayablesInputError) return NextResponse.json({ error: err.code }, { status: 400 });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
