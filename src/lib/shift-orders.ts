/**
 * Item-by-item order detail for the current shift — the framework-free half.
 *
 * The reporting views (Phase 8, migration 0008) all aggregate: the finest
 * grain any of them expose is "one menu item per business day"
 * (v_menu_item_performance). Reviewing a shift order by order needs the
 * transactional rows themselves, so this pairs with shift-orders-service.ts
 * the same way reports.ts pairs with reports-service.ts — the grouping rule
 * lives here and is unit tested; the query lives there.
 *
 * What a reviewed order carries is deliberately the *whole* bill, not a
 * summary of it: every line's add-ons by name and price, its note and void
 * reason, the money breakdown down to discount/service charge/tax/tip, and
 * how it was tendered. Reviewing a shift is the one place someone is asked
 * "why was this order this much?", and an answer that omits the add-ons — the
 * part of a bill customers dispute most often — sends the reviewer to the
 * orders screen to re-read the same order there.
 *
 * A line's amount reuses computeLineSubtotal (orders.ts) rather than
 * recomputing "(unit price + modifiers) × quantity" a second time, so this
 * report can never disagree with what the cashier was charged. It is a
 * *pre-discount* line amount: an order's discount is applied at the order
 * level, and only the order total reflects it.
 */
import { computeLineSubtotal } from "./orders";
import { sumModifierDeltas } from "./modifier-display";
import type { Rial } from "./money";

/** `retail` is a multi-line sales invoice — every website order is one (migration 0071). */
export type OrderKind = "dine_in" | "takeaway" | "delivery" | "retail";

/** One order_item_modifiers snapshot — the add-on as it was sold, name and money. */
export interface ShiftOrderModifier {
  name: string;
  /** Per-unit, integer Rial; negative for a discount-shaped add-on. */
  priceDelta: Rial;
  /** How many times this add-on applies to one unit of the line (migration 0169). */
  quantity?: number;
}

/** One order_items row joined onto its order, with its add-on snapshots collapsed into an array. */
export interface ShiftOrderItemInput {
  orderId: string;
  orderNumber: number | string;
  type: OrderKind;
  status: string;
  tableName: string | null;
  guestCount: number | null;
  customerName: string | null;
  openedAt: string;
  closedAt: string | null;
  openedByName: string | null;
  closedByName: string | null;
  orderNote: string | null;
  voidedReason: string | null;
  amendedAt: string | null;
  subtotal: Rial;
  discount: Rial;
  discountType: "percent" | "amount" | null;
  discountValue: number | null;
  serviceCharge: Rial;
  tax: Rial;
  tipAmount: Rial;
  orderTotal: Rial;
  /** null when the order has no lines yet — an order opened but nothing rung in. */
  itemId: string | null;
  itemName: string | null;
  quantity: number;
  unitPrice: Rial;
  modifiers: ShiftOrderModifier[];
  itemStatus: string | null;
  note: string | null;
  voidReason: string | null;
}

/** One payments row of the order — read separately from the item join, so it can't fan the lines out. */
export interface ShiftOrderPaymentInput {
  orderId: string;
  method: string;
  /**
   * The name the business gave the payment way (migration 0091) — «پوز ملت»
   * rather than the settlement's generic «کارت‌خوان». Null on payments taken
   * before the business named its ways, and on the ones no way owns (a
   * refund, an amendment's adjusting row), where `method` is all there is.
   */
  methodName: string | null;
  amount: Rial;
  reference: string | null;
  receivedAt: string;
  receivedByName: string | null;
}

export type ShiftOrderPayment = Omit<ShiftOrderPaymentInput, "orderId">;

export interface ShiftOrderLine {
  itemId: string;
  name: string;
  quantity: number;
  /** The menu price of one unit at time of sale, before add-ons. */
  unitPrice: Rial;
  modifiers: ShiftOrderModifier[];
  /** Sum of the line's add-on deltas for *one* unit. */
  addOnsPerUnit: Rial;
  /** (unitPrice + modifier deltas) × quantity, Rial — before the order-level discount. */
  amount: Rial;
  note: string | null;
  /** The reason recorded when the line was voided; null on a live line. */
  voidReason: string | null;
  /** The raw order_item_status ('pending', 'served', 'voided', …). */
  status: string | null;
  voided: boolean;
}

export interface ShiftOrder {
  id: string;
  orderNumber: number | string;
  type: OrderKind;
  status: string;
  tableName: string | null;
  guestCount: number | null;
  customerName: string | null;
  openedAt: string;
  closedAt: string | null;
  openedByName: string | null;
  closedByName: string | null;
  note: string | null;
  voidedReason: string | null;
  amendedAt: string | null;
  /** Sum of the live lines before the order-level discount. */
  subtotal: Rial;
  discount: Rial;
  discountType: "percent" | "amount" | null;
  discountValue: number | null;
  serviceCharge: Rial;
  tax: Rial;
  tipAmount: Rial;
  /** The order's own recorded total (post-discount, with tax/service charge) — not the sum of `lines`. */
  total: Rial;
  /** How much of the subtotal came from add-ons, across live lines — the number a customer disputes most often. */
  addOnTotal: Rial;
  lines: ShiftOrderLine[];
  /** «online» when the order came from a website (it has an online sale fact or document), else «in_store». */
  channel?: "online" | "in_store";
  /** Units across non-voided lines. */
  itemCount: number;
  payments: ShiftOrderPayment[];
}

/**
 * Collapses the flat join into one entry per order, keeping the input's row
 * order (the service orders newest first) so the caller decides sorting.
 * Voided lines are kept and flagged rather than dropped — a voided item is
 * exactly the kind of thing someone reviewing a shift is looking for — but
 * they don't count toward `itemCount` or `addOnTotal`.
 *
 * Payments arrive as their own flat list rather than as a third join: an
 * order can carry more than one payment row — a refund, or the re-settlement
 * a closed-order amendment writes — and joining them alongside the items
 * would multiply every line by every payment.
 */
export function groupShiftOrders(
  rows: ShiftOrderItemInput[],
  payments: ShiftOrderPaymentInput[] = [],
): ShiftOrder[] {
  const byId = new Map<string, ShiftOrder>();
  for (const row of rows) {
    let order = byId.get(row.orderId);
    if (!order) {
      order = {
        id: row.orderId,
        orderNumber: row.orderNumber,
        type: row.type,
        status: row.status,
        tableName: row.tableName,
        guestCount: row.guestCount,
        customerName: row.customerName,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        openedByName: row.openedByName,
        closedByName: row.closedByName,
        note: row.orderNote,
        voidedReason: row.voidedReason,
        amendedAt: row.amendedAt,
        subtotal: row.subtotal,
        discount: row.discount,
        discountType: row.discountType,
        discountValue: row.discountValue,
        serviceCharge: row.serviceCharge,
        tax: row.tax,
        tipAmount: row.tipAmount,
        total: row.orderTotal,
        addOnTotal: 0,
        lines: [],
        itemCount: 0,
        payments: [],
      };
      byId.set(row.orderId, order);
    }
    if (!row.itemId) continue;
    const voided = row.itemStatus === "voided";
    const addOnsPerUnit = sumModifierDeltas(
      row.modifiers.map((modifier) => modifier.priceDelta * Math.max(1, modifier.quantity ?? 1)),
    );
    order.lines.push({
      itemId: row.itemId,
      name: row.itemName ?? "",
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      modifiers: row.modifiers,
      addOnsPerUnit,
      amount: computeLineSubtotal({
        unitPrice: row.unitPrice,
        quantity: row.quantity,
        modifierDeltas: row.modifiers.map(
          (modifier) => modifier.priceDelta * Math.max(1, modifier.quantity ?? 1),
        ),
      }),
      note: row.note,
      voidReason: row.voidReason,
      status: row.itemStatus,
      voided,
    });
    if (!voided) {
      order.itemCount += row.quantity;
      order.addOnTotal += addOnsPerUnit * row.quantity;
    }
  }

  for (const payment of payments) {
    const order = byId.get(payment.orderId);
    if (!order) continue;
    order.payments.push({
      method: payment.method,
      methodName: payment.methodName,
      amount: payment.amount,
      reference: payment.reference,
      receivedAt: payment.receivedAt,
      receivedByName: payment.receivedByName,
    });
  }

  return [...byId.values()];
}
