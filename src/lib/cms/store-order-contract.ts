/**
 * cms-store-order-contract/v1 — parse the POST /api/cms/order-events body.
 */
import type { CmsOrder } from "./types";
import type { CmsOrderEventNotice } from "./order-ingest-service";

export const STORE_ORDER_CONTRACT = "cms-store-order-contract/v1";

export function parseOrderPaidNotice(
  body: unknown,
): { ok: true; notice: CmsOrderEventNotice } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_payload" };
  const parsed = body as Record<string, unknown>;
  if (typeof parsed.siteId !== "string" || !parsed.siteId.trim()) {
    return { ok: false, error: "site_id_required" };
  }
  if (typeof parsed.deliveryId !== "string" || !parsed.deliveryId.trim()) {
    return { ok: false, error: "delivery_id_required" };
  }
  if (parsed.event !== "order.paid") return { ok: false, error: "event_must_be_order_paid" };
  const order = parsed.order;
  if (!order || typeof order !== "object") return { ok: false, error: "order_required" };
  const o = order as CmsOrder;
  if (typeof o.id !== "string" || !o.id.trim()) return { ok: false, error: "order_id_required" };
  if (o.status !== "paid") return { ok: false, error: "order_must_be_paid" };
  return {
    ok: true,
    notice: {
      siteId: parsed.siteId,
      deliveryId: parsed.deliveryId,
      event: "order.paid",
      order: o,
    },
  };
}

/** Idempotency tuple documented in migration 0180. */
export function storeOrderIdempotencyKeys(notice: CmsOrderEventNotice): {
  deliveryKey: string;
  orderKey: string;
} {
  return {
    deliveryKey: notice.deliveryId,
    orderKey: notice.order.id,
  };
}
