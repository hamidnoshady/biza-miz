/**
 * Order total calculations — pure functions, integer Rial in/out.
 *
 * Discount is applied at the order level (percent or fixed amount off the
 * subtotal), then distributed across lines proportionally so each line's
 * tax is computed on its own category's tax_rate against its
 * post-discount share. The last line absorbs any rounding remainder so
 * sum(line discounts) === order discount exactly.
 */
import type { Rial } from "./money";
import { evaluatePromotions, type Promotion } from "./promotions";

export interface CartLine {
  /** menu item price at time of sale, Rial */
  unitPrice: Rial;
  quantity: number;
  /** per-unit modifier price deltas, Rial (may be negative) */
  modifierDeltas: Rial[];
  /** the menu item's category tax rate, percent (0-100) */
  taxRatePercent: number;
  /** The sellable thing's id, for Phase 27 promotion scope matching (menu_item_id). */
  id?: string;
  /** The menu item's category id, for promotion scope matching. */
  categoryId?: string | null;
}

export type DiscountInput = { type: "percent" | "amount"; value: number } | { type: null; value?: number };

export interface LineTotal {
  lineSubtotal: Rial;
  lineDiscount: Rial;
  lineTax: Rial;
  lineTotal: Rial;
}

export interface OrderTotals {
  subtotal: Rial;
  discount: Rial;
  tax: Rial;
  total: Rial;
  lines: LineTotal[];
}

export function computeLineSubtotal(line: Pick<CartLine, "unitPrice" | "quantity" | "modifierDeltas">): Rial {
  const modSum = line.modifierDeltas.reduce((a, b) => a + b, 0);
  return (line.unitPrice + modSum) * line.quantity;
}

/** Clamped to [0, subtotal]; percent clamped to [0, 100]. */
export function computeDiscountAmount(subtotal: Rial, discount: DiscountInput): Rial {
  if (!discount.type || subtotal <= 0) return 0;
  if (discount.type === "percent") {
    const pct = Math.min(Math.max(discount.value, 0), 100);
    return Math.round((subtotal * pct) / 100);
  }
  return Math.min(Math.max(Math.round(discount.value), 0), subtotal);
}

export function computeOrderTotals(
  lines: CartLine[],
  discount: DiscountInput,
  serviceCharge: Rial = 0,
  promotions: Promotion[] = [],
  now: Date = new Date(),
): OrderTotals {
  const lineSubtotals = lines.map(computeLineSubtotal);
  const subtotal = lineSubtotals.reduce((a, b) => a + b, 0);

  // Phase 27 Wave 6 — the shared promotion engine runs over the F&B cart
  // exactly as it runs over a retail cart, so one set of rules produces one
  // answer. Lines without an id (a snapshot with no menu item) match nothing.
  const promotionItems = lines.map((line, i) => ({
    id: line.id ?? "",
    categoryId: line.categoryId ?? null,
    gross: lineSubtotals[i],
    quantity: line.quantity,
  }));
  const promotionResult = evaluatePromotions(promotionItems, promotions, now);

  const manualDiscountAmount = computeDiscountAmount(subtotal, discount);
  const remainingAfterPromotions = Math.max(0, subtotal - promotionResult.totalDiscount);
  const discountAmount = Math.min(manualDiscountAmount, remainingAfterPromotions);

  let allocatedDiscount = 0;
  const lineResults: LineTotal[] = lines.map((line, i) => {
    const lineSubtotal = lineSubtotals[i];
    const isLast = i === lines.length - 1;
    const share = subtotal > 0 ? lineSubtotal / subtotal : 0;
    const manualShare = isLast ? discountAmount - allocatedDiscount : Math.round(discountAmount * share);
    allocatedDiscount += manualShare;
    // Promotion discount plus the manual share, never more than the line's gross.
    const lineDiscount = Math.min(lineSubtotal, promotionResult.lineDiscounts[i] + manualShare);
    const taxableBase = lineSubtotal - lineDiscount;
    const lineTax = Math.round((taxableBase * line.taxRatePercent) / 100);
    return { lineSubtotal, lineDiscount, lineTax, lineTotal: taxableBase + lineTax };
  });

  const tax = lineResults.reduce((a, l) => a + l.lineTax, 0);
  const totalDiscount = lineResults.reduce((a, l) => a + l.lineDiscount, 0);
  const total = subtotal - totalDiscount + tax + serviceCharge;
  return { subtotal, discount: totalDiscount, tax, total, lines: lineResults };
}

/** Cashier-facing queue/order label. Takeaway gets a "T-" prefix, delivery a "D-", dine-in a plain "#". */
export function formatQueueLabel(type: "dine_in" | "takeaway" | "delivery" | "retail", orderNumber: number | string): string {
  if (type === "takeaway") return `T-${orderNumber}`;
  if (type === "delivery") return `D-${orderNumber}`;
  return `#${orderNumber}`;
}

/** How an order type reads on a screen — and on the paper, since a print document is built from these too. */
export const ORDER_TYPE_LABELS: Record<string, string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
  retail: "فروشگاهی",
};

/** `dine_in` with a table says which table, because that is what the runner carries the tray to. */
export function orderTypeLabelOf(type: string, tableName?: string | null): string {
  const label = ORDER_TYPE_LABELS[type] ?? type;
  return type === "dine_in" && tableName ? `${label} — ${tableName}` : label;
}

/**
 * The order's own document number as every surface prints it: a retail sale is
 * «فاکتور ۴۲» (it is an invoice), everything else is the kitchen queue label.
 *
 * One helper because the printed receipt and the screen that shows the same
 * order must not disagree about its number.
 */
export function orderDocumentLabel(order: { type: string; order_number: number | string }): string {
  return order.type === "retail"
    ? `فاکتور ${order.order_number}`
    : formatQueueLabel(order.type as "dine_in" | "takeaway" | "delivery" | "retail", order.order_number);
}
