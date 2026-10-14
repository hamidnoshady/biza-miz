import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createItemTransfer, RetailStockError } from "@/lib/retail-stock-service";

/** This business's item transfers, newest first. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const { rows } = await query<{
    id: string;
    status: string;
    note: string | null;
    source: string;
    destination: string;
    created_at: string;
    line_count: string;
  }>(
    `SELECT t.id, t.status::text, t.note, sl.name AS source, dl.name AS destination, t.created_at,
            (SELECT count(*) FROM item_stock_transfer_items i WHERE i.transfer_id = t.id) AS line_count
       FROM item_stock_transfers t
       JOIN locations sl ON sl.id = t.source_location_id
       JOIN locations dl ON dl.id = t.destination_location_id
      WHERE t.business_id = $1
      ORDER BY t.created_at DESC
      LIMIT 100`,
    [session.businessId],
  );

  return NextResponse.json({
    transfers: rows.map((t) => ({
      id: t.id,
      status: t.status,
      note: t.note,
      source: t.source,
      destination: t.destination,
      createdAt: t.created_at,
      lineCount: Number(t.line_count),
    })),
  });
});

/** Creates a draft transfer between two branches. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  let body: {
    sourceLocationId?: string;
    destinationLocationId?: string;
    note?: string | null;
    lines?: {
      sourceItemId?: string;
      destinationItemId?: string;
      quantity?: string;
      /** Batch-tracked items only: move this exact lot instead of FEFO. */
      batchId?: string | null;
    }[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.sourceLocationId || !body.destinationLocationId || !Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const transfer = await createItemTransfer(client, {
      businessId: session.businessId,
      sourceLocationId: body.sourceLocationId,
      destinationLocationId: body.destinationLocationId,
      note: body.note,
      idempotencyKey: randomUUID(),
      createdBy: session.sub,
      lines: body.lines as never[],
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, transfer });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof RetailStockError || err instanceof Error ? err.message : "ایجاد انتقال ناموفق بود.";
    return NextResponse.json({ error: "transfer_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
