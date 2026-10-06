import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createItemSupplierReturn, RetailStockError } from "@/lib/retail-stock-service";

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

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createItemSupplierReturn(client, {
      businessId: session.businessId,
      locationId: location.id,
      purchaseId: typeof body.purchaseId === "string" ? body.purchaseId : null,
      settlementMethod,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey?.trim() || randomUUID(),
      createdBy: session.sub,
      lines: body.lines as never[],
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof RetailStockError || err instanceof Error ? err.message : "ثبت برگشت ناموفق بود.";
    return NextResponse.json({ error: "return_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
