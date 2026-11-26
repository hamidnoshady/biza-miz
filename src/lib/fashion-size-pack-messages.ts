/** GH #1567 6C — Persian messages for size-pack error codes (client-safe: no I/O). */
import { toPersianDigits } from "./digits";

const MESSAGES: Record<string, string> = {
  bad_request: "اطلاعات واردشده کامل یا معتبر نیست.",
  industry_mismatch: "بستهٔ سایزی فقط برای کسب‌وکار پوشاک و مد فعال است.",
  location_required: "ابتدا شعبه را انتخاب کنید.",
  pack_name_required: "نام بسته را وارد کنید.",
  pack_has_no_components: "بسته دست‌کم یک تنوع (سایز/رنگ) لازم دارد.",
  pack_too_many_components: "تعداد اجزای بسته بیش از حد مجاز است.",
  pack_duplicate_component: "یک تنوع دو بار در بسته آمده است.",
  pack_invalid_quantity: "تعداد هر تنوع باید عدد صحیح مثبت باشد.",
  pack_invalid_price: "قیمت عمده معتبر نیست.",
  pack_price_too_large: "قیمت بسته بیش از حد مجاز است.",
  pack_invalid_barcode: "بارکد بسته معتبر نیست.",
  pack_barcode_taken: "این بارکد در این شعبه برای کالا یا بستهٔ دیگری ثبت شده است.",
  pack_name_taken: "بسته‌ای با این نام در این شعبه وجود دارد.",
  pack_not_found: "بسته پیدا نشد.",
  pack_inactive: "این بسته غیرفعال است.",
  pack_industry_mismatch: "بستهٔ سایزی فقط در کسب‌وکار پوشاک قابل فروش است.",
  pack_invalid_vat: "درصد مالیات بسته معتبر نیست.",
  item_not_found: "کالا در این شعبه پیدا نشد.",
  item_is_variant_parent: "کالای مادر موجودی ندارد؛ تنوع‌ها (سایز/رنگ) را انتخاب کنید.",
  item_tracking_not_supported: "کالاهای سریالی/بچی در بسته پشتیبانی نمی‌شوند.",
  item_inactive: "یکی از تنوع‌ها غیرفعال است.",
  style_not_found: "مدل پیدا نشد.",
};

interface ShortageDetail {
  packName?: string;
  shortages?: { name: string; need: number | string; onHand: string; missing: string }[];
}

export function sizePackErrorMessage(code: unknown, detail?: unknown): string {
  if (code === "pack_shortage") {
    const d = (detail ?? {}) as ShortageDetail;
    const parts = (d.shortages ?? []).map((s) =>
      `${s.name}: نیاز ${toPersianDigits(String(s.need))}، موجود ${toPersianDigits(s.onHand)}، کمبود ${toPersianDigits(s.missing)}`);
    return `موجودی برای «${d.packName ?? "بسته"}» کافی نیست — ${parts.join("؛ ")}`;
  }
  return (typeof code === "string" && MESSAGES[code]) || "انجام نشد. دوباره تلاش کنید.";
}
