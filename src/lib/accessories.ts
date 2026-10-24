/**
 * Phase 21 Wave 6 — accessories (بدلیجات): variant stock and pricing (pure
 * helpers).
 *
 * The two computations this wave needs, kept out of the DB layer the same
 * way `gold-pricing.ts` and `watch-pricing.ts` are: the running
 * weighted-average cost after a receipt, and a sale line's price.
 *
 * `inventory-costing.ts` already has a `calculateNewAverageCost`, and this
 * is deliberately not a call to it: that one is plain-number (`Rial`)
 * arithmetic against F&B's own costing engine, and every posting path this
 * phase has built runs on the exact (Decimal/RialText) path instead — the
 * same correction Wave 1's second slice made when it moved the posting
 * engine off plain numbers. Recomputing an average cost in floating point
 * and then posting it exactly would put the imprecision back one layer up.
 */
import Decimal from "decimal.js";
import { rialBigInt, rialText, roundRial, type RialText } from "./inventory-exact";

export interface StockReceiptInput {
  /** Units received — fractional is allowed by the column, whole in practice. */
  quantity: string;
  /**
   * What the shop paid per unit for this receipt (Rial, whole). Issue #915 —
   * decimal *text* is the exact form for bigint Rial (safe past 2^53); a
   * plain number is accepted from older internal callers when it is a safe
   * integer.
   */
  unitCost: number | string;
}

/** Whole non-negative Rial: canonical unsigned digit text within bigint range, or a safe integer. */
export function isWholeRialCost(unitCost: number | string): boolean {
  if (typeof unitCost === "string") {
    return /^\d{1,19}$/.test(unitCost) && BigInt(unitCost) <= 9223372036854775807n;
  }
  return Number.isSafeInteger(unitCost) && unitCost >= 0;
}

export function validateStockReceipt(input: StockReceiptInput): string[] {
  const errors: string[] = [];
  try {
    if (new Decimal(input.quantity).lte(0)) errors.push("تعداد ورودی باید بزرگ‌تر از صفر باشد.");
  } catch {
    errors.push("تعداد ورودی نامعتبر است.");
  }
  if (!isWholeRialCost(input.unitCost)) {
    errors.push("بهای تمام‌شده هر واحد باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  return errors;
}

/**
 * The running weighted-average unit cost after receiving `incomingQty` at
 * `incomingUnitCost` on top of `existingQty` at `existingUnitCost`. With no
 * prior stock (or no prior cost recorded), the incoming cost simply becomes
 * the average.
 */
export function nextAverageUnitCost(
  existingQty: string,
  existingUnitCost: number | string | null,
  incomingQty: string,
  incomingUnitCost: number | string,
): RialText {
  const existing = new Decimal(existingQty);
  const incoming = new Decimal(incomingQty);
  const totalQty = existing.plus(incoming);
  if (totalQty.lte(0) || existingUnitCost == null || existing.lte(0)) {
    return rialText(String(incomingUnitCost));
  }
  const totalValue = existing.times(existingUnitCost).plus(incoming.times(incomingUnitCost));
  return roundRial(totalValue.div(totalQty));
}

export interface AccessorySalePriceInput {
  /** Shelf price per unit (Rial, whole, pre-VAT). */
  unitPrice: number;
  /** Units sold. */
  quantity: string;
  /** A discount off the line total (Rial, whole) — 0 for none. */
  discount?: number;
  /** 0-100. */
  vatPercent: number;
}

export interface AccessorySalePriceBreakdown {
  gross: RialText;
  discount: RialText;
  net: RialText;
  vat: RialText;
  total: RialText;
}

export function validateAccessorySalePriceInput(input: AccessorySalePriceInput): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(input.unitPrice) || input.unitPrice <= 0) {
    errors.push("قیمت فروش هر واحد باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  try {
    if (new Decimal(input.quantity).lte(0)) errors.push("تعداد فروش باید بزرگ‌تر از صفر باشد.");
  } catch {
    errors.push("تعداد فروش نامعتبر است.");
  }
  const discount = input.discount ?? 0;
  if (!Number.isInteger(discount) || discount < 0) {
    errors.push("تخفیف باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (!Number.isFinite(input.vatPercent) || input.vatPercent < 0 || input.vatPercent > 100) {
    errors.push("درصد مالیات باید بین ۰ تا ۱۰۰ باشد.");
  }
  return errors;
}

/** Every component is rounded to whole Rial as it is computed, each stage building on the previous stage's rounded value — the rule Wave 3 set so a receipt's lines always sum to its total. */
export function computeAccessorySalePrice(
  input: AccessorySalePriceInput,
): AccessorySalePriceBreakdown {
  const errors = validateAccessorySalePriceInput(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const gross = roundRial(new Decimal(input.quantity).times(input.unitPrice));
  const discount = rialText(String(input.discount ?? 0));
  if (rialBigInt(discount) > rialBigInt(gross)) {
    throw new Error("تخفیف نمی‌تواند از مبلغ کل بیشتر باشد.");
  }
  const net = rialText((rialBigInt(gross) - rialBigInt(discount)).toString());
  const vat = roundRial(new Decimal(net).times(input.vatPercent).div(100));
  const total = rialText((rialBigInt(net) + rialBigInt(vat)).toString());

  return { gross, discount, net, vat, total };
}

/** The cost of goods sold for `quantity` units carried at `unitCost` — the COGS side of the same sale. */
export function accessoryCogs(quantity: string, unitCost: number): RialText {
  return roundRial(new Decimal(quantity).times(unitCost));
}
