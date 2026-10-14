/**
 * Phase 21 Wave 5 — watch sale and repair pricing (pure).
 *
 * Far simpler than Wave 3's gold engine, and deliberately so: a watch has a
 * price, not a formula. There is no metal value to derive from a daily
 * market rate, so the only computation is VAT on top of an agreed price —
 * and unlike gold (where metal value is VAT-exempt under Iranian tax
 * practice), the whole of a watch's price is a VAT-applicable sale of
 * finished goods, so VAT applies to all of it.
 *
 * Rounding follows the same rule Wave 3 established: every component is
 * rounded to whole Rial as it is computed, so a receipt's lines always sum
 * to exactly the displayed total.
 */
import Decimal from "decimal.js";
import { rialBigInt, rialText, roundRial, type RialText } from "./inventory-exact";

export interface WatchSalePriceInput {
  /** The agreed pre-VAT price of the unit (Rial, whole). */
  price: number;
  /** A discount off that price (Rial, whole) — 0 for none. */
  discount?: number;
  /** 0-100. */
  vatPercent: number;
}

export interface WatchSalePriceBreakdown {
  price: RialText;
  discount: RialText;
  net: RialText;
  vat: RialText;
  total: RialText;
}

export function validateWatchSalePriceInput(input: WatchSalePriceInput): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(input.price) || input.price <= 0) {
    errors.push("قیمت فروش باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  const discount = input.discount ?? 0;
  if (!Number.isInteger(discount) || discount < 0) {
    errors.push("تخفیف باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (Number.isInteger(input.price) && discount > input.price) {
    errors.push("تخفیف نمی‌تواند از قیمت فروش بیشتر باشد.");
  }
  if (!Number.isFinite(input.vatPercent) || input.vatPercent < 0 || input.vatPercent > 100) {
    errors.push("درصد مالیات باید بین ۰ تا ۱۰۰ باشد.");
  }
  return errors;
}

export function computeWatchSalePrice(input: WatchSalePriceInput): WatchSalePriceBreakdown {
  const errors = validateWatchSalePriceInput(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const price = rialText(String(input.price));
  const discount = rialText(String(input.discount ?? 0));
  const net = rialText((rialBigInt(price) - rialBigInt(discount)).toString());
  const vat = roundRial(new Decimal(net).times(input.vatPercent).div(100));
  const total = rialText((rialBigInt(net) + rialBigInt(vat)).toString());

  return { price, discount, net, vat, total };
}

export interface RepairChargeInput {
  /** What the customer pays for labor (Rial, whole). */
  laborCharge: number;
  /** Sum of what the customer pays for the parts used (Rial, whole). */
  partsCharge: number;
  /**
   * An agreed reduction off labor+parts (Rial, whole), before VAT — issue
   * #795 item 11; omit for the plain bill. May not exceed labor+parts.
   */
  discount?: number;
  /** 0-100. */
  vatPercent: number;
}

export interface RepairChargeBreakdown {
  laborCharge: RialText;
  partsCharge: RialText;
  discount: RialText;
  net: RialText;
  vat: RialText;
  total: RialText;
}

export function validateRepairChargeInput(input: RepairChargeInput): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(input.laborCharge) || input.laborCharge < 0) {
    errors.push("اجرت تعمیر باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (!Number.isInteger(input.partsCharge) || input.partsCharge < 0) {
    errors.push("مبلغ قطعات باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  const discount = input.discount ?? 0;
  if (!Number.isInteger(discount) || discount < 0) {
    errors.push("تخفیف باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  } else if (
    Number.isInteger(input.laborCharge) &&
    input.laborCharge >= 0 &&
    Number.isInteger(input.partsCharge) &&
    input.partsCharge >= 0 &&
    discount > input.laborCharge + input.partsCharge
  ) {
    errors.push("تخفیف نمی‌تواند از مجموع اجرت و قطعات بیشتر باشد.");
  }
  if (!Number.isFinite(input.vatPercent) || input.vatPercent < 0 || input.vatPercent > 100) {
    errors.push("درصد مالیات باید بین ۰ تا ۱۰۰ باشد.");
  }
  return errors;
}

/**
 * A repair bill: labor + parts, plus VAT on the sum. A warranty repair is
 * the all-zero case — a real, expected outcome (the shop still consumed
 * parts that cost money; it just billed nobody for them), which is why
 * every field here is allowed to be zero and the posting rule treats a
 * zero total as "record the event, post no revenue entry".
 */
export function computeRepairCharge(input: RepairChargeInput): RepairChargeBreakdown {
  const errors = validateRepairChargeInput(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const laborCharge = rialText(String(input.laborCharge));
  const partsCharge = rialText(String(input.partsCharge));
  const discount = rialText(String(input.discount ?? 0));
  const net = rialText(
    (rialBigInt(laborCharge) + rialBigInt(partsCharge) - rialBigInt(discount)).toString(),
  );
  const vat = roundRial(new Decimal(net).times(input.vatPercent).div(100));
  const total = rialText((rialBigInt(net) + rialBigInt(vat)).toString());

  return { laborCharge, partsCharge, discount, net, vat, total };
}
