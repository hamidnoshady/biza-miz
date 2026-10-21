/**
 * A sale's printed documents, built on the SERVER from the sale's own rows.
 *
 * This is the order-side twin of `src/lib/retail-invoice/print-data.ts`, and
 * it exists for the same reason: a receipt is a financial document, and a
 * receipt assembled by the browser is an assertion about money, items and
 * prices that nothing has verified. The POS used to build `ReceiptData` and
 * `KitchenTicketData` in the till's JavaScript and POST them to
 * `/api/printing/print`, so the server rendered whatever it was told — a
 * reprint of order #12 could name another branch, invent a line or restate the
 * total, and the history row would record it as a receipt for #12.
 *
 * What a reprint must show is also the reason both builders are pure functions
 * of `OrderDetail`:
 *
 *   - the **issue moment** is the sale's own (`closed_at`, else `opened_at`),
 *     never `new Date()` — a reprint months later shows the day the sale
 *     happened (the same defect the retail invoice's builder fixed);
 *   - the **lines, prices and totals** are the persisted ones, so the paper
 *     and the order screen can never disagree;
 *   - the **add-ons** come from `order_item_modifiers`, so the printed line
 *     detail is what was actually sold.
 *
 * Pure: no DB, no Next, no clock (except the kitchen ticket's `sentAt`, which
 * is deliberately "now" — a ticket is an instruction to make food, not a
 * record of a sale).
 */
import type { KitchenTicketData } from "../kitchen-ticket-template";
import { linePriceBreakdown, modifierDeltasOf, modifierNamesLabel, type DisplayModifier } from "../modifier-display";
import type { MoneyUnit } from "../money";
import type { OrderDetail, OrderDetailItem } from "../order-read-service";
import { orderDocumentLabel, orderTypeLabelOf } from "../orders";
import { paymentMethodLabel, type ReceiptBusinessInfo, type ReceiptData, type ReceiptLine } from "../receipt-template";

/** A persisted line's add-ons in the shape the money helpers take. */
function addOnsFor(detail: OrderDetail, item: OrderDetailItem): DisplayModifier[] {
  return detail.modifiers
    .filter((modifier) => modifier.order_item_id === item.id)
    .map((modifier) => ({
      name: modifier.name_snapshot,
      priceDelta: Number(modifier.price_delta),
      quantity: modifier.quantity,
    }));
}

/** The lines that are still on the bill — a voided line is never printed. */
function liveLines(detail: OrderDetail): OrderDetailItem[] {
  return detail.items.filter((item) => item.status !== "voided");
}

function receiptLine(detail: OrderDetail, item: OrderDetailItem): ReceiptLine {
  const addOns = addOnsFor(detail, item);
  return {
    name: item.name_snapshot,
    quantity: item.quantity,
    lineTotal: linePriceBreakdown({
      unitPrice: Number(item.unit_price),
      modifierDeltas: modifierDeltasOf(addOns),
      quantity: item.quantity,
    }).total,
    modifiersLabel: modifierNamesLabel(addOns) || null,
  };
}

/**
 * The customer receipt / formal invoice for one sale, from the sale's rows.
 *
 * `business` is the identity its branch resolved (printing/identity.ts) — the
 * builder never reaches for one, exactly like the retail invoice's builder.
 */
export function buildOrderReceipt(
  detail: OrderDetail,
  business: ReceiptBusinessInfo,
  currencyUnit: MoneyUnit,
): ReceiptData {
  const { order } = detail;
  const payments = detail.payments.map((payment) => ({
    label: payment.payment_method_name ?? paymentMethodLabel(payment.method),
    amount: Number(payment.amount),
  }));
  return {
    business,
    orderLabel: orderDocumentLabel(order),
    orderTypeLabel: orderTypeLabelOf(order.type, order.table_name),
    customerName: order.customer_name,
    issuedAt: order.closed_at ?? order.opened_at,
    lines: liveLines(detail).map((item) => receiptLine(detail, item)),
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    tax: Number(order.tax),
    total: Number(order.total),
    tip: Number(order.tip_amount ?? 0),
    paymentMethod: detail.payments[0]?.method ?? null,
    payments: payments.length ? payments : null,
    unit: currencyUnit,
  };
}

/** A round number is available only when this print represents one send batch. */
function roundNumberForItems(detail: OrderDetail, itemIds: Set<string> | null): number | undefined {
  if (!itemIds?.size) return undefined; // A full-order reprint is not one send round.
  const selected = liveLines(detail).filter((item) => itemIds.has(item.id));
  if (selected.length !== itemIds.size || selected.some((item) => !item.sent_to_kitchen_at)) return undefined;
  const selectedTimes = new Set(selected.map((item) => new Date(item.sent_to_kitchen_at!).getTime()));
  if (selectedTimes.size !== 1 || [...selectedTimes].some((time) => !Number.isFinite(time))) return undefined;

  const sentTimes = [...new Set(liveLines(detail)
    .map((item) => item.sent_to_kitchen_at ? new Date(item.sent_to_kitchen_at).getTime() : NaN)
    .filter(Number.isFinite))].sort((left, right) => left - right);
  const index = sentTimes.indexOf([...selectedTimes][0]!);
  return index < 0 ? undefined : index + 1;
}

/**
 * The kitchen ticket for one sale: what to make, not what it costs.
 *
 * The print identifies the order, explicit table destination, and (for a
 * partial send) its persisted send round. `sentAt` is now: a reprint is a
 * fresh instruction, unlike a receipt, which is a record.
 */
export function buildOrderKitchenTicket(
  detail: OrderDetail,
  options: { itemIds?: readonly string[] } = {},
): KitchenTicketData {
  const { order } = detail;
  const requestedIds = options.itemIds ? new Set(options.itemIds) : null;
  return {
    label: orderTypeLabelOf(order.type),
    orderTypeLabel: orderTypeLabelOf(order.type),
    orderNumber: order.order_number,
    roundNumber: roundNumberForItems(detail, requestedIds),
    tableName: order.table_name,
    sentAt: new Date(),
    lines: liveLines(detail).filter((item) => !requestedIds || requestedIds.has(item.id)).map((item) => ({
      name: item.name_snapshot,
      quantity: item.quantity,
      modifiersLabel: modifierNamesLabel(addOnsFor(detail, item)) || null,
      note: item.note || null,
    })),
    orderNote: order.note,
  };
}
