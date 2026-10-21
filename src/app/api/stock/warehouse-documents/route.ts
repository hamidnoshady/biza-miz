import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { isValidIsoDate } from "@/lib/jalali";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { authorize, denialResponse, actionableLocationIds } from "@/lib/authorize";
import { buildCollectionPayloadHash } from "@/lib/warehouse-idempotency";
import {
  createRetailWarehouseDocumentInTransaction,
  isRetailWarehouseDocumentKind,
  listRetailWarehouseDocuments,
  parseRetailWarehouseDocumentLines,
  RetailWarehouseDocumentError,
} from "@/lib/retail-warehouse-document-service";
import {
  encodeWarehouseRegisterCursor,
  parseWarehouseRegisterQuery,
  registerExportTable,
  type WarehouseRegisterQueryError,
  type WarehouseRegisterRow,
} from "@/lib/warehouse-document-register";
import { moneyExportCell, rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import type { MoneyUnit } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";

/**
 * Phase 42b — retail warehouse documents (رسید/حواله انبار) on the
 * items/item_stock/item_batches model.
 *
 * GET lists the documents the business has posted (optionally by kind and
 * warehouse, with a search over number/recipient/note), branch-scoped and
 * paginated; POST creates and posts one. Creation moves the lots/stock and
 * posts the ledger entry in one transaction (retail-warehouse-document
 * -service), so a document never exists without its stock effect and journal
 * lines.
 *
 * Branch scope (Issue #923 P0): a branch-restricted member never sees
 * another branch's documents. When no `locationId` is named the list is
 * scoped to the server-resolved permitted location set — never tenant-wide.
 * When a `locationId` is named it is authorized through the canonical guard
 * (403 if forbidden).
 *
 * P1 idempotency: header/body key with payload hash.
 */
const REGISTER_QUERY_ERRORS: Record<WarehouseRegisterQueryError, number> = {
  invalid_date: 400,
  bad_request: 400,
  invalid_cursor: 400,
  invalid_amount_range: 400,
  unknown_creator: 404,
};

const KIND_LABELS: Record<string, string> = {
  receipt: "رسید",
  issue: "حواله",
  disposal: "امحا",
  internal_use: "مصرف داخلی",
};

const EXPORT_CAP = 5000;

async function fetchAllRegisterRows(
  businessId: string,
  options: NonNullable<Parameters<typeof listRetailWarehouseDocuments>[1]> & { locationIds: string[] },
): Promise<{ rows: WarehouseRegisterRow[]; truncated: boolean }> {
  const rows: WarehouseRegisterRow[] = [];
  let cursor: NonNullable<NonNullable<Parameters<typeof listRetailWarehouseDocuments>[1]>["cursor"]> | null = null;
  for (let page = 0; page < 100 && rows.length < EXPORT_CAP; page++) {
    const batch = await listRetailWarehouseDocuments(businessId, { ...options, cursor, paginate: true, limit: 200 });
    const more = batch.length > 200;
    const pageRows = more ? batch.slice(0, 200) : batch;
    rows.push(...pageRows);
    if (!more) return { rows, truncated: false };
    const last = pageRows[pageRows.length - 1];
    cursor = { sort: (options.sort ?? "created_desc") as never, key: last.sort_key, id: last.id };
  }
  return { rows: rows.slice(0, EXPORT_CAP), truncated: rows.length >= EXPORT_CAP };
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const { session, membership } = guard;

  const url = new URL(request.url);
  const parsed = parseWarehouseRegisterQuery(url, {
    isKind: (value) => isRetailWarehouseDocumentKind(value),
    isUuid,
  });
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: REGISTER_QUERY_ERRORS[parsed.error] });
  }
  const { filters, sort, limit, cursor, format } = parsed;

  // The branches this member may act in, resolved server-side from the
  // membership (role, scope, assignments, Hybrid site restriction) — never
  // from the client.
  const permitted = await actionableLocationIds(membership);
  const locationId = url.searchParams.get("locationId");

  let locationIds: string[];
  if (locationId !== null && locationId !== "") {
    if (!isUuid(locationId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const decision = await authorize(session, { locationId });
    if (!decision.ok) return denialResponse(decision);
    locationIds = [locationId];
  } else {
    // Explicitly empty permitted set → an empty register, not everything.
    locationIds = permitted;
  }

  const query = {
    kind: filters.kind,
    locationIds,
    search: filters.search,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    amountMin: filters.amountMin,
    amountMax: filters.amountMax,
    createdBy: filters.createdBy,
    postingState: filters.postingState,
    sort,
  };

  if (format) {
    const { rows, truncated } = await fetchAllRegisterRows(session.businessId, query);
    const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(
      session.businessId,
      SETTING_KEYS.businessPrefs,
    );
    const unit: MoneyUnit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
    const unitLabel = unit === "rial" ? "ریال" : "تومان";
    const table = registerExportTable(rows, unitLabel, format, {
      toDisplayAmount: (rial, target) => moneyExportCell(rial, unit, target === "xlsx" ? "excel" : "csv"),
      formatDate: (date) => formatJalali(date, { timeZone: "UTC" }),
      kindLabel: (kind) => KIND_LABELS[kind] ?? kind,
    });
    const filename = `warehouse-documents.${format}`;
    const headers = {
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...(truncated ? { "X-Export-Truncated": "true" } : {}),
    };
    return format === "xlsx"
      ? new NextResponse(new Uint8Array(await rowsToXlsxBuffer(table, "اسناد انبار")), {
          headers: {
            ...headers,
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        })
      : new NextResponse(rowsToCsv(table), {
          headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
        });
  }

  const rows = await listRetailWarehouseDocuments(session.businessId, {
    ...query,
    cursor,
    paginate: true,
    limit,
  });

  const hasMore = rows.length > limit;
  const documents = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeWarehouseRegisterCursor({
        sort,
        key: documents[documents.length - 1].sort_key,
        id: documents[documents.length - 1].id,
      })
    : null;

  return NextResponse.json({ documents, hasMore, nextCursor });
});

// canonical payload hash now in @/lib/warehouse-idempotency

export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (guard.error) return guard.error;
  const session = guard.session;

  const defaultLocation = await resolveActiveLocation(session);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const body = rawBody as {
    kind?: unknown;
    locationId?: unknown;
    supplierId?: unknown;
    recipient?: unknown;
    documentNumber?: unknown;
    note?: unknown;
    idempotencyKey?: unknown;
    internalVoucherNumber?: unknown;
    freeGoodsReason?: unknown;
    postingDate?: unknown;
    lines?: unknown;
  };

  if (!isRetailWarehouseDocumentKind(body.kind)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Strict schema: locationId handling
  let locationId: string;
  if (typeof body.locationId === "string" && body.locationId) {
    locationId = body.locationId;
  } else if (typeof body.locationId === "string" && body.locationId === "") {
    locationId = defaultLocation?.id || "";
  } else {
    locationId = defaultLocation?.id || "";
  }
  if (!locationId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (body.lines !== undefined && !Array.isArray(body.lines)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (Array.isArray(body.lines) && body.lines.length > 200) {
    return NextResponse.json({ error: "too_many_lines" }, { status: 400 });
  }
  if (Array.isArray(body.lines) && body.lines.some((l) => l == null || typeof l !== "object" || Array.isArray(l))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isUuid(locationId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const locationDecision = await authorize(session, { locationId });
  if (!locationDecision.ok) return denialResponse(locationDecision);

  for (const field of ["recipient", "documentNumber", "note", "internalVoucherNumber"] as const) {
    const v = (body as Record<string, unknown>)[field];
    if (v != null && typeof v !== "string") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof v === "string" && v.length > 500) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  // lot/expiry validation: if present must be string
  const rawLines = (body.lines ?? []) as Array<Record<string, unknown>>;
  if (rawLines.some((line) => line?.itemId != null && line.itemId !== "" && (typeof line.itemId !== "string" || !isUuid(line.itemId as string)))) {
    return NextResponse.json({ error: "invalid_line" }, { status: 400 });
  }
  for (const line of rawLines) {
    if (line.lot != null && typeof line.lot !== "string") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (line.expiryDate != null && typeof line.expiryDate !== "string") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (line.expiryDate && typeof line.expiryDate === "string" && line.expiryDate.trim() !== "") {
      const d = line.expiryDate.trim();
      // Strong date validation: YYYY-MM-DD, real calendar date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + "T00:00:00Z"))) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
    }
    if (line.unitCost != null && typeof line.unitCost !== "string" && typeof line.unitCost !== "number") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (line.quantity != null && typeof line.quantity !== "string" && typeof line.quantity !== "number") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  if (body.freeGoodsReason != null && typeof body.freeGoodsReason !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.postingDate != null && (typeof body.postingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.postingDate))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Idempotency key
  const headerKey = request.headers.get("idempotency-key") ?? request.headers.get("Idempotency-Key");
  let idempotencyKey: string | null = null;
  const rawKey = (headerKey ?? (body.idempotencyKey as string | undefined) ?? null) as string | null;
  if (rawKey != null && rawKey !== "") {
    if (typeof rawKey !== "string" || !isUuid(rawKey)) {
      return NextResponse.json({ error: "idempotency_key_invalid" }, { status: 400 });
    }
    idempotencyKey = rawKey;
  }

  let parsed;
  try {
    parsed = parseRetailWarehouseDocumentLines(
      body.kind as never,
      (body.lines ?? []) as never,
    );
  } catch (err) {
    const code = err instanceof Error ? err.message : "bad_request";
    return NextResponse.json({ error: code }, { status: 400 });
  }

  const payloadHash = buildCollectionPayloadHash({
    kind: parsed.kind,
    locationId,
    supplierId: (body.supplierId as string) ?? null,
    recipient: typeof body.recipient === "string" ? body.recipient : null,
    documentNumber: typeof body.documentNumber === "string" ? body.documentNumber : null,
    note: typeof body.note === "string" ? body.note : null,
    freeGoodsReason: typeof body.freeGoodsReason === "string" ? body.freeGoodsReason : null,
    postingDate: typeof body.postingDate === "string" ? body.postingDate : null,
    lines: parsed.lines.map((l) => ({
      itemId: l.itemId,
      quantity: l.quantity,
      unitCost: l.unitCost,
      lot: l.lotNumber,
      expiryDate: l.expiryDate,
    })),
  });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await createRetailWarehouseDocumentInTransaction(client, {
      businessId: session.businessId,
      locationId,
      kind: parsed.kind,
      supplierId: (body.supplierId as string) ?? null,
      recipient: typeof body.recipient === "string" ? body.recipient : null,
      documentNumber: typeof body.documentNumber === "string" ? body.documentNumber : null,
      note: typeof body.note === "string" ? body.note : null,
      createdBy: session.sub,
      lines: parsed.lines,
      idempotencyKey,
      payloadHash,
      internalVoucherNumber: typeof body.internalVoucherNumber === "string" ? body.internalVoucherNumber.trim() || null : null,
      freeGoodsReason: typeof body.freeGoodsReason === "string" ? body.freeGoodsReason.trim() || null : null,
      postingDate: typeof body.postingDate === "string" ? body.postingDate : null,
    });
    await client.query("COMMIT");
    if ((created as unknown as { duplicate?: boolean }).duplicate) {
      return NextResponse.json({
        ok: true,
        id: created.id,
        totalValue: created.totalValue,
        entryId: created.entryId,
        debitCode: created.debitCode,
        creditCode: created.creditCode,
        duplicate: true,
      });
    }
    return NextResponse.json({
      ok: true,
      id: created.id,
      voucherNumber: created.voucherNumber,
      totalValue: created.totalValue,
      entryId: created.entryId,
      debitCode: created.debitCode,
      creditCode: created.creditCode,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    // Two concurrent posts computing the same voucher sequence collide on
    // the unique index — a retryable conflict, not a 500.
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "voucher_number_taken" }, { status: 409 });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof RetailWarehouseDocumentError) {
      return NextResponse.json(
        { error: "document_failed", message: err.message },
        { status: 400 },
      );
    }
    if (err instanceof Error) {
      if (err.message === "idempotency_key_conflict") {
        return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
      }
      if (err.message === "document_number_taken" || (err as { code?: string }).code === "23505") {
        return NextResponse.json({ error: "document_number_taken" }, { status: 409 });
      }
      const known: Record<string, number> = {
        no_items: 400,
        invalid_line: 400,
        invalid_quantity: 400,
        missing_cost: 400,
        invalid_cost: 400,
        cost_out_of_range: 400,
        quantity_precision_exceeded: 400,
        too_many_lines: 400,
        idempotency_key_invalid: 400,
        fiscal_period_locked: 409,
        fiscal_period_soft_closed: 409,
        fiscal_period_not_defined: 409,
        bad_request: 400,
      };
      if (known[err.message]) {
        return NextResponse.json({ error: err.message }, { status: known[err.message] });
      }
    }
    // Handle unique violation for document_number as typed conflict
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "document_number_taken" }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }
});
