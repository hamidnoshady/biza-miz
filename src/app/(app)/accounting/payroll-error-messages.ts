/**
 * Every refusal the payroll API can answer, in Persian — one map, so a code the
 * payroll screen can meet is never «خطای غیرمنتظره».
 *
 * Two readers, with opposite precedence on purpose:
 *
 *   - the payroll section (`payrollError`) looks here **first**, then falls back
 *     to the shared map: several codes are shared across the dashboard with a
 *     different meaning (`invalid_period` is a domain's term elsewhere,
 *     `invalid_amount` and `invalid_method` are receipts' and payments'), and
 *     on this screen they mean payroll's;
 *   - the accounting workspace's runner (`accounting-errors.ts`) looks here
 *     **last**, so the codes it already words for receipts, payments and
 *     expenses keep their text, and only the payroll-only ones are added.
 */
export const PAYROLL_ERROR_MESSAGES: Record<string, string> = {
  // The month
  invalid_period: "ماه حقوق معتبر نیست.",
  period_in_future: "این ماه هنوز شروع نشده است و حقوق آن قابل ثبت نیست.",
  period_already_accrued: "برای این ماه قبلاً تعهد حقوق ثبت شده است؛ برای ثبت دوباره ابتدا آن را ابطال کنید.",
  invalid_accrual_date: "تاریخ تعهد معتبر نیست.",
  invalid_paid_date: "تاریخ پرداخت معتبر نیست.",
  paid_date_before_accrual: "تاریخ پرداخت نمی‌تواند پیش از تاریخ تعهد باشد.",

  // Retrying an accrual safely
  idempotency_key_invalid: "شناسهٔ تکرار درخواست معتبر نیست.",
  idempotency_key_conflict: "این شناسهٔ درخواست قبلاً برای ماه دیگری به‌کار رفته است؛ صفحه را تازه کنید و دوباره تلاش کنید.",

  // Amounts
  invalid_amount: "مبلغ وارد‌شده معتبر نیست.",
  amount_out_of_range: "مبلغ بیش از حد مجاز است.",
  amount_too_large: "مبلغ حقوق بیش از حد بزرگ است.",
  invalid_overtime: "مبلغ اضافه‌کار معتبر نیست.",
  deductions_exceed_gross: "کسور یکی از کارکنان از حقوق ناخالص او بیشتر است؛ کسور ثابت یا نرخ‌ها را بررسی کنید.",
  invalid_wage_reason: "توضیح تغییر حقوق باید متنی حداکثر ۵۰۰ نویسه باشد.",
  no_wages_set: "هیچ عضو فعالی حقوق تعیین‌شده ندارد.",
  user_not_found: "عضو موردنظر پیدا نشد.",

  // Commission settled with the run
  commission_already_settled: "پورسانتی که می‌خواستید تسویه کنید همزمان در لیست دیگری تسویه شد؛ دوباره تلاش کنید.",

  // Paying, voiding
  run_not_found: "تعهد حقوق پیدا نشد.",
  already_paid: "این تعهد قبلاً پرداخت شده است.",
  invalid_rules: "مجموعه قوانین حقوق معتبر نیست.",
  invalid_month_days: "تعداد روزهای ماه باید بین ۲۸ تا ۳۱ باشد.",
  invalid_monthly_hours: "ساعت کار ماهانه معتبر نیست.",
  invalid_overtime_hours: "ساعت اضافه‌کار معتبر نیست.",
  invalid_unpaid_leave_days: "روزهای مرخصی بدون حقوق معتبر نیست.",
  no_base_salary: "برای این کارمند حقوق پایه تعریف نشده است؛ اضافه‌کار و مرخصی بدون حقوق محاسبه نمی‌شود.",
  unknown_component: "این جزء حقوق در فهرست اجزای حقوق وجود ندارد.",
  component_not_enterable: "این جزء حقوق به‌صورت خودکار محاسبه می‌شود و قابل ورود دستی نیست.",
  component_missing: "یکی از اجزای قانونی حقوق غیرفعال یا حذف شده است.",
  negative_gross: "جمع حقوق ناخالص نمی‌تواند منفی باشد.",
  invalid_worked_days: "روزهای کارکرد این ماه معتبر نیست.",
  invalid_run_id: "شناسهٔ اجرای حقوق معتبر نیست.",
  invalid_user_id: "شناسهٔ کارمند معتبر نیست.",
  invalid_inputs: "اطلاعات ورودی دوره حقوق معتبر نیست.",
  invalid_run_type: "نوع دوره حقوق معتبر نیست.",
  period_held_by_journal_payroll: "برای این ماه قبلاً تعهد حقوق ساده ثبت شده است؛ ابتدا آن را ابطال کنید.",
  period_already_has_run: "برای این ماه قبلاً دوره حقوق اصلی ایجاد شده است؛ برای اصلاح از دوره اصلاحی استفاده کنید.",
  supplemental_requires_approved_run: "دوره اصلاحی فقط پس از تأیید دوره اصلی همان ماه ممکن است.",
  open_run_exists: "یک دوره تأییدنشده برای این ماه باز است؛ ابتدا آن را تأیید یا لغو کنید.",
  run_cancelled: "این دوره حقوق لغو شده است.",
  run_immutable: "دوره تأییدشده قابل تغییر نیست؛ برای اصلاح، دوره اصلاحی ایجاد کنید.",
  invalid_run_transition: "این مرحله برای وضعیت فعلی دوره حقوق مجاز نیست.",
  no_rule_set: "برای تاریخ این دوره، نسخه‌ای از قوانین بیمه و مالیات حقوق تعریف نشده است.",
  employee_not_in_payroll: "این کارمند پروفایل حقوقی فعالی در این ماه ندارد.",
  no_employees: "هیچ کارمندی برای محاسبه در این دوره وجود ندارد.",
  already_posted: "سند این دوره حقوق قبلاً ثبت شده است.",
  staff_not_found: "کارمند پیدا نشد.",
  invalid_title: "عنوان معتبر نیست.",
  invalid_effective_date: "تاریخ اعتبار معتبر نیست.",
  component_not_found: "جزء حقوق پیدا نشد.",
  invalid_component_code: "کد جزء حقوق باید با حروف بزرگ لاتین، رقم یا زیرخط باشد.",
  invalid_component_name: "نام جزء حقوق معتبر نیست.",
  invalid_component_kind: "نوع جزء حقوق معتبر نیست.",
  invalid_component_flags: "تنظیمات مشمول مالیات یا بیمه معتبر نیست.",
  invalid_account_code: "کد حساب معتبر نیست.",
  system_component_locked: "اجزای قانونی حقوق قابل غیرفعال‌سازی یا تغییر نوع نیستند.",
  component_code_taken: "این کد قبلاً برای جزء دیگری استفاده شده است.",
  invalid_profile: "اطلاعات پروفایل حقوقی معتبر نیست.",
  invalid_cost_allocation: "تسهیم هزینه معتبر نیست؛ شعبه یا پروژهٔ انتخاب‌شده متعلق به این کسب‌وکار نیست یا غیرفعال است.",
  invalid_iban: "شماره شبا باید با IR و ۲۴ رقم باشد.",
  payroll_code_taken: "این کد پرسنلی قبلاً استفاده شده است.",
  payslip_not_found: "فیش حقوقی پیدا نشد.",
  unknown_report: "این گزارش وجود ندارد.",
  unknown_action: "این عملیات وجود ندارد.",
  period_held_by_engine: "حقوق این ماه در موتور حقوق و دستمزد قانونی محاسبه شده است و از این بخش دوباره ثبت نمی‌شود.",
  already_voided: "این مورد قبلاً ابطال شده است.",
  run_voided: "این تعهد ابطال شده و قابل پرداخت نیست.",
  invalid_method: "حساب پرداخت معتبر نیست.",
  invalid_payment_account: "حساب پرداخت انتخاب‌شده معتبر نیست؛ یکی از حساب‌های صندوق، بانک یا تنخواه را انتخاب کنید.",

  // Salary advances
  advance_not_found: "مساعده پیدا نشد.",
  advance_already_recovered: "بخشی از این مساعده در حقوق کسر شده است؛ ابتدا تعهد حقوق آن ماه را ابطال کنید.",
  invalid_advance_date: "تاریخ مساعده معتبر نیست.",
  note_too_long: "توضیح مساعده بیش از حد طولانی است.",

  // The business's own rates
  invalid_percent: "درصد باید بین ۰ تا ۱۰۰ و حداکثر با دو رقم اعشار باشد.",
  invalid_settings: "تنظیمات حقوق معتبر نیست.",
  invalid_brackets: "پله‌های مالیات معتبر نیست.",
  brackets_not_ascending: "سقف پله‌های مالیات باید صعودی و بیشتر از سقف معافیت باشد.",
  last_bracket_must_be_open: "فقط پلهٔ آخر مالیات باید بدون سقف باشد.",
  too_many_brackets: "تعداد پله‌های مالیات بیش از حد مجاز است.",

  // The history
  invalid_run_status: "وضعیت انتخاب‌شده معتبر نیست.",
  invalid_limit: "تعداد نتایج معتبر نیست.",
  invalid_cursor: "نشانی صفحهٔ درخواستی معتبر نیست؛ فهرست را از نو بارگذاری کنید.",
};
