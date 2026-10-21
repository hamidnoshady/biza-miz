import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { isValidIsoDate } from "@/lib/jalali";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { authorize, denialResponse, actionableLocationIds } from "@/lib/authorize";
import {
  createWarehouseDocument,
  listWarehouseDocuments,
  isWarehouseDocumentKind,
  parseWarehouseDocumentLines,
} from "@/lib/warehouse-document-service";
import { buildCollectionPayloadHash } from "@/lib/warehouse-idempotency";
import {
  encodeWarehouseRegisterCursor,
  parseWarehouseRegisterQuery,
  registerExportTable,
  type WarehouseRegisterQueryError,
  type WarehouseRegisterRow,
} from "@/lib/warehouse-document-register";
import { moneyColumnLabel, moneyExportCell, rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import type { MoneyUnit } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";

/**
 * Phase 42 — warehouse documents (رسید/حواله انبار).
 *
 * GET lists the documents a business has posted (optionally by kind and
 * warehouse), branch-scoped and paginated; POST creates and posts one.
 * Creation runs the exact-costing path and the ledger entry in one
 * transaction (warehouse-document-service), so a document never exists
 * without its stock movement and journal lines.
 *
 * Branch scope (Issue #923 P0): a branch-restricted member never sees
 * another branch's documents. When no `locationId` is named the list is
 * scoped to the server-resolved permitted location set — never tenant-wide.
 * When a `locationId` is named it is authorized through the canonical guard
 * (403 if forbidden).
 *
 * P1 idempotency: POST accepts an Idempotency-Key header or body
 * idempotencyKey (UUID). Same key+same payload returns the original
 * voucher; same key+changed payload returns 409. Includes atomic
 * reservation via unique index and payload hash.
 */
const REGISTER_QUERY_ERRORS: Record<WarehouseRegisterQueryError, number> = {
  invalid_date: 400,
  bad_request: 400,
  invalid_cursor: 400,
  invalid_amount_range: 400,
  unknown_creator: 404,
};

/** The F&B register's kind label, shared by the screen, the export and print. */
const KIND_LABELS: Record<string, string> = {
  receipt: "رسید",
  issue: "حواله",
};

/**
 * Walk the keyset to the end of the filtered register — what `?format=` and
 * the print sheet need. Capped so one request cannot read an unbounded tenant
 * into memory; the caller is told when it stopped (`truncated`).
 */
const EXPORT_CAP = 5000;

async function fetchAllRegisterRows(
  businessId: string,
  options: NonNullable<Parameters<typeof listWarehouseDocuments>[1]> & { locationIds: string[] },
): Promise<{ rows: WarehouseRegisterRow[]; truncated: boolean }> {
  const rows: WarehouseRegisterRow[] = [];
  let cursor: NonNullable<NonNullable<Parameters<typeof listWarehouseDocuments>[1]>["cursor"]> | null = null;
  for (let page = 0; page < 100 && rows.length < EXPORT_CAP; page++) {
    const batch = await listWarehouseDocuments(businessId, { ...options, cursor, paginate: true, limit: 200 });
    const more = batch.length > 200;
    const pageRows = more ? batch.slice(0, 200) : batch;
    rows.push(...(pageRows as unknown as WarehouseRegisterRow[]));
    if (!more) return { rows, truncated: false };
    const last = pageRows[pageRows.length - 1];
    cursor = {
      sort: (options.sort ?? "created_desc") as never,
      key: last.sort_key,
      id: last.id,
    };
  }
  return { rows: rows.slice(0, EXPORT_CAP), truncated: rows.length >= EXPORT_CAP };
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const { session, membership } = guard;

  const url = new URL(request.url);
  const parsed = parseWarehouseRegisterQuery(url, {
    isKind: (value) => isWarehouseDocumentKind(value),
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
    // A non-uuid locationId is a caller error, not a uuid-syntax 500.
    if (!isUuid(locationId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    // Explicitly requesting a branch the member may not act in — including an
    // inactive or non-member branch — is refused without confirming whether
    // the id exists at all.
    const decision = await authorize(session, { locationId });
    if (!decision.ok) return denialResponse(decision);
    locationIds = [locationId];
  } else {
    // Unfiltered listing reaches only the member's permitted branches. A
    // member with no permitted branch reads an empty register (and an empty
    // export), never the whole tenant's — the listers answer `[]` for an
    // explicitly empty set, which is why this is not an early return.
    locationIds = permitted;
  }

  const query = {
    kind: filters.kind as never,
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

  // The export and the print sheet are the *complete* filtered register, not
  // the page on screen — the same rule the voucher register follows. The
  // branch authorization above already ran, so the file can only contain
  // branches this member may read.
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

  const rows = (await listWarehouseDocuments(session.businessId, {
    ...query,
    cursor: cursor ?? undefined,
    paginate: true,
    limit,
  })) as unknown as WarehouseRegisterRow[];

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

// canonical payload hash now in @/lib/warehouse-idempotency (deep-canonical)

export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (guard.error) return guard.error;
  const session = guard.session;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // P2 strict schema: root must be plain object
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
    allowNegativeStock?: unknown;
    lines?: unknown;
  };

  // Body size / max lines guard (P2)
  const rawLines = body.lines;
  if (rawLines !== undefined) {
    if (!Array.isArray(rawLines)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (rawLines.length > 200) {
      return NextResponse.json({ error: "too_many_lines" }, { status: 400 });
    }
    if (rawLines.some((l) => l == null || typeof l !== "object" || Array.isArray(l))) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  if (!isWarehouseDocumentKind(body.kind)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.locationId !== "string" || !body.locationId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!isUuid(body.locationId)) {
    return NextResponse.json({ error: "location_not_found" }, { status: 404 });
  }
  // Branch authorization using live membership scope, not client-provided permissions
  const locationDecision = await authorize(session, { locationId: body.locationId });
  if (!locationDecision.ok) return denialResponse(locationDecision);

  if (body.supplierId != null && body.supplierId !== "" && (typeof body.supplierId !== "string" || !isUuid(body.supplierId))) {
    return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  }
  // Validate optional text fields are strings when present (P2)
  for (const field of ["recipient", "documentNumber", "note", "internalVoucherNumber"] as const) {
    const v = (body as Record<string, unknown>)[field];
    if (v != null && typeof v !== "string") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof v === "string" && v.length > 500) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  const typedLines = (body.lines ?? []) as Array<{ inventoryItemId?: unknown; quantity?: unknown; unitCost?: unknown }>;
  if (
    typedLines.some(
      (line) => line?.inventoryItemId != null && line.inventoryItemId !== "" && (typeof line.inventoryItemId !== "string" || !isUuid(line.inventoryItemId)),
    )
  ) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  // Idempotency key: header takes precedence, then body, otherwise null (no dedup)
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
    parsed = parseWarehouseDocumentLines(body.kind as never, typedLines as never);
  } catch (err) {
    const code = err instanceof Error ? err.message : "bad_request";
    return NextResponse.json({ error: code }, { status: 400 });
  }

  // Deep-canonical payload hash (P1): kind, location, supplier, recipient, docNo, note, freeGoodsReason, postingDate + full ordered lines
  const payloadHash = buildCollectionPayloadHash({
    kind: parsed.kind,
    locationId: body.locationId,
    supplierId: (body.supplierId as string) ?? null,
    recipient: typeof body.recipient === "string" ? body.recipient : null,
    documentNumber: typeof body.documentNumber === "string" ? body.documentNumber : null,
    note: typeof body.note === "string" ? body.note : null,
    freeGoodsReason: typeof body.freeGoodsReason === "string" ? body.freeGoodsReason : null,
    postingDate: typeof body.postingDate === "string" ? body.postingDate : null,
    lines: parsed.lines.map((l) => ({
      inventoryItemId: l.inventoryItemId,
      quantity: l.quantity,
      unitCost: l.unitCost,
      lot: null,
      expiryDate: null,
    })),
  });

  // Optional fields for P2 hardening
  if (body.freeGoodsReason != null && typeof body.freeGoodsReason !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.postingDate != null && (typeof body.postingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.postingDate))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.allowNegativeStock != null && typeof body.allowNegativeStock !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const created = await createWarehouseDocument({
      businessId: session.businessId,
      locationId: body.locationId,
      kind: parsed.kind,
      supplierId: (body.supplierId as string) ?? null,
      recipient: typeof body.recipient === "string" ? body.recipient.trim() || null : null,
      documentNumber: typeof body.documentNumber === "string" ? body.documentNumber.trim() || null : null,
      note: typeof body.note === "string" ? body.note.trim() || null : null,
      createdBy: session.sub,
      lines: parsed.lines,
      idempotencyKey,
      payloadHash,
      internalVoucherNumber: typeof body.internalVoucherNumber === "string" ? body.internalVoucherNumber.trim() || null : null,
      freeGoodsReason: typeof body.freeGoodsReason === "string" ? body.freeGoodsReason.trim() || null : null,
      postingDate: typeof body.postingDate === "string" ? body.postingDate : null,
      allowNegativeStock: body.allowNegativeStock === true,
    });
    const payload: Record<string, unknown> = {
      ok: true,
      id: created.id,
      totalValue: created.totalValue,
    };
    if (created.voucherNumber) payload.voucherNumber = created.voucherNumber;
    // If duplicate key returned the same document, signal it
    if (created.duplicate) payload.duplicate = true;
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error) {
      if (err.message.startsWith("inventory_exact_cutover_required")) {
        return NextResponse.json({ error: "inventory_exact_cutover_required" }, { status: 409 });
      }
      if (err.message === "idempotency_key_conflict") {
        return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
      }
      if (err.message === "document_number_taken") {
        return NextResponse.json({ error: "document_number_taken" }, { status: 409 });
      }
      const known: Record<string, number> = {
        location_not_found: 404,
        location_inactive: 409,
        supplier_not_found: 404,
        item_not_found: 404,
        no_items: 400,
        invalid_line: 400,
        invalid_quantity: 400,
        quantity_precision_exceeded: 400,
        invalid_rial: 400,
        rial_out_of_range: 400,
        receipt_value_required: 400,
        periodic_system_unsupported: 409,
        idempotency_key_invalid: 400,
        too_many_lines: 400,
        fiscal_period_locked: 409,
        fiscal_period_soft_closed: 409,
        fiscal_period_not_defined: 409,
        negative_stock_requires_confirm: 409,
        bad_request: 400,
      };
      const status = known[err.message];
      if (status) return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
});
