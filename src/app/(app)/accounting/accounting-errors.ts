/**
 * The accounting workspace's error codes, in Persian — what `AccountingManager`'s
 * runner shows when an action's request is refused.
 *
 * Its own module (it used to be a private function at the bottom of the
 * manager) so a section's tests can assert the exact sentence a refusal
 * produces without loading every section of the workspace.
 *
 * `src/app/dashboard/ui.tsx` keeps a second map for the screens that handle
 * their own errors; a code a section can raise belongs in BOTH — except
 * the fixed-asset register's, which come from `src/lib/fixed-assets-errors.ts`,
 * and payroll's, which live in `payroll-error-messages.ts` and are read after
 * this map (so a code already worded for receipts or payments keeps that
 * wording).
 */
import { errorMessageOrRaw } from "@/app/dashboard/ui";
import { EXPENSE_UI_ERROR_MESSAGES } from "@/lib/expense-errors";
import { FIXED_ASSET_ERROR_TRANSLATIONS } from "@/lib/fixed-assets-errors";
import { PAYROLL_ERROR_MESSAGES } from "./payroll-error-messages";

export function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    memo_required: "شرح سند الزامی است.",
    memo_too_long: "شرح سند بیش از حد طولانی است؛ آن را کوتاه‌تر بنویسید.",
    no_lines: "حداقل یک سطر با مبلغ لازم است.",
    too_few_lines: "سند باید حداقل دو ردیف داشته باشد.",
    too_many_lines: "تعداد ردیف‌های سند بیش از حد مجاز است.",
    single_account_entry: "سند باید حداقل به دو حساب متفاوت بخورد.",
    invalid_line: "یکی از سطرها معتبر نیست (حساب، یا فقط بدهکار یا بستانکار).",
    invalid_entry_date: "تاریخ سند معتبر نیست.",
    not_balanced: "مجموع بدهکار و بستانکار برابر نیست.",
    unknown_account: "یکی از حساب‌های انتخاب‌شده معتبر نیست.",
    not_a_leaf_account: "به حساب گروه یا کل نمی‌توان سند زد؛ حساب معین یا تفصیلی را انتخاب کنید.",
    ledger_account_missing: "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    network_error: "ارتباط با سرور برقرار نشد. اتصال اینترنت یا شبکه را بررسی و دوباره تلاش کنید.",
    bad_request: "درخواست نامعتبر بود.",
    // Phase 16 — AR subledger
    customer_required: "انتخاب مشتری الزامی است.",
    customer_not_found: "مشتری انتخاب‌شده معتبر نیست.",
    invalid_amount: "مبلغ معتبر نیست.",
    invalid_method: "روش دریافت/پرداخت معتبر نیست.",
    // A date parameter the caller sent could not be used (not YYYY-MM-DD, or
    // not a real calendar date) — the A/R and A/P routes reject rather than
    // guessing what was meant.
    invalid_date: "تاریخ واردشده معتبر نیست.",
    // Phase 16 — AP subledger
    supplier_required: "انتخاب تأمین‌کننده الزامی است.",
    supplier_not_found: "تأمین‌کننده انتخاب‌شده معتبر نیست.",
    // Phase 30 — cheques
    invalid_direction: "نوع چک معتبر نیست.",
    invalid_action: "این عملیات روی چک تعریف نشده است.",
    invalid_cheque_transition: "این تغییر وضعیت برای چک ممکن نیست؛ ممکن است وضعیت چک را کسی دیگر تغییر داده باشد.",
    cheque_not_found: "چک پیدا نشد.",
    duplicate_cheque: "چکی با همین شماره و بانک (یا همین شناسه صیاد) قبلاً ثبت شده است.",
    invalid_sayad_id: "شناسه صیاد باید ۱۶ رقم باشد.",
    serial_number_required: "شماره چک الزامی است.",
    bank_name_required: "نام بانک الزامی است.",
    counterparty_name_required: "نام صاحب چک الزامی است.",
    due_date_required: "تاریخ سررسید الزامی است.",
    invalid_issue_date: "تاریخ دریافت/صدور معتبر نیست.",
    invalid_due_date: "تاریخ سررسید معتبر نیست.",
    due_date_before_issue: "سررسید نمی‌تواند پیش از تاریخ دریافت/صدور باشد.",
    invalid_occurred_on: "تاریخ وقوع معتبر نیست.",
    action_before_issue: "تاریخ این اقدام نمی‌تواند پیش از تاریخ دریافت/صدور باشد.",
    invalid_counterparty_for_direction: "طرف حساب انتخاب‌شده با نوع چک هم‌خوانی ندارد.",
    // Phase 16 — bank & cash reconciliation
    invalid_account: "حساب انتخاب‌شده معتبر نیست.",
    statement_date_required: "تاریخ صورتحساب الزامی است.",
    invalid_statement_date: "تاریخ صورتحساب معتبر نیست؛ تاریخ را از تقویم انتخاب کنید.",
    statement_date_already_reconciled:
      "برای این حساب، تطبیقی با تاریخ مساوی یا جدیدتر قبلاً قفل شده است؛ تاریخ صورتحساب باید بعد از آخرین تطبیق قفل‌شده باشد.",
    reconciliation_in_progress:
      "یک تطبیق ناتمام برای این حساب وجود دارد؛ ابتدا آن را تکمیل یا حذف کنید.",
    reconciliation_not_found: "تطبیق پیدا نشد.",
    reconciliation_completed: "این تطبیق قبلاً قفل شده و قابل تغییر نیست.",
    negative_statement_balance:
      "مانده صورتحساب صندوق یا کارت‌خوان نمی‌تواند منفی باشد؛ مانده پایانی را وارد کنید، نه گردش دوره.",
    journal_line_not_found: "سند انتخاب‌شده معتبر نیست.",
    journal_line_already_reconciled: "این سند در یک تطبیق قفل‌شدهٔ دیگر ثبت شده و دوباره قابل تطبیق نیست.",
    balance_mismatch: "مانده محاسبه‌شده با مانده صورتحساب برابر نیست.",
    fiscal_period_locked: "دوره مالی این تاریخ قفل است و امکان ثبت سند وجود ندارد.",
    fiscal_period_soft_closed: "دوره مالی این تاریخ بسته‌ی موقت است؛ فقط مالک یا حسابدار می‌تواند سند ثبت کند.",
    // Phase 16 — manual journal workflow
    draft_not_found: "پیش‌نویس پیدا نشد.",
    entry_not_found: "سند پیدا نشد.",
    not_reversible: "فقط اسناد دستی قابل برگشت هستند.",
    cannot_reverse_a_reversal: "سند برگشتی را نمی‌توان دوباره برگشت زد.",
    already_reversed: "این سند قبلاً برگشت خورده است.",
    entry_has_no_lines: "این سند ردیف حسابداری ندارد و قابل برگشت نیست.",
    // Phase 16 — chart of accounts customisation
    well_known_account: "این حساب برای عملکرد سیستم لازم است و قابل غیرفعال یا حذف نیست.",
    account_not_found: "حساب پیدا نشد.",
    /*
     * Phase 16 — expense management, and every code issue #832 added to it
     * (reversal, payment-source, VAT, branch, party). The text lives once, in
     * `expense-errors.ts`, next to the codes the service throws and the map the
     * import adapter reads; spreading it here is what keeps a code from being
     * translated in one channel and left as «خطای غیرمنتظره» in another. The
     * three codes the register shares with the journal (`invalid_amount`,
     * `memo_required`, `unknown_account`) are deliberately not in this spread —
     * their wording above is deliberately about a *document*, not only an
     * expense.
     */
    ...EXPENSE_UI_ERROR_MESSAGES,
    // Chart of accounts (accounts-service.ts) — these reach here whenever a
    // section routes an accounts error through `run` rather than its own map.
    code_required: "کد حساب الزامی است.",
    invalid_code: "کد حساب باید فقط شامل عدد باشد (مثل ۶۱۰۰).",
    name_required: "نام حساب الزامی است.",
    invalid_type: "نوع حساب معتبر نیست.",
    code_in_use: "این کد حساب قبلاً استفاده شده است.",
    parent_not_found: "حساب والد پیدا نشد.",
    parent_cycle: "حساب نمی‌تواند والد خودش یا زیرمجموعه‌اش باشد.",
    parent_too_deep: "حساب والد از سطح «تفصیلی» است و نمی‌تواند زیرمجموعه داشته باشد.",
    hierarchy_too_deep: "این جابه‌جایی باعث می‌شود ساختار حساب از سطح «تفصیلی» عمیق‌تر شود.",
    account_has_postings: "این حساب سند خورده و قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید.",
    account_has_draft_postings: "این حساب در یک پیش‌نویس استفاده شده و قابل حذف نیست.",
    account_has_children: "ابتدا زیرمجموعه‌های این حساب را جابه‌جا یا حذف کنید.",
    // Fiscal years and periods (fiscal-periods-service.ts)
    invalid_year: "سال شمسی نامعتبر است.",
    fiscal_year_exists: "این سال مالی قبلاً تعریف شده است.",
    fiscal_year_not_found: "سال مالی یافت نشد.",
    fiscal_year_closed: "سال مالی این دوره بسته شده و دیگر قابل بازگشایی نیست.",
    fiscal_year_already_closed: "این سال مالی قبلاً بسته شده است.",
    periods_not_ready: "برای بستن سال مالی، ابتدا همه دوره‌های آن را به‌صورت موقت ببندید.",
    periods_incomplete: "فهرست دوره‌های سال مالی کامل نیست و سال قابل بستن نیست.",
    fiscal_period_overlap: "بازهٔ این سال با یک دورهٔ مالی موجود هم‌پوشانی دارد؛ دوره‌ها را بررسی کنید.",
    period_locked_for_closing: "دوره پایانی سال قفل است؛ ابتدا آن را بازگشایی و دوباره بسته‌ی موقت کنید.",
    period_not_found: "دوره یافت نشد.",
    invalid_transition: "این تغییر وضعیت مجاز نیست.",
    // Phase 22 — fixed assets & depreciation (lifecycle per issue #833)
    location_not_found: "شعبه انتخاب‌شده معتبر نیست.",
    reason_required: "ذکر دلیل الزامی است.",
    reason_too_long: "دلیل واردشده بیش از حد طولانی است.",
    // Multicurrency (issue #863) — rates, documents, settlements, revaluation.
    rate_not_configured: "برای این ارز نرخی ثبت نشده است.",
    rate_not_found: "نرخ یافت نشد.",
    rate_voided: "این نرخ باطل شده است.",
    rate_already_recorded: "برای این لحظه پیش‌تر نرخ ثبت شده است.",
    rate_currency_mismatch: "نرخ انتخاب‌شده مربوط به ارز دیگری است.",
    base_currency_locked: "با سابقهٔ اسناد ارزی، ارز پایه قابل تغییر نیست.",
    base_currency_not_a_transaction_currency: "ارز پایه نمی‌تواند ارز معامله باشد.",
    currency_not_found: "ارز یافت نشد.",
    currency_inactive: "این ارز در فهرست جهانی غیرفعال است.",
    currency_not_allowed: "این ارز برای کسب‌وکار شما فعال نشده است.",
    rate_already_voided: "این نرخ پیش‌تر باطل شده است.",
    currency_precision_locked: "دقت این ارز با سابقهٔ ثبت قفل شده است.",
    insufficient_open_balance: "مبلغ بیش از ماندهٔ باز این طرف حساب است.",
    duplicate_entry_reference: "هر سند فقط یک‌بار در اقلام تسویه می‌آید.",
    entry_has_active_settlements: "ابتدا تسویه‌های فعال این سند را برگشت بزنید.",
    account_currency_mismatch: "این حساب با ارز سند هم‌خوانی ندارد.",
    fx_residual_unexplained: "اختلاف سمت پایه با سیاست گرد کردن توضیح داده نمی‌شود؛ سطر سود/زیان تسعیر را بازبینی کنید.",
    foreign_unbalanced: "مجموع بدهکار و بستانکار ارزی باید برابر باشد.",
    idempotency_payload_mismatch: "این کلید همگام‌سازی پیش‌تر برای درخواست دیگری استفاده شده است.",
    nothing_to_settle: "چیزی برای تسویه وجود ندارد.",
    invalid_party: "طرف حساب معتبر نیست.",
    no_foreign_lines: "حداقل یک سطر ارزی لازم است.",
    neither_foreign_nor_base: "هر سطر باید ارزی یا پایه باشد.",
  };
  // The fixed-asset register's domain errors come from the one canonical
  // dictionary (fixed-assets-errors.ts); everything else is this screen's own
  // journal/account vocabulary, then payroll's, then the shared dashboard
  // fallback (the raw code, never a vague «خطای غیرمنتظره»).
  if (code && FIXED_ASSET_ERROR_TRANSLATIONS[code]) return FIXED_ASSET_ERROR_TRANSLATIONS[code];
  return map[code ?? ""] ?? PAYROLL_ERROR_MESSAGES[code ?? ""] ?? errorMessageOrRaw(code);
}
