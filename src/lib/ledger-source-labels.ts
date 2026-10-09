/**
 * One Persian label per `journal_entries.source_type`.
 *
 * A journal entry's `source_type` is the machine name of whatever posted it
 * (`ar_receipt`, `gold_sale`, `stock_count_reversal`, …). Three screens used to
 * keep their own short map of those codes — the journal (`entries-section`),
 * bank reconciliation and the reports drill-down — and each covered fewer than
 * ten of the fifty-odd codes the posting engine actually emits, so «دفتر
 * روزنامه» printed raw English like `retail_invoice` or `cheque` next to its
 * Persian columns. That is the same failure the assistant's rule names — a
 * label is a fact the app owes the reader, never a code they must decode — so
 * the map lives here once, is complete, and is asserted complete by
 * `ledger-source-labels.test.ts`.
 *
 * Framework-free on purpose: the client components and the (future) export
 * paths read the same table.
 */

export const LEDGER_SOURCE_LABELS: Record<string, string> = {
  // Sales — F&B and the retail trades
  order: "فروش سفارش",
  order_item: "قلم سفارش",
  order_amendment: "اصلاح سفارش",
  retail_invoice: "فاکتور فروش",
  retail_invoice_void: "ابطال فاکتور فروش",
  sale: "فروش",
  accessory_sale: "فروش لوازم جانبی",
  cosmetic_sale: "فروش آرایشی و بهداشتی",
  gold_sale: "فروش طلا",
  gold_consignment_sale: "فروش طلای امانی",
  gold_buy_back: "خرید طلا از مشتری",
  gold_account_manual: "تعدیل حساب طلا",
  watch_sale: "فروش ساعت",
  custom_order_ticket: "سفارش ساخت",
  repair_ticket: "تعمیرات",
  serial_transfer: "انتقال دستگاه بین شعب",
  layaway_plan: "پیش‌فروش (رزرو کالا)",
  layaway_payment: "قسط پیش‌فروش",
  consignment_payout: "تسویهٔ امانی",
  customer_return: "مرجوعی مشتری",
  woocommerce_order: "سفارش ووکامرس",
  woocommerce_refund: "بازپرداخت ووکامرس",
  cms_store_order: "سفارش فروشگاه سایت",

  // Purchasing and stock
  purchase: "خرید",
  item_purchase: "خرید کالا",
  supplier_return: "برگشت به تأمین‌کننده",
  item_supplier_return: "برگشت کالا به تأمین‌کننده",
  production: "تولید",
  waste: "ضایعات",
  stock_count: "شمارش موجودی",
  stock_count_reversal: "برگشت شمارش موجودی",
  // سیستم ادواری — بستن دوره (periodic-closing-service.ts).
  periodic_closing: "بستن دوره انبار (ادواری)",
  item_stock_count: "شمارش موجودی کالا",
  item_stock_transfer: "انتقال موجودی کالا",
  item_audit: "بازبینی کالا",
  item: "کالا",
  inventory_transfer: "انتقال بین انبار",
  inventory_transfer_cancel: "لغو انتقال انبار",
  inventory_write_down: "کاهش ارزش موجودی",
  warehouse_issue: "حوالهٔ انبار",
  retail_warehouse_document: "سند انبار فروشگاهی",
  opening_inventory: "موجودی افتتاحیه",
  holoo_import: "ورود از هلو",
  cosmetic_tester: "تستر و کالای منقضی",
  cosmetic_write_off: "امحای کالای آرایشی",

  // Money in and out
  ar_receipt: "دریافت از مشتری",
  ap_payment: "پرداخت به تأمین‌کننده",
  ap_payment_reversal: "برگشت پرداخت به تأمین‌کننده",
  installment_interest: "سود برنامهٔ اقساط",
  cheque: "چک",
  expense: "هزینه",
  payroll_accrual: "تعهد حقوق",
  payroll_payment: "پرداخت حقوق",
  payroll_advance: "مساعده کارکنان",
  payroll_accrual_void: "ابطال تعهد حقوق",
  payroll_payment_void: "ابطال پرداخت حقوق",
  payroll_advance_void: "ابطال مساعده",
  payroll_engine_accrual: "حقوق و دستمزد (موتور قانونی)",
  payroll_engine_payment: "پرداخت حقوق (موتور قانونی)",
  fixed_asset_depreciation: "استهلاک دارایی ثابت",
  fixed_asset_disposal: "واگذاری دارایی ثابت",
  fixed_asset_acquisition: "خرید دارایی ثابت",

  // Marketing and loyalty
  gift_card: "کارت هدیه",
  loyalty_points_redemption: "مصرف امتیاز وفاداری",
  loyalty_store_credit: "اعتبار فروشگاهی",
  loyalty_store_credit_use: "مصرف اعتبار فروشگاهی",
  message_campaign: "هزینهٔ کمپین پیامکی",

  // The ledger's own documents
  manual: "سند دستی",
  manual_adjustment: "تعدیل دستی",
  opening: "تراز افتتاحیه",
  closing: "بستن سال مالی",

  // شرکت پلتفرم — the internal company's own accounting, posted from the
  // platform billing outbox (migration 0193). Subscription revenue and wallet
  // settlements of a customer's subscription invoice are the company's trades,
  // so they land in this ledger with a label the company's accountant reads.
  platform_billing: "صورتحساب پلتفرم",
};

/**
 * The Persian label for a `source_type`, or a readable fallback.
 *
 * A code this table has never heard of (a newer posting rule on an older
 * deploy) falls back to «سند سیستمی» rather than to the raw English code: a
 * reader who cannot act on `foo_bar` is better served by knowing it was posted
 * by the system than by being handed the identifier. `null`/empty — an entry
 * with no source at all — reads as an em dash.
 */
export function ledgerSourceLabel(sourceType: string | null | undefined): string {
  const code = sourceType?.trim();
  if (!code) return "—";
  return LEDGER_SOURCE_LABELS[code] ?? "سند سیستمی";
}
