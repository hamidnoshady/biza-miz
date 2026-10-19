import { purchaseHistoryInput, PURCHASE_HISTORY_PAGE_SIZE } from "@/lib/purchase-history-input";
import { parseRetailPurchase, requestKey } from "@/lib/retail-purchase-input";
import { RetailRequestConflict } from "@/lib/retail-stock-request";
import { retailStockMessage } from "@/lib/retail-stock";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { receiveItemPurchase, RetailStockError } from "@/lib/retail-stock-service";
import { enqueueHolooPurchase } from "@/lib/integrations/holoo/outbox-producer";

/** This branch's item purchases plus its suppliers, for the purchase form. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ purchases: [], suppliers: [], page: 1, pageSize: PURCHASE_HISTORY_PAGE_SIZE, count: 0, total: "0" });

  let filters: ReturnType<typeof purchaseHistoryInput>;
  try { filters = purchaseHistoryInput(new URL(request.url).searchParams, ["received", "cancelled"]); }
  catch (err) { return NextResponse.json({ error: err instanceof Error && !(err instanceof SyntaxError) ? err.message : "bad_request" }, { status: 400 }); }
  const params: unknown[] = [location.id];
  const conditions = ["p.location_id=$1"];
  for (const [column, value, operator] of [
    ["p.supplier_id", filters.supplierId, "="], ["p.status", filters.status, "="],
    ["p.received_at", filters.dateFrom, ">="], ["p.received_at", filters.dateTo ? `${filters.dateTo}T23:59:59.999999Z` : null, "<="],
  ]) {
    if (value) { params.push(value); conditions.push(`${column} ${operator} $${params.length}`); }
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(`(p.id::text ILIKE $${params.length} OR p.note ILIKE $${params.length} OR s.name ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM item_purchase_items pi JOIN items i ON i.id=pi.item_id
                 WHERE pi.purchase_id=p.id AND (i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length})))`);
  }
  const { rows: summary } = await query<{ count: string; total: string }>(
    `SELECT count(*)::text count,COALESCE(sum(p.total),0)::text total
       FROM item_purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE ${conditions.join(" AND ")}`, params);
  params.push(PURCHASE_HISTORY_PAGE_SIZE, filters.offset);
  const [{ rows: purchases }, { rows: suppliers }] = await Promise.all([
    query<{ id: string; total: string; note: string | null; received_at: string; supplier_name: string | null; line_count: string }>(
      `SELECT p.id, p.total::text, p.note, p.received_at, s.name AS supplier_name,
              (SELECT count(*) FROM item_purchase_items i WHERE i.purchase_id = p.id) AS line_count
         FROM item_purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY p.received_at DESC,p.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM suppliers WHERE location_id = $1 AND is_active ORDER BY name`,
      [location.id],
    ),
  ]);

  return NextResponse.json({
    purchases: purchases.map((p) => ({
      id: p.id,
      total: p.total,
      note: p.note,
      receivedAt: p.received_at,
      supplierName: p.supplier_name,
      lineCount: Number(p.line_count),
    })),
    suppliers,
    page: filters.page, pageSize: PURCHASE_HISTORY_PAGE_SIZE, count: Number(summary[0].count), total: summary[0].total,
  });
});

/** Receives one purchase: writes the document, receives stock, posts the AP entry. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: ReturnType<typeof parseRetailPurchase>;
  let idempotencyKey: string;
  try {
    const raw: unknown = await request.json();
    body = parseRetailPurchase(raw);
    if ((raw as Record<string, unknown>).locationId !== undefined && (raw as Record<string, unknown>).locationId !== location.id) {
      return NextResponse.json({ error: "location_changed", message: "شعبه تغییر کرده است؛ درخواست قبلی را در شعبهٔ اصلی پیگیری کنید." }, { status: 409 });
    }
    idempotencyKey = requestKey((raw as Record<string, unknown>).idempotencyKey);
    if (body.settlementMethod === "credit" && !body.supplierId) throw new Error("supplier_required");
  } catch (err) {
    const code = err instanceof Error && !(err instanceof SyntaxError) ? err.message : "bad_request";
    return NextResponse.json({ error: code, message: retailStockMessage(code) }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const purchase = await receiveItemPurchase(client, {
      businessId: session.businessId,
      locationId: location.id,
      ...body,
      idempotencyKey,
      createdBy: session.sub,
    });
    if (!purchase.duplicate) await enqueueHolooPurchase(client, session.businessId, purchase.id, "item_purchase");
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, purchase: { id: purchase.id, total: purchase.total } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof RetailRequestConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    if (err && typeof err === "object" && "code" in err && /^[0-9A-Z]{5}$/.test(String(err.code))) {
      return NextResponse.json({ error: "stock_operation_failed", message: "ثبت سند ناموفق بود؛ اطلاعات و وضعیت حسابداری را بررسی کنید." }, { status: 409 });
    }
    const known = err instanceof RetailStockError;
    const message = retailStockMessage(known ? err.message : "stock_operation_failed");
    return NextResponse.json({ error: "purchase_failed", message }, { status: known ? 400 : 500 });
  } finally {
    client.release();
  }
});
