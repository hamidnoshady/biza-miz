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

export function orderIdFromEvent(event: { data?: Record<string, unknown>; id: string }): string | null {
  if (typeof event.data?.orderId === "string") return event.data.orderId;
  if (typeof event.data?.id === "string") return event.data.id;
  const parts = event.id.split(":");
  if (parts[0] === "order" && parts[1] === "paid" && parts[2]) return parts[2];
  return null;
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

  const paidEvents = page.events.filter((e) => e.kind === "order.paid" && e.siteId);
  let ingested = 0;

  for (const event of paidEvents) {
    const siteId = event.siteId!;
    const orderId = orderIdFromEvent(event);
    if (!orderId) continue;

    const order = await loadOrderForSite(siteId, orderId);
    if (!order || order.status !== "paid") continue;

    const notice: CmsOrderEventNotice = {
      siteId,
      deliveryId: `poll:${event.id}`,
      event: "order.paid",
      order,
    };
    const res = await handleCmsStoreOrderWebhook(notice);
    if (res.status === 200) {
      const body = (await res.json()) as { status?: string };
      if (body.status === "processed") ingested += 1;
    }
  }

  await advanceStoreOrderIngestCursor(page.cursor);
  return { ok: true, ingested, polled: paidEvents.length };
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
