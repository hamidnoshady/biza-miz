/**
 * The dedicated retail invoice read model.
 *
 * `OrderDetailModal`/`getOrderDetail` are the café's own document reader — they
 * fetch `/api/tables` and `/api/menu`, resolve add-on modifier groups and speak
 * in F&B vocabulary (میز، افزودنی، آشپزخانه). None of that exists for a retail
 * sale, so retail's invoice detail screen must not open through them (item 36
 * of the retail POS brief). This module is the retail-only equivalent: one
 * query plan, built for `orders.type = 'retail'`, returning nothing a shop
 * counter does not need.
 *
 * DB-touching, so per repo convention this has no direct unit test; covered by
 * integration/retail-invoice.integration.test.ts (historical-fidelity suite).
 */
import { query } from "../db";
import { PAYMENT_METHOD_LABELS } from "../receipt-template";
import { getSetting, SETTING_KEYS } from "../settings";
import type { BusinessPrefs } from "../setup-state";
import type {
  LegacyRetailLine,
  RetailInvoiceCustomer,
  RetailInvoiceDetail,
  RetailInvoiceDetailLine,
  RetailInvoicePayment,
} from "./types";

type OrderRow = {
  id: string;
  order_number: string;
  status: "completed" | "voided";
  opened_at: string;
  closed_at: string | null;
  voided_reason: string | null;
  business_id: string;
  location_id: string;
  location_name: string;
  cashier_id: string | null;
  cashier_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  note: string | null;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
};

type OrderItemRow = {
  id: string;
  item_id: string | null;
  name_snapshot: string;
  unit_price: string;
  quantity: number;
  metal_value: string | null;
  making_charge: string | null;
  profit: string | null;
  retail_snapshot: Record<string, unknown> | null;
};

type PaymentRow = {
  id: string;
  method: string;
  amount: string;
  reference: string | null;
  payment_method_id: string | null;
  payment_method_name: string | null;
  received_at: string;
};

function mapLine(row: OrderItemRow): RetailInvoiceDetailLine {
  if (!row.retail_snapshot) {
    // Pre-migration-0174 row: the true quantity/discount split was never
    // persisted. Reported honestly as a legacy line rather than fabricated.
    const legacy: LegacyRetailLine = {
      kind: "legacy",
      orderItemId: row.id,
      itemId: row.item_id,
      nameSnapshot: row.name_snapshot,
      quantity: "1",
      unitPrice: row.unit_price,
      total: row.unit_price,
      metalValue: row.metal_value,
      makingCharge: row.making_charge,
      profit: row.profit,
    };
    return legacy;
  }
  const stored = row.retail_snapshot as Record<string, unknown>;
  return {
    ...(stored as object),
    orderItemId: row.id,
    itemId: row.item_id,
    nameSnapshot: row.name_snapshot,
  } as RetailInvoiceDetailLine;
}

/**
 * One retail invoice's full detail, scoped to the branch the caller is
 * currently working from — the same scope `GET /api/sales/invoices` already
 * lists by, so a member restricted to one branch cannot read another
 * branch's invoice just by guessing its id. Returns null rather than
 * throwing when the id does not resolve to a retail invoice in that scope —
 * the API route turns that into 404.
 */
export async function getRetailInvoiceDetail(
  businessId: string,
  locationId: string,
  orderId: string,
): Promise<RetailInvoiceDetail | null> {
  const { rows: orders } = await query<OrderRow>(
    `SELECT o.id, o.order_number::text, o.status::text AS status, o.opened_at::text, o.closed_at::text,
            o.voided_reason, l.business_id, o.location_id, l.name AS location_name,
            o.closed_by AS cashier_id, cashier.full_name AS cashier_name,
            o.customer_id, c.name AS customer_name, c.phone AS customer_phone,
            o.note, o.subtotal::text, o.discount::text, o.tax::text, o.total::text
       FROM orders o
       JOIN locations l ON l.id = o.location_id
       LEFT JOIN users cashier ON cashier.id = COALESCE(o.closed_by, o.opened_by)
       LEFT JOIN parties c ON c.id = o.customer_id
      WHERE o.id = $1 AND o.location_id = $2 AND l.business_id = $3 AND o.type = 'retail'`,
    [orderId, locationId, businessId],
  );
  const order = orders[0];
  if (!order) return null;

  const { rows: items } = await query<OrderItemRow>(
    `SELECT id, item_id, name_snapshot, unit_price::text, quantity,
            metal_value::text, making_charge::text, profit::text, retail_snapshot
       FROM order_items
      WHERE order_id = $1
      ORDER BY id`,
    [order.id],
  );

  const { rows: payments } = await query<PaymentRow>(
    `SELECT p.id, p.method::text, p.amount::text, p.reference, p.payment_method_id,
            pm.name AS payment_method_name, p.received_at::text
       FROM payments p
       LEFT JOIN payment_methods pm ON pm.id = p.payment_method_id
      WHERE p.order_id = $1
      ORDER BY p.received_at, p.id`,
    [order.id],
  );

  const { rows: outbox } = await query<{ status: string }>(
    `SELECT status FROM integration_outbox_events WHERE local_id = $1 AND entity_type LIKE 'holoo_%'`,
    [order.id],
  );

  const prefs = await getSetting<BusinessPrefs>(order.business_id, SETTING_KEYS.businessPrefs);
  const currencyUnit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";

  const customer: RetailInvoiceCustomer | null = order.customer_id
    ? { id: order.customer_id, name: order.customer_name ?? "", phone: order.customer_phone }
    : null;

  const mappedPayments: RetailInvoicePayment[] = payments.map((p) => ({
    id: p.id,
    method: p.method,
    methodLabel: p.payment_method_name ?? PAYMENT_METHOD_LABELS[p.method] ?? p.method,
    amount: Number(p.amount),
    reference: p.reference,
    paymentMethodId: p.payment_method_id,
    receivedAt: p.received_at,
  }));

  const paidTotal = mappedPayments.reduce((sum, p) => sum + p.amount, 0);
  const total = Number(order.total);
  const creditTotal = mappedPayments
    .filter((p) => p.method === "credit")
    .reduce((sum, p) => sum + p.amount, 0);

  return {
    orderId: order.id,
    orderNumber: Number(order.order_number),
    status: order.status,
    // The original issue moment — never `new Date()`. A retail invoice is
    // settled the instant it is written, so `closed_at` is set; `opened_at`
    // is the safety fallback for a row that somehow never closed.
    issuedAt: order.closed_at ?? order.opened_at,
    voidedReason: order.voided_reason,
    businessId: order.business_id,
    locationId: order.location_id,
    locationName: order.location_name,
    cashierId: order.cashier_id,
    cashierName: order.cashier_name,
    customer,
    note: order.note,
    lines: items.map(mapLine),
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    tax: Number(order.tax),
    total,
    payments: mappedPayments,
    paidTotal,
    balanceDue: Math.max(0, total - paidTotal),
    overpaid: Math.max(0, paidTotal - total),
    creditTotal,
    currencyUnit,
    integration: {
      holooQueued: outbox.length > 0,
      holooSynced: outbox.some((r) => r.status === "sent"),
    },
  };
}
