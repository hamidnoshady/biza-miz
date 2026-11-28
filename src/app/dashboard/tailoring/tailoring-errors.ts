/**
 * GH #1567 Phase 6A — Persian copy for every code the tailoring routes return.
 * Kept beside the screens (rather than in the dashboard-wide map) because no
 * other surface returns these codes.
 */
const MESSAGES: Record<string, string> = {
  forbidden: "برای این کار دسترسی لازم را ندارید.",
  industry_mismatch: "خیاطی و دوخت فقط برای کسب‌وکارهای پوشاک، کیف، کفش و مد فعال است.",
  location_required: "ابتدا شعبه را انتخاب کنید.",
  bad_request: "اطلاعات واردشده کامل یا معتبر نیست.",
  tailoring_encryption_unavailable:
    "کلید رمزنگاری این کسب‌وکار در دسترس نیست؛ تا رفع آن، اندازه‌ها نه ثبت می‌شوند و نه نمایش داده می‌شوند.",
  tailoring_purpose_required: "دلیل مشاهده را بنویسید (دست‌کم ۳ نویسه).",
  tailoring_reason_required: "دلیل پاک‌سازی را بنویسید (دست‌کم ۳ نویسه).",
  tailoring_measurements_invalid: "یکی از اندازه‌ها معتبر نیست؛ فقط عدد مثبت با حداکثر یک رقم اعشار پذیرفته می‌شود.",
  tailoring_retention_invalid: "مدت نگهداری باید بین ۳۰ تا ۳۶۵۰ روز باشد.",
  tailoring_party_not_found: "مشتری پیدا نشد.",
  tailoring_profile_not_found: "نسخهٔ اندازهٔ انتخاب‌شده برای این مشتری پیدا نشد.",
  tailoring_location_not_found: "شعبه پیدا نشد.",
  tailoring_description_required: "شرح کار را بنویسید.",
  tailoring_kind_invalid: "نوع کار را انتخاب کنید.",
  tailoring_job_not_found: "سفارش خیاطی پیدا نشد.",
  tailoring_job_changed: "این سفارش هم‌زمان تغییر کرده است؛ صفحه تازه شد، دوباره تلاش کنید.",
  tailoring_transition_invalid: "این مرحله از وضعیت فعلی سفارش مجاز نیست.",
  tailoring_estimate_required: "مبلغ برآورد را وارد کنید.",
  tailoring_customer_approval_required: "تأیید مشتری را علامت بزنید.",
  tailoring_fitting_required: "دوخت سفارشی بدون پرو به کنترل کیفیت نمی‌رود.",
  tailoring_qc_outcome_required: "نتیجهٔ کنترل کیفیت را مشخص کنید.",
  tailoring_order_required: "پیش از تحویل، فروش (سفارش/فاکتور) این کار را پیوند دهید.",
  tailoring_order_not_found: "سفارش فروش پیدا نشد.",
  tailoring_order_mismatch: "این فروش به شعبه یا مشتری دیگری تعلق دارد، باطل شده یا به کار دیگری پیوند خورده است.",
};

export function tailoringErrorMessage(code: string | undefined): string {
  return MESSAGES[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}
