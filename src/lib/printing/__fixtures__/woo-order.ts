import type { WooOrderDetail } from "../../integrations/woo-order-detail-service";
import { normalizeWooOrderSnapshot } from "../../integrations/woo-order-snapshot";

export const CONNECTION = "13579000-0000-4000-8000-000000000001";
export const LOCATION = "13579000-0000-4000-8000-000000000002";
export const BUSINESS = "13579000-0000-4000-8000-000000000003";
export const REVISION = "13579000-0000-4000-8000-000000000004";
export const PRINTER = "13579000-0000-4000-8000-000000000005";
export const STAFF = "13579000-0000-4000-8000-000000000006";
export const JOB = "13579000-0000-4000-8000-000000000007";

export function wooPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 1042, number: "WC-1042", status: "pending", currency: "USD",
    date_created_gmt: "2026-10-19T08:00:00", date_modified_gmt: "2026-10-20T09:00:00", date_paid: null,
    payment_method: "cod", payment_method_title: "پرداخت در محل", customer_note: "پیش از تحویل تماس بگیرید",
    billing: { first_name: "علی", last_name: "احمدی", phone: "09121234567", email: "customer@example.test", country: "IR", city: "تهران", address_1: "نشانی صورتحساب", postcode: "1234512345" },
    shipping: { first_name: "سارا", last_name: "احمدی", country: "IR", state: "تهران", city: "تهران", address_1: "خیابان نمونه، پلاک ۱۲", address_2: "واحد ۳", postcode: "1234567890" },
    line_items: [{ id: 1, product_id: 42, variation_id: 43, sku: "SKU-42", name: "محصول فارسی", quantity: 2, subtotal: "20.50", total: "19.50", total_tax: "1.95", meta_data: [{ key: "رنگ", value: "آبی" }, { key: "_secret", value: "MUST_NOT_PRINT" }] }],
    discount_total: "1.00", total_tax: "1.95", shipping_total: "3.00", shipping_tax: "0.00", total: "24.45",
    shipping_lines: [{ method_id: "flat_rate", method_title: "پست" }], fee_lines: [], coupon_lines: [{ code: "WELCOME" }], refunds: [],
    ...overrides,
  };
}

export function wooDetail(overrides: Record<string, unknown> = {}): WooOrderDetail {
  return {
    connectionId: CONNECTION, storeName: "فروشگاه نمونه", locationId: LOCATION,
    snapshotId: REVISION, revision: REVISION, receivedAt: "2026-10-20T10:00:00Z",
    localOrderId: null, localOrderNumber: null, ingestStatus: "pending", ingestError: null, operations: [],
    order: normalizeWooOrderSnapshot(wooPayload(overrides), "1042"),
  };
}
