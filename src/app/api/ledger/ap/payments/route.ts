import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ApError, MissingLedgerAccountError, payBill } from "@/lib/ap-service";
import { iteratePaymentsForExport, listPaymentsPage, VoucherListError } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/iso-date";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { streamVoucherExportCsv, voucherExportFilename } from "@/lib/voucher-export";
import { isVoucherMethod, optionalBodyText, PayablesInputError, VOUCHER_METHODS } from "@/lib/payables-input";

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

  // CSV export honors the same filters but ignores the cursor: it is the
  // full filtered set (not the visible page), streamed chunk by chunk so a
  // long history never sits whole in memory, through the shared codec. The
  // first chunk is pulled eagerly so an invalid filter still answers 400
  // JSON instead of a 200 whose body starts mid-error.
  if (params.get("format") === "csv") {
    try {
      const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(session.businessId, SETTING_KEYS.businessPrefs);
      const unit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
      const rest = iteratePaymentsForExport(session.businessId, filters);
      const first = await rest.next();
      return new NextResponse(
        streamVoucherExportCsv({
          businessId: session.businessId,
          locationId: session.locationId ?? null,
          userId: session.sub ?? null,
          unit,
          kind: "payments",
          firstChunk: first.done ? [] : first.value,
          rest,
        }),
        {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${voucherExportFilename("payments")}"`,
          },
        },
      );
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
  clientRequestId?: string;
  /** The cash/bank/clearing account (an active account of the chosen method); omitted = the method's default. */
  cashAccountId?: string | null;
  /** The bank's tracking/reference number. */
  bankReference?: string | null;
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

  // Every body field is type-checked before it is touched: a wrong-typed
  // value (a number id, a boolean amount) is a controlled 400, never a
  // `.trim()` TypeError or a silently coerced meaning (`Number(true) === 1`).
  const supplierId = optionalBodyText(body.supplierId) ?? "";
  if (!supplierId) return NextResponse.json({ error: "supplier_required" }, { status: 400 });
  const clientRequestId = optionalBodyText(body.clientRequestId) ?? "";
  if (!clientRequestId || clientRequestId.length > 200) {
    return NextResponse.json({ error: "idempotency_key_required" }, { status: 400 });
  }
  if (!isVoucherMethod(body.method)) {
    return NextResponse.json({ error: "invalid_method", allowed: [...VOUCHER_METHODS] }, { status: 400 });
  }
  const amount = typeof body.amount === "number" || typeof body.amount === "string" ? Number(body.amount) : NaN;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }
  // Same guard as the receipts route: an unparseable or impossible date must
  // be a 400 here, not Postgres's datetime error surfacing as a 500.
  const paymentDate = optionalBodyText(body.paymentDate);
  if (paymentDate === undefined) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (paymentDate && !isValidIsoDate(paymentDate)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  const memo = optionalBodyText(body.memo);
  if (memo === undefined) {
    return NextResponse.json({ error: "invalid_memo" }, { status: 400 });
  }
  const cashAccountId = optionalBodyText(body.cashAccountId);
  if (cashAccountId === undefined) {
    return NextResponse.json({ error: "invalid_cash_account" }, { status: 400 });
  }
  const bankReference = optionalBodyText(body.bankReference);
  if (bankReference === undefined) {
    return NextResponse.json({ error: "invalid_bank_reference" }, { status: 400 });
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
      memo,
      clientRequestId,
      createdBy: session.sub,
      cashAccountId,
      bankReference,
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
