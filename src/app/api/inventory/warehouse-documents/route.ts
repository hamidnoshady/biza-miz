import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { isValidIsoDate } from "@/lib/jalali";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  createWarehouseDocument,
  listWarehouseDocuments,
  isWarehouseDocumentKind,
  parseWarehouseDocumentLines,
} from "@/lib/warehouse-document-service";
import {
  actionableLocationIds,
  canActInLocation,
} from "@/lib/authorize";
import { decodeWarehouseDocumentCursor, encodeWarehouseDocumentCursor } from "@/lib/warehouse-document-cursor";

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
    if (!isWarehouseDocumentKind(kind)) {
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

  const rows = await listWarehouseDocuments(session.businessId, {
    kind: kind === null || kind === "" ? undefined : kind,
    locationIds,
    search: search || undefined,
    dateFrom,
    dateTo,
    cursor: cursor ?? undefined,
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const documents = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeWarehouseDocumentCursor({
        createdAt: documents[documents.length - 1].created_at,
        id: documents[documents.length - 1].id,
      })
    : null;

  return NextResponse.json({ documents, hasMore, nextCursor });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  let body: {
    kind?: string;
    locationId?: string;
    supplierId?: string | null;
    recipient?: string | null;
    documentNumber?: string | null;
    note?: string | null;
    lines?: Array<{ inventoryItemId?: string; quantity?: string; unitCost?: string | number }>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isWarehouseDocumentKind(body.kind)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.locationId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  // A non-array `lines` would make the parser's for-of throw a TypeError
  // ("rawLines is not iterable") rather than a validation error, i.e. a 500.
  // This has to precede the per-line id screen below, which iterates it.
  if (body.lines !== undefined && !Array.isArray(body.lines)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Malformed ids would surface as Postgres uuid-syntax 500s inside the
  // posting transaction; answer 400/404 up front instead.
  if (!isUuid(body.locationId)) {
    return NextResponse.json({ error: "location_not_found" }, { status: 404 });
  }
  if (body.supplierId != null && body.supplierId !== "" && !isUuid(body.supplierId)) {
    return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  }
  if (
    (body.lines ?? []).some(
      (line) => line?.inventoryItemId != null && line.inventoryItemId !== "" && !isUuid(line.inventoryItemId),
    )
  ) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  let parsed;
  try {
    parsed = parseWarehouseDocumentLines(body.kind, body.lines ?? []);
  } catch (err) {
    // Every parse failure is a caller error: missing line, duplicate item,
    // non-positive quantity, or a non-whole-Rial cost.
    const code = err instanceof Error ? err.message : "bad_request";
    return NextResponse.json({ error: code }, { status: 400 });
  }

  try {
    const created = await createWarehouseDocument({
      businessId: session.businessId,
      locationId: body.locationId,
      kind: parsed.kind,
      supplierId: body.supplierId ?? null,
      recipient: body.recipient?.trim() || null,
      documentNumber: body.documentNumber?.trim() || null,
      note: body.note?.trim() || null,
      createdBy: session.sub,
      lines: parsed.lines,
    });
    return NextResponse.json({
      ok: true,
      id: created.id,
      voucherNumber: created.voucherNumber,
      totalValue: created.totalValue,
    });
  } catch (err) {
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error) {
      // Two concurrent posts computing the same voucher sequence collide on
      // the unique index — a retryable conflict, not a 500.
      if ((err as { code?: string }).code === "23505") {
        return NextResponse.json({ error: "voucher_number_taken" }, { status: 409 });
      }
      // The exact-costing guard throws `inventory_exact_cutover_required: …`
      // with the offending row appended — a 409 the UI knows, not a 500.
      if (err.message.startsWith("inventory_exact_cutover_required")) {
        return NextResponse.json({ error: "inventory_exact_cutover_required" }, { status: 409 });
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
      };
      const status = known[err.message];
      if (status) return NextResponse.json({ error: err.message }, { status });
      // An item whose cost basis predates the exact-costing cutover cannot be
      // received until that item is initialised. It is a documented 409 on the
      // amend route; without this it fell through as an unhandled 500.
      if (err.message.startsWith("inventory_exact_cutover_required")) {
        return NextResponse.json({ error: "inventory_exact_cutover_required" }, { status: 409 });
      }
    }
    throw err;
  }
});
