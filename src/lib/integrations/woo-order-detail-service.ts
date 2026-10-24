import { query } from "../db";
import { getConnection } from "./connections-service";
import { isWooRemoteId, normalizeWooOrderSnapshot, UUID_ID, type WooOrderSnapshot } from "./woo-order-snapshot";

export interface WooOrderDetail {
  connectionId: string; storeName: string; locationId: string;
  snapshotId: string; receivedAt: string; revision: string;
  order: WooOrderSnapshot; localOrderId: string | null; localOrderNumber: string | null;
  ingestStatus: string; ingestError: string | null;
  operations: { type: string; status: string; createdAt: string }[];
}
export type WooDetailResult = { ok: true; detail: WooOrderDetail } | { ok: false; status: number; error: "document_not_found" | "woo_snapshot_invalid" | "woo_branch_unassigned" };

/** Explicit tenant AND active-branch association, also used before fallback and preview.
 * A legacy unassigned connection must be assigned in Connections, not guessed
 * from a guessed accounting mapping or the member's current branch.
 */
export async function wooConnectionForPrint(businessId: string, locationId: string, connectionId: string) {
  if (!UUID_ID.test(connectionId)) return null;
  const connection = await getConnection(businessId, connectionId);
  if (!connection || connection.business_id !== businessId || connection.provider !== "woocommerce") return null;
  if (connection.location_id !== locationId) return null;
  return connection;
}

export async function loadWooOrderDetail(input: {
  businessId: string; locationId: string; connectionId: string; remoteId: string; snapshotId?: string;
}): Promise<WooDetailResult> {
  if (!isWooRemoteId(input.remoteId) || !UUID_ID.test(input.connectionId) || (input.snapshotId && !UUID_ID.test(input.snapshotId))) {
    return { ok: false, status: 404, error: "document_not_found" };
  }
  const connection = await wooConnectionForPrint(input.businessId, input.locationId, input.connectionId);
  if (!connection) return { ok: false, status: 404, error: "document_not_found" };
  const { rows } = await query<{
    id: string; payload: unknown; created_at: Date | string; status: string; error: string | null;
    local_order_id: string | null; order_number: string | null;
  }>(
    `SELECT w.id, w.payload, w.created_at, w.status, w.error,
            o.id::text AS local_order_id, o.order_number::text
       FROM integration_webhook_events w
       LEFT JOIN integration_mappings m ON m.business_id = w.business_id
         AND m.connection_id = w.connection_id AND m.remote_id = w.remote_id AND m.entity_type = 'order'
       LEFT JOIN orders o ON o.id = m.local_id AND o.location_id = $4
      WHERE w.business_id = $1 AND w.connection_id = $2 AND w.remote_id = $3
        AND w.event_topic IN ('order.created', 'order.updated', 'order.restored')
        AND ($5::uuid IS NULL OR w.id = $5::uuid)
      ORDER BY w.created_at DESC, w.id DESC LIMIT 1`,
    [input.businessId, input.connectionId, input.remoteId, input.locationId, input.snapshotId ?? null],
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "document_not_found" };
  let order: WooOrderSnapshot;
  try {
    order = normalizeWooOrderSnapshot(row.payload, input.remoteId);
  } catch {
    return { ok: false, status: 409, error: "woo_snapshot_invalid" };
  }
  const receivedAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  const { rows: ops } = await query<{ entity_type: string; status: string; created_at: Date | string }>(
    `SELECT entity_type, status, created_at FROM integration_outbox_events
      WHERE business_id = $1 AND connection_id = $2
        AND (remote_id = $3 OR (entity_type = 'refund_create' AND payload->>'__orderRemoteId' = $3))
        AND entity_type IN ('order_status', 'refund_create')
      ORDER BY created_at DESC LIMIT 20`,
    [input.businessId, input.connectionId, input.remoteId],
  );
  return { ok: true, detail: {
    connectionId: input.connectionId, storeName: connection.name, locationId: input.locationId,
    snapshotId: row.id, receivedAt, revision: row.id, order,
    localOrderId: row.local_order_id, localOrderNumber: row.order_number,
    ingestStatus: row.status, ingestError: row.error,
    operations: ops.map(o => ({ type: o.entity_type, status: o.status, createdAt: o.created_at instanceof Date ? o.created_at.toISOString() : o.created_at })),
  } };
}
