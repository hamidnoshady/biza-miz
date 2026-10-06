/**
 * Phase 26 (issue #125) Wave 6 — rollback of one import run.
 *
 * The run row is locked and verified in the same transaction as the deletes.
 * Every domain delete is keyed only by mappings stamped with this exact run;
 * an unknown, incomplete, cross-connection or already-rolled-back run is
 * refused before any tenant data is touched.
 */
import { getPool } from "../../db";

interface RunMapping extends Record<string, unknown> {
  entity_type: string;
  local_id: string;
  local_created_by_import_run: boolean;
}

/** Return only local rows that this run actually created; links are not owned rows. */
export function localIdsCreatedByImportRun(
  mappings: readonly { entity_type: string; local_id: string; local_created_by_import_run: boolean }[],
  entityType: string,
): string[] {
  return [...new Set(mappings
    .filter((mapping) => mapping.entity_type === entityType && mapping.local_created_by_import_run)
    .map((mapping) => mapping.local_id))];
}

interface RunState extends Record<string, unknown> {
  connection_id: string;
  status: "running" | "completed" | "rolled_back";
}

interface WeightedAverageRollbackItem {
  inventoryItemId: string;
  locationId: string;
  eventCreatedAt: Date;
  previousAvgCost: string | null;
  previousCarryingValueRial: string | null;
  expectedAvgCost: string | null;
  expectedCarryingValueRial: string | null;
}

export function readWeightedAverageRollbackItems(
  event: { location_id: string; created_at: Date; metadata: unknown },
): WeightedAverageRollbackItem[] {
  let metadata = event.metadata;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata) as unknown;
    } catch {
      throw new Error("holoo_import_rollback_metadata_invalid");
    }
  }
  if (metadata === null || metadata === undefined) return [];
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("holoo_import_rollback_metadata_invalid");
  }
  const rollback = (metadata as Record<string, unknown>).rollback;
  if (rollback === undefined) return [];
  if (!rollback || typeof rollback !== "object" || Array.isArray(rollback)) {
    throw new Error("holoo_import_rollback_metadata_invalid");
  }
  const rawItems = (rollback as Record<string, unknown>).weightedAverageItems;
  if (rawItems === undefined) return [];
  if (!Array.isArray(rawItems)) throw new Error("holoo_import_rollback_metadata_invalid");

  return rawItems.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("holoo_import_rollback_metadata_invalid");
    }
    const value = item as Record<string, unknown>;
    const nullableText = (key: string): string | null => {
      const field = value[key];
      if (field === null) return null;
      if (typeof field !== "string") throw new Error("holoo_import_rollback_metadata_invalid");
      return field;
    };
    if (typeof value.inventoryItemId !== "string") throw new Error("holoo_import_rollback_metadata_invalid");
    return {
      inventoryItemId: value.inventoryItemId,
      locationId: event.location_id,
      eventCreatedAt: event.created_at,
      previousAvgCost: nullableText("previousAvgCost"),
      previousCarryingValueRial: nullableText("previousCarryingValueRial"),
      expectedAvgCost: nullableText("expectedAvgCost"),
      expectedCarryingValueRial: nullableText("expectedCarryingValueRial"),
    };
  });
}

export interface RollbackResult {
  runId: string;
  reverted: Record<string, number>;
}

export async function rollbackImportRun(
  businessId: string,
  runId: string,
  expectedConnectionId?: string,
): Promise<RollbackResult> {
  const reverted: Record<string, number> = {};
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: runRows } = await client.query<RunState>(
      `SELECT connection_id, status FROM holoo_import_runs
        WHERE business_id = $1 AND id = $2
        FOR UPDATE`,
      [businessId, runId],
    );
    const run = runRows[0];
    if (!run || (expectedConnectionId && run.connection_id !== expectedConnectionId)) {
      throw new Error("holoo_import_run_not_found");
    }
    if (run.status !== "completed") throw new Error("holoo_import_run_not_rollbackable");

    const { rows } = await client.query<RunMapping>(
      `SELECT entity_type, local_id, local_created_by_import_run FROM integration_mappings
        WHERE business_id = $1 AND import_run_id = $2`,
      [businessId, runId],
    );
    const ids = (type: string) => localIdsCreatedByImportRun(rows, type);

    // Opening inventory maps holoo_stock → inventory_events.id. Include the
    // run's source-linked event as a recovery path if a mapping row is missing.
    const mappedStockEventIds = [...new Set(ids("holoo_stock"))];
    const { rows: stockEvents } = await client.query<{
      id: string;
      location_id: string;
      metadata: unknown;
      created_at: Date;
    }>(
      `SELECT id, location_id, metadata, created_at FROM inventory_events
        WHERE business_id = $1
          AND (id = ANY($2::uuid[]) OR (source_type = 'holoo_import' AND source_id = $3))
        FOR UPDATE`,
      [businessId, mappedStockEventIds, runId],
    );
    const stockEventIds = [...new Set([...mappedStockEventIds, ...stockEvents.map((event) => event.id)])];
    const weightedAverageItems = stockEvents.flatMap(readWeightedAverageRollbackItems);
    for (const snapshot of weightedAverageItems) {
      const { rows: currentItems } = await client.query<{
        avg_cost: string | null;
        carrying_value_rial: string | null;
      }>(
        `SELECT avg_cost::text, carrying_value_rial::text FROM inventory_items
          WHERE id = $1 AND location_id = $2 FOR UPDATE`,
        [snapshot.inventoryItemId, snapshot.locationId],
      );
      const current = currentItems[0];
      if (
        !current ||
        current.avg_cost !== snapshot.expectedAvgCost ||
        current.carrying_value_rial !== snapshot.expectedCarryingValueRial
      ) {
        throw new Error("holoo_import_rollback_inventory_item_changed");
      }
      const { rows: laterMovementRows } = await client.query<{ changed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM stock_movements
            WHERE inventory_item_id = $1
              AND (inventory_event_id IS NULL OR inventory_event_id <> ALL($2::uuid[]))
              AND created_at >= $3
         ) AS changed`,
        [snapshot.inventoryItemId, stockEventIds, snapshot.eventCreatedAt],
      );
      if (laterMovementRows[0]?.changed) throw new Error("holoo_import_rollback_inventory_item_changed");
    }

    // Remove the opening journal first, then movements/lots, then the event.
    // A later user reference is protected by the same RESTRICT constraints as a manual edit.
    if (stockEventIds.length) {
      await client.query(
        `DELETE FROM journal_entries
          WHERE business_id = $2 AND inventory_event_id = ANY($1::uuid[])`,
        [stockEventIds, businessId],
      );
      await client.query(`DELETE FROM inventory_lots WHERE inventory_event_id = ANY($1::uuid[])`, [stockEventIds]);
      const movements = await client.query(
        `DELETE FROM stock_movements WHERE inventory_event_id = ANY($1::uuid[])`,
        [stockEventIds],
      );
      await client.query(
        `DELETE FROM inventory_events WHERE business_id = $2 AND id = ANY($1::uuid[])`,
        [stockEventIds, businessId],
      );
      reverted.holoo_stock = movements.rowCount ?? 0;
    }
    for (const snapshot of weightedAverageItems) {
      const { rowCount } = await client.query(
        `UPDATE inventory_items
            SET avg_cost = $3, carrying_value_rial = $4::bigint
          WHERE id = $1 AND location_id = $2`,
        [snapshot.inventoryItemId, snapshot.locationId, snapshot.previousAvgCost, snapshot.previousCarryingValueRial],
      );
      if (rowCount !== 1) throw new Error("holoo_import_rollback_inventory_item_changed");
    }
    const inventoryItemIds = ids("holoo_inventory_item");
    if (inventoryItemIds.length) {
      const { rowCount } = await client.query(
        `DELETE FROM inventory_items
          WHERE id = ANY($1::uuid[])
            AND location_id IN (SELECT id FROM locations WHERE business_id = $2)`,
        [inventoryItemIds, businessId],
      );
      reverted.holoo_inventory_item = rowCount ?? 0;
    }

    // Journal entries (their lines cascade via ON DELETE CASCADE).
    const journalIds = ids("holoo_journal");
    if (journalIds.length) {
      const { rowCount } = await client.query(
        `DELETE FROM journal_entries WHERE id = ANY($1::uuid[]) AND business_id = $2`,
        [journalIds, businessId],
      );
      reverted.holoo_journal = rowCount ?? 0;
    }

    // Accounts (journal_lines already gone; parent_id self-ref is SET NULL).
    const accountIds = ids("holoo_account");
    if (accountIds.length) {
      const { rowCount } = await client.query(
        `DELETE FROM accounts WHERE id = ANY($1::uuid[]) AND business_id = $2`,
        [accountIds, businessId],
      );
      reverted.holoo_account = rowCount ?? 0;
    }

    // Goods — could be menu_items (food service) or items (retail).
    const goodsIds = ids("holoo_goods");
    if (goodsIds.length) {
      const menu = await client.query(`DELETE FROM menu_items WHERE id = ANY($1::uuid[])`, [goodsIds]);
      const retail = await client.query(`DELETE FROM items WHERE id = ANY($1::uuid[])`, [goodsIds]);
      reverted.holoo_goods = (menu.rowCount ?? 0) + (retail.rowCount ?? 0);
    }

    // Persons — customers or suppliers.
    const personIds = ids("holoo_customer");
    if (personIds.length) {
      const cust = await client.query(
        `DELETE FROM parties WHERE id = ANY($1::uuid[]) AND business_id = $2`,
        [personIds, businessId],
      );
      const sup = await client.query(`DELETE FROM suppliers WHERE id = ANY($1::uuid[])`, [personIds]);
      reverted.holoo_customer = (cust.rowCount ?? 0) + (sup.rowCount ?? 0);
    }

    // Drop only this run's identity rows, then atomically mark the run.
    await client.query(
      `DELETE FROM integration_mappings WHERE business_id = $1 AND import_run_id = $2`,
      [businessId, runId],
    );
    const marked = await client.query(
      `UPDATE holoo_import_runs
          SET status = 'rolled_back',
              summary = jsonb_set(COALESCE(summary, '{}'::jsonb), '{rollbackState}', '"rolled_back"'::jsonb, true)
        WHERE business_id = $1 AND id = $2 AND status = 'completed'`,
      [businessId, runId],
    );
    if (marked.rowCount !== 1) throw new Error("holoo_import_run_not_rollbackable");

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { runId, reverted };
}
