import { parseRetailReturn, requestKey } from "@/lib/retail-purchase-input";
import { RetailRequestConflict } from "@/lib/retail-stock-request";
import { retailStockMessage } from "@/lib/retail-stock";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createItemSupplierReturn, RetailStockError } from "@/lib/retail-stock-service";


/** Sends purchased stock back to the supplier, with the settlement posting. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: ReturnType<typeof parseRetailReturn>;
  let idempotencyKey: string;
  try {
    const raw: unknown = await request.json();
    body = parseRetailReturn(raw);
    if ((raw as Record<string, unknown>).locationId !== undefined && (raw as Record<string, unknown>).locationId !== location.id) {
      return NextResponse.json({ error: "location_changed", message: "شعبه تغییر کرده است؛ درخواست قبلی را در شعبهٔ اصلی پیگیری کنید." }, { status: 409 });
    }
    idempotencyKey = requestKey((raw as Record<string, unknown>).idempotencyKey);
  } catch (err) {
    const code = err instanceof Error && !(err instanceof SyntaxError) ? err.message : "bad_request";
    return NextResponse.json({ error: code, message: retailStockMessage(code) }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createItemSupplierReturn(client, {
      businessId: session.businessId,
      locationId: location.id,
      ...body,
      idempotencyKey,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof RetailRequestConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    if (err && typeof err === "object" && "code" in err && /^[0-9A-Z]{5}$/.test(String(err.code))) {
      return NextResponse.json({ error: "stock_operation_failed", message: "ثبت سند ناموفق بود؛ اطلاعات و وضعیت حسابداری را بررسی کنید." }, { status: 409 });
    }
    const known = err instanceof RetailStockError;
    const message = retailStockMessage(known ? err.message : "stock_operation_failed");
    return NextResponse.json({ error: "return_failed", message }, { status: known ? 400 : 500 });
  } finally {
    client.release();
  }
});
