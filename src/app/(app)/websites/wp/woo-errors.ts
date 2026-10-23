/**
 * The stable error codes the WooCommerce store APIs answer with, and what
 * each one says to a person (issue #943).
 *
 * The routes deliberately return machine codes — `push_prices_disabled`,
 * `product_not_mapped` — rather than raw internal messages. This map is the
 * other half of that contract: every code the products/orders/sync routes can
 * emit has a Persian sentence here, so the panels never show an LTR slug
 * where an explanation belongs. An unmapped code falls back to the raw text
 * (errorMessageOrRaw's rule), which keeps a new backend code visible rather
 * than silently blank.
 */
export const WOO_ERROR_LABELS: Record<string, string> = {
  not_found: "اتصال یا محصول پیدا نشد.",
  invalid_json: "بدنهٔ درخواست قابل خواندن نیست.",
  invalid_body: "بدنهٔ درخواست باید یک شیء معتبر باشد.",
  invalid_fields: "فیلدهای ارسالی باید یک شیء معتبر باشند.",
  invalid_remote_id: "شناسهٔ محصول نامعتبر است؛ شناسهٔ ووکامرس باید عددی باشد.",
  product_not_mapped: "این محصول در این فروشگاه همگام‌سازی/نگاشت نشده است.",
  invalid_price: "قیمت باید یک عدد صحیح و نامنفی (ریال) باشد.",
  invalid_sale_price: "قیمت تخفیف باید یک عدد صحیح و نامنفی (ریال) باشد.",
  invalid_manage_stock: "مقدار «مدیریت موجودی» نامعتبر است؛ باید روشن یا خاموش باشد.",
  invalid_stock_quantity: "موجودی باید یک عدد صحیح و نامنفی باشد.",
  invalid_product_status: "وضعیت انتشار نامعتبر است.",
  empty_patch: "هیچ فیلد قابل ارسالی در درخواست نبود.",
  push_prices_disabled: "ارسال قیمت برای این فروشگاه خاموش است؛ ابتدا آن را در تنظیمات اتصال روشن کنید.",
  push_stock_disabled: "ارسال موجودی برای این فروشگاه خاموش است؛ ابتدا آن را در تنظیمات اتصال روشن کنید.",
  connection_paused: "اتصال فروشگاه متوقف (paused) است؛ تا فعال‌شدن، عملیاتی ارسال نمی‌شود.",
  sync_products_disabled: "همگام‌سازی محصولات در این اتصال غیرفعال است.",
  sync_failed: "همگام‌سازی محصولات با خطا مواجه شد؛ جزئیات در «صف و رویدادها» و گزارش سرور است.",
  no_location: "هیچ شعبهٔ فعالی برای این کسب‌وکار پیدا نشد.",
  internal_error: "خطای داخلی در ثبت درخواست؛ دوباره تلاش کنید.",
};

/** The Persian sentence for a Woo API error code, or "" when unmapped. */
export function describeWooError(code: string | null | undefined): string {
  if (!code) return "";
  return WOO_ERROR_LABELS[code] ?? "";
}
