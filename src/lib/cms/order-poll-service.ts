/**
 * Phase G2 — poll the CMS platform event feed for `order.paid` when no direct
 * webhook is configured, then ingest through the same path as POST /api/cms/order-events.
 */
import { fetchOrderById } from "./client";
import { getCmsConfigForBusiness } from "./connections";
import { fetchCmsEvents } from "./platform-client";
import {
  advanceStoreOrderIngestCursor,
  getCmsControlConfig,
  resolvePlatformCmsConfig,
} from "./platform-control-service";
import { handleCmsStoreOrderWebhook, resolveCmsConnectionBySiteId, type CmsOrderEventNotice } from "./order-ingest-service";
import type { CmsOrder } from "./types";
import { withTenant } from "../db";

export interface CmsStoreOrderPollResult {
  error?: string;
  ingested: number;
  ok: boolean;
  polled: number;
}

export function orderIdFromEvent(event: { data?: Record<string, unknown>; id: string; kind?: string }): string | null {
  if (typeof event.data?.orderId === "string") return event.data.orderId;
  if (typeof event.data?.id === "string") return event.data.id;
  const parts = event.id.split(":");
  if (parts[0] === "order" && parts[2]) {
    if (parts[1] === "paid") return parts[2];
    if (parts[1] === "refunded" || parts[1] === "cancelled") return parts[2];
  }
  return null;
}

const STORE_ORDER_EVENT_KINDS = ["order.paid", "order.refunded", "order.cancelled"] as const;
type StoreOrderEventKind = (typeof STORE_ORDER_EVENT_KINDS)[number];

function isStoreOrderEventKind(kind: string): kind is StoreOrderEventKind {
  return (STORE_ORDER_EVENT_KINDS as readonly string[]).includes(kind);
}

export async function runCmsStoreOrderPollTick(): Promise<CmsStoreOrderPollResult> {
  const platform = await resolvePlatformCmsConfig();
  if (!platform) return { ok: true, ingested: 0, polled: 0 };

  const control = await getCmsControlConfig();
  let page;
  try {
    page = await fetchCmsEvents(platform, { limit: 200, since: control.storeOrderIngestCursor });
  } catch (err) {
    const message = err instanceof Error ? err.message : "cms_events_failed";
    return { ok: false, ingested: 0, polled: 0, error: message };
  }

  const storeEvents = page.events.filter((e) => e.siteId && isStoreOrderEventKind(e.kind));
  let ingested = 0;

  for (const event of storeEvents) {
    const siteId = event.siteId!;
    const orderId = orderIdFromEvent(event);
    if (!orderId) continue;

    const order = await loadOrderForSite(siteId, orderId);
    if (!order) continue;
    if (event.kind === "order.paid" && order.status !== "paid") continue;
    if (event.kind === "order.refunded" && order.status !== "refunded") continue;
    if (event.kind === "order.cancelled" && order.status !== "cancelled") continue;

    const notice: CmsOrderEventNotice = {
      siteId,
      deliveryId: `poll:${event.id}`,
      event: event.kind,
      order,
    };
    const res = await handleCmsStoreOrderWebhook(notice);
    if (res.status === 200) {
      const body = (await res.json()) as { status?: string };
      if (body.status === "processed") ingested += 1;
    }
  }

  await advanceStoreOrderIngestCursor(page.cursor);
  return { ok: true, ingested, polled: storeEvents.length };
}

async function loadOrderForSite(siteId: string, orderId: string): Promise<CmsOrder | null> {
  const connection = await resolveCmsConnectionBySiteId(siteId);
  if (!connection) return null;

  return withTenant(connection.business_id, async () => {
    try {
      const config = await getCmsConfigForBusiness(connection.business_id);
      return await fetchOrderById(config, orderId);
    } catch {
      return null;
    }
  });
}
