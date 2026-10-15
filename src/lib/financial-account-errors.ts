/**
 * The Financial Accounts domain's error codes, in Persian, ONCE (issue #862).
 *
 * The register section, the transfer form and the accounting manager's shared
 * error mapper all read this dictionary instead of carrying their own copies —
 * the mistake `fixed-assets-errors.ts` exists to prevent, where a new refusal
 * code lands translated in one screen and raw in another and a business owner
 * is shown «خطای غیرمنتظره» next to a field they can fix.
 *
 * Codes that are not specific to this domain (`bad_request`, the fiscal-lock
 * codes, `ledger_account_missing`) stay in the dashboard's shared map, which
 * every screen already falls back to; this module only owns what it alone can
 * explain. The API answers with the code and an HTTP status; the browser
 * translates it here.
 */

export const FINANCIAL_ACCOUNT_ERROR_MESSAGES: Record<string, string> = {
  // --- financial accounts -------------------------------------------------
  financial_account_not_found: "حساب مالی پیدا نشد.",
  financial_account_not_active:
    "این حساب مالی بایگانی شده است و برای ثبت تراکنش تازه قابل انتخاب نیست؛ ابتدا آن را فعال کنید.",
  financial_account_delete_forbidden:
    "حساب مالی حذف نمی‌شود؛ سابقهٔ حسابداری آن باید حفظ شود. برای کنار گذاشتن حساب، آن را بایگانی کنید.",
  financial_account_has_balance:
    "این حساب مانده دارد و بایگانی نمی‌شود؛ ابتدا مانده را با یک انتقال وجه (یا سند اصلاحی) به صفر برسانید.",
  financial_account_identity_locked:
    "پس از ثبت تراکنش روی این حساب، سرفصل دفتر کل، نوع و ارز آن قابل تغییر نیست؛ در صورت نیاز حساب تازه‌ای بسازید.",
  financial_account_already_linked:
    "این سرفصل دفتر کل پیش‌تر به یک حساب مالی دیگر متصل شده است. هر حساب مالی باید سرفصل اختصاصی خود را داشته باشد تا مانده‌ها با دفتر کل دقیق تطبیق کند.",
  financial_account_code_in_use: "این کد حساب قبلاً استفاده شده است.",
  financial_account_has_transfers:
    "برای این حساب انتقال وجه ثبت شده است و می‌توان آن را فقط بایگانی کرد (نه حذف).",
  kind_required: "نوع حساب مالی را انتخاب کنید.",
  invalid_kind: "نوع حساب مالی معتبر نیست.",
  name_required: "نام حساب را وارد کنید.",
  name_too_long: "نام حساب بیش از حد طولانی است.",
  code_too_long: "کد حساب بیش از ۳۲ نویسه است.",
  description_too_long: "توضیح حساب بیش از حد طولانی است.",
  notes_too_long: "یادداشت حساب بیش از حد طولانی است.",
  gl_account_required: "سرفصل دفتر کل این حساب را انتخاب کنید.",
  invalid_gl_account: "سرفصل دفتر کل انتخاب‌شده معتبر نیست.",
  gl_account_unavailable: "سرفصل دفتر کل انتخاب‌شده در دسترس نیست.",
  gl_account_not_postable:
    "سرفصل انتخاب‌شده برای ثبت سند مناسب نیست؛ باید یک حساب داراییِ فعال و بدون زیرحساب باشد.",
  gl_account_wrong_role:
    "سرفصل انتخاب‌شده با نوع حساب هم‌خوان نیست. حساب بانکی باید سرفصل بانک، صندوق باید سرفصل صندوق، تنخواه باید سرفصل تنخواه و پایانهٔ کارت‌خوان باید سرفصل «وجوه در راه» یا بانک باشد.",
  gl_account_unclassified:
    "سرفصل انتخاب‌شده به هیچ‌یک از حساب‌های بانک، صندوق، تنخواه یا وجوه در راه شناخته‌شده متصل نیست؛ آن را زیر یکی از این حساب‌ها تعریف کنید.",
  gl_account_is_parent:
    "سرفصل انتخاب‌شده زیرحساب دارد؛ ابتدا یک زیرحساب تفصیلی برای این حساب مالی بسازید.",
  invalid_currency: "ارز انتخاب‌شده معتبر نیست.",
  currency_not_available: "این ارز برای این کسب‌وکار فعال نشده است؛ ابتدا آن را در بخش ارز و تسعیر فعال کنید.",
  invalid_location: "شعبهٔ انتخاب‌شده معتبر نیست.",
  no_branch_access: "به شعبهٔ انتخاب‌شده دسترسی ندارید.",
  invalid_default_flag: "مقدار پیش‌فرض بودن حساب معتبر نیست.",
  bankName_required: "نام بانک را وارد کنید.",
  bankName_too_long: "نام بانک بیش از حد طولانی است.",
  bankName_not_allowed_for_kind: "برای این نوع حساب، نام بانک معنا ندارد.",
  bankBranchName_too_long: "نام شعبهٔ بانک بیش از حد طولانی است.",
  bankBranchName_not_allowed_for_kind: "برای این نوع حساب، نام شعبهٔ بانک معنا ندارد.",
  accountNumber_too_long: "شمارهٔ حساب بیش از حد طولانی است.",
  accountNumber_not_allowed_for_kind: "برای این نوع حساب، شمارهٔ حساب بانکی معنا ندارد.",
  cardNumber_too_long: "شمارهٔ کارت بیش از حد طولانی است.",
  cardNumber_invalid: "شمارهٔ کارت باید ۱۶ رقم باشد.",
  cardNumber_not_allowed_for_kind: "برای این نوع حساب، شمارهٔ کارت معنا ندارد.",
  iban_too_long: "شبا بیش از حد طولانی است.",
  iban_invalid: "شبا باید با IR شروع شود و ۲۴ رقم داشته باشد.",
  iban_not_allowed_for_kind: "برای این نوع حساب، شبا معنا ندارد.",
  accountHolder_too_long: "نام صاحب حساب بیش از حد طولانی است.",
  accountHolder_not_allowed_for_kind: "برای این نوع حساب، نام صاحب حساب معنا ندارد.",
  settlementReference_too_long: "شناسهٔ تسویه بیش از حد طولانی است.",
  settlementReference_not_allowed_for_kind: "برای این نوع حساب، شناسهٔ تسویه معنا ندارد.",
  pspProvider_required: "نام شرکت PSP یا سوئیچ را وارد کنید.",
  pspProvider_too_long: "نام شرکت PSP بیش از حد طولانی است.",
  pspProvider_not_allowed_for_kind: "برای این نوع حساب، نام PSP معنا ندارد.",
  terminalNumber_required: "شمارهٔ پایانه را وارد کنید.",
  terminalNumber_too_long: "شمارهٔ پایانه بیش از حد طولانی است.",
  terminalNumber_not_allowed_for_kind: "برای این نوع حساب، شمارهٔ پایانه معنا ندارد.",
  merchantNumber_too_long: "شمارهٔ پذیرنده بیش از حد طولانی است.",
  merchantNumber_not_allowed_for_kind: "برای این نوع حساب، شمارهٔ پذیرنده معنا ندارد.",
  invalid_settlement_account: "حساب تسویهٔ انتخاب‌شده معتبر نیست.",
  settlement_account_not_found: "حساب تسویهٔ انتخاب‌شده پیدا نشد.",
  settlement_account_wrong_kind: "حساب تسویه باید یک حساب بانکی باشد.",
  settlement_account_not_active: "حساب تسویهٔ انتخاب‌شده بایگانی شده است.",
  settlement_account_same_tenant:
    "حساب تسویهٔ انتخاب‌شده به این کسب‌وکار تعلق ندارد.",
  settlement_account_is_self: "یک پایانه نمی‌تواند حساب تسویهٔ خودش باشد.",
  invalid_settlement_delay: "مهلت تسویه باید عددی بین ۰ تا ۹۰ روز باشد.",

  // --- internal transfers -------------------------------------------------
  transfer_not_found: "انتقال وجه پیدا نشد.",
  transfer_date_required: "تاریخ انتقال را وارد کنید.",
  invalid_transfer_date: "تاریخ انتقال معتبر نیست.",
  transfer_date_in_future: "تاریخ انتقال نمی‌تواند در آینده باشد.",
  source_account_required: "حساب مبدأ را انتخاب کنید.",
  destination_account_required: "حساب مقصد را انتخاب کنید.",
  source_account_not_found: "حساب مبدأ پیدا نشد.",
  destination_account_not_found: "حساب مقصد پیدا نشد.",
  same_account: "حساب مبدأ و مقصد باید متفاوت باشند.",
  same_gl_account:
    "حساب مبدأ و مقصد به یک سرفصل دفتر کل می‌رسند؛ انتقال بین آن‌ها هیچ اثری در دفتر ندارد.",
  source_account_archived: "حساب مبدأ بایگانی شده است.",
  destination_account_archived: "حساب مقصد بایگانی شده است.",
  no_source_branch_access: "به حساب مبدأ در این شعبه دسترسی ندارید.",
  no_destination_branch_access: "به حساب مقصد در این شعبه دسترسی ندارید.",
  currency_mismatch:
    "انتقال بین دو حساب با ارز متفاوت انجام نمی‌شود، چون هیچ نرخ تبدیلی ازپیش‌تعیین‌شده‌ای وجود ندارد. برای جابه‌جایی ارزی از عملیات تسویهٔ ارزی استفاده کنید.",
  invalid_amount: "مبلغ انتقال باید عدد صحیح ریال و بزرگ‌تر از صفر باشد.",
  invalid_fee: "کارمزد باید عدد صحیح ریال و نامنفی باشد.",
  fee_account_required: "برای انتقال با کارمزد، سرفصل هزینهٔ کارمزد را انتخاب کنید.",
  fee_account_not_found: "سرفصل هزینهٔ کارمزد پیدا نشد.",
  fee_account_invalid: "سرفصل هزینهٔ کارمزد باید یک حساب هزینهٔ فعال باشد.",
  fee_account_without_fee: "بدون کارمزد، انتخاب سرفصل هزینهٔ کارمزد معنا ندارد.",
  invalid_fee_payer: "نحوهٔ پرداخت کارمزد معتبر نیست.",
  fee_payer_not_allowed:
    "با این دسترسی نمی‌توانید تعیین کنید کارمزد از کدام طرف کسر شود؛ حالت پیش‌فرض (کسر از مبدأ) استفاده می‌شود.",
  fee_exceeds_amount: "کارمزد نمی‌تواند برابر یا بیشتر از خودِ مبلغ انتقال باشد.",
  invalid_project: "پروژهٔ انتخاب‌شده معتبر نیست.",
  project_not_found: "پروژهٔ انتخاب‌شده در این کسب‌وکار پیدا نشد.",
  attachment_not_found: "پیوست انتخاب‌شده در کتابخانهٔ رسانه پیدا نشد.",
  invalid_attachment: "پیوست انتخاب‌شده معتبر نیست.",
  description_too_long_transfer: "شرح انتقال بیش از حد طولانی است.",
  referenceNumber_too_long: "شمارهٔ پیگیری بیش از حد طولانی است.",
  invalid_idempotency_key: "کلید تکرار درخواست معتبر نیست.",
  idempotency_conflict:
    "این کلید تکرار برای درخواست دیگری استفاده شده است؛ همان درخواست را با همان مقادیر تکرار کنید یا کلید تازه بگیرید.",
  transfer_already_reversed: "این انتقال قبلاً برگشت خورده است.",
  transfer_not_reversible: "این سند، خودش برگشتِ یک انتقال است و دوباره برگشت نمی‌خورد.",
  invalid_reversal_reason: "دلیل برگشت معتبر نیست.",
  reversal_reason_required: "دلیل برگشت الزامی است.",
  transfer_reversal_conflict:
    "هم‌زمان درخواست برگشت دیگری برای همین انتقال ثبت شده است؛ فهرست را تازه کنید.",
  invalid_transfer_status: "وضعیت انتقال معتبر نیست.",
  invalid_transfer_sort: "ترتیب نمایش انتقال‌ها معتبر نیست.",
  invalid_limit: "تعداد ردیف درخواستی معتبر نیست.",
  invalid_cursor: "صفحهٔ درخواستی معتبر نیست؛ فهرست را از ابتدا باز کنید.",

  // --- codes the service raises directly (constraints, guards, races) -----
  // Each of these is a real refusal the API returns, so each has to have words
  // here rather than surfacing as the generic «خطای غیرمنتظره».
  card_number_invalid: "شمارهٔ کارت معتبر نیست؛ ۱۶ رقم کارت را بدون خط تیره وارد کنید.",
  default_scope_change_requires_flag:
    "برای بردن پیش‌فرض از یک شعبه به شعبهٔ دیگر تأیید دوباره لازم است؛ ابتدا پیش‌فرض فعلی را بردارید یا با تأیید همان شعبه را پیش‌فرض کنید.",
  financial_account_archive_via_endpoint:
    "بایگانی حساب از مسیر ویرایش انجام نمی‌شود؛ از دکمهٔ «بایگانی» همین حساب استفاده کنید.",
  financial_account_is_settlement_target:
    "این حساب، حساب تسویهٔ یک پایانهٔ کارت‌خوان است؛ ابتدا در تنظیمات پایانه، حساب تسویه را تغییر دهید.",
  transfer_number_conflict:
    "شمارهٔ سند انتقال با ثبت هم‌زمان دیگری تکراری شد؛ درخواست را دوباره بفرستید.",
  cross_tenant_reference:
    "یکی از مراجع انتخاب‌شده به کسب‌وکار دیگری تعلق دارد و در این سند پذیرفته نمی‌شود.",
  currency_rate_missing:
    "برای ارز این حساب، نرخ تبدیل مؤثر در تاریخ سند ثبت نشده است؛ ابتدا نرخ را در «ارز و تسعیر» ثبت کنید.",

  // --- reports ------------------------------------------------------------
  invalid_date_range: "بازهٔ تاریخ معتبر نیست؛ تاریخ شروع باید پیش از پایان باشد.",
  report_too_large: "حجم گزارش برای خروجی بیش از حد مجاز است؛ بازه را کوچک‌تر کنید.",
};

/** The Persian text for a code, or `null` when this domain does not own it. */
export function financialAccountErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return FINANCIAL_ACCOUNT_ERROR_MESSAGES[code] ?? null;
}
