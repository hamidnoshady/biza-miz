/**
 * Dashboard audit F13 / issue #1592 — archiving a proven surplus duplicate row
 * (DB-touching). Used by `scripts/resolve-duplicate-items.ts` and the duplicate
 * review screen.
 *
 * Before the creation lock (`lockRemoteIdentity`) two deliveries of one new
 * WooCommerce product each inserted an item and only one kept the mapping; the
 * other stayed behind as an unmapped twin with the same name, SKU and a frozen
 * stock snapshot. The lock stops new ones; this clears the ones already there.
 * Issue #1592 adds the same shape weeks apart (an August row beside a September
 * one, from a reconnected store) as a *separate* fingerprint.
 *
 * What it will do is deliberately small: set `is_active = false` on an unmapped
 * twin of a live WooCommerce-mapped item of the same product, and only while
 * nothing points at it (`countItemReferences` asks the catalogue for every
 * foreign key into `items`) and its explicit `item_stock` quantity is zero. That
 * is reversible — the row, its stock snapshot and its history stay — and it
 * writes an `audit_log` row naming the twin it duplicated. It never merges
 * stock or history, never deletes, and leaves every blocked row to a person.
 */
import type { PoolClient } from "pg";
import { getPool, withTenant, withTenantTransaction } from "./db";
import { findDuplicateItemGroups, type DuplicateReportOptions, type DuplicateSkuGroup } from "./duplicate-items-report";
import {
  planHistoricalDuplicates,
  planRaceOrphans,
  planVariantFamilyOrphans,
  type ItemInventory,
  type ItemReference,
  type OrphanBlocker,
  type OrphanPlan,
} from "./duplicate-items-resolution";
import type { DuplicateVerdict } from "./duplicate-items";

/** What the integration itself writes when it creates an item — not anyone's history. */
const SYNC_OWNED_TABLES = new Set(["item_stock", "item_variant_attributes"]);

/** The opening price the Woo sync records on create (`woocommerce_product_created`). */
const SYNC_OWNED_PRICE_ROW = "NOT (source = 'sync' AND reason = 'woocommerce_product_created')";

/** The audit row written when a proven duplicate row is archived. */
export function archiveActionFor(kind: OrphanPlan["kind"]): string {
  if (kind === "historical_variant_orphan") return "item.duplicate_variant_orphan_archived";
  return kind === "historical_duplicate_candidate"
    ? "item.duplicate_historical_archived"
    : "item.duplicate_orphan_archived";
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Same comparison the planner uses, so the re-check cannot disagree with it. */
function normalisedName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
 *
 * `item_stock` is skipped *here* on purpose (the sync owns that snapshot), but
 * that is exactly why {@link readItemInventories} exists: an empty foreign-key
 * scan must never be read as "no inventory". The archive plan asks both.
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
 * The explicit `item_stock` reading for each row, keyed by item id.
 *
 * Every requested id gets an entry (null quantity means the row has no stock
 * snapshot at all), so a missing key is "the database did not answer" — which
 * the planner blocks — rather than an accidental zero.
 */
export async function readItemInventories(
  client: PoolClient,
  itemIds: readonly string[],
): Promise<Map<string, ItemInventory>> {
  const inventories = new Map<string, ItemInventory>();
  if (itemIds.length === 0) return inventories;
  const { rows } = await client.query<{ item_id: string; quantity: string | null }>(
    `SELECT i.id::text AS item_id, s.quantity::text AS quantity
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = ANY($1::uuid[])`,
    [itemIds],
  );
  for (const row of rows) inventories.set(row.item_id, { quantity: row.quantity });
  return inventories;
}

/**
 * Plan every duplicate group of one business without writing: which rows may
 * be archived, which are already archived, which are blocked and why. Both the
 * ten-minute race and the weeks-apart historical duplicate are planned, each
 * with its own fingerprint; nothing here widens the race window.
 */
export async function planDuplicateOrphanArchives(
  businessId: string,
  options: DuplicateReportOptions = {},
): Promise<OrphanPlan[]> {
  const groups = (await findDuplicateItemGroups(businessId, options)).filter((g) => PLANNED_VERDICTS.has(g.verdict));
  return planOrphanArchivesForGroups(businessId, groups);
}

const PLANNED_VERDICTS = new Set<DuplicateVerdict>([
  "race_orphan",
  "historical_duplicate_candidate",
  "historical_variant_orphan",
]);

/**
 * The same plan for groups a caller already holds — the duplicate review screen
 * reads the report once and plans from it, instead of reading the catalogue a
 * second time. Writes nothing: `READ ONLY`, rolled back.
 */
export async function planOrphanArchivesForGroups(
  businessId: string,
  groups: readonly DuplicateSkuGroup[],
): Promise<OrphanPlan[]> {
  const planned = groups.filter((g) => PLANNED_VERDICTS.has(g.verdict));
  if (planned.length === 0) return [];
  return withTenant(businessId, async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN READ ONLY");
      const unmappedIds = planned.flatMap((group) =>
        group.members.filter((member) => member.mappings.length === 0).map((member) => member.itemId),
      );
      // One explicit inventory read for the whole plan: the FK scan skips
      // `item_stock`, so quantity is evidence this planner must carry itself.
      const inventories = await readItemInventories(client, [...new Set(unmappedIds)]);
      const plans: OrphanPlan[] = [];
      for (const group of planned) {
        const references = new Map<string, ItemReference[]>();
        for (const member of group.members) {
          if (member.mappings.length === 0) references.set(member.itemId, await countItemReferences(client, member.itemId));
        }
        plans.push(
          ...(group.verdict === "race_orphan"
            ? planRaceOrphans(group.members, references, inventories)
            : group.verdict === "historical_duplicate_candidate"
              ? planHistoricalDuplicates(group.members, references, inventories)
              : planVariantFamilyOrphans(group.members, references, inventories)),
        );
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
 * Reverse one archive this workflow performed.
 *
 * Only a row whose latest archive audit is the duplicate archive can be
 * restored, and only while it is still inactive and still unmapped — so this
 * cannot resurrect a row a person archived for a different reason, and cannot
 * create a second mapped copy. The row was never deleted, so restore is a flag
 * and one audit row; inventory and history were never moved.
 */
export async function restoreArchivedDuplicateItem(
  businessId: string,
  input: { itemId: string; actorUserId?: string | null },
): Promise<{ restored: boolean; reason?: "not_found" | "already_active" | "not_duplicate_archive" }> {
  return withTenantTransaction(businessId, async (client) => {
    const { rows: locked } = await client.query<{ is_active: boolean; location_id: string; sku: string }>(
      `SELECT i.is_active, i.location_id::text, i.sku
         FROM items i JOIN locations l ON l.id = i.location_id
        WHERE i.id = $1 AND l.business_id = $2 FOR UPDATE OF i`,
      [input.itemId, businessId],
    );
    if (!locked[0]) return { restored: false, reason: "not_found" };
    if (locked[0].is_active) return { restored: false, reason: "already_active" };

    const { rows: mappings } = await client.query(
      `SELECT 1 FROM integration_mappings WHERE business_id = $1 AND local_id = $2 LIMIT 1`,
      [businessId, input.itemId],
    );
    const { rows: archivedByThis } = await client.query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE business_id = $1 AND entity = 'item' AND entity_id = $2
          AND action IN ('item.duplicate_orphan_archived', 'item.duplicate_historical_archived',
                         'item.duplicate_variant_orphan_archived')
        ORDER BY created_at DESC LIMIT 1`,
      [businessId, input.itemId],
    );
    if (mappings.length > 0 || archivedByThis.length === 0) {
      return { restored: false, reason: "not_duplicate_archive" };
    }

    await client.query(`UPDATE items SET is_active = true, updated_at = now() WHERE id = $1`, [input.itemId]);
    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, 'item.duplicate_archive_restored', 'item', $4, $5::jsonb)`,
      [
        businessId,
        locked[0].location_id,
        input.actorUserId ?? null,
        input.itemId,
        JSON.stringify({ sku: locked[0].sku, restoredFrom: archivedByThis[0].action }),
      ],
    );
    return { restored: true };
  });
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
        const { rows: locked } = await client.query<{ is_active: boolean; location_id: string; name: string; kind: string }>(
          `SELECT i.is_active, i.location_id::text, i.name, i.kind
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
        // Lock the stock snapshot and read it explicitly. A row that still
        // holds quantity is real inventory, not a leftover pointer: archiving
        // it would take that quantity out of the active catalogue. No
        // `item_stock` row at all is the retail model's "no stock" (the planner
        // reads the same shape), not an unread value.
        const { rows: stock } = await client.query<{ quantity: string | null }>(
          `SELECT quantity::text FROM item_stock WHERE item_id = $1 FOR UPDATE`,
          [plan.orphanItemId],
        );
        if (stock.length > 0 && Number(stock[0].quantity ?? 0) !== 0) found.push("nonzero_stock");

        const { rows: twin } = await client.query<{ is_active: boolean; woo: boolean; name: string; kind: string }>(
          `SELECT i.is_active, i.name, i.kind,
                  EXISTS (SELECT 1 FROM integration_mappings m
                            JOIN integration_connections c ON c.id = m.connection_id
                           WHERE m.business_id = $2 AND m.local_id = i.id
                             AND m.entity_type = 'product' AND c.provider = 'woocommerce') AS woo
             FROM items i JOIN locations l ON l.id = i.location_id
            WHERE i.id = $1 AND l.business_id = $2`,
          [plan.twinItemId, businessId],
        );
        if (!twin[0] || !twin[0].woo) found.push("twin_not_woo_product");
        else {
          if (!twin[0].is_active) found.push("twin_inactive");
          if (normalisedName(twin[0].name) !== normalisedName(locked[0].name)) found.push("different_name");
          if (plan.kind === "historical_variant_orphan") {
            const { rows: children } = await client.query(
              `SELECT 1 FROM items c
                WHERE c.parent_item_id = $1 AND c.location_id = $3 AND c.is_active
                  AND EXISTS (SELECT 1 FROM integration_mappings m
                               WHERE m.business_id = $2 AND m.local_id = c.id AND m.entity_type = 'product')
                LIMIT 1`,
              [plan.twinItemId, businessId, locked[0].location_id],
            );
            if (locked[0].kind !== "simple" || twin[0].kind !== "variant_parent" || children.length === 0) {
              found.push("twin_not_variant_family");
            }
          }
        }
        if (found.length > 0) return found;

        if (locked[0].is_active) {
          await client.query(`UPDATE items SET is_active = false, updated_at = now() WHERE id = $1`, [plan.orphanItemId]);
        }
        await client.query(
          `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
           VALUES ($1, $2, $3, $4, 'item', $5, $6::jsonb)`,
          [
            businessId,
            locked[0].location_id,
            options.actorUserId ?? null,
            archiveActionFor(plan.kind),
            plan.orphanItemId,
            JSON.stringify({
              kind: plan.kind,
              sku: plan.sku,
              name: plan.orphanName,
              twinItemId: plan.twinItemId,
              twinName: plan.twinName,
              orphanQuantity: plan.orphanQuantity,
              twinQuantity: plan.twinQuantity,
              orphanCreatedAt: plan.orphanCreatedAt,
              daysApart: plan.daysApart,
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
