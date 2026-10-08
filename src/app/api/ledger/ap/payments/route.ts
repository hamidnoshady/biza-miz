import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ApError, MissingLedgerAccountError, payBill } from "@/lib/ap-service";
import { listPaymentsPage, VoucherListError } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/iso-date";
import { buildCsv, sanitizeCsvText } from "@/lib/csv-safe";
import { isVoucherMethod, PayablesInputError, VOUCHER_METHOD_LABELS, VOUCHER_METHODS } from "@/lib/payables-input";

/**
 * The «پرداخت‌ها» ledger slice — payment vouchers, newest first, keyset-
 * paginated. Same contract as the receipts route: `limit` + `cursor` page,
 * filters narrow, `?format=csv` exports the filtered set formula-safe.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const params = request.nextUrl.searchParams;
  const parseAmount = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw === "") return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : NaN;
  };
  const filters = {
    q: params.get("q") ?? undefined,
    dateFrom: params.get("dateFrom") ?? undefined,
    dateTo: params.get("dateTo") ?? undefined,
    method: params.get("method") ?? undefined,
    partyId: params.get("partyId") ?? params.get("supplierId") ?? undefined,
    locationId: params.get("locationId") ?? undefined,
    cashAccountId: params.get("cashAccountId") ?? undefined,
    minAmount: parseAmount("minAmount"),
    maxAmount: parseAmount("maxAmount"),
    status: params.get("status") ?? undefined,
  } as Parameters<typeof listPaymentsPage>[1];
  const limitRaw = params.get("limit");
  const limit = limitRaw === null || limitRaw === "" ? undefined : Number(limitRaw);
  const cursor = params.get("cursor") ?? undefined;

  if (params.get("format") === "csv") {
    try {
      const page = await listPaymentsPage(session.businessId, { ...filters, limit: 5000 });
      const csv = buildCsv(
        ["شماره سند", "تاریخ", "تأمین‌کننده", "روش", "شماره پیگیری", "مبلغ (ریال)", "شرح", "وضعیت"],
        page.rows.map((r) => [
          r.voucherNumber === null ? "" : String(r.voucherNumber),
          r.date,
          sanitizeCsvText(r.partyName),
          sanitizeCsvText(
            r.cashAccount ? `${VOUCHER_METHOD_LABELS[r.method]} · ${r.cashAccount.name}` : VOUCHER_METHOD_LABELS[r.method],
          ),
          sanitizeCsvText(r.bankReference ?? ""),
          String(r.amount),
          sanitizeCsvText(r.memo ?? ""),
          r.reversedAt ? "باطل‌شده" : "فعال",
        ]),
      );
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=payments.csv",
        },
      });
    } catch (err) {
      if (err instanceof VoucherListError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
  }

  try {
    const page = await listPaymentsPage(session.businessId, { ...filters, limit, cursor });
    return NextResponse.json({ payments: page.rows, nextCursor: page.nextCursor, hasMore: page.hasMore });
  } catch (err) {
    if (err instanceof VoucherListError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

interface PaymentBody {
  supplierId?: string;
  method?: string;
  amount?: number;
  paymentDate?: string;
  memo?: string;
  /** The cash/bank/clearing account (an active account of the chosen method); omitted = the method's default. */
  cashAccountId?: string | null;
  /** The bank's tracking/reference number. */
  bankReference?: string | null;
  idempotencyKey?: string;
}

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
  if (!isVoucherMethod(body.method)) {
    return NextResponse.json({ error: "invalid_method", allowed: [...VOUCHER_METHODS] }, { status: 400 });
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
      method: body.method,
      amount,
      paymentDate,
      memo: body.memo,
      idempotencyKey: body.idempotencyKey,
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
