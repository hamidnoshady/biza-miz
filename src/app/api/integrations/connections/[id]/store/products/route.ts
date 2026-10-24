import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { localIdForRemote } from "@/lib/integrations/mapping-service";
import { enqueueOperation, sanitizeProductPatch, setProductPushPause, WooOpsError } from "@/lib/integrations/woo-ops-service";
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
 *
 * Issue #943 tightened what gets in: `woocommerce.manage` (the shopfront
 * capability) rather than `integrations.manage` (configuring connections);
 * WooCommerce connections only — a Holoo id is a 404, never outbox work; the
 * remote id must be a numeric WooCommerce id AND mapped to this connection,
 * so a typo or another store's product cannot be queued; the store's own
 * push switches are enforced; and failures answer with stable codes instead
 * of raw internal messages.
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
  const { remoteId: rawRemoteId, fields: rawFields } = body as { remoteId?: unknown; fields?: unknown };
  if (rawFields !== undefined && (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields))) {
    return NextResponse.json({ error: "invalid_fields" }, { status: 400 });
  }

  const remoteId = String(rawRemoteId ?? "").trim();
  // A WooCommerce product id is numeric. Anything else — a UUID, a slug, an
  // empty string — is rejected before it can be queued under a key the
  // outbox, the plugin and the mapping table will never resolve.
  if (!/^\d{1,20}$/.test(remoteId)) {
    return NextResponse.json({ error: "invalid_remote_id" }, { status: 400 });
  }
  // And it must be a product THIS connection has mapped: no queueing edits
  // for ids that belong to another store or were never synced.
  const mappedLocalId = await localIdForRemote(session.businessId, id, "product", remoteId);
  if (!mappedLocalId) {
    return NextResponse.json({ error: "product_not_mapped" }, { status: 404 });
  }

  // The per-product scheduled-push switch (issue #943, item 4): a body of
  // `{ remoteId, pushSettings: { stock?, price? } }` pauses or resumes the
  // AUTOMATIC diff for this one product. It is metadata plus queue hygiene
  // — nothing here is sent to WooCommerce, and manual edits stay possible
  // while an axis is paused. Strict booleans only: a string "false" that
  // coercion turned into a pause would be a switch nobody can read.
  const rawPushSettings = (body as { pushSettings?: unknown }).pushSettings;
  if (rawPushSettings !== undefined) {
    if (typeof rawPushSettings !== "object" || rawPushSettings === null || Array.isArray(rawPushSettings)) {
      return NextResponse.json({ error: "invalid_push_settings" }, { status: 400 });
    }
    const { stock, price } = rawPushSettings as { stock?: unknown; price?: unknown };
    const axes: { stock?: boolean; price?: boolean } = {};
    if (stock !== undefined) {
      if (typeof stock !== "boolean") return NextResponse.json({ error: "invalid_push_settings" }, { status: 400 });
      axes.stock = stock;
    }
    if (price !== undefined) {
      if (typeof price !== "boolean") return NextResponse.json({ error: "invalid_push_settings" }, { status: 400 });
      axes.price = price;
    }
    if (Object.keys(axes).length === 0) {
      return NextResponse.json({ error: "invalid_push_settings" }, { status: 400 });
    }
    try {
      await setProductPushPause(session.businessId, id, remoteId, axes);
      return NextResponse.json({ ok: true, queued: false, pushSettings: axes });
    } catch (err) {
      if (err instanceof WooOpsError) return NextResponse.json({ error: err.message }, { status: 400 });
      console.error("woo_push_settings_failed", { connectionId: id, remoteId, error: (err as Error).message });
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
  }

  try {
    const fields = { ...((rawFields ?? {}) as Record<string, unknown>) };
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

    // The store's push switches are rules, not defaults: an owner who turned
    // off price/stock pushing does not get them re-enabled by a row-level
    // edit — the request is refused with the switch named, so the UI can say
    // which one to change.
    const touchesPrice = "regular_price" in patch || "sale_price" in patch;
    const touchesStock = "stock_quantity" in patch || "manage_stock" in patch;
    if (touchesPrice && !connection.push_prices) {
      return NextResponse.json({ error: "push_prices_disabled" }, { status: 409 });
    }
    if (touchesStock && !connection.push_stock) {
      return NextResponse.json({ error: "push_stock_disabled" }, { status: 409 });
    }

    await enqueueOperation(session.businessId, id, "product_update", remoteId, patch);
    return NextResponse.json({ ok: true, queued: true, patch });
  } catch (err) {
    if (err instanceof WooOpsError) return NextResponse.json({ error: err.message }, { status: 400 });
    // Never hand a raw internal error to the client: the stable code goes
    // out, the detail goes to the server log where it can be diagnosed.
    console.error("woo_product_update_failed", { connectionId: id, remoteId, error: (err as Error).message });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
});
