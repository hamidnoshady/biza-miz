import { query } from "./db";
import { calculateRefundCapacity } from "./customer-return-domain";

export interface CustomerReturnHistoryLine {
  orderItemId: string;
  itemName: string;
  quantity: string;
  disposition: "restockable" | "discarded";
  recoveredQuantity: string;
  recoveredValueRial: string;
}

export interface CustomerReturnHistoryEntry {
  id: string;
  refundMethod: string;
  refundAmountRial: string;
  reason: string;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  inventoryPostingStatus: string | null;
  accountingPostingCount: number;
  recoveredValueRial: string;
  lines: CustomerReturnHistoryLine[];
}

export interface OrderReturnHistory {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    totalRial: string;
    customerId: string | null;
    customerName: string | null;
    customerPhone: string | null;
  };
  returns: CustomerReturnHistoryEntry[];
  refundedTotalRial: string;
  refundCapacity: {
    saleRemainingRial: string;
    tenderRemainingRial: string;
    remainingRefundRial: string;
  };
}

interface OrderRow extends Record<string, unknown> {
  id: string;
  order_number: string;
  status: string;
  total: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
}

interface ReturnRow extends Record<string, unknown> {
  id: string;
  refund_method: string;
  refund_amount_rial: string;
  reason: string;
  created_at: Date | string;
  created_by: string | null;
  created_by_name: string | null;
  inventory_posting_status: string | null;
  accounting_posting_count: number | string;
  recovered_value_rial: string;
  lines: CustomerReturnHistoryLine[] | null;
}

/**
 * Return history is a separate branch-scoped read model. `getOrderDetail` is
 * shared with printing, the POS and AI tools, so this panel deliberately does
 * not widen its shape for a dashboard-only history feature.
 */
export async function getOrderReturnHistory(input: {
  businessId: string;
  locationId: string;
  orderId: string;
}): Promise<OrderReturnHistory | null> {
  const { rows: orderRows } = await query<OrderRow>(
    `SELECT o.id, o.order_number::text, o.status, o.total::text,
            o.customer_id, p.name AS customer_name, p.phone AS customer_phone
       FROM orders o
       LEFT JOIN parties p ON p.id=o.customer_id AND p.business_id=$3
      WHERE o.id=$1 AND o.location_id=$2`,
    [input.orderId, input.locationId, input.businessId],
  );
  const order = orderRows[0];
  if (!order) return null;

  const [historyResult, totalsResult] = await Promise.all([
    query<ReturnRow>(
      `SELECT cr.id, cr.refund_method, cr.refund_amount_rial::text,
              cr.reason, cr.created_at, cr.created_by,
              u.full_name AS created_by_name,
              ie.posting_status AS inventory_posting_status,
              COALESCE((
                SELECT sum(a.recovered_value_rial)::text
                  FROM customer_return_inventory_allocations a
                  JOIN customer_return_lines rl ON rl.id=a.customer_return_line_id
                 WHERE rl.customer_return_id=cr.id
              ), '0') AS recovered_value_rial,
              COALESCE((
                SELECT count(*)::int FROM journal_entries je
                 WHERE je.business_id=cr.business_id
                   AND je.source_type='customer_return' AND je.source_id=cr.id
              ), 0) AS accounting_posting_count,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'orderItemId', line.order_item_id,
                         'itemName', line.name_snapshot,
                         'quantity', line.quantity,
                         'disposition', line.disposition,
                         'recoveredQuantity', line.recovered_quantity,
                         'recoveredValueRial', line.recovered_value_rial
                       ) ORDER BY line.created_at, line.order_item_id)
                  FROM (
                    SELECT rl.order_item_id, oi.name_snapshot,
                           rl.quantity::text AS quantity, rl.disposition,
                           oi.created_at,
                           COALESCE(sum(a.quantity),0)::text AS recovered_quantity,
                           COALESCE(sum(a.recovered_value_rial),0)::text AS recovered_value_rial
                      FROM customer_return_lines rl
                      JOIN order_items oi ON oi.id=rl.order_item_id
                      LEFT JOIN customer_return_inventory_allocations a
                        ON a.customer_return_line_id=rl.id
                     WHERE rl.customer_return_id=cr.id
                     GROUP BY rl.order_item_id, oi.name_snapshot, rl.quantity,
                              rl.disposition, oi.created_at
                  ) line
              ), '[]'::json) AS lines
         FROM customer_returns cr
         LEFT JOIN users u ON u.id=cr.created_by AND u.business_id=cr.business_id
         LEFT JOIN inventory_events ie ON ie.id=cr.inventory_event_id
        WHERE cr.business_id=$1 AND cr.location_id=$2 AND cr.order_id=$3
        ORDER BY cr.created_at DESC, cr.id DESC`,
      [input.businessId, input.locationId, input.orderId],
    ),
    query<{
      previously_refunded: string;
      net_non_credit_tender: string;
    }>(
      `SELECT
         (SELECT COALESCE(sum(refund_amount_rial),0)::text
            FROM customer_returns
           WHERE business_id=$1 AND location_id=$2 AND order_id=$3) AS previously_refunded,
         (SELECT COALESCE(sum(p.amount) FILTER (
                    WHERE p.method <> 'credit' AND p.superseded_by_amendment_id IS NULL
                  ),0)::text
            FROM payments p
           WHERE p.location_id=$2 AND p.order_id=$3) AS net_non_credit_tender`,
      [input.businessId, input.locationId, input.orderId],
    ),
  ]);

  const totals = totalsResult.rows[0];
  const previouslyRefunded = totals?.previously_refunded ?? "0";
  return {
    order: {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      totalRial: order.total,
      customerId: order.customer_id,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
    },
    returns: historyResult.rows.map((row) => ({
      id: row.id,
      refundMethod: row.refund_method,
      refundAmountRial: row.refund_amount_rial,
      reason: row.reason,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      inventoryPostingStatus: row.inventory_posting_status,
      accountingPostingCount: Number(row.accounting_posting_count ?? 0),
      recoveredValueRial: row.recovered_value_rial ?? "0",
      lines: row.lines ?? [],
    })),
    refundedTotalRial: previouslyRefunded,
    refundCapacity: calculateRefundCapacity({
      orderTotalRial: order.total,
      previouslyRefundedRial: previouslyRefunded,
      netNonCreditTenderRial: totals?.net_non_credit_tender ?? "0",
    }),
  };
}
