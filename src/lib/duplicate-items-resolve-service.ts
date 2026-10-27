/**
 * Dashboard audit F13 — archiving the losing twin of a creation race
 * (DB-touching). Used by `scripts/resolve-duplicate-items.ts`.
 *
 * Before the creation lock (`lockRemoteIdentity`) two deliveries of one new
 * WooCommerce product each inserted an item and only one kept the mapping; the
 * other stayed behind as an unmapped twin with the same name, SKU and a frozen
 * stock snapshot. The lock stops new ones; this clears the ones already there.
 *
 * What it will do is deliberately small: set `is_active = false` on an unmapped
 * twin of a live WooCommerce-mapped item, and only while nothing at all points
 * at it (`countItemReferences` asks the catalogue for every foreign key into
 * `items`, so a table added later is covered without editing this file). That
 * is reversible — the row, its stock snapshot and its history stay — and it
 * writes an `audit_log` row naming the twin it duplicated. It never merges
 * stock or history, never deletes, and leaves every blocked row to a person.
 */
import type { PoolClient } from "pg";
import { getPool, withTenant, withTenantTransaction } from "./db";
import { findDuplicateItemGroups, type DuplicateReportOptions } from "./duplicate-items-report";
import { planRaceOrphans, type ItemReference, type OrphanBlocker, type OrphanPlan } from "./duplicate-items-resolution";

/** What the integration itself writes when it creates an item — not anyone's history. */
const SYNC_OWNED_TABLES = new Set(["item_stock", "item_variant_attributes"]);

/** The opening price the Woo sync records on create (`woocommerce_product_created`). */
const SYNC_OWNED_PRICE_ROW = "NOT (source = 'sync' AND reason = 'woocommerce_product_created')";

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface ReferenceColumn {
  table: string;
  column: string;
}

async function referenceColumns(client: PoolClient): Promise<ReferenceColumn[]> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(attnum, fattnum)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fattnum AND fa.attname = 'id'
      WHERE c.contype = 'f' AND c.confrelid = 'items'::regclass
      ORDER BY 1, 2`,
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

/**
 * Every row, in every table with a foreign key into `items`, that points at
 * this item — except what the sync itself wrote when it created the row. Reads
 * only; a table that cannot be read throws rather than counting as empty.
 */
export async function countItemReferences(client: PoolClient, itemId: string): Promise<ItemReference[]> {
  const found: ItemReference[] = [];
  for (const { table, column } of await referenceColumns(client)) {
    if (SYNC_OWNED_TABLES.has(table)) continue;
    const extra = table === "product_price_history" ? ` AND ${SYNC_OWNED_PRICE_ROW}` : "";
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE ${quoteIdent(column)} = $1${extra}`,
      [itemId],
    );
    const count = Number(rows[0]?.n ?? 0);
    if (count > 0) found.push({ table, column, count });
  }
  return found;
}

/**
 * Plan every race-orphan group of one business without writing: which unmapped
 * twins may be archived, which are already archived, which are blocked and why.
 */
export async function planDuplicateOrphanArchives(
  businessId: string,
  options: DuplicateReportOptions = {},
): Promise<OrphanPlan[]> {
  const groups = (await findDuplicateItemGroups(businessId, options)).filter((g) => g.verdict === "race_orphan");
  if (groups.length === 0) return [];
  return withTenant(businessId, async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN READ ONLY");
      const plans: OrphanPlan[] = [];
      for (const group of groups) {
        const references = new Map<string, ItemReference[]>();
        for (const member of group.members) {
          if (member.mappings.length === 0) references.set(member.itemId, await countItemReferences(client, member.itemId));
        }
        plans.push(...planRaceOrphans(group.members, references));
      }
      return plans;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
}

export interface ArchiveOrphansResult {
  archived: OrphanPlan[];
  /** Planned as `archive`, but something changed before the write: left alone. */
  changedSincePlan: Array<{ plan: OrphanPlan; blockers: OrphanBlocker[] }>;
}

/**
 * Archive every orphan the plan marks `archive`. Each one is re-checked inside
 * its own transaction, under a row lock, so a mapping, a reference or a twin
 * that changed since the plan stops that row (and only that row).
 */
export async function archiveDuplicateOrphans(
  businessId: string,
  plans: OrphanPlan[],
  options: { actorUserId?: string | null } = {},
): Promise<ArchiveOrphansResult> {
  const result: ArchiveOrphansResult = { archived: [], changedSincePlan: [] };
  for (const plan of plans) {
    if (plan.status !== "archive" || !plan.twinItemId) continue;
    const blockers = await withTenantTransaction(
      businessId,
      async (client) => {
        const { rows: locked } = await client.query<{ is_active: boolean; location_id: string }>(
          `SELECT i.is_active, i.location_id::text
             FROM items i JOIN locations l ON l.id = i.location_id
            WHERE i.id = $1 AND l.business_id = $2 FOR UPDATE OF i`,
          [plan.orphanItemId, businessId],
        );
        if (!locked[0]) return ["has_references" as OrphanBlocker];

        const found: OrphanBlocker[] = [];
        const { rows: orphanMapped } = await client.query(
          `SELECT 1 FROM integration_mappings WHERE business_id = $1 AND local_id = $2 LIMIT 1`,
          [businessId, plan.orphanItemId],
        );
        if (orphanMapped.length > 0 || (await countItemReferences(client, plan.orphanItemId)).length > 0) {
          found.push("has_references");
        }
        const { rows: twin } = await client.query<{ is_active: boolean; woo: boolean }>(
          `SELECT i.is_active,
                  EXISTS (SELECT 1 FROM integration_mappings m
                            JOIN integration_connections c ON c.id = m.connection_id
                           WHERE m.business_id = $2 AND m.local_id = i.id
                             AND m.entity_type = 'product' AND c.provider = 'woocommerce') AS woo
             FROM items i JOIN locations l ON l.id = i.location_id
            WHERE i.id = $1 AND l.business_id = $2`,
          [plan.twinItemId, businessId],
        );
        if (!twin[0] || !twin[0].woo) found.push("twin_not_woo_product");
        else if (!twin[0].is_active) found.push("twin_inactive");
        if (found.length > 0) return found;

        if (locked[0].is_active) {
          await client.query(`UPDATE items SET is_active = false, updated_at = now() WHERE id = $1`, [plan.orphanItemId]);
        }
        await client.query(
          `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
           VALUES ($1, $2, $3, 'item.duplicate_orphan_archived', 'item', $4, $5::jsonb)`,
          [
            businessId,
            locked[0].location_id,
            options.actorUserId ?? null,
            plan.orphanItemId,
            JSON.stringify({
              sku: plan.sku,
              name: plan.orphanName,
              twinItemId: plan.twinItemId,
              orphanQuantity: plan.orphanQuantity,
              twinQuantity: plan.twinQuantity,
              orphanCreatedAt: plan.orphanCreatedAt,
            }),
          ],
        );
        return [] as OrphanBlocker[];
      },
    );
    if (blockers.length > 0) result.changedSincePlan.push({ plan, blockers });
    else result.archived.push(plan);
  }
  return result;
}
