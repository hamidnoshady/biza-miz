import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php", "utf8");
const order = source.slice(source.indexOf("public static function order_payload("), source.indexOf("private static function public_order_item_meta("));
const meta = source.slice(source.indexOf("private static function public_order_item_meta("), source.indexOf("private static function public_order_item_meta(") + 850);

describe("plugin/REST order snapshot payload parity (PHP source contract)", () => {
  it("exports full checkout addresses, source times/payment, exact source money and order number", () => {
    for (const key of ["number", "status", "currency", "currency_decimals", "total", "total_tax", "discount_total", "shipping_total", "shipping_tax", "discount_tax", "total_refunded", "payment_method", "payment_method_title", "date_paid", "date_modified", "customer_note", "billing", "shipping"]) expect(order).toContain(`'${key}'`);
    for (const prefix of ["billing", "shipping"]) {
      for (const field of ["first_name", "last_name", "company", "address_1", "address_2", "state", "city", "postcode", "country", "phone"]) expect(order).toContain(`get_${prefix}_${field}`);
    }
    expect(order).toContain("(string) $order->get_total()");
    expect(order).toContain("DATE_ATOM");
    expect(order).toContain("is_callable( array( $order, 'get_shipping_phone' ) )");
  });
  it("keeps parent/variation identity, quantity, public variation metadata, per-unit subtotal and line discounts/tax", () => {
    for (const key of ["product_id", "variation_id", "sku", "quantity", "subtotal", "total", "total_tax", "meta_data", "price"]) expect(order).toContain(`'${key}'`);
    expect(order).toContain("$order->get_item_subtotal( $item, false, false )");
    expect(order).toContain("'quantity'     => $item->get_quantity()");
    expect(meta).toContain("is_scalar");
    expect(meta).toContain("'_' === substr");
  });
  it("exports actual shipment tracking only, plus shipping services, fees, coupons and refund amounts", () => {
    for (const key of ["shipping_lines", "fee_lines", "coupon_lines", "refunds", "shipments"]) expect(order).toContain(`'${key}'`);
    expect(order).toContain("$order->get_meta( '_wc_shipment_tracking_items', true )");
    expect(order).toContain("empty( $shipment['tracking_number'] )");
    expect(order).toContain("sanitize_text_field( $shipment['tracking_number'] )");
    expect(order).not.toContain("$order->get_meta_data()");
    expect(order).not.toContain("wc_get_order_notes"); // private admin notes are not a print source
  });
  it("is a pure snapshot builder — no payment, status, stock or order writes", () => {
    expect(order).not.toMatch(/->(?:save|update_status|set_status|payment_complete|reduce_order_stock)\s*\(/);
    expect(order).not.toContain("wc_create_order");
  });
});
