import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";
import {
  createRetailWarehouseDocumentInTransaction,
  parseRetailWarehouseDocumentLines,
} from "@/lib/retail-warehouse-document-service";
import { buildReversalPayloadHash } from "@/lib/warehouse-idempotency";

type Context = { params: Promise<{ id: string }> };

export const POST = withTenantScope(async (request: NextRequest, context: Context) => {
  const guard = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (guard.error) return guard.error;
  const session = guard.session;
  const { id: originalId } = await context.params;
  if (!isUuid(originalId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }
  if (rawBody == null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const body = rawBody as { note?: unknown; idempotencyKey?: unknown };

  if (body.note != null && typeof body.note !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const headerKey = request.headers.get("idempotency-key") ?? request.headers.get("Idempotency-Key");
  let effectiveKey: string | null = null;
  const rawBodyKey = body.idempotencyKey as string | undefined;
  const candidate = (headerKey ?? rawBodyKey ?? null) as string | null;
  if (candidate != null && candidate !== "") {
    if (typeof candidate !== "string" || !isUuid(candidate)) {
      return NextResponse.json({ error: "idempotency_key_invalid" }, { status: 400 });
    }
    effectiveKey = candidate;
  }

  const payloadHash = buildReversalPayloadHash({
    originalId,
    note: typeof body.note === "string" ? body.note : null,
  });

  const { rows: docs } = await query<{
    id: string;
    kind: string;
    location_id: string;
    document_number: string | null;
    internal_voucher_number: string | null;
    reversed_of: string | null;
    is_reversal: boolean;
  }>(
    `SELECT id, kind, location_id, document_number, internal_voucher_number, reversed_of, is_reversal
       FROM retail_warehouse_documents WHERE id=$2 AND business_id=$1`,
    [session.businessId, originalId],
  );
  const original = docs[0];
  if (!original) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const decision = await authorize(session, { locationId: original.location_id });
  if (!decision.ok) return denialResponse(decision);

  if (original.reversed_of || original.is_reversal) {
    return NextResponse.json({ error: "already_reversed", message: "سند برگشت‌خورده قابل برگشت نیست." }, { status: 409 });
  }

  const { rows: existingReversal } = await query<{ id: string }>(
    `SELECT id FROM retail_warehouse_documents WHERE reversed_of=$1 AND business_id=$2 LIMIT 1`,
    [originalId, session.businessId],
  );
  if (existingReversal.length) {
    return NextResponse.json({ error: "already_reversed", reversalId: existingReversal[0].id }, { status: 409 });
  }

  const { rows: lines } = await query<{
    item_id: string;
    quantity: string;
    unit_cost: string;
    lot_number: string | null;
    expiry_date: string | null;
  }>(
    `SELECT item_id, quantity::text AS quantity, unit_cost::text AS unit_cost, lot_number, expiry_date::text
       FROM retail_warehouse_document_lines WHERE document_id=$1`,
    [originalId],
  );
  if (!lines.length) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const reverseKind = original.kind === "receipt" ? "issue" : "receipt";
  // Reverse at original carrying value and lot, not just line unit cost
  const parsed = parseRetailWarehouseDocumentLines(
    reverseKind,
    lines.map((l) => ({
      itemId: l.item_id,
      quantity: l.quantity,
      unitCost: l.unit_cost,
      lot: l.lot_number,
      expiryDate: l.expiry_date,
    })),
  );

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await createRetailWarehouseDocumentInTransaction(client as never, {
      businessId: session.businessId,
      locationId: original.location_id,
      kind: reverseKind as "receipt" | "issue",
      supplierId: null,
      recipient: null,
      documentNumber: null,
      note: (typeof body.note === "string" && body.note.trim() ? body.note.trim() : `برگشت سند ${original.internal_voucher_number ?? original.document_number ?? originalId}`),
      createdBy: session.sub,
      lines: parsed.lines,
      idempotencyKey: effectiveKey,
      payloadHash,
      reversedOf: originalId,
      freeGoodsReason: null,
    });
    await client.query("COMMIT");
    return NextResponse.json({ id: created.id, kind: reverseKind }, { status: 201 });
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    const msg = err instanceof Error ? err.message : String(err);
    const pgCode = (err as { code?: string })?.code;
    if (msg === "fiscal_period_locked" || msg === "fiscal_period_soft_closed" || msg === "fiscal_period_not_defined" || msg === "period_closed") {
      return NextResponse.json({ error: msg === "period_closed" ? "fiscal_period_locked" : msg }, { status: 409 });
    }
    if (msg === "insufficient_stock" || msg === "negative_stock_requires_confirm" || msg === "negative_stock" || msg === "batch_not_found" || msg === "item_not_found" || msg === "not_enough_stock" || msg === "موجودی بچ کافی نیست" || msg === "موجودی کافی نیست") {
      return NextResponse.json({ error: "insufficient_stock" }, { status: 409 });
    }
    if (msg === "idempotency_key_conflict") {
      return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
    }
    if (pgCode === "23505") {
      const constraint = (err as { constraint?: string })?.constraint ?? "";
      if (constraint.includes("reversed_of") || constraint.includes("uq_retail_warehouse_documents_reversed_of")) {
        return NextResponse.json({ error: "already_reversed" }, { status: 409 });
      }
      if (constraint.includes("idempotency")) {
        return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
      }
      if (effectiveKey) {
        const { rows: existing } = await query<{ id: string; payload_hash: string | null }>(
          `SELECT id, payload_hash FROM retail_warehouse_documents WHERE business_id=$1 AND idempotency_key=$2`,
          [session.businessId, effectiveKey],
        );
        if (existing[0]) {
          if (payloadHash && existing[0].payload_hash !== payloadHash) {
            return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
          }
          return NextResponse.json({ id: existing[0].id, kind: reverseKind, duplicate: true }, { status: 200 });
        }
      }
      return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }
});
