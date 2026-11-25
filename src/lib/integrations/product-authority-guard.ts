/**
 * Issue #1592 — no outbound stock/price push while a duplicate row holds the
 * inventory authority.
 *
 * A mapped product row and an unmapped twin can both exist (the historical
 * shape). When the *unmapped* twin holds quantity, the mapped row's
 * `item_stock` is not the whole physical stock, so pushing it to the store
 * would overwrite the real quantity with an empty snapshot. Until an owner
 * reconciles identity and stock, the automatic and manual outbound paths stay
 * quiet for that item. This is a per-item pause, not a global sync disable: the
 * rest of the catalogue keeps pushing.
 */
import { query } from "../db";

export interface DuplicateStockConflict {
  /** The mapped local row (the one the outbox would push). */
  localId: string;
  /** The unmapped row that holds the quantity. */
  twinItemId: string;
  twinQuantity: string;
}

const CONFLICT_SQL = `
  SELECT DISTINCT i.id::text AS local_id, twin.id::text AS twin_item_id, s.quantity::text AS twin_quantity
    FROM integration_mappings m
    JOIN items i ON i.id = m.local_id AND i.is_active
    JOIN items twin
      ON twin.location_id = i.location_id
     AND twin.id <> i.id
     AND twin.is_active
     AND twin.kind = i.kind
     AND twin.parent_item_id IS NOT DISTINCT FROM i.parent_item_id
     AND NULLIF(btrim(twin.sku), '') IS NOT NULL
     AND lower(btrim(twin.sku)) = lower(btrim(i.sku))
    JOIN item_stock s ON s.item_id = twin.id AND s.quantity <> 0
   WHERE m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = 'product'
     AND NULLIF(btrim(i.sku), '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM integration_mappings tm
        WHERE tm.business_id = $1 AND tm.local_id = twin.id
     )`;

/** Every mapped row of this connection whose SKU is shared with a stocked, unmapped twin. */
export async function listDuplicateStockConflicts(
  businessId: string,
  connectionId: string,
): Promise<Map<string, DuplicateStockConflict>> {
  const { rows } = await query<{ local_id: string; twin_item_id: string; twin_quantity: string }>(CONFLICT_SQL, [
    businessId,
    connectionId,
  ]);
  const conflicts = new Map<string, DuplicateStockConflict>();
  for (const row of rows) {
    conflicts.set(row.local_id, {
      localId: row.local_id,
      twinItemId: row.twin_item_id,
      twinQuantity: row.twin_quantity,
    });
  }
  return conflicts;
}

/** The same question for one remote id (the manual publish path). */
export async function duplicateStockConflictForRemote(
  businessId: string,
  connectionId: string,
  remoteId: string,
): Promise<DuplicateStockConflict | null> {
  const { rows } = await query<{ local_id: string; twin_item_id: string; twin_quantity: string }>(
    `${CONFLICT_SQL} AND m.remote_id = $3 LIMIT 1`,
    [businessId, connectionId, remoteId],
  );
  const row = rows[0];
  return row ? { localId: row.local_id, twinItemId: row.twin_item_id, twinQuantity: row.twin_quantity } : null;
}
