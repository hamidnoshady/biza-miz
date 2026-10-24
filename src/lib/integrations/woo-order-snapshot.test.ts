import { describe, expect, it } from "vitest";
import { formatWooMoney, isWooRemoteId, normalizeWooOrderSnapshot, wooAddressText } from "./woo-order-snapshot";
import { wooPayload } from "../printing/__fixtures__/woo-order";

const normalize = (overrides: Record<string, unknown> = {}) => normalizeWooOrderSnapshot(wooPayload(overrides), "1042");

describe("Woo source normalization — no Rial accounting coercion", () => {
  it.each(["IRR", "IRT", "USD", "AED"])("preserves exact %s source decimals, discounts, fees, tax and refunds", currency => {
    const order = normalize({ currency, total: "9007199254740993.125", total_refunded: "0.125", fee_lines: [{ name: "بسته‌بندی", total: "0.25", total_tax: "0.05" }] });
    expect(order.total).toBe("9007199254740993.125");
    expect(order.refunded).toBe("0.125");
    expect(order.discount).toBe("1.00");
    expect(order.lines[0]).toMatchObject({ unitPrice: "10.25", discount: "1", tax: "1.95", total: "19.50", variation: "رنگ: آبی" });
    expect(order.fees).toEqual([{ name: "بسته‌بندی", total: "0.25", tax: "0.05" }]);
    expect(order.decimals).toBe(3);
    expect(order.warnings).toContain("اجزای مبلغ با جمع منبع نیازمند تطبیق است؛ جمع سفارش ووکامرس ملاک است");
  });
  it("reconciles line subtotal - discounts + all tax + shipping + fees exactly", () => {
    const order = normalize();
    expect(order.reconciliationDelta).toBe("0");
    expect(order.coupons).toEqual(["WELCOME"]);
    expect(order.createdAt).toBe("2026-10-19T08:00:00Z");
  });
  it("matches the REST tracking allowlist to the plugin's explicit shipment payload", () => {
    const tracking = [{ tracking_number: "12345678901234567890", tracking_provider: "پست" }];
    const rest = normalize({ meta_data: [{ key: "_wc_shipment_tracking_items", value: tracking }, { key: "_consumer_secret", value: "SECRET" }] });
    const plugin = normalize({ shipments: tracking });
    expect(rest.shipments).toEqual(plugin.shipments);
    expect(JSON.stringify(rest)).not.toContain("SECRET");
    expect(normalize().shipments).toEqual([]);
  });
  it("never substitutes the billing recipient/address when shipping is missing", () => {
    const order = normalize({ shipping: {} });
    expect(order.shipping.phone).toBe("09121234567");
    expect(wooAddressText(order.shipping)).toBe("");
    expect(order.missingShipping).toEqual(["نام گیرنده", "نشانی", "شهر", "کد پستی", "کشور"]);
    expect(JSON.stringify(order)).not.toContain("MUST_NOT_PRINT");
  });
  it.each(["-1", "NaN", "1e20", "1,000", "0.1234567890123", "<script>"])("refuses malformed totals: %s", total => {
    expect(() => normalize({ total })).toThrow("woo_amount_invalid");
  });
  it("refuses an unsupported/absent currency instead of defaulting to Rial", () => {
    expect(() => normalize({ currency: "" })).toThrow("woo_currency_invalid");
  });
  it("handles fractional quantities and 12 decimal places without IEEE754 sums", () => {
    const order = normalize({ currency: "AED", total: "0.300000000001", total_tax: "0", shipping_total: "0", discount_total: "0", line_items: [{ name: "وزنی", quantity: 1, subtotal: "0.300000000001", total: "0.300000000001" }] });
    expect(order.lines[0].unitPrice).toBe("0.300000000001");
    expect(order.reconciliationDelta).toBe("0");
  });
});

describe("truthful source payment states", () => {
  it.each(["pending", "on-hold", "processing", "completed"])("never infers paid from %s or is_paid", status => {
    const order = normalize({ status, payment_method: "bacs", is_paid: true });
    expect(order.paid).toBe("0");
    expect(order.due).toBe("24.45");
    expect(order.paymentState).toBe("پرداخت تأیید نشده");
  });
  it("does not mistake Woo's COD processing paid timestamp for courier collection", () => {
    const order = normalize({ status: "processing", date_paid_gmt: "2026-10-20T09:00:00" });
    expect(order.paid).toBe("0");
    expect(order.paymentState).toContain("وصول تأیید نشده");
  });
  it("prefers exact refund record totals over a float-derived Woo/PHP aggregate", () => {
    const order = normalize({ total_refunded: "9007199254740993.12", refunds: [
      { total: "-9007199254740993.125" }, { total: "-0.000000000001" },
    ] });
    expect(order.refunded).toBe("9007199254740993.125000000001");
  });
  it("uses an authoritative paid timestamp for prepaid payment and keeps a partial refund separate", () => {
    const order = normalize({ payment_method: "stripe", status: "processing", date_paid_gmt: "2026-10-20T09:00:00", refunds: [{ total: "-2.50" }] });
    expect(order).toMatchObject({ paid: "24.45", refunded: "2.5", due: "0", paymentState: "برگشت جزئی" });
  });
  it.each(["cancelled", "refunded", "failed"])("has an explicit %s warning and no collectible due", status => {
    const order = normalize({ status, payment_method: "bacs" });
    expect(order.due).toBe("0");
    expect(order.warnings).toContain(order.paymentState);
    expect(order.paymentState).not.toBe("پرداخت‌شده");
  });
});

describe("exact presentation and bounded identities", () => {
  it("converts only Iranian display units, preserving fractional Rial/Toman", () => {
    expect(formatWooMoney("123.45", "IRR", 2, "toman")).toContain("۱۲٫۳۴۵ تومان");
    expect(formatWooMoney("12.345", "IRT", 3, "rial")).toContain("۱۲۳٫۴۵ ریال");
    expect(formatWooMoney("24.45", "USD", 2, "toman")).toContain("۲۴٫۴۵ USD");
    expect(formatWooMoney("24.45", "AED", 2, "rial")).toContain("۲۴٫۴۵ AED");
  });
  it.each(["0", "-1", "1.5", "1 OR 1=1", "9007199254740992", "00042"])("rejects malformed/unsafe remote identity %s", value => expect(isWooRemoteId(value)).toBe(false));
  it("accepts actual positive Woo identities without a local accounting UUID", () => expect(isWooRemoteId("1042")).toBe(true));
});
