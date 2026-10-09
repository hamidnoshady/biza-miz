import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ArError, MissingLedgerAccountError, receivePayment } from "@/lib/ar-service";
import { listReceiptsForExport, listReceiptsPage, VoucherListError } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/iso-date";
import { rowsToCsv } from "@/lib/report-export";
import { buildReceiptsExportTable, voucherExportFilename } from "@/lib/voucher-export";
import { VOUCHER_EXPORT_ROW_CAP } from "@/lib/voucher-shared";
import { isVoucherMethod, PayablesInputError, VOUCHER_METHODS } from "@/lib/payables-input";

/**
 * The «دریافت‌ها» ledger slice — receipt vouchers, newest first, keyset-
 * paginated. Issue #829: the old version returned the business's entire
 * history; callers now page with `limit` + `cursor` and filter with
 * `q/dateFrom/dateTo/method/partyId/locationId/cashAccountId/
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
    cashAccountId: params.get("cashAccountId") ?? undefined,
    minAmount: parseAmount("minAmount"),
    maxAmount: parseAmount("maxAmount"),
    status: params.get("status") ?? undefined,
  } as Parameters<typeof listReceiptsPage>[1];
  const limitRaw = params.get("limit");
  const limit = limitRaw === null || limitRaw === "" ? undefined : Number(limitRaw);
  const cursor = params.get("cursor") ?? undefined;

  // CSV export honors the same filters but ignores the cursor: it is the full
  // filtered set (bounded, not the visible page) through the shared codec, so
  // the file matches the journal export's conventions.
  if (params.get("format") === "csv") {
    try {
      const { rows, truncated } = await listReceiptsForExport(session.businessId, filters);
      const response = new NextResponse(rowsToCsv(buildReceiptsExportTable(rows)), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${voucherExportFilename("receipts")}"`,
        },
      });
      // A truncated export is a fact the operator has to know before they
      // reconcile against it; the header is read by the screen, which says so.
      if (truncated) response.headers.set("X-Voucher-Export-Truncated", String(VOUCHER_EXPORT_ROW_CAP));
      return response;
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
  /** The cash/bank/clearing account (an active account of the chosen method); omitted = the method's default. */
  cashAccountId?: string | null;
  /** The bank's tracking/reference number. */
  bankReference?: string | null;
  /** Client-generated key per logical submission. Required: a retry replays the original voucher. */
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
  const idempotencyKey = body.idempotencyKey?.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return NextResponse.json({ error: "idempotency_key_required" }, { status: 400 });
  }
  if (!isVoucherMethod(body.method)) {
    return NextResponse.json({ error: "invalid_method", allowed: [...VOUCHER_METHODS] }, { status: 400 });
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
      idempotencyKey,
      createdBy: session.sub,
      cashAccountId: typeof body.cashAccountId === "string" ? body.cashAccountId : null,
      bankReference: typeof body.bankReference === "string" ? body.bankReference : null,
    });
    // An idempotent replay answers the original voucher with 200 so the client
    // can tell it did not create a second one; a fresh posting is 201.
    return NextResponse.json({ receipt }, { status: receipt.duplicate ? 200 : 201 });
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
