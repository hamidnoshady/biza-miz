/**
 * The intangible-asset register's domain errors, in Persian, ONCE (issue
 * #1326, Linear ESH-163). The register section, the estimate dialog and the
 * accounting manager all read this dictionary, the same way the fixed-asset
 * screen reads `fixed-assets-errors.ts`. Generic codes (`bad_request`, fiscal
 * locks, `ledger_account_missing`, …) stay in the dashboard's shared map,
 * which every screen already falls back to.
 */
export const INTANGIBLE_ASSET_ERROR_TRANSLATIONS: Record<string, string> = {
  intangible_asset_not_found: "دارایی نامشهود پیدا نشد.",
  intangible_asset_disposed: "این دارایی نامشهود واگذار شده و دیگر عملیاتی روی آن انجام نمی‌شود.",
  intangible_asset_code_in_use: "دارایی نامشهود دیگری با همین کد ثبت شده است.",

  // registration and capitalization policy
  asset_account_required: "حساب دارایی نامشهود را انتخاب کنید.",
  accumulated_amortization_account_required: "برای دارایی با عمر محدود، حساب استهلاک انباشته را انتخاب کنید.",
  amortization_expense_account_required: "برای دارایی با عمر محدود، حساب هزینهٔ استهلاک را انتخاب کنید.",
  amortization_accounts_required: "حساب استهلاک انباشته و حساب هزینهٔ استهلاک را انتخاب کنید.",
  impairment_accounts_required: "برای ثبت کاهش ارزش، حساب زیان کاهش ارزش و حساب کاهش ارزش انباشته را انتخاب کنید.",
  invalid_date: "تاریخ وارد‌شده معتبر نیست.",
  invalid_acquisition_date: "تاریخ تحصیل معتبر نیست.",
  location_not_found: "شعبهٔ انتخاب‌شده معتبر نیست.",
  idempotency_key_too_long: "کلید تکرارپذیری بیش از حد طولانی است.",

  // amortization
  invalid_period: "ماه درخواستی معتبر نیست.",
  period_already_amortized: "استهلاک این ماه قبلاً برای این دارایی ثبت شده است.",
  indefinite_life_not_amortized:
    "دارایی با عمر نامحدود استهلاک نمی‌شود؛ آن را برای کاهش ارزش بررسی کنید.",
  period_label_too_long: "یادداشت دوره بیش از حد طولانی است.",
  amortization_entry_not_found: "سند استهلاک انتخاب‌شده پیدا نشد.",
  amortization_already_reversed: "این سند استهلاک قبلاً برگشت خورده است.",
  invalid_reversal_date: "تاریخ برگشت معتبر نیست.",
  effective_date_in_future: "تاریخ برگشت نمی‌تواند در آینده باشد.",

  // impairment
  invalid_assessment_date: "تاریخ ارزیابی کاهش ارزش معتبر نیست.",
  invalid_recoverable_amount: "مبلغ بازیافتنی باید عدد صحیح نامنفی (ریال) باشد.",
  impairment_before_available_for_use:
    "تاریخ کاهش ارزش نمی‌تواند پیش از تاریخ آمادهٔ بهره‌برداری باشد.",
  impairment_not_found: "ارزیابی کاهش ارزش انتخاب‌شده پیدا نشد.",
  impairment_already_reversed: "این ارزیابی کاهش ارزش قبلاً برگشت خورده است.",
  no_impairment_required: "مبلغ بازیافتنی از ارزش دفتری بیشتر است؛ کاهش ارزشی لازم نیست.",
  no_reversible_impairment: "کاهش ارزش قابل برگشتی برای این دارایی وجود ندارد.",
  reversal_before_impairment: "تاریخ برگشت نمی‌تواند پیش از تاریخ ارزیابی کاهش ارزش باشد.",

  // disposal
  invalid_disposal_kind: "نوع واگذاری معتبر نیست.",
  invalid_disposal_date: "تاریخ واگذاری معتبر نیست.",
  disposal_date_in_future: "تاریخ واگذاری نمی‌تواند در آینده باشد.",
  disposal_before_available_for_use:
    "تاریخ واگذاری نمی‌تواند پیش از تاریخ آمادهٔ بهره‌برداری باشد.",
  disposal_before_amortization:
    "تاریخ واگذاری نمی‌تواند پیش از آخرین استهلاک ثبت‌شده باشد؛ ابتدا استهلاک‌های بعد از تاریخ واگذاری را برگشت بزنید.",
  disposal_proceeds_required: "برای فروش، مبلغ واگذاری (بزرگ‌تر از صفر) الزامی است.",
  disposal_proceeds_not_allowed: "برای کنارگذاری یا حذف، مبلغ واگذاری نباید وارد شود.",
  proceeds_account_required: "حساب وصول مبلغ فروش را انتخاب کنید.",

  // prospective estimate changes (Phase 2)
  reason_required: "ذکر دلیل تغییر برآورد الزامی است.",
  reason_too_long: "دلیل تغییر برآورد بیش از حد طولانی است.",
  invalid_effective_date: "تاریخ اجرای تغییر برآورد معتبر نیست.",
  estimate_effective_in_past:
    "تغییر برآورد فقط از دورهٔ جاری یا دوره‌های بعد اعمال می‌شود؛ تاریخ اجرا نمی‌تواند در گذشته باشد.",
  estimate_before_available_for_use:
    "تاریخ اجرای تغییر برآورد نمی‌تواند پیش از تاریخ آمادهٔ بهره‌برداری باشد.",
  fiscal_period_locked: "دورهٔ مالی این تاریخ قفل شده است و ثبت تغییر در آن مجاز نیست.",
  invalid_useful_life_type: "نوع عمر مفید (محدود یا نامحدود) معتبر نیست.",
  invalid_useful_life: "عمر مفید باید عدد صحیح بین ۱ تا ۶۰۰ ماه باشد.",
  invalid_residual_value: "ارزش باقی‌مانده باید عدد صحیح نامنفی (ریال) باشد.",
  residual_not_less_than_cost: "ارزش باقی‌مانده باید کمتر از بهای تمام‌شده باشد.",
  residual_above_carrying_amount:
    "ارزش باقی‌ماندهٔ جدید نمی‌تواند از ارزش دفتری جاری دارایی بیشتر باشد.",
  estimate_unchanged: "مقدار جدید با مقدار فعلی یکسان است.",
  estimate_change_excludes_history:
    "عمر مفید جدید نمی‌تواند کوتاه‌تر از ماه‌هایی باشد که قبلاً استهلاک آن‌ها ثبت شده است.",
  estimate_change_conflict:
    "تغییر برآورد دیگری هم‌زمان برای این دارایی ثبت شده است؛ فهرست را تازه کنید و دوباره تلاش کنید.",
  estimate_change_failed: "ثبت تغییر برآورد ناموفق بود؛ دوباره تلاش کنید.",

  // reports and export
  export_too_large:
    "حجم داده‌های فیلترشده از سقف مجاز هر برگهٔ اکسل (حدود یک میلیون ردیف) بیشتر است؛ فیلترها را محدودتر کنید.",
  invalid_report: "گزارش درخواستی معتبر نیست.",
  invalid_format: "قالب خروجی معتبر نیست.",

  // shared ledger dependency
  ledger_account_missing: "حساب دفتر کل لازم برای این عملیات در سرفصل حساب‌ها وجود ندارد.",
};
