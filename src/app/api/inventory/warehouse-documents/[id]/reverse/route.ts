import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";
import {
  createWarehouseDocumentInTransaction,
  parseWarehouseDocumentLines,
} from "@/lib/warehouse-document-service";
import { buildReversalPayloadHash } from "@/lib/warehouse-idempotency";
import { normaliseReversalReason } from "@/lib/warehouse-document-history";
import { WarehouseDocumentError } from "@/lib/warehouse-document-errors";

type Context = { params: Promise<{ id: string }> };

/**
 * POST reverses a posted warehouse document (#922 P2).
 * Creates an opposite-kind document linked via reversed_of, reuses valuation,
 * checks closed period, negative-stock, and idempotency.
 */
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
  const body = rawBody as { note?: unknown; reason?: unknown; idempotencyKey?: unknown };

  if (body.note != null && typeof body.note !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.reason != null && typeof body.reason !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Idempotency key validation: header or body, must be UUID if present; invalid → 400
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

  // The human reason is what the history panel shows; it also feeds the
  // idempotency hash, so a retry with a *different* reason is a conflict
  // rather than a silent second reversal with someone else's explanation.
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  const payloadHash = buildReversalPayloadHash({
    originalId,
    note: `${typeof body.note === "string" ? body.note : ""}\u0000${reason ?? ""}`,
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
       FROM warehouse_documents WHERE id=$2 AND business_id=$1`,
    [session.businessId, originalId],
  );
  const original = docs[0];
  if (!original) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const decision = await authorize(session, { locationId: original.location_id });
  if (!decision.ok) return denialResponse(decision);

  // Block reversing a reversal (original is itself a reversal)
  if (original.reversed_of || original.is_reversal) {
    return NextResponse.json({ error: "already_reversed", message: "سند برگشت‌خورده قابل برگشت نیست." }, { status: 409 });
  }
  // Check if a reversal already exists for this original (unique partial index enforces, but check for 409 early)
  const { rows: existingReversal } = await query<{ id: string }>(
    `SELECT id FROM warehouse_documents WHERE reversed_of=$1 AND business_id=$2 LIMIT 1`,
    [originalId, session.businessId],
  );
  if (existingReversal.length) {
    return NextResponse.json({ error: "already_reversed", reversalId: existingReversal[0].id }, { status: 409 });
  }

  const { rows: lines } = await query<{
    inventory_item_id: string;
    quantity: string;
    unit_cost: string;
  }>(
    `SELECT inventory_item_id, quantity::text AS quantity, unit_cost::text AS unit_cost
       FROM warehouse_document_lines WHERE document_id=$1`,
    [originalId],
  );
  if (!lines.length) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const reverseKind = original.kind === "receipt" ? "issue" : "receipt";

  // Reverse at the original carrying value and lot, not just line unit cost
  // For F&B the lot is the inventory lot's carrying value; line unit_cost is already that value
  const parsed = parseWarehouseDocumentLines(
    reverseKind,
    lines.map((l) => ({
      inventoryItemId: l.inventory_item_id,
      quantity: l.quantity,
      unitCost: l.unit_cost,
    })),
  );

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await createWarehouseDocumentInTransaction(client as never, {
      businessId: session.businessId,
      locationId: original.location_id,
      kind: reverseKind as "receipt" | "issue",
      supplierId: null,
      recipient: null,
      documentNumber: null,
      note: (typeof body.note === "string" && body.note.trim() ? body.note.trim() : `برگشت سند ${original.internal_voucher_number ?? original.document_number ?? originalId}`),
      reversalReason: normaliseReversalReason(
        reason,
        body.note,
        `برگشت سند ${original.internal_voucher_number ?? original.document_number ?? originalId}`,
      ),
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
    const pgCode = (err as { code?: string })?.code;
    // Typed refusals: the service classes carry both the code and the HTTP
    // status, so the route never classifies an outcome by its message text.
    // A closed period, a short lot, a missing lot and a missing item are all
    // expected answers here, not 500s.
    if (err instanceof WarehouseDocumentError) {
      return NextResponse.json(
        { error: err.code === "period_closed" ? "fiscal_period_locked" : err.code },
        { status: err.status },
      );
    }
    if (pgCode === "23505") {
      // Check if it's idempotency conflict via constraint name / message
      const constraint = (err as { constraint?: string })?.constraint ?? "";
      if (constraint.includes("idempotency") || constraint.includes("reversed_of")) {
        // Need to distinguish idempotency vs reversed_of unique violation
        if (constraint.includes("reversed_of") || constraint.includes("uq_warehouse_documents_reversed_of")) {
          return NextResponse.json({ error: "already_reversed" }, { status: 409 });
        }
        return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
      }
      // Check via existing row for idempotency
      if (effectiveKey) {
        const { rows: existing } = await query<{ id: string; payload_hash: string | null }>(
          `SELECT id, payload_hash FROM warehouse_documents WHERE business_id=$1 AND idempotency_key=$2`,
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
