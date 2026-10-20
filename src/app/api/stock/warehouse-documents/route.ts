import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { authorize, denialResponse, actionableLocationIds } from "@/lib/authorize";
import { createHash } from "node:crypto";
import {
  createRetailWarehouseDocumentInTransaction,
  isRetailWarehouseDocumentKind,
  parseRetailWarehouseDocumentLines,
  RetailWarehouseDocumentError,
} from "@/lib/retail-warehouse-document-service";

/**
 * Phase 42b — retail warehouse documents (رسید/حواله انبار) on the
 * items/item_stock/item_batches model.
 *
 * GET lists the documents the business has posted (optionally by kind and
 * warehouse, with a search over number/recipient/note); POST creates and
 * posts one. Creation moves the lots/stock and posts the ledger entry in one
 * transaction (retail-warehouse-document-service), so a document never
 * exists without its stock effect and journal lines.
 *
 * P0 branch security: scopes listings to allowed branches and authorizes
 * locationId explicitly. P1 idempotency: header/body key with payload hash.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const locationId = url.searchParams.get("locationId");
  const search = (url.searchParams.get("search") ?? "").trim();
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 1), 500);

  if (kind !== null && kind !== "") {
    if (!isRetailWarehouseDocumentKind(kind)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  if (locationId !== null && locationId !== "") {
    if (!isUuid(locationId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const decision = await authorize(session, { locationId });
    if (!decision.ok) return denialResponse(decision);
  }

  const allowedIds = await actionableLocationIds(guard.membership);
  if (allowedIds.length === 0) {
    return NextResponse.json({ documents: [] });
  }

  const clauses = ["d.business_id = $1"];
  const params: unknown[] = [session.businessId];
  if (kind !== null && kind !== "") {
    params.push(kind);
    clauses.push(`d.kind = $${params.length}`);
  }
  if (locationId !== null && locationId !== "") {
    params.push(locationId);
    clauses.push(`d.location_id = $${params.length}`);
  } else {
    params.push(allowedIds);
    clauses.push(`d.location_id = ANY($${params.length}::uuid[])`);
  }
  if (search) {
    params.push(`%${search}%`);
    clauses.push(
      `(d.document_number ILIKE $${params.length} OR d.recipient ILIKE $${params.length} OR d.note ILIKE $${params.length})`,
    );
  }

  const { rows } = await query(
    `SELECT d.id, d.kind::text AS kind, d.location_id, l.name AS location_name,
            d.recipient, d.document_number, d.note,
            d.total_value_rial::text AS total_value_rial,
            d.created_at, u.full_name AS created_by_name,
            (SELECT count(*) FROM retail_warehouse_document_lines l2
              WHERE l2.document_id = d.id)::int AS line_count
       FROM retail_warehouse_documents d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN users u ON u.id = d.created_by
      WHERE ${clauses.join(" AND ")}
      ORDER BY d.created_at DESC
      LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  return NextResponse.json({ documents: rows });
});

function canonicalPayloadHash(payload: unknown): string {
  const str = JSON.stringify(payload, Object.keys(payload as Record<string, unknown>).sort());
  return createHash("sha256").update(str).digest("hex");
}

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

  const canonicalLines = parsed.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost, lot: l.lotNumber }));
  const payloadHash = canonicalPayloadHash({ kind: parsed.kind, locationId, lines: canonicalLines });

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
      totalValue: created.totalValue,
      entryId: created.entryId,
      debitCode: created.debitCode,
      creditCode: created.creditCode,
    });
  } catch (err) {
    await client.query("ROLLBACK");
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
