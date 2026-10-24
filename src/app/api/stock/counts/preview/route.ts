import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation, resolveActiveLocationForUser } from "@/lib/setup-state";
import { previewItemStockCount, type ItemStockCountLineInput } from "@/lib/item-stock-count-service";

/**
 * Server-validated preview for a stock count — the pre-post confirmation
 * that compares tally to current stock, computes variance, ledger impact
 * and warnings (zero-wipe, missing cost basis, changed-since-preview).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  let body: {
    note?: string;
    locationId?: string | null;
    warehouseId?: string | null;
    lines?: ItemStockCountLineInput[];
    snapshotVersion?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const lines = body.lines ?? [];
  if (!Array.isArray(lines) || lines.length === 0) return NextResponse.json({ error: "no_items" }, { status: 400 });

  const requestedLocation = body.locationId || body.warehouseId || null;
  let location: Awaited<ReturnType<typeof resolveActiveLocation>> | null;
  if (requestedLocation) {
    const resolved = await resolveActiveLocationForUser(session.businessId, session.sub, requestedLocation);
    if (!resolved || resolved.id !== requestedLocation) return NextResponse.json({ error: "warehouse_not_accessible" }, { status: 403 });
    location = resolved;
  } else {
    location = await resolveActiveLocation(session);
  }
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    const preview = await previewItemStockCount(client, {
      businessId: session.businessId,
      locationId: location.id,
      note: body.note,
      lines: lines as ItemStockCountLineInput[],
      snapshotVersion: body.snapshotVersion ? Number(body.snapshotVersion) : null,
    });
    return NextResponse.json({ ok: true, preview });
  } catch (err) {
    if (err instanceof Error) {
      const known = [
        "no_items",
        "too_many_lines",
        "invalid_item",
        "invalid_item_parent",
        "unsupported_tracking_serial",
        "unsupported_tracking_weight",
        "duplicate_item",
        "item_not_found",
        "invalid_quantity",
        "quantity_precision_exceeded",
        "quantity_out_of_range",
        "missing_counted_qty",
        "note_too_long",
        "rial_out_of_range",
      ];
      if (known.includes(err.message)) return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  } finally {
    client.release();
  }
});
