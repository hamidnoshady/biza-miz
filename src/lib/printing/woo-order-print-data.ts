/** Woo source bridge into the canonical template renderer. Never creates a sale/payment. */
import type { MoneyUnit } from "../money";
import type { PrintDocumentData } from "../print-template";
import type { WooOrderDetail } from "../integrations/woo-order-detail-service";
import { formatWooMoney, wooAddressText, wooRecipientName } from "../integrations/woo-order-snapshot";
import type { PrintBranding } from "./document-bridge";

export interface WooLabelSelection { shipmentIndex?: number; packageIndex?: number; packageCount?: number; }
export function buildWooPrintDocument(
  detail: WooOrderDetail,
  kind: "woo_invoice" | "shipping_label",
  displayUnit: MoneyUnit,
  selection: WooLabelSelection = {},
): PrintDocumentData {
  const o = detail.order;
  const money = (a: string) => formatWooMoney(a, o.currency, o.decimals, displayUnit);
  const shipment = o.shipments[selection.shipmentIndex ?? 0];
  const receiver = o.shipping;
  return {
    business: { name: detail.storeName },
    title: kind === "shipping_label" ? "برچسب ارسال سفارش" : o.paid === "0" ? "پیش‌فاکتور سفارش آنلاین (غیرمالیاتی)" : "فاکتور سفارش آنلاین (غیرمالیاتی)",
    number: o.number,
    subtitle: `${detail.storeName} · ${o.paymentState}`,
    issuedAt: o.createdAt ?? detail.receivedAt,
    customer: { name: wooRecipientName(o.billing) || o.billing.company || "مشتری مهمان", phone: o.billing.phone, address: wooAddressText(o.billing) },
    lines: o.lines.map(l => ({ name: l.name, quantity: l.quantity,
      detail: [l.sku ? `SKU: ${l.sku}` : "", l.variationId && l.variationId !== "0" ? `تنوع ${l.variationId}` : "", l.variation].filter(Boolean).join(" · "),
      // Source amounts below are the ONLY monetary values rendered for Woo.
      lineTotal: 0,
    })),
    subtotal: 0, discount: 0, tax: 0, total: 0,
    sourceAmounts: {
      currency: o.currency,
      lines: o.lines.map(l => ({ unitPrice: money(l.unitPrice), discount: money(l.discount), tax: money(l.tax), total: money(l.total) })),
      totals: [
        { label: "جمع اقلام پیش از تخفیف", value: money(o.subtotal) },
        { label: `تخفیف${o.coupons.length ? ` (${o.coupons.join("، ")})` : ""}`, value: money(o.discount) },
        { label: "مالیات (شامل مالیات ارسال و هزینه‌ها)", value: money(o.tax) },
        { label: "هزینه ارسال (پیش از مالیات)", value: money(o.shippingTotal) },
        ...o.fees.map(f => ({ label: f.name || "سایر هزینه‌ها", value: money(f.total) })),
        { label: "جمع سفارش ووکامرس", value: money(o.total), grand: true },
        { label: "پرداخت تأییدشده در منبع", value: money(o.paid) },
        { label: "برگشت وجه", value: money(o.refunded) },
        { label: "مانده قابل وصول", value: money(o.due) },
      ],
    },
    warnings: o.warnings,
    sourceRevision: { id: detail.snapshotId, receivedAt: detail.receivedAt, updatedAt: o.updatedAt },
    note: o.customerNote || null,
    paymentDescription: `${o.paymentTitle || "روش پرداخت ثبت نشده"} · ${o.paymentState}`,
    shipment: {
      recipient: wooRecipientName(receiver), company: receiver.company, phone: receiver.phone,
      address: wooAddressText(receiver), method: o.shippingMethods.join("، "),
      trackingId: shipment?.trackingId || null, provider: shipment?.provider || null,
      packageIndex: selection.packageIndex ?? 1, packageCount: selection.packageCount ?? 1,
      payment: `${o.paymentState}${o.paymentMethod === "cod" ? ` · قابل وصول: ${money(o.due)}` : ""}`,
      contents: o.lines.map(l => `${l.quantity} × ${l.name}`).join("، "),
    },
    qrPayload: `woo-order:${detail.connectionId}:${o.remoteId}`,
    barcodeValue: o.number,
    barcodeFormat: "code128",
  };
}

/** Central branding is still the only sender/legal identity source. */
export function withWooBranding(data: PrintDocumentData, branding: PrintBranding): PrintDocumentData {
  return { ...data, business: { ...branding, name: branding.name || data.business.name } };
}

export function wooPrintSample(kind: "woo_invoice" | "shipping_label", branding: PrintBranding = {}): PrintDocumentData {
  const shipping = { firstName: "سارا", lastName: "احمدی", company: "", phone: "09120000000", email: "",
    address1: "خیابان نمونه، پلاک ۱۲، واحد ۳", address2: "طبقه دوم", city: "تهران", state: "تهران", postcode: "1234567890", country: "IR" };
  const detail: WooOrderDetail = {
    connectionId: "sample", locationId: "sample", storeName: branding.name || "فروشگاه نمونه", snapshotId: "sample", revision: "sample",
    receivedAt: "2026-10-20T09:00:00Z", localOrderId: null, localOrderNumber: null, ingestStatus: "pending", ingestError: null, operations: [],
    order: { remoteId: "1042", number: "WC-1042", status: "pending", currency: "USD", decimals: 2,
      createdAt: "2026-10-20T08:00:00Z", updatedAt: "2026-10-20T09:00:00Z", paidAt: null,
      paymentMethod: "cod", paymentTitle: "پرداخت در محل", customerNote: "پیش از تحویل تماس بگیرید", billing: shipping, shipping,
      lines: [{ id: "1", name: "محصول نمونه", sku: "SKU-42", variationId: "0", variation: "رنگ: آبی", quantity: 2, unitPrice: "10.25", subtotal: "20.50", discount: "1.00", tax: "1.95", total: "19.50" }],
      shippingMethods: ["پست"], shipments: [], subtotal: "20.50", discount: "1.00", tax: "1.95", shippingTotal: "3.00", shippingTax: "0", fees: [], coupons: ["WELCOME"],
      total: "24.45", paid: "0", refunded: "0", due: "24.45", paymentState: "پرداخت در محل — وصول تأیید نشده",
      warnings: ["چاپ آزمایشی — پرداخت تأیید نشده"], missingShipping: [], reconciliationDelta: "0",
    },
  };
  return withWooBranding(buildWooPrintDocument(detail, kind, "toman"), branding);
}
