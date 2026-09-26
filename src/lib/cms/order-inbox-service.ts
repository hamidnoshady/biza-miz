/**
 * Read models for `cms_store_order_inbox` — ingest status on the CMS orders UI.
 */
import { query } from "../db";

export type CmsOrderInboxStatus = "pending" | "processed" | "failed" | "duplicate";

export interface CmsOrderInboxRow {
  cmsOrderId: string;
  error: string | null;
  importedOrderId: string | null;
  status: CmsOrderInboxStatus;
}

export async function inboxStatusForCmsOrders(
  cmsConnectionId: string,
  cmsOrderIds: string[],
): Promise<Record<string, CmsOrderInboxRow>> {
  if (cmsOrderIds.length === 0) return {};
  const { rows } = await query<{
    cms_order_id: string;
    status: CmsOrderInboxStatus;
    error: string | null;
    imported_order_id: string | null;
  }>(
    `SELECT cms_order_id, status, error, imported_order_id
       FROM cms_store_order_inbox
      WHERE cms_connection_id = $1 AND cms_order_id = ANY($2::text[])`,
    [cmsConnectionId, cmsOrderIds],
  );
  const out: Record<string, CmsOrderInboxRow> = {};
  for (const row of rows) {
    out[row.cms_order_id] = {
      cmsOrderId: row.cms_order_id,
      status: row.status,
      error: row.error,
      importedOrderId: row.imported_order_id,
    };
  }
  return out;
}
