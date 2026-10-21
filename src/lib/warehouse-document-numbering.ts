/**
 * Internal warehouse voucher numbers — Issue #923 P1.
 *
 * `W-<Gregorian posting year>-<per-business sequence>`: an auto-assigned,
 * immutable, human-readable internal number, distinct from the optional
 * external `document_number` (supplier invoice / حواله کاغذی). The sequence
 * is per business per year, so a business's first voucher of 1406 is
 * `W-2027-0001` regardless of branch.
 *
 * Uniqueness under concurrency is enforced by the partial unique index on
 * `(business_id, voucher_number)` added in migration 0232: two concurrent
 * posts that compute the same sequence collide on INSERT and one receives a
 * unique violation, which the posting route translates to a retryable 409.
 * The number is computed inside the posting transaction so a rolled-back
 * document never consumes a sequence.
 *
 * Creation-side assignment lives in the two posting services (coordinated
 * with #922); this migration backfills existing posted documents so the
 * register can display, search and export by it.
 */
import type { PoolClient } from "pg";

export type VoucherTable = "warehouse_documents" | "retail_warehouse_documents";

/** The next voucher number for this business, computed inside the caller's transaction. */
export async function nextWarehouseVoucherNumber(
  client: PoolClient,
  businessId: string,
  table: VoucherTable,
): Promise<string> {
  const year = new Date().toISOString().slice(0, 4);
  const prefix = `W-${year}-`;
  const { rows } = await client.query<{ next: string }>(
    `SELECT COALESCE(max(substring(voucher_number from '-(\\d+)$')::int), 0) + 1 AS next
       FROM ${table}
      WHERE business_id = $1 AND voucher_number LIKE $2`,
    [businessId, `${prefix}%`],
  );
  return `${prefix}${String(rows[0]?.next ?? 1).padStart(4, "0")}`;
}
