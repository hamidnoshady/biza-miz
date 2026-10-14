import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  createWarehouseDocument,
  listWarehouseDocuments,
  isWarehouseDocumentKind,
  parseWarehouseDocumentLines,
} from "@/lib/warehouse-document-service";

/**
 * Phase 42 — warehouse documents (رسید/حواله انبار).
 *
 * GET lists the documents a business has posted (optionally by kind and
 * warehouse); POST creates and posts one. Creation runs the exact-costing
 * path and the ledger entry in one transaction (warehouse-document-service),
 * so a document never exists without its stock movement and journal lines.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const locationId = url.searchParams.get("locationId");
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 1), 500);

  const clauses = ["d.business_id = $1"];
  const params: unknown[] = [session.businessId];
  if (kind !== null && kind !== "") {
    if (!isWarehouseDocumentKind(kind)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    params.push(kind);
    clauses.push(`d.kind = $${params.length}`);
  }
  if (locationId !== null && locationId !== "") {
    // A non-uuid locationId would raise `invalid input syntax for type uuid`
    // (a 500), not "no rows" — refuse it as the caller error it is.
    if (!isUuid(locationId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    params.push(locationId);
    clauses.push(`d.location_id = $${params.length}`);
  }

  const documents = await listWarehouseDocuments(session.businessId, {
    kind: kind === null || kind === "" ? undefined : kind,
    locationId: locationId === null || locationId === "" ? undefined : locationId,
    limit,
  });
  return NextResponse.json({ documents });
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
    return NextResponse.json({ ok: true, id: created.id, totalValue: created.totalValue });
  } catch (err) {
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error) {
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
