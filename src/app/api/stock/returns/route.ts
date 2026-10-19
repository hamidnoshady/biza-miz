import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createItemSupplierReturn,
  readItemSupplierReturnByIdempotencyKey,
  retailRequestHash,
  RetailIdempotencyConflictError,
  RetailIdempotencyRaceError,
  RetailStockError,
} from "@/lib/retail-stock-service";

const SETTLEMENT_METHODS = ["accounts_payable", "cash", "bank", "supplier_receivable"] as const;

/** Sends purchased stock back to the supplier, with the settlement posting. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: {
    purchaseId?: string | null;
    settlementMethod?: string;
    reason?: string;
    idempotencyKey?: string;
    lines?: {
      itemId?: string;
      quantity?: string;
      batchId?: string | null;
      /** Serial-tracked items: the exact unit going back (issue #795). */
      serialId?: string | null;
      serialNumber?: string | null;
    }[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0 || !body.reason?.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const settlementMethod = (body.settlementMethod ?? "accounts_payable") as (typeof SETTLEMENT_METHODS)[number];
  if (!SETTLEMENT_METHODS.includes(settlementMethod)) {
    return NextResponse.json({ error: "invalid_settlement_method" }, { status: 400 });
  }
  // Shape-check every id so a malformed value is a stable 400, not a raw
  // Postgres cast error surfaced as a 500 (issue #915).
  const purchaseId = typeof body.purchaseId === "string" && body.purchaseId ? body.purchaseId : null;
  if (purchaseId && !isUuid(purchaseId)) {
    return NextResponse.json({ error: "invalid_purchase" }, { status: 400 });
  }
  for (const line of body.lines) {
    if (typeof line?.itemId !== "string" || !isUuid(line.itemId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (line.batchId != null && !isUuid(line.batchId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (line.serialId != null && !isUuid(line.serialId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  const requestHash = retailRequestHash({
    operation: "stock.supplier_return",
    businessId: session.businessId,
    locationId: location.id,
    purchaseId,
    settlementMethod,
    reason: body.reason,
    lines: body.lines,
  });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createItemSupplierReturn(client, {
      businessId: session.businessId,
      locationId: location.id,
      purchaseId,
      settlementMethod,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey?.trim() || randomUUID(),
      requestHash,
      createdBy: session.sub,
      lines: body.lines as never[],
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof RetailIdempotencyRaceError) {
      // A concurrent request with the same key committed first — answer
      // from the winner exactly as an idempotent retry would.
      const winner = await readItemSupplierReturnByIdempotencyKey(session.businessId, err.idempotencyKey);
      if (winner && (!winner.requestHash || winner.requestHash === requestHash)) {
        return NextResponse.json({ ok: true, id: winner.id, value: winner.value, duplicate: true });
      }
      return NextResponse.json(
        { error: "idempotency_conflict", message: "این شناسهٔ درخواست قبلاً برای درخواست دیگری استفاده شده است." },
        { status: 409 },
      );
    }
    if (err instanceof RetailIdempotencyConflictError) {
      return NextResponse.json({ error: "idempotency_conflict", message: err.message }, { status: 409 });
    }
    const message = err instanceof RetailStockError || err instanceof Error ? err.message : "ثبت برگشت ناموفق بود.";
    return NextResponse.json({ error: "return_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
