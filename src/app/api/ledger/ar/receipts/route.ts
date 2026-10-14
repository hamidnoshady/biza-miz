import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ArError, MissingLedgerAccountError, receivePayment } from "@/lib/ar-service";
import { iterateReceiptsForExport, listReceiptsPage, VoucherListError } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/iso-date";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { streamVoucherExportCsv, voucherExportFilename } from "@/lib/voucher-export";
import { isJsonObject, isVoucherMethod, optionalBodyText, PayablesInputError, VOUCHER_METHODS, type VoucherMethod } from "@/lib/payables-input";

/**
 * The «دریافت‌ها» ledger slice — receipt vouchers, newest first, keyset-
 * paginated. Issue #829: the old version returned the business's entire
 * history; callers now page with `limit` + `cursor` and filter with
 * `q/dateFrom/dateTo/method/partyId/locationId/cashAccountId/
 * minAmount/maxAmount/status`. `?format=csv` exports the filtered set
 * (formula-safe, streamed whole, in the business's display unit) instead of a page.
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

  // CSV export honors the same filters but ignores the cursor: it is the
  // full filtered set (not the visible page), streamed chunk by chunk so a
  // long history never sits whole in memory, through the shared codec. The
  // first chunk is pulled eagerly so an invalid filter still answers 400
  // JSON instead of a 200 whose body starts mid-error.
  if (params.get("format") === "csv") {
    try {
      const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(session.businessId, SETTING_KEYS.businessPrefs);
      const unit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
      const rest = iterateReceiptsForExport(session.businessId, filters);
      const first = await rest.next();
      return new NextResponse(
        streamVoucherExportCsv({
          businessId: session.businessId,
          locationId: session.locationId ?? null,
          userId: session.sub ?? null,
          unit,
          kind: "receipts",
          firstChunk: first.done ? [] : first.value,
          rest,
        }),
        {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${voucherExportFilename("receipts")}"`,
          },
        },
      );
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

interface ParsedReceiptPostBody {
  customerId: string;
  method: VoucherMethod;
  amount: number;
  receiptDate: string | null;
  memo: string | null;
  cashAccountId: string | null;
  bankReference: string | null;
  idempotencyKey: string;
}

/**
 * Type-checks the receipt POST body before anything is touched: a wrong-typed
 * value (a number id, a boolean amount) is a controlled 400, never a
 * `.trim()` TypeError or a silently coerced meaning (`Number(true) === 1`).
 * Lives outside POST so the handler reads as the gate it is — permission,
 * parse, post — with the service call next to the permission that guards it.
 */
function parseReceiptPostBody(body: Record<string, unknown>): { ok: true; value: ParsedReceiptPostBody } | { ok: false; response: Record<string, unknown> } {
  const customerId = optionalBodyText(body.customerId) ?? "";
  if (!customerId) return { ok: false, response: { error: "customer_required" } };
  const idempotencyKey = optionalBodyText(body.idempotencyKey) ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return { ok: false, response: { error: "idempotency_key_required" } };
  }
  if (!isVoucherMethod(body.method)) {
    return { ok: false, response: { error: "invalid_method", allowed: [...VOUCHER_METHODS] } };
  }
  const amount = typeof body.amount === "number" || typeof body.amount === "string" ? Number(body.amount) : NaN;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, response: { error: "invalid_amount" } };
  }
  // `receiptDate` goes straight into a `date` column, so a malformed value is
  // a Postgres `22007` error — an unhandled 500 — rather than the 400 a bad
  // input is. (Date.parse wouldn't do: it normalises «2024-02-30» to March 1st.)
  const receiptDate = optionalBodyText(body.receiptDate);
  if (receiptDate === undefined) {
    return { ok: false, response: { error: "invalid_date" } };
  }
  if (receiptDate && !isValidIsoDate(receiptDate)) {
    return { ok: false, response: { error: "invalid_date" } };
  }
  const memo = optionalBodyText(body.memo);
  if (memo === undefined) {
    return { ok: false, response: { error: "invalid_memo" } };
  }
  const cashAccountId = optionalBodyText(body.cashAccountId);
  if (cashAccountId === undefined) {
    return { ok: false, response: { error: "invalid_cash_account" } };
  }
  const bankReference = optionalBodyText(body.bankReference);
  if (bankReference === undefined) {
    return { ok: false, response: { error: "invalid_bank_reference" } };
  }
  return { ok: true, value: { customerId, method: body.method, amount, receiptDate, memo, cashAccountId, bankReference, idempotencyKey } };
}

/** Records a customer paying down their AR balance. Same access as posting a manual journal entry. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReceivablesManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Valid JSON of the wrong shape (`null`, an array, a scalar) is a 400
  // here — before the parser touches a property — never a TypeError 500
  // (`null`) or a silent empty submission (an array's missing fields).
  if (!isJsonObject(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = parseReceiptPostBody(body);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 400 });
  const { customerId, method, amount, receiptDate, memo, cashAccountId, bankReference, idempotencyKey } = parsed.value;

  const location = await resolveActiveLocation(session);

  try {
    const receipt = await receivePayment({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      customerId,
      method,
      amount,
      receiptDate,
      memo,
      idempotencyKey,
      createdBy: session.sub,
      cashAccountId,
      bankReference,
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
