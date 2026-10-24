import { query } from "@/lib/db";

export interface ProductWooLink {
  localId: string;
  connectionId: string;
  provider: string;
  storeName: string;
  remoteId: string;
  connectionStatus: "active" | "paused" | "error";
  lastCatalogueSyncAt: string | null;
  lastOutboundStatus: "pending" | "processing" | "sent" | "failed" | "dead" | null;
  lastOutboundSentAt: string | null;
  lastOutboundError: string | null;
}

interface ProductWooLinkRow extends Record<string, unknown> {
  local_id: string;
  connection_id: string;
  provider: ProductWooLink["provider"];
  store_name: string;
  remote_id: string;
  connection_status: ProductWooLink["connectionStatus"];
  last_catalogue_sync_at: string | null;
  outbound_status: ProductWooLink["lastOutboundStatus"];
  outbound_sent_at: string | null;
  outbound_error: string | null;
}

/**
 * Read-only Accounting-side view of Woo product identity and delivery health.
 * Both the mapping and local item are constrained to the authenticated
 * business and active branch; store-specific mappings remain separate rows.
 */
export async function listProductWooLinks(businessId: string, locationId: string): Promise<ProductWooLink[]> {
  const { rows } = await query<ProductWooLinkRow>(
    `SELECT m.local_id::text AS local_id,
            c.id::text AS connection_id,
            c.provider,
            c.name AS store_name,
            m.remote_id,
            c.status AS connection_status,
            c.last_catalogue_sync_at::text AS last_catalogue_sync_at,
            outbound.status AS outbound_status,
            outbound.sent_at::text AS outbound_sent_at,
            outbound.last_error AS outbound_error
       FROM integration_mappings m
       JOIN integration_connections c
         ON c.id = m.connection_id
        AND c.business_id = m.business_id
       JOIN items i
         ON i.id = m.local_id
        AND i.location_id = $2
       LEFT JOIN LATERAL (
         SELECT o.status, o.sent_at, o.last_error
           FROM integration_outbox_events o
          WHERE o.business_id = m.business_id
            AND o.connection_id = m.connection_id
            AND o.local_id = m.local_id
            AND o.entity_type IN ('stock', 'price', 'product_update')
          ORDER BY o.updated_at DESC, o.created_at DESC
          LIMIT 1
       ) outbound ON true
      WHERE m.business_id = $1
        AND m.entity_type = 'product'
        AND (c.location_id IS NULL OR c.location_id = $2)
      ORDER BY i.name, c.name, m.remote_id`,
    [businessId, locationId],
  );

  return rows.map((row) => ({
    localId: row.local_id,
    connectionId: row.connection_id,
    provider: row.provider,
    storeName: row.store_name,
    remoteId: row.remote_id,
    connectionStatus: row.connection_status,
    lastCatalogueSyncAt: row.last_catalogue_sync_at,
    lastOutboundStatus: row.outbound_status,
    lastOutboundSentAt: row.outbound_sent_at,
    lastOutboundError: row.outbound_error,
  }));
}
