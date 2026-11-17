/**
 * Phase 27 Wave 12 — read-only F&B waste analytics.
 *
 * Waste is already a posting fact: the waste route writes a `waste`
 * stock_movement and posts Debit wasteExpense / Credit inventory. This just
 * reads those back — no new posting, no new table — and cross-checks the
 * movement total against the waste expense account's ledger balance for the
 * same period, so the two can never silently disagree.
 */
import { query } from "./db";

export interface WasteReasonRow {
  reason: string;
  quantity: string;
  cost: number;
}

export interface WasteReport {
  rows: WasteReasonRow[];
  totalCost: number;
  ledgerWasteExpense: number;
}

export async function wasteReport(
  businessId: string,
  locationId: string,
  options: { from?: string; to?: string } = {},
): Promise<WasteReport> {
  const { rows } = await query<{ reason: string; quantity: string; cost: string }>(
    `SELECT COALESCE(sm.waste_reason, 'other') AS reason,
            SUM(-sm.quantity)::text AS quantity,
            SUM(-sm.quantity * sm.unit_cost)::text AS cost
       FROM stock_movements sm
      WHERE sm.location_id = $1 AND sm.type = 'waste'
        AND ($2::date IS NULL OR sm.occurred_at >= $2::date)
        AND ($3::date IS NULL OR sm.occurred_at < ($3::date + 1))
      GROUP BY COALESCE(sm.waste_reason, 'other')
      ORDER BY cost DESC`,
    [locationId, options.from ?? null, options.to ?? null],
  );

  const byReason: WasteReasonRow[] = rows.map((r) => ({
    reason: r.reason,
    quantity: r.quantity,
    cost: Math.round(Number(r.cost)),
  }));

  const totalCost = byReason.reduce((sum, r) => sum + r.cost, 0);

  // The same period's debit movement on the waste-expense account — the
  // ledger's own statement of what waste cost.
  const { rows: ledger } = await query<{ total: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS total
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       JOIN journal_entries je ON je.id = jl.entry_id AND NOT is_carry_forward_snapshot(je)
      WHERE a.business_id = $1 AND a.code = '5150'
        AND ($2::date IS NULL OR je.entry_date >= $2::date)
        AND ($3::date IS NULL OR je.entry_date < ($3::date + 1))`,
    [businessId, options.from ?? null, options.to ?? null],
  );

  return {
    rows: byReason,
    totalCost,
    ledgerWasteExpense: Math.round(Number(ledger[0]?.total ?? 0)),
  };
}
