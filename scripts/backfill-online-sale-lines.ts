/**
 * Backfill `online_sale_lines` (migration 0209) for online retail orders that
 * were imported before it existed — dashboard audit F01/F04.
 *
 * Without this, a tenant whose whole history predates 0209 (the audit's
 * zaniziba: 75 WooCommerce invoices, no cost basis anywhere) would show no
 * uncosted exposure and no website sales in the variant/brand reports until
 * new orders arrived.
 *
 * What it reconstructs, and only from what the database already holds:
 *
 *   - a line with persisted batch allocations: `known`, COGS = Σ cost_value,
 *     stock `relieved` (the batch engine relieved it);
 *   - the one remaining fungible line of an order whose COGS entry exceeds the
 *     batch-attributed part: `known`, COGS = that difference exactly,
 *     stock `legacy` with the quantity counted as relieved (the pre-0209 code
 *     only relieved stock when it posted COGS);
 *   - several such lines: `unattributed` — a COGS total that cannot honestly
 *     be split back to lines, so no per-line figure is invented;
 *   - any line of an order that posted no COGS for it: `missing`, nothing
 *     relieved (the pre-0209 code returned before the decrement).
 *
 * It never posts, never changes a journal, an order, a payment or a stock
 * quantity, never guesses a cost from a price and never invents a remote date
 * (the fact is dated at the order's own `closed_at`). It is idempotent: a line
 * that already has a fact is skipped.
 *
 * Read-only by default; it prints, per business, what it would write and a
 * reconciliation of the facts' net against the revenue the books posted for
 * the same orders.
 *
 *   npx tsx scripts/backfill-online-sale-lines.ts                     # dry run, every business
 *   npx tsx scripts/backfill-online-sale-lines.ts --business <uuid>   # dry run, one business
 *   npx tsx scripts/backfill-online-sale-lines.ts --business <uuid> --apply
 */
import "dotenv/config";
import { Client } from "pg";
import {
  planLegacyOnlineLines,
  type LegacyOnlineLine,
} from "../src/lib/online-sale-backfill";

const apply = process.argv.includes("--apply");
const businessArgIndex = process.argv.indexOf("--business");
const businessId =
  businessArgIndex >= 0 ? process.argv[businessArgIndex + 1] : null;
if (businessArgIndex >= 0 && !businessId) {
  console.error("--business needs a business id.");
  process.exit(2);
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // An operator's maintenance pass over the whole database, like
    // scripts/normalize-customer-phones.ts: RLS is bypassed explicitly here, and
    // every query below carries its own business predicate.
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const { rows: businesses } = await client.query<{
      id: string;
      name: string;
    }>(
      `SELECT id::text, name FROM businesses WHERE ($1::uuid IS NULL OR id = $1::uuid) ORDER BY name`,
      [businessId],
    );

    let written = 0;
    for (const business of businesses) {
      const { rows } = await client.query<
        LegacyOnlineLine & { business_id: string }
      >(
        `SELECT oi.id AS "orderItemId", oi.order_id AS "orderId", o.location_id AS "locationId",
              oi.item_id AS "itemId", src.source_type AS "sourceType",
              oi.quantity::text AS quantity, (oi.unit_price * oi.quantity)::text AS "netRial",
              COALESCE(o.closed_at, o.opened_at)::text AS "occurredAt",
              (SELECT COALESCE(sum(a.cost_value), 0)::text FROM order_item_batch_allocations a
                WHERE a.order_item_id = oi.id) AS "batchCostRial",
              EXISTS (SELECT 1 FROM order_item_batch_allocations a WHERE a.order_item_id = oi.id) AS "hasBatch",
              (SELECT COALESCE(sum(l.debit), 0)::text
                 FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
                WHERE e.business_id = $1 AND e.source_type = src.source_type AND e.source_id = o.id
                  AND e.posting_kind = 'cogs' AND e.reverses_entry_id IS NULL) AS "orderCogsRial",
              (i.kind = 'variant_parent') AS "isContainer"
         FROM orders o
         JOIN locations loc ON loc.id = o.location_id AND loc.business_id = $1
         JOIN LATERAL (
           SELECT e.source_type FROM journal_entries e
            WHERE e.business_id = $1 AND e.source_id = o.id
              AND e.source_type IN ('woocommerce_order', 'cms_store_order') AND e.posting_kind = 'revenue'
            LIMIT 1
         ) src ON true
         JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN items i ON i.id = oi.item_id
        WHERE o.type = 'retail' AND oi.quantity > 0
          AND NOT EXISTS (SELECT 1 FROM online_sale_lines f WHERE f.order_item_id = oi.id)
        ORDER BY o.opened_at, oi.created_at, oi.id`,
        [business.id],
      );
      if (rows.length === 0) continue;

      const plan = planLegacyOnlineLines(rows);
      const byStatus = new Map<string, { lines: number; netRial: bigint }>();
      for (const fact of plan) {
        const entry = byStatus.get(fact.costStatus) ?? {
          lines: 0,
          netRial: 0n,
        };
        entry.lines += 1;
        entry.netRial += BigInt(fact.netRial);
        byStatus.set(fact.costStatus, entry);
      }
      const orderIds = [...new Set(plan.map((f) => f.orderId))];
      const { rows: revenue } = await client.query<{ net: string }>(
        `SELECT COALESCE(sum(l.credit), 0)::text AS net
         FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.business_id = $1 AND e.source_id = ANY($2::uuid[]) AND e.posting_kind = 'revenue'
          AND a.type = 'revenue' AND e.reverses_entry_id IS NULL`,
        [business.id, orderIds],
      );
      const factNet = plan.reduce((sum, f) => sum + BigInt(f.netRial), 0n);

      console.log(
        `${apply ? "APPLY" : "DRY RUN"} ${business.name} (${business.id}): ${plan.length} line(s) over ${orderIds.length} order(s)`,
      );
      for (const [status, { lines, netRial }] of byStatus) {
        console.log(
          `  ${status.padEnd(14)} ${String(lines).padStart(6)} line(s), net ${netRial} Rial`,
        );
      }
      const posted = BigInt(revenue[0].net);
      console.log(
        `  reconciliation: facts net ${factNet} Rial vs revenue posted ${posted} Rial (difference ${posted - factNet})`,
      );

      if (!apply) continue;
      for (const fact of plan) {
        await client.query(
          `INSERT INTO online_sale_lines
           (order_item_id, order_id, location_id, item_id, source_type, quantity, net_rial,
            cost_status, cogs_rial, stock_outcome, relieved_quantity, short_quantity, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11::numeric, 0, $12)
         ON CONFLICT (order_item_id) DO NOTHING`,
          [
            fact.orderItemId,
            fact.orderId,
            fact.locationId,
            fact.itemId,
            fact.sourceType,
            fact.quantity,
            fact.netRial,
            fact.costStatus,
            fact.cogsRial,
            fact.stockOutcome,
            fact.relievedQuantity,
            fact.occurredAt,
          ],
        );
        written += 1;
      }
    }

    if (apply) {
      await client.query("COMMIT");
      console.log(`Wrote ${written} fact(s).`);
    } else {
      await client.query("ROLLBACK");
      console.log("Dry run — nothing written. Re-run with --apply to write.");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
