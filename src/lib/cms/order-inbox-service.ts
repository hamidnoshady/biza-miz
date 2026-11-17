/**
 * Read models for `cms_store_order_inbox` — ingest status on the CMS orders UI.
 */
import { query } from "../db";

export type CmsOrderInboxStatus = "pending" | "processed" | "failed" | "duplicate";

export interface CmsOrderInboxRow {
  cmsOrderId: string;
  error: string | null;
  importedOrderId: string | null;
  reversed: boolean;
  status: CmsOrderInboxStatus;
}

export async function inboxStatusForCmsOrders(
  cmsConnectionId: string,
  cmsOrderIds: string[],
): Promise<Record<string, CmsOrderInboxRow>> {
  if (cmsOrderIds.length === 0) return {};
  // One row per (order, topic) since 0299. The café flow writes
  // `order.submitted` first and `order.paid` later, both naming the same POS
  // order; the submitted row is the one the CMS orders screen should show,
  // because it is the one that exists even for a pay-at-counter order.
  const { rows } = await query<{
    cms_order_id: string;
    status: CmsOrderInboxStatus;
    error: string | null;
    imported_order_id: string | null;
    reversal_amendment_id: string | null;
  }>(
    `SELECT DISTINCT ON (cms_order_id)
            cms_order_id, status, error, imported_order_id, reversal_amendment_id
       FROM cms_store_order_inbox
      WHERE cms_connection_id = $1 AND cms_order_id = ANY($2::text[])
      ORDER BY cms_order_id, (event_topic = 'order.submitted') DESC, created_at DESC`,
    [cmsConnectionId, cmsOrderIds],
  );
  const out: Record<string, CmsOrderInboxRow> = {};
  for (const row of rows) {
    out[row.cms_order_id] = {
      cmsOrderId: row.cms_order_id,
      status: row.status,
      error: row.error,
      importedOrderId: row.imported_order_id,
      reversed: row.reversal_amendment_id != null,
    };
  }
  return out;
}
