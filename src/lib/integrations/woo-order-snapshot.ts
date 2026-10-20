/** Secret-free, print-safe parity for REST webhooks and plugin order snapshots (#935).
 * No accounting conversion: Woo decimal strings remain in the source currency.
 * Private order/item metadata is deliberately allowlisted, never copied wholesale.
 */
import Decimal from "decimal.js";
import { formatPersianNumericText } from "../digits";
import type { MoneyUnit } from "../money";

const Exact = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
export const WOO_REMOTE_ID = /^[1-9][0-9]{0,15}$/;
export const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isWooRemoteId(value: unknown): value is string {
  return typeof value === "string" && WOO_REMOTE_ID.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
export function wooText(value: unknown, limit = 1000): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, limit) : "";
}
export function wooDecimal(value: unknown, fallback = "0"): string {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^-?\d{1,24}(?:\.\d{1,12})?$/.test(text)) {
    if (fallback === "") throw new Error("woo_amount_invalid");
    return fallback;
  }
  return text;
}
export function sumWoo(values: string[]): string { return values.reduce((sum, v) => sum.plus(v), new Exact(0)).toFixed(); }
export function subtractWoo(a: string, b: string): string { return new Exact(a).minus(b).toFixed(); }
export function positiveWoo(value: string): boolean { return new Exact(value).gt(0); }
export function absoluteWoo(value: string): string { return new Exact(value).abs().toFixed(); }
function date(value: unknown): string | null {
  const s = wooText(value, 50);
  return s && Number.isFinite(Date.parse(s)) ? s : null;
}
function sourceDate(raw: Record<string, unknown>, key: string): string | null {
  const utc = date(raw[`${key}_gmt`]);
  return utc ? (/Z$|[+-]\d\d:\d\d$/.test(utc) ? utc : `${utc}Z`) : date(raw[key]);
}

export interface WooAddress {
  firstName: string; lastName: string; company: string; phone: string; email: string;
  address1: string; address2: string; city: string; state: string; postcode: string; country: string;
}
function address(value: unknown): WooAddress {
  const a = record(value);
  return {
    firstName: wooText(a.first_name, 100), lastName: wooText(a.last_name, 100), company: wooText(a.company, 200),
    phone: wooText(a.phone, 80), email: wooText(a.email, 200), address1: wooText(a.address_1, 400), address2: wooText(a.address_2, 400),
    city: wooText(a.city, 120), state: wooText(a.state, 120), postcode: wooText(a.postcode, 40), country: wooText(a.country, 80),
  };
}
export function wooRecipientName(a: WooAddress): string { return [a.firstName, a.lastName].filter(Boolean).join(" "); }
export function wooAddressText(a: WooAddress): string { return [a.country, a.state, a.city, a.address1, a.address2, a.postcode].filter(Boolean).join("، "); }
export function missingShipmentFields(a: WooAddress): string[] {
  return [
    ["نام گیرنده", wooRecipientName(a)], ["تلفن گیرنده", a.phone], ["نشانی", a.address1],
    ["شهر", a.city], ["کد پستی", a.postcode], ["کشور", a.country],
  ].filter(([, value]) => !value).map(([label]) => label);
}
export interface WooSnapshotLine {
  id: string; name: string; sku: string; variationId: string; variation: string;
  quantity: number; unitPrice: string; subtotal: string; total: string; tax: string; discount: string;
}
export interface WooShipment { trackingId: string; provider: string; }
export interface WooOrderSnapshot {
  remoteId: string; number: string; status: string; currency: string; decimals: number;
  createdAt: string | null; updatedAt: string | null; paidAt: string | null;
  paymentMethod: string; paymentTitle: string; customerNote: string;
  billing: WooAddress; shipping: WooAddress; lines: WooSnapshotLine[];
  shippingMethods: string[]; shipments: WooShipment[];
  subtotal: string; discount: string; tax: string; shippingTotal: string; shippingTax: string;
  fees: { name: string; total: string; tax: string }[]; coupons: string[];
  total: string; paid: string; refunded: string; due: string;
  paymentState: string; warnings: string[]; missingShipping: string[]; reconciliationDelta: string;
}
export function normalizeWooOrderSnapshot(payload: unknown, remoteId: string): WooOrderSnapshot {
  const raw = record(payload);
  const total = wooDecimal(raw.total, "");
  if (new Exact(total).isNegative()) throw new Error("woo_amount_invalid");
  if (!/^[A-Z]{3,8}$/.test(String(raw.currency ?? ""))) throw new Error("woo_currency_invalid");
  const billing = address(raw.billing);
  const shipping = address(raw.shipping);
  // Woo commonly collects one checkout phone in billing, but never substitute
  // a billing address/name for the recipient without an operator's verification.
  if (!shipping.phone) shipping.phone = billing.phone;
  const lines = list(raw.line_items).map((l): WooSnapshotLine => {
    const quantity = Number(l.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) throw new Error("woo_amount_invalid");
    const lineTotal = wooDecimal(l.total, "");
    const subtotal = wooDecimal(l.subtotal, lineTotal);
    return {
      id: wooText(l.id, 40), name: wooText(l.name, 400), sku: wooText(l.sku, 100), variationId: wooText(l.variation_id, 40),
      // Only displayed variation attributes; private meta keys never reach a document.
      variation: list(l.meta_data).filter(m => !wooText(m.key).startsWith("_") && typeof m.value === "string")
        .map(m => `${wooText(m.display_key ?? m.key, 80)}: ${wooText(m.display_value ?? m.value, 160)}`).slice(0, 12).join(" · "),
      quantity, unitPrice: new Exact(subtotal).div(quantity).toDecimalPlaces(12).toFixed(),
      subtotal, total: lineTotal, tax: wooDecimal(l.total_tax), discount: subtractWoo(subtotal, lineTotal),
    };
  });
  if (!lines.length) throw new Error("woo_amount_invalid");
  const fees = list(raw.fee_lines).map(f => ({ name: wooText(f.name, 200), total: wooDecimal(f.total, ""), tax: wooDecimal(f.total_tax) }));
  const subtotal = sumWoo(lines.map(l => l.subtotal));
  const discount = wooDecimal(raw.discount_total, sumWoo(lines.map(l => l.discount)));
  const tax = wooDecimal(raw.total_tax);
  const shippingTotal = wooDecimal(raw.shipping_total);
  // Woo's PHP aggregate is a float; refund records retain their exact decimal
  // strings. Prefer those records in both REST and plugin snapshots.
  const refunds = list(raw.refunds);
  const refunded = refunds.length
    ? sumWoo(refunds.map(r => absoluteWoo(wooDecimal(r.total, ""))))
    : raw.total_refunded != null ? absoluteWoo(wooDecimal(raw.total_refunded, "")) : "0";
  const paidAt = sourceDate(raw, "date_paid");
  const status = wooText(raw.status, 60);
  // COD processing is not proof the courier has collected payment.
  const codUncollected = raw.payment_method === "cod" && status !== "completed";
  const paid = paidAt && !codUncollected ? total : "0";
  const closed = status === "cancelled" || status === "refunded" || status === "failed";
  const due = closed ? "0" : Exact.max(0, new Exact(total).minus(paid)).toFixed();
  const paymentMethod = wooText(raw.payment_method, 100);
  const paymentState = status === "cancelled" ? "لغو شده" : status === "refunded" ? "برگشت کامل" : status === "failed" ? "سفارش ناموفق — پرداخت نیازمند بررسی"
    : positiveWoo(refunded) ? "برگشت جزئی" : positiveWoo(paid) ? "پرداخت‌شده"
    : paymentMethod === "cod" ? "پرداخت در محل — وصول تأیید نشده" : "پرداخت تأیید نشده";
  const warnings: string[] = [];
  if (closed || !positiveWoo(paid) || positiveWoo(refunded)) warnings.push(paymentState);
  const meta = list(raw.meta_data);
  const tracking = meta.find(m => m.key === "_wc_shipment_tracking_items")?.value;
  const shipments = list(raw.shipments ?? tracking).map(t => ({
    trackingId: wooText(t.tracking_number, 120), provider: wooText(t.custom_tracking_provider || t.tracking_provider, 120),
  })).filter(t => t.trackingId);
  const allAmounts = [total, tax, discount, shippingTotal, refunded, ...lines.flatMap(l => [l.total, l.subtotal, l.tax]), ...fees.map(f => f.total)];
  const inferred = Math.max(...allAmounts.map(a => a.split(".")[1]?.length ?? 0));
  const configured = Number(raw.currency_decimals);
  const defaultPrecision = ["IRR", "IRT", "RIAL", "TOMAN"].includes(String(raw.currency)) ? 0 : 2;
  const decimals = Math.max(inferred, Number.isInteger(configured) && configured >= 0 && configured <= 12 ? configured : defaultPrecision);
  const expected = new Exact(subtotal).minus(discount).plus(tax).plus(shippingTotal).plus(sumWoo(fees.map(f => f.total)));
  const reconciliationDelta = new Exact(total).minus(expected).toFixed();
  if (!new Exact(reconciliationDelta).isZero()) warnings.push("اجزای مبلغ با جمع منبع نیازمند تطبیق است؛ جمع سفارش ووکامرس ملاک است");
  return {
    remoteId, number: wooText(raw.number, 100) || remoteId, status, currency: String(raw.currency), decimals,
    createdAt: sourceDate(raw, "date_created"), updatedAt: sourceDate(raw, "date_modified"), paidAt,
    paymentMethod, paymentTitle: wooText(raw.payment_method_title, 200) || paymentMethod,
    customerNote: wooText(raw.customer_note, 2000), billing, shipping, lines,
    shippingMethods: list(raw.shipping_lines).map(l => wooText(l.method_title || l.method_id, 200)).filter(Boolean), shipments,
    subtotal, discount, tax, shippingTotal, shippingTax: wooDecimal(raw.shipping_tax), fees,
    coupons: list(raw.coupon_lines).map(c => wooText(c.code, 100)).filter(Boolean),
    total, paid, refunded, due, paymentState, warnings, missingShipping: missingShipmentFields(shipping), reconciliationDelta,
  };
}

/** Exact source currency presentation, including fractional Rial/Toman. No integer-Rial coercion. */
export function formatWooMoney(amount: string, currency: string, decimals = 2, displayUnit?: MoneyUnit): string {
  let value = new Exact(wooDecimal(amount, ""));
  let code = currency;
  let precision = decimals;
  if (displayUnit && ["IRR", "RIAL", "IRT", "TOMAN"].includes(code)) {
    const sourceToman = code === "IRT" || code === "TOMAN";
    if (sourceToman && displayUnit === "rial") { value = value.mul(10); precision = Math.max(0, decimals - 1); }
    if (!sourceToman && displayUnit === "toman") { value = value.div(10); precision = decimals + 1; }
    code = displayUnit === "rial" ? "IRR" : "IRT";
  }
  const label = code === "IRR" || code === "RIAL" ? "ریال" : code === "IRT" || code === "TOMAN" ? "تومان" : code;
  const text = value.toFixed(Math.max(precision, value.decimalPlaces()));
  return `${formatPersianNumericText(text, { allowDecimal: true, allowNegative: true, grouping: true })} ${label}`;
}
