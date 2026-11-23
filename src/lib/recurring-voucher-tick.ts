/**
 * The recurring-voucher background tick.
 *
 * The same shape every other tick in `server.ts` uses: enumerate the tenants
 * under the documented platform bypass, then wrap each one's work in
 * `withTenant`. The business's own date — not the database server's UTC date —
 * decides what is due (`businessToday`), so a Tehran evening cannot advance a
 * schedule into tomorrow.
 *
 * There is deliberately no "is another tick running" flag. Two servers (or a
 * restarted one) may run this at the same time; the per-template lock and the
 * occurrence/draft unique indexes make the second run a no-op. A best-effort
 * single-flight would only hide exactly the race the design is meant to
 * survive.
 */
import { query, withTenant, withoutTenantScope } from "./db";
import { generateDueOccurrences } from "./recurring-voucher-service";

/** Every ten minutes. A daily schedule does not need a minute tick, and a catch-up queue drains in a few passes. */
export const RECURRING_VOUCHER_TICK_INTERVAL_MS = 10 * 60 * 1000;

export interface RecurringVoucherTickResult {
  businesses: number;
  draftsCreated: number;
  failed: number;
}

export async function runRecurringVoucherTick(): Promise<RecurringVoucherTickResult> {
  const { rows } = await withoutTenantScope(
    "recurring journal voucher tick — enumerating businesses with an active template",
    () =>
      query<{ business_id: string }>(
        `SELECT DISTINCT business_id FROM recurring_journal_templates
          WHERE status = 'active' ORDER BY business_id`,
      ),
  );

  const total: RecurringVoucherTickResult = {
    businesses: rows.length,
    draftsCreated: 0,
    failed: 0,
  };
  for (const row of rows) {
    try {
      const result = await withTenant(row.business_id, () =>
        generateDueOccurrences({ businessId: row.business_id }),
      );
      total.draftsCreated += result.draftsCreated;
      total.failed += result.failed;
    } catch (err) {
      /* One business's broken template must not stop the next business's run. */
      console.error(`recurring voucher tick failed for business ${row.business_id}:`, err);
    }
  }
  return total;
}
