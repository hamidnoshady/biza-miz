/**
 * Read models for `cms_store_order_inbox` and `cms_order_state_outbox` —
 * ingest + outbound state sync visibility on the CMS orders UI.
 */
import { query } from "../db";
import type { CmsOrderOutboxAxis, CmsOrderOutboxState } from "./order-state-sync-policy";

export type CmsOrderInboxStatus = "pending" | "processed" | "failed" | "duplicate";

export interface CmsOrderInboxRow {
  cmsOrderId: string;
  error: string | null;
  importedOrderId: string | null;
  reversed: boolean;
  status: CmsOrderInboxStatus;
}

export interface CmsOrderSyncAxisSummary {
  outboxId: string;
  axis: CmsOrderOutboxAxis;
  state: CmsOrderOutboxState;
  status: string;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
}

export interface CmsOrderStateSyncSummary {
  cmsOrderId: string;
  posOrderId: string | null;
  fulfillment: CmsOrderSyncAxisSummary | null;
  payment: CmsOrderSyncAxisSummary | null;
}

export async function inboxStatusForCmsOrders(
  cmsConnectionId: string,
  cmsOrderIds: string[],
): Promise<Record<string, CmsOrderInboxRow>> {
  if (cmsOrderIds.length === 0) return {};
  const { rows } = await query<{
    cms_order_id: string;
    event_topic: string;
    status: CmsOrderInboxStatus;
    error: string | null;
    imported_order_id: string | null;
    reversal_amendment_id: string | null;
  }>(
    `SELECT cms_order_id, event_topic, status, error, imported_order_id, reversal_amendment_id
       FROM cms_store_order_inbox
      WHERE cms_connection_id = $1 AND cms_order_id = ANY($2::text[])
      ORDER BY cms_order_id,
               CASE event_topic WHEN 'order.paid' THEN 0 WHEN 'order.submitted' THEN 1 ELSE 2 END,
               created_at DESC`,
    [cmsConnectionId, cmsOrderIds],
  );
  const out: Record<string, CmsOrderInboxRow> = {};
  for (const row of rows) {
    const existing = out[row.cms_order_id];
    if (!existing) {
      out[row.cms_order_id] = {
        cmsOrderId: row.cms_order_id,
        status: row.status,
        error: row.error,
        importedOrderId: row.imported_order_id,
        reversed: row.reversal_amendment_id != null,
      };
      continue;
    }
    if (!existing.importedOrderId && row.imported_order_id) {
      existing.importedOrderId = row.imported_order_id;
    }
    if (row.reversal_amendment_id != null) {
      existing.reversed = true;
    }
    if (existing.status !== "failed" && row.status === "failed") {
      existing.status = "failed";
      existing.error = row.error;
    }
  }
  return out;
}

/**
 * Latest outbound ESH-148 state per axis (`fulfillment`, `payment`) for each
 * CMS order id shown on the CMS orders manager.
 */
export async function syncStatusForCmsOrders(
  cmsConnectionId: string,
  cmsOrderIds: string[],
): Promise<Record<string, CmsOrderStateSyncSummary>> {
  if (cmsOrderIds.length === 0) return {};
  const { rows } = await query<{
    id: string;
    cms_order_id: string;
    pos_order_id: string | null;
    axis: CmsOrderOutboxAxis;
    state: CmsOrderOutboxState;
    status: string;
    attempts: number;
    last_error: string | null;
    delivered_at: string | null;
  }>(
    `SELECT DISTINCT ON (cms_order_id, axis)
            id, cms_order_id, pos_order_id, axis, state, status, attempts,
            last_error, delivered_at::text AS delivered_at
       FROM cms_order_state_outbox
      WHERE cms_connection_id = $1 AND cms_order_id = ANY($2::text[])
      ORDER BY cms_order_id, axis, state_version DESC, created_at DESC`,
    [cmsConnectionId, cmsOrderIds],
  );
  const out: Record<string, CmsOrderStateSyncSummary> = {};
  for (const row of rows) {
    const current = out[row.cms_order_id] ?? {
      cmsOrderId: row.cms_order_id,
      posOrderId: row.pos_order_id,
      fulfillment: null,
      payment: null,
    };
    const summary: CmsOrderSyncAxisSummary = {
      outboxId: row.id,
      axis: row.axis,
      state: row.state,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      deliveredAt: row.delivered_at,
    };
    if (!current.posOrderId && row.pos_order_id) current.posOrderId = row.pos_order_id;
    if (row.axis === "fulfillment") current.fulfillment = summary;
    else current.payment = summary;
    out[row.cms_order_id] = current;
  }
  return out;
}
