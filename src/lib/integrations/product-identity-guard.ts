/**
 * Issue #1592 — one identity decision before any WooCommerce product is created.
 *
 * The creation lock in `mapping-service.ts` serialises the same *connection* and
 * remote id; it cannot see a product that arrived through a previous or
 * different connection. That is how 410 historical pairs appeared in زنی زیبا:
 * an August import created local rows with no mapping, a September (re)connect
 * created the same physical products again under a new connection id — same SKU,
 * same name, different item.
 *
 * Before the `items` INSERT this guard looks at the branch for an active row
 * carrying the same normalised SKU. A row that belongs to *this* connection is
 * either the product's own family (a parent/child sharing a SKU) or one of two
 * remote records with the same code — a source-side problem the report already
 * calls `distinct_remote_records`. Anything else is ambiguous: an unmapped local
 * row, or a row mapped through another connection/store. That must be reviewed,
 * never guessed at, so the caller stages it through the shared reconciliation
 * engine and refuses to create a twin.
 *
 * No merge, no mapping copy, no re-point. Pure database reads on the caller's
 * transaction (the creator's own `BEGIN`, already holding the identity lock).
 */
import type { PoolClient } from "pg";

/** The sentinel a create path throws after staging the record for review. */
export const PRODUCT_IDENTITY_REVIEW_REQUIRED = "product_identity_review_required";

/**
 * Serialise creates that could produce the same SKU in one branch, across
 * connections. The identity lock in `mapping-service` is keyed on connection +
 * remote id, so two *different* connections (a relink, or two stores) can race
 * the same physical product into existence. This transaction-scoped lock is
 * released on commit, after which the loser's re-read sees the winner's row and
 * refuses to create a twin.
 */
export async function lockProductSkuIdentity(
  client: PoolClient,
  locationId: string,
  sku: string | null | undefined,
): Promise<void> {
  const key = (sku ?? "").trim().toLowerCase();
  if (!key) return;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`product-sku:${locationId}:${key}`]);
}

export interface LocalSkuMapping {
  connectionId: string;
  entityType: string;
  remoteId: string;
}

export interface LocalSkuMatch {
  itemId: string;
  name: string;
  kind: string;
  parentItemId: string | null;
  mappings: LocalSkuMapping[];
}

export interface LocalSkuGuardInput {
  businessId: string;
  locationId: string;
  /** The connection doing the create. */
  connectionId: string;
  /** The incoming remote SKU (un-normalised). */
  sku: string | null | undefined;
}

/** True when this row could be the same physical product, not this connection's own family. */
export function isAmbiguousLocalMatch(match: LocalSkuMatch, connectionId: string): boolean {
  // No integration owns it: the historical/reimport shape. A shared SKU alone
  // is not proof, which is exactly why this goes to review rather than a link.
  if (match.mappings.length === 0) return true;
  // Mapped only through the connection creating this product: allowed. A parent
  // and its variations legitimately share the parent's SKU, and two distinct
  // remote records with one SKU stay a source-side `distinct_remote_records`
  // case instead of a new blocking rule.
  return match.mappings.some((mapping) => mapping.connectionId !== connectionId);
}

/** Every active row in the branch carrying the same normalised SKU, with its product mappings. */
export async function findLocalSkuMatches(
  client: PoolClient,
  input: LocalSkuGuardInput,
): Promise<LocalSkuMatch[]> {
  const sku = (input.sku ?? "").trim();
  if (!sku) return [];
  const { rows } = await client.query<{
    item_id: string;
    name: string;
    kind: string;
    parent_item_id: string | null;
  }>(
    `SELECT i.id::text AS item_id, i.name, i.kind, i.parent_item_id::text
       FROM items i
       JOIN locations l ON l.id = i.location_id
      WHERE l.business_id = $1
        AND i.location_id = $2
        AND i.is_active
        AND NULLIF(btrim(i.sku), '') IS NOT NULL
        AND lower(btrim(i.sku)) = lower(btrim($3))
      ORDER BY i.created_at, i.id`,
    [input.businessId, input.locationId, sku],
  );
  if (rows.length === 0) return [];
  const { rows: mappings } = await client.query<{
    local_id: string;
    connection_id: string;
    entity_type: string;
    remote_id: string;
  }>(
    `SELECT local_id::text, connection_id::text, entity_type, remote_id
       FROM integration_mappings
      WHERE business_id = $1 AND entity_type = 'product' AND local_id = ANY($2::uuid[])`,
    [input.businessId, rows.map((row) => row.item_id)],
  );
  const byItem = new Map<string, LocalSkuMapping[]>();
  for (const mapping of mappings) {
    const list = byItem.get(mapping.local_id) ?? [];
    list.push({ connectionId: mapping.connection_id, entityType: mapping.entity_type, remoteId: mapping.remote_id });
    byItem.set(mapping.local_id, list);
  }
  return rows.map((row) => ({
    itemId: row.item_id,
    name: row.name,
    kind: row.kind,
    parentItemId: row.parent_item_id,
    mappings: byItem.get(row.item_id) ?? [],
  }));
}

/**
 * The create-path guard. Throws {@link PRODUCT_IDENTITY_REVIEW_REQUIRED} when a
 * same-SKU local row needs review; the caller stages the incoming record and
 * stops, so no item (and no stock snapshot) is ever written beside it.
 */
export async function assertNoAmbiguousLocalIdentity(
  client: PoolClient,
  input: LocalSkuGuardInput,
): Promise<void> {
  await lockProductSkuIdentity(client, input.locationId, input.sku);
  const matches = await findLocalSkuMatches(client, input);
  if (matches.some((match) => isAmbiguousLocalMatch(match, input.connectionId))) {
    throw new Error(PRODUCT_IDENTITY_REVIEW_REQUIRED);
  }
}
