import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ArError, MissingLedgerAccountError, receivePayment } from "@/lib/ar-service";
import { listReceiptsPage, VoucherListError } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/iso-date";
import { isSettlementMethod, SETTLEMENT_METHODS } from "@/lib/voucher-shared";
import { buildCsv, sanitizeCsvText } from "@/lib/csv-safe";

/**
 * The «دریافت‌ها» ledger slice — receipt vouchers, newest first, keyset-
 * paginated. Issue #829: the old version returned the business's entire
 * history; callers now page with `limit` + `cursor` and filter with
 * `q/dateFrom/dateTo/method/partyId/locationId/settlementAccountId/
 * minAmount/maxAmount/status`. `?format=csv` exports the filtered set
 * (formula-safe, capped) instead of a page.
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
    partyId: params.get("partyId") ?? params.get("customerId") ?? undefined,
    locationId: params.get("locationId") ?? undefined,
    settlementAccountId: params.get("settlementAccountId") ?? undefined,
    minAmount: parseAmount("minAmount"),
    maxAmount: parseAmount("maxAmount"),
    status: params.get("status") ?? undefined,
  } as Parameters<typeof listReceiptsPage>[1];
  const limitRaw = params.get("limit");
  const limit = limitRaw === null || limitRaw === "" ? undefined : Number(limitRaw);
  const cursor = params.get("cursor") ?? undefined;

  // CSV export honors the same filters but ignores the cursor: it is the full
  // filtered set (capped), not the visible page.
  if (params.get("format") === "csv") {
    try {
      const page = await listReceiptsPage(session.businessId, { ...filters, limit: 5000 });
      const csv = buildCsv(
        ["شماره سند", "تاریخ", "مشتری", "روش", "مبلغ (ریال)", "شرح", "وضعیت"],
        page.rows.map((r) => [
          r.voucherNumber === null ? "" : String(r.voucherNumber),
          r.date,
          sanitizeCsvText(r.partyName),
          r.method,
          String(r.amount),
          sanitizeCsvText(r.memo ?? ""),
          r.reversedAt ? "باطل‌شده" : "فعال",
        ]),
      );
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=receipts.csv",
        },
      });
    } catch (err) {
      if (err instanceof VoucherListError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
  }

  try {
    const page = await listReceiptsPage(session.businessId, { ...filters, limit, cursor });
    return NextResponse.json({ receipts: page.rows, nextCursor: page.nextCursor, hasMore: page.hasMore });
  } catch (err) {
    if (err instanceof VoucherListError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

interface ReceiptBody {
  customerId?: string;
  method?: string;
  amount?: number;
  receiptDate?: string;
  memo?: string;
  settlementAccountId?: string;
  idempotencyKey?: string;
}

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
  if (!isSettlementMethod(body.method)) {
    return NextResponse.json({ error: "invalid_method", allowed: [...SETTLEMENT_METHODS] }, { status: 400 });
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
      method: body.method,
      amount,
      receiptDate,
      memo: body.memo,
      settlementAccountId: body.settlementAccountId?.trim() || null,
      idempotencyKey: body.idempotencyKey,
      createdBy: session.sub,
    });
    // An idempotent replay answers the original voucher with 200 so the client
    // can tell it did not create a second one; a fresh posting is 201.
    return NextResponse.json({ receipt }, { status: receipt.duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof ArError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
