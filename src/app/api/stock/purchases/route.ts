import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { receiveItemPurchase, RetailStockError } from "@/lib/retail-stock-service";
import { enqueueHolooPurchase } from "@/lib/integrations/holoo/outbox-producer";

/** This branch's item purchases plus its suppliers, for the purchase form. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ purchases: [], suppliers: [] });

  const [{ rows: purchases }, { rows: suppliers }] = await Promise.all([
    query<{ id: string; total: string; note: string | null; received_at: string; supplier_name: string | null; line_count: string }>(
      `SELECT p.id, p.total::text, p.note, p.received_at, s.name AS supplier_name,
              (SELECT count(*) FROM item_purchase_items i WHERE i.purchase_id = p.id) AS line_count
         FROM item_purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.location_id = $1
        ORDER BY p.received_at DESC
        LIMIT 100`,
      [location.id],
    ),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM suppliers WHERE location_id = $1 AND is_active ORDER BY name`,
      [location.id],
    ),
  ]);

  return NextResponse.json({
    purchases: purchases.map((p) => ({
      id: p.id,
      total: Number(p.total),
      note: p.note,
      receivedAt: p.received_at,
      supplierName: p.supplier_name,
      lineCount: Number(p.line_count),
    })),
    suppliers,
  });
});

/** Receives one purchase: writes the document, receives stock, posts the AP entry. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: {
    supplierId?: string | null;
    note?: string | null;
    lines?: {
      itemId?: string;
      quantity?: string;
      unitCost?: number;
      /** Batch-tracked items: the real manufacturer/supplier lot number. */
      batchNumber?: string | null;
      expiryDate?: string | null;
      manufactureDate?: string | null;
      supplierReference?: string | null;
      /** Serial-tracked items: the exact physical serials this line receives (issue #795). */
      serials?: { serialNumber?: string; warrantyMonths?: number }[] | null;
    }[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: "empty_purchase" }, { status: 400 });
  }
  if (!body.lines.every((l) => l?.itemId && l?.quantity && Number.isInteger(l?.unitCost))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const purchase = await receiveItemPurchase(client, {
      businessId: session.businessId,
      locationId: location.id,
      supplierId: typeof body.supplierId === "string" ? body.supplierId : null,
      note: body.note,
      createdBy: session.sub,
      lines: body.lines as never[],
    });
    await enqueueHolooPurchase(client, session.businessId, purchase.id, "item_purchase");
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, purchase });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof RetailStockError || err instanceof Error ? err.message : "ثبت خرید ناموفق بود.";
    return NextResponse.json({ error: "purchase_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
