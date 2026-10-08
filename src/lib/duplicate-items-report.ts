/**
 * Dashboard audit F13 — the read-only duplicate-SKU report (DB-touching).
 *
 * Lists every SKU that more than one `items` row of one business carries, with
 * what an owner needs before merging anything: each row's id, kind, parent,
 * branch, on-hand quantity, every integration mapping that points at it
 * (connection, remote id, remote parent id), and the newest product payload the
 * store sent for that remote id — the source snapshot. The pure verdict lives
 * in `duplicate-items.ts`.
 *
 * It writes nothing: the work runs inside `withTenant` (so RLS confines it to
 * the one business) on a `READ ONLY` transaction that is always rolled back.
 * Used by `scripts/report-duplicate-items.ts`.
 */
import { getPool, withTenant } from "./db";
import {
  classifyDuplicateGroup,
  describeProvenance,
  normaliseSku,
  normaliseStoreKey,
  type DuplicateItemKind,
  type DuplicateItemMapping,
  type DuplicateItemMember,
  type DuplicateVerdict,
} from "./duplicate-items";

export interface DuplicateSourceSnapshot {
  connectionId: string;
  remoteId: string;
  topic: string;
  receivedAt: string;
  status: string;
  sku: string | null;
  name: string | null;
  stockQuantity: number | null;
}

export interface DuplicateReportMember extends DuplicateItemMember {
  provenance: string;
  snapshots: DuplicateSourceSnapshot[];
}

export interface DuplicateSkuGroup {
  sku: string;
  verdict: DuplicateVerdict;
  members: DuplicateReportMember[];
}

export interface DuplicateReportOptions {
  /** Only this SKU (compared trimmed and case-insensitively). */
  sku?: string | null;
}

interface ItemRow {
  id: string;
  name: string;
  sku: string;
  kind: DuplicateItemKind;
  parent_item_id: string | null;
  is_active: boolean;
  location_id: string;
  location_name: string;
  quantity: string | null;
  created_at: Date;
}

interface MappingRow {
  local_id: string;
  connection_id: string;
  connection_name: string;
  provider: string;
  store_url: string | null;
  entity_type: string;
  remote_id: string;
  remote_parent_id: string | null;
}

interface SnapshotRow {
  connection_id: string;
  remote_id: string;
  event_topic: string;
  created_at: Date;
  status: string;
  sku: string | null;
  name: string | null;
  stock_quantity: string | null;
}

export async function findDuplicateItemGroups(
  businessId: string,
  options: DuplicateReportOptions = {},
): Promise<DuplicateSkuGroup[]> {
  const skuFilter = normaliseSku(options.sku ?? null);
  return withTenant(businessId, async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN READ ONLY");
      const { rows: items } = await client.query<ItemRow>(
        `WITH dup AS (
           SELECT lower(btrim(i.sku)) AS key
             FROM items i
             JOIN locations l ON l.id = i.location_id
            WHERE l.business_id = $1
              AND NULLIF(btrim(i.sku), '') IS NOT NULL
              AND ($2::text IS NULL OR lower(btrim(i.sku)) = $2)
            GROUP BY lower(btrim(i.sku))
           HAVING count(*) > 1
         )
         SELECT i.id::text, i.name, i.sku, i.kind, i.parent_item_id::text, i.is_active,
                i.location_id::text, l.name AS location_name, s.quantity::text AS quantity, i.created_at
           FROM items i
           JOIN locations l ON l.id = i.location_id
           JOIN dup d ON d.key = lower(btrim(i.sku))
           LEFT JOIN item_stock s ON s.item_id = i.id
          WHERE l.business_id = $1
          ORDER BY lower(btrim(i.sku)), i.created_at, i.id`,
        [businessId, skuFilter],
      );
      if (items.length === 0) return [];

      const ids = items.map((r) => r.id);
      const { rows: mappings } = await client.query<MappingRow>(
        `SELECT m.local_id::text, m.connection_id::text, c.name AS connection_name, c.provider,
                COALESCE(c.plugin_site_url, c.base_url) AS store_url,
                m.entity_type, m.remote_id,
                NULLIF(m.last_pushed_payload ->> 'remoteParentId', '') AS remote_parent_id
           FROM integration_mappings m
           JOIN integration_connections c ON c.id = m.connection_id
          WHERE m.business_id = $1 AND m.local_id = ANY($2::uuid[])
          ORDER BY c.created_at, m.created_at`,
        [businessId, ids],
      );

      // The newest product payload the store sent for each mapped remote id —
      // what the store said the SKU, name and quantity were.
      const remotePairs = mappings.filter((m) => m.provider === "woocommerce" && m.entity_type === "product");
      let snapshots: SnapshotRow[] = [];
      if (remotePairs.length > 0) {
        const { rows } = await client.query<SnapshotRow>(
          `SELECT DISTINCT ON (e.connection_id, e.remote_id)
                  e.connection_id::text, e.remote_id, e.event_topic, e.created_at, e.status,
                  e.payload ->> 'sku' AS sku, e.payload ->> 'name' AS name,
                  e.payload ->> 'stock_quantity' AS stock_quantity
             FROM integration_webhook_events e
             JOIN unnest($2::uuid[], $3::text[]) AS p(connection_id, remote_id)
               ON p.connection_id = e.connection_id AND p.remote_id = e.remote_id
            WHERE e.business_id = $1 AND e.event_topic LIKE '%product.%'
            ORDER BY e.connection_id, e.remote_id, e.created_at DESC`,
          [businessId, remotePairs.map((m) => m.connection_id), remotePairs.map((m) => m.remote_id)],
        );
        snapshots = rows;
      }

      const mappingsByItem = new Map<string, MappingRow[]>();
      for (const m of mappings) {
        const list = mappingsByItem.get(m.local_id) ?? [];
        list.push(m);
        mappingsByItem.set(m.local_id, list);
      }

      const groups = new Map<string, DuplicateReportMember[]>();
      for (const row of items) {
        const rowMappings = mappingsByItem.get(row.id) ?? [];
        const member: DuplicateItemMember = {
          itemId: row.id,
          name: row.name,
          sku: row.sku,
          kind: row.kind,
          parentItemId: row.parent_item_id,
          isActive: row.is_active,
          locationId: row.location_id,
          locationName: row.location_name,
          quantity: row.quantity,
          createdAt: row.created_at.toISOString(),
          mappings: rowMappings.map(
            (m): DuplicateItemMapping => ({
              connectionId: m.connection_id,
              connectionName: m.connection_name,
              provider: m.provider,
              storeKey: normaliseStoreKey(m.store_url),
              entityType: m.entity_type,
              remoteId: m.remote_id,
              remoteParentId: m.remote_parent_id,
            }),
          ),
        };
        const memberSnapshots = snapshots
          .filter((s) => rowMappings.some((m) => m.connection_id === s.connection_id && m.remote_id === s.remote_id))
          .map(
            (s): DuplicateSourceSnapshot => ({
              connectionId: s.connection_id,
              remoteId: s.remote_id,
              topic: s.event_topic,
              receivedAt: s.created_at.toISOString(),
              status: s.status,
              sku: s.sku,
              name: s.name,
              stockQuantity: s.stock_quantity == null || s.stock_quantity === "" ? null : Number(s.stock_quantity),
            }),
          );
        const key = normaliseSku(row.sku)!;
        const list = groups.get(key) ?? [];
        list.push({ ...member, provenance: describeProvenance(member), snapshots: memberSnapshots });
        groups.set(key, list);
      }

      return [...groups.entries()].map(([sku, members]) => ({
        sku,
        verdict: classifyDuplicateGroup(members),
        members,
      }));
    } finally {
      // READ ONLY, and rolled back regardless: this report never writes.
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
}
