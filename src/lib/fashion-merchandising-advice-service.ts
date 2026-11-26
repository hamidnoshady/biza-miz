/**
 * GH #1567 Phase 6E — the facts behind the advisory merchandising report.
 *
 * Read-only by construction: two SELECTs (the shared variant sale facts and
 * the branch's owned stock) and a pure planner. No INSERT/UPDATE, no domain
 * event, no executor — the report is consumed by «گزارش‌ها» and by the
 * assistant's read-only `run_report` tool only.
 */
import { query } from "./db";
import { buildAdvice, type AdviceReport, type VariantFact } from "./fashion-merchandising-advice";
import { variantSalesAnalysis } from "./industry-reports-service";

/** Default look-back when the caller sends no range: eight weeks to today. */
export const DEFAULT_ADVICE_WINDOW_DAYS = 56;

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function fashionMerchandisingAdvice(
  businessId: string,
  locationId: string,
  options: { from?: string; to?: string; todayIso?: string; now?: Date } = {},
): Promise<AdviceReport> {
  const today = options.todayIso ?? new Date().toISOString().slice(0, 10);
  const to = options.to ?? today;
  const from = options.from ?? shiftIso(to, -(DEFAULT_ADVICE_WINDOW_DAYS - 1));

  const sales = await variantSalesAnalysis(businessId, locationId, { from, to, eventPrefix: "fashion_apparel" });
  const soldByItem = new Map(sales.map((r) => [r.itemId, Number(r.quantitySold)]));

  const { rows } = await query<{
    id: string; parent_item_id: string | null; parent_name: string | null; name: string;
    attrs: string | null; on_hand: string; unit_cost: string | null; consigned: boolean;
  }>(
    `SELECT i.id, i.parent_item_id, p.name AS parent_name, i.name,
            (SELECT string_agg(a.value, ' / ' ORDER BY a.name) FROM item_variant_attributes a WHERE a.item_id = i.id) AS attrs,
            COALESCE(s.quantity, 0)::text AS on_hand, s.unit_cost::text AS unit_cost,
            EXISTS (SELECT 1 FROM fashion_consignment_lines l WHERE l.item_id = i.id AND l.is_open) AS consigned
       FROM items i
       JOIN locations loc ON loc.id = i.location_id
       LEFT JOIN items p ON p.id = i.parent_item_id
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.location_id = $2 AND loc.business_id = $1
        AND i.kind <> 'variant_parent' AND i.is_active`,
    [businessId, locationId],
  );

  let excludedConsigned = 0;
  const facts: VariantFact[] = [];
  for (const r of rows) {
    // Consigned (امانی) goods belong to their owner: buying more of them is
    // not the shop's decision, so they never get purchase advice here.
    if (r.consigned) { excludedConsigned += 1; continue; }
    facts.push({
      itemId: r.id,
      styleId: r.parent_item_id,
      styleName: r.parent_name ?? r.name,
      variantLabel: r.attrs ?? r.name,
      soldUnits: soldByItem.get(r.id) ?? 0,
      onHand: Number(r.on_hand),
      unitCostRial: r.unit_cost == null ? null : Number(r.unit_cost),
    });
  }

  return buildAdvice(facts, { from, to }, { generatedAt: (options.now ?? new Date()).toISOString(), excludedConsigned });
}
