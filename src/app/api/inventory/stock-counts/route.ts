import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createStockCount, listStockCounts, type StockCountLineInput } from "@/lib/stock-count-service";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ counts: [] });

  // The query lives in the service now (issue #883): the MCP read tool
  // `list_stock_counts` runs the exact same query the screen does.
  const counts = await listStockCounts(location.id);
  return NextResponse.json({ counts });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  let body: { note?: string; lines?: StockCountLineInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const lines = body.lines ?? [];
  if (lines.length === 0) return NextResponse.json({ error: "no_items" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createStockCount(client, {
      businessId: session.businessId,
      locationId: location.id,
      note: body.note,
      lines,
      createdBy: session.sub,
      sync: { actorRole: session.role },
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: result.id });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error) {
      const known = [
        "no_items",
        "invalid_item",
        "invalid_quantity",
        "quantity_precision_exceeded",
        "duplicate_item",
        "item_not_found",
      ];
      if (known.includes(err.message)) return NextResponse.json({ error: err.message }, { status: 400 });
      if (err.message === "periodic_system_unsupported") {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
    }
    throw err;
  } finally {
    client.release();
  }
});
