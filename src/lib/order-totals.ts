/**
 * Server-side helper: recompute an order's subtotal/discount/tax/total from
 * its current (non-voided) order_items + their modifiers, and persist it.
 * Used whenever items or the discount change after the order was created.
 *
 * Issue #913 — the pricing policy this module now states explicitly:
 *
 * * **Promotion eligibility is snapshotted at creation.** `orders.promotion_ids`
 *   holds the candidate set the sale was priced against (the campaigns active
 *   when the order opened), and `orders.opened_at` is the instant they are
 *   re-evaluated at. An amendment therefore re-prices the SAME bill under the
 *   SAME campaigns: a campaign that starts, ends or is paused while the table
 *   eats cannot change the total the guest already agreed to, and a campaign
 *   activated after opening never joins an open order. Rows with
 *   `promotion_ids IS NULL` (every order predating this release) keep the old
 *   live evaluation, because nobody snapshotted anything for them. Amounts and
 *   rules are still read live from the campaign rows — only eligibility and
 *   evaluation time are frozen. Manual discount + promotions are never applied
 *   twice: computeOrderTotals clamps the manual share against what the
 *   promotions left.
 *
 * * **Tax is frozen per line when the line enters the order** (item 11),
 *   mirroring how `order_items.unit_price` is a snapshot while menu prices
 *   move. `tax_rate_snapshot` is written by every intake path; a NULL
 *   snapshot is a legacy line and falls back to the live category rate, which
 *   is exactly what it was priced from until now. Legal effective-dated rate
 *   changes belong on the category going forward — they price new lines only.
 *
 * The same run leaves the campaign-effectiveness audit rows
 * (`promotion_applications`), rewritten atomically with the totals so the
 * report and the bill can never disagree about which campaigns fired.
 */
import type { PoolClient } from "pg";
import {
  computeOrderTotals,
  promotionEvaluationFor,
  type CartLine,
  type DiscountInput,
  type OrderTotals,
} from "./orders";
import { listPromotions } from "./promotions-service";

export async function recomputeOrderTotals(
  client: PoolClient,
  orderId: string,
  discount: DiscountInput,
): Promise<OrderTotals> {
  const { rows: orderRows } = await client.query<{
    business_id: string;
    location_id: string;
    promotion_ids: unknown;
    opened_at: Date | string | null;
  }>(
    `SELECT l.business_id, o.location_id, o.promotion_ids, o.opened_at
       FROM orders o JOIN locations l ON l.id = o.location_id WHERE o.id = $1`,
    [orderId],
  );
  const businessId = orderRows[0]?.business_id;
  const locationId = orderRows[0]?.location_id ?? null;

  const { rows } = await client.query<{
    unit_price: string;
    quantity: number;
    tax_rate: string;
    mod_deltas: string[] | null;
    menu_item_id: string | null;
    category_id: string | null;
  }>(
    `SELECT oi.unit_price, oi.quantity,
            COALESCE(oi.tax_rate_snapshot, mc.tax_rate, 0) AS tax_rate,
            ARRAY(SELECT oim.price_delta * oim.quantity FROM order_item_modifiers oim
                   WHERE oim.order_item_id = oi.id) AS mod_deltas,
            oi.menu_item_id, mc.id AS category_id
       FROM order_items oi
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE oi.order_id = $1 AND oi.status != 'voided'`,
    [orderId],
  );

  const lines: CartLine[] = rows.map((r) => ({
    unitPrice: Number(r.unit_price),
    quantity: r.quantity,
    modifierDeltas: (r.mod_deltas ?? []).map(Number),
    taxRatePercent: Number(r.tax_rate),
    id: r.menu_item_id ?? undefined,
    categoryId: r.category_id,
  }));

  // The frozen eligibility snapshot — see the header. A NULL promotion_ids is
  // a pre-0232 order: evaluate live campaigns now, exactly as before.
  const frozenIdsRaw = orderRows[0]?.promotion_ids;
  const frozenIds: string[] | null = Array.isArray(frozenIdsRaw)
    ? frozenIdsRaw.filter((id): id is string => typeof id === "string")
    : null;
  const promotions = businessId
    ? frozenIds !== null
      ? (await listPromotions(businessId, true, client)).filter((p) => frozenIds.includes(p.id))
      : await listPromotions(businessId, false, client)
    : [];
  // Frozen orders are re-priced as of the moment they opened; legacy orders
  // keep the wall clock (their eligibility was never snapshotted).
  const pricedAt =
    frozenIds !== null && orderRows[0]?.opened_at
      ? new Date(orderRows[0].opened_at)
      : new Date();

  // A delivery order's flat fee rides on service_charge and is part of the
  // total the customer pays (see order-mutations.ts), so a recompute has to
  // carry it — computing without it would quietly knock the fee off the bill
  // the first time an item or the discount changed.
  const { rows: header } = await client.query<{ service_charge: string }>(
    "SELECT service_charge::text FROM orders WHERE id = $1",
    [orderId],
  );
  const totals = computeOrderTotals(lines, discount, Number(header[0]?.service_charge ?? 0), promotions, pricedAt);

  // The audit trail the campaign-effectiveness reports read, rewritten with
  // (never alongside) the totals: same transaction, same evaluation, so a
  // failed recompute leaves neither a new total nor half a trail.
  if (businessId && locationId) {
    await client.query(
      `DELETE FROM promotion_applications WHERE source_type = 'order' AND source_id = $1`,
      [orderId],
    );
    const evaluation = promotionEvaluationFor(lines, promotions, pricedAt);
    for (const applied of evaluation.applied) {
      if (applied.amount <= 0) continue;
      await client.query(
        `INSERT INTO promotion_applications (business_id, location_id, promotion_id, source_type, source_id, discount_rial)
         VALUES ($1, $2, $3, 'order', $4, $5)`,
        [businessId, locationId, applied.promotionId, orderId, applied.amount],
      );
    }
  }

  await client.query(
    `UPDATE orders SET subtotal = $2, discount = $3, discount_type = $4, discount_value = $5,
            tax = $6, total = $7 WHERE id = $1`,
    [
      orderId,
      totals.subtotal,
      totals.discount,
      discount.type,
      discount.type ? discount.value : null,
      totals.tax,
      totals.total,
    ],
  );
  return totals;
}
