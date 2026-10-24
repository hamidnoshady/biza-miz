import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { resolveActiveLocation, resolveActiveLocationForUser } from "@/lib/setup-state";
import {
  createItemStockCount,
  searchItemStockCounts,
  previewItemStockCount,
  type ItemStockCountLineInput,
} from "@/lib/item-stock-count-service";

/** Recent physical counts at this branch — now with searchable/paginated filters. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const url = request.nextUrl;
  const requestedLocation = url.searchParams.get("locationId") || url.searchParams.get("warehouseId");
  let locationId: string | null = null;
  if (requestedLocation) {
    const resolved = await resolveActiveLocationForUser(session.businessId, session.sub, requestedLocation);
    if (resolved && resolved.id === requestedLocation) locationId = resolved.id;
    else return NextResponse.json({ error: "warehouse_not_accessible" }, { status: 403 });
  } else {
    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ counts: [], total: 0 });
    locationId = location.id;
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  const search = url.searchParams.get("search");
  const status = url.searchParams.get("status");
  const warehouseId = url.searchParams.get("warehouseId") || url.searchParams.get("warehouse") || undefined;
  const dateFrom = url.searchParams.get("dateFrom") || url.searchParams.get("from");
  const dateTo = url.searchParams.get("dateTo") || url.searchParams.get("to");
  const userId = url.searchParams.get("userId") || undefined;
  const itemId = url.searchParams.get("itemId") || undefined;

  const client = await getPool().connect();
  try {
    const result = await searchItemStockCounts(client, locationId, {
      limit,
      offset,
      search,
      status: status || undefined,
      warehouseId: warehouseId || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      userId: userId || undefined,
      itemId: itemId || undefined,
    });
    return NextResponse.json({ counts: result.counts, total: result.total, limit, offset });
  } finally {
    client.release();
  }
});

/**
 * Record a physical count. The counted quantities become the stock on hand and
 * the difference posts as a variance — one entry for the whole count, shortage
 * and surplus kept apart.
 *
 * Hardened for #921:
 *  - warehouse selection via locationId/body.warehouseId with authorization
 *  - Idempotency-Key header or body.idempotencyKey prevents double post
 *  - preview mode (?preview=true) returns server-validated variance without writing
 *  - snapshotVersion/baselineSnapshot conflict detection for concurrent movements
 *  - actionable 400/409 with structured error codes, never 500 for bad input
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  let body: {
    note?: string;
    warehouseId?: string | null;
    locationId?: string | null;
    lines?: ItemStockCountLineInput[];
    idempotencyKey?: string | null;
    countId?: string | null;
    snapshotVersion?: string | null;
    baselineSnapshot?: Record<string, string> | null;
    preview?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Preview mode — no write, just validated computation
  if (body.preview || request.nextUrl.searchParams.get("preview") === "true") {
    const lines = body.lines ?? [];
    if (lines.length === 0) return NextResponse.json({ error: "no_items" }, { status: 400 });
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
      // Input shape validation before preview
      if (!Array.isArray(lines)) return NextResponse.json({ error: "invalid_lines_shape" }, { status: 400 });
      for (const line of lines) {
        if (!line || typeof line !== "object" || Array.isArray(line)) return NextResponse.json({ error: "invalid_line_shape" }, { status: 400 });
        if (!line.itemId || typeof line.itemId !== "string") return NextResponse.json({ error: "invalid_item" }, { status: 400 });
      }
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
          "batch_detail_required",
          "batch_number_required",
          "invalid_batch_quantity",
          "invalid_batch_cost",
          "batch_count_mismatch",
        ];
        if (known.includes(err.message)) return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  const lines = body.lines ?? [];
  if (!Array.isArray(lines) || lines.length === 0) return NextResponse.json({ error: "no_items" }, { status: 400 });
  if (lines.length > 500) return NextResponse.json({ error: "too_many_lines" }, { status: 400 });

  // Input shape validation — return 400 with actionable code instead of 500
  for (const line of lines) {
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      return NextResponse.json({ error: "invalid_line_shape" }, { status: 400 });
    }
    if (!line.itemId || typeof line.itemId !== "string") {
      return NextResponse.json({ error: "invalid_item" }, { status: 400 });
    }
    if (line.countedQty === undefined || line.countedQty === null || String(line.countedQty).trim() === "") {
      return NextResponse.json({ error: "missing_counted_qty", itemId: line.itemId }, { status: 400 });
    }
    if (line.batches && !Array.isArray(line.batches)) {
      return NextResponse.json({ error: "invalid_batch_shape" }, { status: 400 });
    }
    // UUID format check — prevents SQL-level uuid syntax error → 500
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line.itemId)) {
      return NextResponse.json({ error: "invalid_item" }, { status: 400 });
    }
  }
  if (body.note && body.note.length > 2000) return NextResponse.json({ error: "note_too_long" }, { status: 400 });
  if (body.warehouseId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.warehouseId)) {
    return NextResponse.json({ error: "invalid_warehouse" }, { status: 400 });
  }
  if (body.locationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.locationId)) {
    return NextResponse.json({ error: "invalid_warehouse" }, { status: 400 });
  }

  // Warehouse scoping — explicit selector or active location, validated against member's access
  const requestedLocation = body.locationId || body.warehouseId || null;
  let location: Awaited<ReturnType<typeof resolveActiveLocation>> | null;
  if (requestedLocation) {
    const resolved = await resolveActiveLocationForUser(session.businessId, session.sub, requestedLocation);
    if (!resolved || resolved.id !== requestedLocation) {
      return NextResponse.json({ error: "warehouse_not_accessible" }, { status: 403 });
    }
    location = resolved;
  } else {
    location = await resolveActiveLocation(session);
  }
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  // Idempotency — header wins over body, both are optional
  const headerKey = request.headers.get("Idempotency-Key") || request.headers.get("idempotency-key");
  const idempotencyKey = headerKey?.trim() || body.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > 200) {
    return NextResponse.json({ error: "idempotency_key_too_long" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createItemStockCount(client, {
      businessId: session.businessId,
      locationId: location.id,
      note: body.note,
      lines: lines as ItemStockCountLineInput[],
      createdBy: session.sub,
      countId: body.countId ?? undefined,
      idempotencyKey,
      snapshotVersion: body.snapshotVersion ?? null,
      baselineSnapshot: body.baselineSnapshot ?? null,
      sync: { actorRole: session.role },
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error) {
      const known400 = [
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
        "batch_detail_required",
        "batch_number_required",
        "invalid_batch_quantity",
        "invalid_batch_cost",
        "batch_count_mismatch",
        "count_batch_shortage_exceeds_sellable",
        "invalid_lines_shape",
        "invalid_line_shape",
        "invalid_batch_shape",
        "invalid_warehouse",
        "idempotency_key_too_long",
      ];
      if (known400.includes(err.message)) return NextResponse.json({ error: err.message }, { status: 400 });
      if (err.message === "snapshot_conflict") {
        return NextResponse.json(
          {
            error: "snapshot_conflict",
            message: "موجودی از زمان شروع شمارش تغییر کرده است؛ پیش‌نمایش را تازه کنید و دوباره بررسی کنید.",
          },
          { status: 409 },
        );
      }
      if (err.message === "count_batch_concurrent_conflict") {
        return NextResponse.json({ error: "concurrent_conflict" }, { status: 409 });
      }
    }
    throw err;
  } finally {
    client.release();
  }
});
