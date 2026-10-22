import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { enqueueOperation, sanitizeProductPatch, WooOpsError } from "@/lib/integrations/woo-ops-service";
import { rialToWooAmount } from "@/lib/integrations/woo-money";

/**
 * Push a product change to the store: its name, its price, its stock, whether
 * it is published.
 *
 * The price arrives in Rial and leaves in the store's own unit — a Toman
 * store's «۱۵۰٬۰۰۰ ریال» is «۱۵۰۰۰» to WooCommerce. Doing that conversion
 * here rather than in the browser is what keeps the integer-Rial rule from
 * being re-implemented (and gotten wrong) in the client.
 *
 * Everything else about this route is the outbox: queued, retried, visible.
 * Notably it works identically in plugin mode, where the app holds no
 * credentials for the store and the plugin applies the change on its next
 * run.
 */
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (connection.status === "paused") return NextResponse.json({ error: "connection_paused" }, { status: 409 });

  let body: { remoteId?: string; fields?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const remoteId = String(body.remoteId ?? "").trim();
  if (!remoteId) return NextResponse.json({ error: "missing_remote_id" }, { status: 400 });

  try {
    const fields = { ...(body.fields ?? {}) };
    // A price sent as Rial is converted; one already in the store's unit
    // (a string like "15000") passes through untouched, so a caller that
    // knows what it is doing is not fought over.
    if (typeof fields.priceRial === "string" || typeof fields.priceRial === "number") {
      const value = String(fields.priceRial);
      if (!/^\d+$/.test(value)) return NextResponse.json({ error: "invalid_price" }, { status: 400 });
      fields.regular_price = rialToWooAmount(BigInt(value), connection.currency_unit);
      delete fields.priceRial;
    }
    if (typeof fields.salePriceRial === "string" || typeof fields.salePriceRial === "number") {
      const value = String(fields.salePriceRial);
      if (!/^\d+$/.test(value)) return NextResponse.json({ error: "invalid_sale_price" }, { status: 400 });
      fields.sale_price = rialToWooAmount(BigInt(value), connection.currency_unit);
      delete fields.salePriceRial;
    }
    const patch = sanitizeProductPatch(fields);
    await enqueueOperation(session.businessId, id, "product_update", remoteId, patch);
    return NextResponse.json({ ok: true, queued: true, patch });
  } catch (err) {
    if (err instanceof WooOpsError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
