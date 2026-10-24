/**
 * Issue #918 — the retail supplier-return voucher's domain errors, in Persian,
 * ONCE.
 *
 * The service throws `RetailReturnError` with a stable machine code and an
 * HTTP status; the route answers `{ error: code, message }` with that status;
 * the dashboard's shared error map (src/app/dashboard/ui.tsx) spreads
 * `RETAIL_RETURN_ERROR_TRANSLATIONS` so every screen renders the same Persian
 * sentence for the same code. No raw PostgreSQL text ever reaches the UI.
 *
 * This module is deliberately dependency-free and client-safe — it is imported
 * by a "use client" error map, so it must never gain a server-only import
 * (node:crypto, pg, …). Payload parsing and the idempotency fingerprint live
 * in retail-return-validation.ts (server-only); the money math stays in
 * inventory-exact.ts.
 */

export class RetailReturnError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: keyof typeof RETAIL_RETURN_ERROR_TRANSLATIONS | (string & {}), status = 400) {
    super(RETAIL_RETURN_ERROR_TRANSLATIONS[code] ?? RETAIL_RETURN_ERROR_TRANSLATIONS.return_failed);
    this.name = "RetailReturnError";
    this.code = code;
    this.status = status;
  }
}

export const RETAIL_RETURN_ERROR_TRANSLATIONS: Record<string, string> = {
  return_failed: "ثبت برگشت ناموفق بود.",
  return_invalid: "برگشت نامعتبر است.",
  idempotency_key_required: "شناسهٔ ارسال (idempotency key) الزامی است؛ فرم را تازه‌سازی کنید و دوباره تلاش کنید.",
  idempotency_conflict:
    "این شناسهٔ ارسال قبلاً با مشخصات دیگری ثبت شده است؛ صفحه را تازه‌سازی کنید و برگشت جدید بسازید.",
  settlement_required: "روش تسویه را انتخاب کنید.",
  settlement_invalid: "روش تسویه معتبر نیست.",
  reason_required: "دلیل برگشت را بنویسید.",
  reason_too_long: "دلیل برگشت بیش از حد طولانی است.",
  lines_required: "برگشت بدون قلم کالا قابل ثبت نیست.",
  too_many_lines: "تعداد اقلام برگشت بیش از حد مجاز است.",
  invalid_line: "یکی از اقلام برگشت نامعتبر است.",
  item_not_found: "کالا یافت نشد.",
  variant_parent_unsupported: "موجودی روی خودِ خانوادهٔ کالا ثبت نمی‌شود؛ روی هر تنوع جداگانه ثبت کنید.",
  weight_unsupported: "برگشت کالای وزنی از مسیر همان کالا ثبت می‌شود، نه از حواله بازگشت.",
  quantity_invalid: "تعداد باید عددی بزرگ‌تر از صفر باشد.",
  quantity_precision_exceeded: "تعداد حداکثر ۹ رقم اعشار می‌تواند داشته باشد.",
  quantity_out_of_range: "تعداد بیش از حد مجاز است.",
  serial_quantity_must_be_one: "برگشت کالای سریالی هر ردیف دقیقاً یک دستگاه است.",
  serial_required: "برای برگشت کالای سریالی، سریال دقیق دستگاه را مشخص کنید.",
  serial_not_found: "سریال یافت نشد.",
  serial_not_in_stock: "فقط دستگاهِ موجود در انبار را می‌توان به تأمین‌کننده برگرداند.",
  serial_already_sold: "این دستگاه قبلاً فروخته شده و قابل برگشت به تأمین‌کننده نیست.",
  serial_already_returned: "این دستگاه قبلاً به تأمین‌کننده برگشت خورده است.",
  serial_provenance_mismatch: "این دستگاه از خریدِ انتخاب‌شده دریافت نشده است.",
  batch_required: "برای برگشت کالای بچ‌محور، بچ را مشخص کنید.",
  batch_not_found: "بچ یافت نشد.",
  batch_item_mismatch: "این بچ متعلق به کالای انتخاب‌شده نیست.",
  batch_provenance_mismatch: "این بچ از خریدِ انتخاب‌شده دریافت نشده است.",
  batch_depleted: "موجودی بچ کافی نیست.",
  stock_insufficient: "موجودی کافی نیست.",
  cost_missing: "بهای تمام‌شده ثبت نشده است؛ برگشت بدون مبنای بها ممکن نیست.",
  purchase_not_found: "خریدِ مبنا یافت نشد.",
  purchase_cancelled: "این خرید لغو شده و قابل برگشت نیست.",
  purchase_location_mismatch: "این خرید متعلق به انبار جاری نیست.",
  purchase_item_not_found: "قلم خریدِ مبنا یافت نشد.",
  ambiguous_purchase_line: "این کالا در خریدِ مبنا با چند بهای مختلف ثبت شده؛ قلم دقیق خرید را مشخص کنید.",
  item_not_in_purchase: "این کالا در خریدِ انتخاب‌شده وجود ندارد.",
  ceiling_exceeded: "مجموع برگشت‌شده از مقدار دریافت‌شدهٔ این خرید بیشتر می‌شود.",
  supplier_not_found: "تأمین‌کننده یافت نشد.",
  supplier_location_mismatch: "این تأمین‌کننده متعلق به انبار جاری نیست.",
  supplier_mismatch: "تأمین‌کنندهٔ انتخاب‌شده با تأمین‌کنندهٔ خریدِ مبنا یکی نیست.",
  supplier_required_for_payable: "تسویه از بدهی به تأمین‌کننده بدون تأمین‌کنندهٔ مشخص ممکن نیست.",
  return_not_found: "حواله بازگشت یافت نشد.",
  reversal_reason_required: "دلیل معکوس‌سازی حواله را بنویسید.",
  return_already_reversed: "این حواله قبلاً معکوس شده است.",
  return_not_reversible: "وضعیت این حواله اجازهٔ معکوس‌سازی نمی‌دهد.",
  return_reversal_provenance_missing: "ردیابی بچ یا سریال این حواله برای بازگردانی موجودی کامل نیست.",
  return_reversal_stock_changed: "وضعیت موجودی پس از حواله تغییر کرده و بازگردانی خودکار امن نیست.",
};
