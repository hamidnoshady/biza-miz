import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { localIdForRemote } from "@/lib/integrations/mapping-service";
import { retryProductQueue } from "@/lib/integrations/woo-ops-service";

/**
 * Retry a product's failed queue events, on purpose (issue #943, item 5).
 *
 * The row on the products page shows «ارسال ناموفق» with the store's own
 * error text; this endpoint is the button under it. It is the ONE path that
 * may resurrect a `dead`/`needs_review`/backed-off event — the scheduled
 * refresh is explicitly forbidden from doing that, because an automatic
 * loop overruling a human decision (or a backoff) is how a queue hammers a
 * store forever. Here a person asked, per product, and the ask is audited.
 *
 * Same gate as the product-edit route: `woocommerce.manage`, this tenant's
 * WooCommerce connection, a numeric remote id that THIS connection mapped —
 * another store's product cannot be requeued with someone's connection id.
 */
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceManage);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (connection.status === "paused") return NextResponse.json({ error: "connection_paused" }, { status: 409 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const remoteId = String((body as { remoteId?: unknown }).remoteId ?? "").trim();
  if (!/^\d{1,20}$/.test(remoteId)) {
    return NextResponse.json({ error: "invalid_remote_id" }, { status: 400 });
  }
  const mappedLocalId = await localIdForRemote(session.businessId, id, "product", remoteId);
  if (!mappedLocalId) {
    return NextResponse.json({ error: "product_not_mapped" }, { status: 404 });
  }

  try {
    const retried = await retryProductQueue(session.businessId, id, remoteId);
    // `retried: 0` is a truthful response, not a failure: nothing was
    // parked for this product, so nothing was requeued.
    return NextResponse.json({ ok: true, retried });
  } catch (err) {
    console.error("woo_product_retry_failed", { connectionId: id, remoteId, error: (err as Error).message });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
});
