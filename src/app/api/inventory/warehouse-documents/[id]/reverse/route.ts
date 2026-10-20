import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission, getSession } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";
import {
  createWarehouseDocumentInTransaction,
  parseWarehouseDocumentLines,
} from "@/lib/warehouse-document-service";
import { createHash } from "node:crypto";

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

  const body = (await request.json().catch(() => ({}))) as {
    note?: string;
    idempotencyKey?: string;
  };
  const idempotencyKey = body.idempotencyKey && isUuid(body.idempotencyKey) ? body.idempotencyKey : null;
  const payloadHash = createHash("sha256").update(JSON.stringify({ originalId, ...body })).digest("hex");

  // Idempotency header takes precedence
  const headerKey = request.headers.get("idempotency-key");
  const effectiveKey = headerKey && isUuid(headerKey) ? headerKey : idempotencyKey;

  const { rows: docs } = await query<{
    id: string;
    kind: string;
    location_id: string;
    document_number: string | null;
    internal_voucher_number: string | null;
    reversed_of: string | null;
  }>(
    `SELECT id, kind, location_id, document_number, internal_voucher_number, reversed_of
       FROM warehouse_documents WHERE id=$2 AND business_id=$1`,
    [session.businessId, originalId],
  );
  const original = docs[0];
  if (!original) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const decision = await authorize(await getSession(), { locationId: original.location_id });
  if (!decision.ok) return denialResponse(decision);

  if (original.reversed_of) {
    return NextResponse.json({ error: "already_reversed", message: "سند قبلاً برگشت خورده‌است." }, { status: 409 });
  }
  // Check if a reversal already exists for this original
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

  // If reversing an issue, the carrying value at original time may differ from now;
  // we reverse at the exact original line values so GL/Stock reconcile.
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
    // For F&B we lock inventory_items rows via the service (same deterministic ordering)
    const created = await createWarehouseDocumentInTransaction(client as never, {
      businessId: session.businessId,
      locationId: original.location_id,
      kind: reverseKind as "receipt" | "issue",
      supplierId: null,
      recipient: null,
      documentNumber: null,
      note: body.note ?? `برگشت سند ${original.internal_voucher_number ?? original.document_number ?? originalId}`,
      createdBy: (session as unknown as { userId?: string }).userId ?? null,
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
    if (msg.includes("period_closed") || msg.includes("closed")) {
      return NextResponse.json({ error: "period_closed", message: "دوره مالی بسته است؛ برگشت ممکن نیست." }, { status: 409 });
    }
    if (msg.includes("insufficient") || msg.includes("negative_stock")) {
      return NextResponse.json({ error: "negative_stock", message: msg }, { status: 409 });
    }
    if ((err as { code?: string })?.code === "23505" || msg.includes("23505") || msg.includes("duplicate key")) {
      return NextResponse.json({ error: "conflict", message: "سند تکراری — درخواست قبلاً ثبت شده‌است." }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }
});
