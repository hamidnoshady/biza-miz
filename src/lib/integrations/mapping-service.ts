/**
 * Phase 23 (issue #118) — remote id ↔ local id mapping (DB-touching).
 * One mapping row per (connection, entity_type, remote_id); the unique index
 * is the idempotency backbone for order import and the lookup used to diff
 * stock/price pushes against the last-pushed value.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "../db";

export type MappingEntityType =
  | "product"
  | "customer"
  | "order"
  | "refund"
  // Phase 38 — a WooCommerce product_cat term bridged into `menu_categories`.
  | "category"
  // Phase 26 — Holoo entity kinds (Waves 3–8). See migrations/0104.
  | "holoo_goods"
  | "holoo_customer"
  | "holoo_account"
  | "holoo_invoice"
  | "holoo_purchase"
  | "holoo_receipt"
  | "holoo_stock"
  | "holoo_inventory_item"
  | "holoo_journal"
  | "holoo_document";

const UPSERT_MAPPING_SQL = `INSERT INTO integration_mappings
   (business_id, connection_id, entity_type, remote_id, local_id, import_run_id, local_created_by_import_run)
 VALUES ($1, $2, $3, $4, $5, $6, $7)
 ON CONFLICT (connection_id, entity_type, remote_id)
 DO UPDATE SET local_id = EXCLUDED.local_id,
               import_run_id = COALESCE(EXCLUDED.import_run_id, integration_mappings.import_run_id),
               local_created_by_import_run = CASE
                 WHEN EXCLUDED.import_run_id IS NULL THEN integration_mappings.local_created_by_import_run
                 ELSE EXCLUDED.local_created_by_import_run
               END,
               updated_at = now()`;

function mappingParams(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  localId: string,
  importRunId: string | null | undefined,
  localCreatedByImportRun: boolean,
): unknown[] {
  const runId = importRunId ?? null;
  return [businessId, connectionId, entityType, remoteId, localId, runId, Boolean(runId && localCreatedByImportRun)];
}

export async function upsertMapping(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  localId: string,
  /** Phase 26 Wave 6 — the import run that associated this mapping. */
  importRunId?: string | null,
  /** False for links to an existing local row (for example a seed account). */
  localCreatedByImportRun = Boolean(importRunId),
): Promise<void> {
  await query(
    UPSERT_MAPPING_SQL,
    mappingParams(businessId, connectionId, entityType, remoteId, localId, importRunId, localCreatedByImportRun),
  );
}

/** Write an identity mapping on the caller's open transaction. */
export async function upsertMappingOnClient(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  localId: string,
  importRunId?: string | null,
  localCreatedByImportRun = Boolean(importRunId),
): Promise<void> {
  await client.query(
    UPSERT_MAPPING_SQL,
    mappingParams(businessId, connectionId, entityType, remoteId, localId, importRunId, localCreatedByImportRun),
  );
}

const LOCAL_ID_FOR_REMOTE_SQL = `SELECT local_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`;

export async function localIdForRemote(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
): Promise<string | null> {
  const { rows } = await query<{ local_id: string }>(LOCAL_ID_FOR_REMOTE_SQL, [businessId, connectionId, entityType, remoteId]);
  return rows[0]?.local_id ?? null;
}

/**
 * The same lookup, on the caller's transaction. A mapping written earlier in
 * that transaction is invisible to the pool, so a writer that links and then
 * resolves inside one transaction must use this form.
 */
export async function localIdForRemoteOnClient(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ local_id: string }>(LOCAL_ID_FOR_REMOTE_SQL, [businessId, connectionId, entityType, remoteId]);
  return rows[0]?.local_id ?? null;
}

export interface MappingRow {
  entityType: MappingEntityType;
  remoteId: string;
  localId: string;
  lastPushedPayload: unknown;
}

export async function listMappings(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
): Promise<MappingRow[]> {
  const { rows } = await query<{ entity_type: MappingEntityType; remote_id: string; local_id: string; last_pushed_payload: unknown }>(
    `SELECT entity_type, remote_id, local_id, last_pushed_payload
       FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3`,
    [businessId, connectionId, entityType],
  );
  return rows.map((r) => ({
    entityType: r.entity_type,
    remoteId: r.remote_id,
    localId: r.local_id,
    lastPushedPayload: r.last_pushed_payload,
  }));
}

/**
 * Merge a few keys into a mapping's metadata without discarding the rest.
 *
 * Needed because `last_pushed_payload` carries two different things: the
 * value last pushed to the store (stock, price) and facts about the remote
 * object itself — a variation's parent id, without which a later push goes to
 * `products/{variation}` and 404s. `setLastPushedPayload` replaces wholesale,
 * which would let a stock push silently erase the parent id.
 */
export async function mergeMappingMeta(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE integration_mappings
        SET last_pushed_payload = COALESCE(last_pushed_payload, '{}'::jsonb) || $5::jsonb,
            updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`,
    [businessId, connectionId, entityType, remoteId, JSON.stringify(patch)],
  );
}

/** Reads a mapping's metadata, or an empty object when there is none. */
export async function mappingMeta(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await query<{ last_pushed_payload: Record<string, unknown> | null }>(
    `SELECT last_pushed_payload FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`,
    [businessId, connectionId, entityType, remoteId],
  );
  return rows[0]?.last_pushed_payload ?? {};
}

/** Records the value that was last successfully pushed to the store. */
export async function setLastPushedPayload(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  payload: unknown,
): Promise<void> {
  await query(
    `UPDATE integration_mappings SET last_pushed_payload = $5, updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`,
    [businessId, connectionId, entityType, remoteId, JSON.stringify(payload)],
  );
}

/**
 * Take the per-remote-identity lock on the caller's open transaction and
 * return what the identity is mapped to *now* (dashboard audit F13).
 *
 * Creation used to be check-then-insert: read the mapping, find nothing,
 * insert an item, then upsert the mapping with `DO UPDATE SET local_id`. Two
 * deliveries of one new product — WooCommerce fires `product.created` and
 * `product.updated` for a single save, and the plugin queue, the manual
 * catalogue pull and an order's variation stub all reach the same code — both
 * found nothing, both inserted, and the later upsert silently re-pointed the
 * mapping at its own row. The first item stayed behind unmapped: the same
 * name, the same SKU and a stock snapshot frozen at that instant.
 *
 * The UNIQUE (connection_id, entity_type, remote_id) index cannot stop that on
 * its own, because the duplicate is the *item*, not the mapping. This lock is
 * what serialises creation; it is released with the transaction.
 */
export async function lockRemoteIdentity(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
): Promise<string | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `integration-identity:${connectionId}:${entityType}:${remoteId}`,
  ]);
  const { rows } = await client.query<{ local_id: string }>(
    `SELECT local_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`,
    [businessId, connectionId, entityType, remoteId],
  );
  return rows[0]?.local_id ?? null;
}

/**
 * Insert a brand-new mapping on the caller's transaction, refusing to
 * re-point an existing one. Used only after {@link lockRemoteIdentity} said
 * the identity was unmapped; a conflict therefore means a writer that skipped
 * the lock, and throwing (so the caller's item insert rolls back) is the only
 * answer that cannot orphan a row.
 */
export async function insertNewMappingOnClient(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  localId: string,
): Promise<void> {
  const { rowCount } = await client.query(
    `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (connection_id, entity_type, remote_id) DO NOTHING`,
    [businessId, connectionId, entityType, remoteId, localId],
  );
  if (rowCount !== 1) throw new Error("mapping_conflict");
}

/**
 * Create the local row for a remote identity exactly once.
 *
 * Runs `create` in its own transaction under {@link lockRemoteIdentity}. If
 * another delivery mapped the identity first, nothing is created and its
 * local id is returned with `created: false`, so the caller applies its
 * payload as an update instead.
 */
export async function createForRemoteOnce(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  create: (client: PoolClient) => Promise<string>,
): Promise<{ created: boolean; localId: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const mapped = await lockRemoteIdentity(client, businessId, connectionId, entityType, remoteId);
    if (mapped) {
      await client.query("COMMIT");
      return { created: false, localId: mapped };
    }
    const localId = await create(client);
    await insertNewMappingOnClient(client, businessId, connectionId, entityType, remoteId, localId);
    await client.query("COMMIT");
    return { created: true, localId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
