import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { isValidIsoDate } from "@/lib/jalali";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  createRetailWarehouseDocumentInTransaction,
  isRetailWarehouseDocumentKind,
  parseRetailWarehouseDocumentLines,
  RetailWarehouseDocumentError,
} from "@/lib/retail-warehouse-document-service";
import {
  actionableLocationIds,
  canActInLocation,
} from "@/lib/authorize";
import { decodeWarehouseDocumentCursor, encodeWarehouseDocumentCursor } from "@/lib/warehouse-document-cursor";

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
 * When a `locationId` is named it must be one of the member's permitted,
 * active branches of this business, otherwise the request is refused.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const { session, membership } = guard;

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const locationId = url.searchParams.get("locationId");
  const search = (url.searchParams.get("search") ?? "").trim();
  const dateFrom = url.searchParams.get("dateFrom") || undefined;
  const dateTo = url.searchParams.get("dateTo") || undefined;
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 1), 500);
  const cursor = decodeWarehouseDocumentCursor(url.searchParams.get("cursor"));

  if (dateFrom !== undefined && !isValidIsoDate(dateFrom)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (dateTo !== undefined && !isValidIsoDate(dateTo)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  if (kind !== null && kind !== "") {
    if (!isRetailWarehouseDocumentKind(kind)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  // The branches this member may act in, resolved server-side from the
  // membership (role, scope, assignments, Hybrid site restriction) — never
  // from the client.
  const permitted = await actionableLocationIds(membership);

  let locationIds: string[];
  if (locationId !== null && locationId !== "") {
    // A non-uuid locationId is a caller error, not a uuid-syntax 500.
    if (!isUuid(locationId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    // Explicitly requesting a branch the member may not act in — including an
    // inactive or non-member branch — is refused without confirming whether
    // the id exists at all.
    if (!(await canActInLocation(membership, locationId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    locationIds = [locationId];
  } else {
    // Unfiltered listing reaches only the member's permitted branches. A
    // member with no permitted branch sees an empty ledger, not the whole
    // tenant's.
    if (permitted.length === 0) {
      return NextResponse.json({ documents: [], hasMore: false, nextCursor: null });
    }
    locationIds = permitted;
  }

  const params: unknown[] = [session.businessId, locationIds];
  const clauses = ["d.business_id = $1", "d.location_id = ANY($2)"];
  if (kind !== null && kind !== "") {
    params.push(kind);
    clauses.push(`d.kind = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`d.business_date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    clauses.push(`d.business_date <= $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(
      `(d.document_number ILIKE $${params.length} OR d.recipient ILIKE $${params.length} OR d.note ILIKE $${params.length})`,
    );
  }
  if (cursor) {
    params.push(cursor.createdAt);
    clauses.push(`(d.created_at, d.id) < ($${params.length}, $${params.length + 1})`);
    params.push(cursor.id);
  }

  const { rows } = await query(
    `SELECT d.id, d.kind::text AS kind, d.location_id, l.name AS location_name,
            d.recipient, d.document_number, d.voucher_number, d.business_date,
            d.note,
            d.total_value_rial::text AS total_value_rial,
            d.created_at, u.full_name AS created_by_name,
            (SELECT count(*) FROM retail_warehouse_document_lines l2
              WHERE l2.document_id = d.id)::int AS line_count
       FROM retail_warehouse_documents d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN users u ON u.id = d.created_by
      WHERE ${clauses.join(" AND ")}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length + 1}`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const documents = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeWarehouseDocumentCursor({
        createdAt: (documents[documents.length - 1] as { created_at: string; id: string }).created_at,
        id: (documents[documents.length - 1] as { created_at: string; id: string }).id,
      })
    : null;

  return NextResponse.json({ documents, hasMore, nextCursor });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  const defaultLocation = await resolveActiveLocation(session);

  let body: {
    kind?: string;
    locationId?: string;
    supplierId?: string | null;
    recipient?: string | null;
    documentNumber?: string | null;
    note?: string | null;
    lines?: Array<{
      itemId?: string;
      quantity?: string | number;
      unitCost?: string | number;
      lot?: string | null;
      expiryDate?: string | null;
    }>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isRetailWarehouseDocumentKind(body.kind)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const locationId = body.locationId || defaultLocation?.id || "";
  if (!locationId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  // A non-array `lines` would make the parser's for-of throw a TypeError
  // ("rawLines is not iterable") rather than a validation error, i.e. a 500.
  // This has to precede the per-line id screen below, which iterates it.
  if (body.lines !== undefined && !Array.isArray(body.lines)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Malformed ids would surface as Postgres uuid-syntax 500s inside the
  // posting transaction; answer 400 up front instead.
  if (!isUuid(locationId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if ((body.lines ?? []).some((line) => line?.itemId != null && line.itemId !== "" && !isUuid(line.itemId))) {
    return NextResponse.json({ error: "invalid_line" }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseRetailWarehouseDocumentLines(body.kind, body.lines ?? []);
  } catch (err) {
    // Every parse failure is a caller error: missing line, duplicate item,
    // non-positive quantity, or a missing/invalid receipt cost.
    const code = err instanceof Error ? err.message : "bad_request";
    return NextResponse.json({ error: code }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await createRetailWarehouseDocumentInTransaction(client, {
      businessId: session.businessId,
      locationId,
      kind: parsed.kind,
      supplierId: body.supplierId ?? null,
      recipient: body.recipient ?? null,
      documentNumber: body.documentNumber ?? null,
      note: body.note ?? null,
      createdBy: session.sub,
      lines: parsed.lines,
    });
    await client.query("COMMIT");
    // The posting summary: what the document did to the ledger.
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
    const known: Record<string, number> = {
      no_items: 400,
      invalid_line: 400,
      invalid_quantity: 400,
      missing_cost: 400,
      invalid_cost: 400,
      cost_out_of_range: 400,
      quantity_precision_exceeded: 400,
    };
    if (err instanceof Error && known[err.message]) {
      return NextResponse.json({ error: err.message }, { status: known[err.message] });
    }
    throw err;
  } finally {
    client.release();
  }
});
