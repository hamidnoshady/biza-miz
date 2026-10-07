/**
 * Every error code the expense channel can produce, with the text a human sees
 * and the HTTP status it carries — one definition for all four entry points
 * (issue #832 §17).
 *
 * `recordExpense()` throws `ExpenseError(code)`, and four callers then had to
 * agree on what that code means: the Expenses screen's `errorMessage()` map,
 * the data-transfer import adapter, the AI/autopilot executor and the route's
 * own status mapping. They did not: the import adapter still translated
 * `wrong_account_type` and `period_closed`, codes the expense service stopped
 * emitting, so a real failure such as `invalid_payment_account` fell through to
 * «ثبت هزینه ممکن نشد (invalid_payment_account).» — technical text in a
 * business screen. This module is the single source both read.
 *
 * Two curated exports rather than one, because one code is not always an
 * *expense* code: `invalid_amount`, `memo_required` and `unknown_account` are
 * shared with the journal, the cheques register and the reconciliation screen,
 * whose wording is deliberately generic («شرح سند الزامی است.»). The Expenses
 * map therefore spreads `EXPENSE_UI_ERROR_MESSAGES` — the expense-specific keys
 * only — and leaves those three to the shared text it already had.
 */

/** Codes `recordExpense()` / `reverseExpense()` can throw, with their Persian text. */
export const EXPENSE_ERROR_MESSAGES = {
  invalid_amount: "مبلغ هزینه معتبر نیست.",
  memo_required: "شرح هزینه الزامی است.",
  unknown_account: "یکی از حساب‌های انتخاب‌شده معتبر نیست.",
  invalid_expense_account: "دسته هزینه انتخاب‌شده یک حساب هزینه معتبر نیست.",
  invalid_payment_account:
    "حساب پرداخت باید صندوق، بانک، تنخواه یا حساب تسویهٔ کارت‌خوان باشد؛ از حسابی مثل موجودی کالا، حساب‌های دریافتنی یا مالیات قابل استرداد نمی‌توان هزینه پرداخت.",
  same_account: "دسته هزینه و حساب پرداخت نمی‌توانند یکسان باشند.",
  invalid_expense_date: "تاریخ هزینه معتبر نیست.",
  expense_date_in_future: "تاریخ هزینه نمی‌تواند در آینده باشد.",
  vat_amount_invalid: "مالیات بر ارزش افزودهٔ هزینه معتبر نیست؛ باید عدد صحیح و کمتر از مبلغ کل باشد.",
  vat_account_missing:
    "حساب مالیات بر ارزش افزودهٔ خرید (قابل استرداد) در سرفصل حساب‌های این کسب‌وکار وجود ندارد؛ یا آن را بسازید یا مالیات را ۰ بگذارید.",
  receipt_asset_not_found: "تصویر رسید در کتابخانهٔ رسانه پیدا نشد.",
  party_not_found: "شخص انتخاب‌شده در فهرست اشخاص این کسب‌وکار نیست.",
  invalid_location: "شعبهٔ انتخاب‌شده برای این کسب‌وکار معتبر نیست.",
  expense_not_found: "هزینه پیدا نشد.",
  expense_already_reversed: "این هزینه قبلاً برگشت خورده است.",
  expense_is_reversal:
    "این ردیف خودش برگشتِ یک هزینه است و برگشت نمی‌خورد؛ برای ثبت دوبارهٔ هزینه، یک هزینهٔ جدید ثبت کنید.",
} as const;

export type ExpenseErrorCode = keyof typeof EXPENSE_ERROR_MESSAGES;

/** The codes the Expenses screen maps itself (see the header for the three it does not). */
export const EXPENSE_UI_ERROR_MESSAGES: Record<string, string> = Object.fromEntries(
  Object.entries(EXPENSE_ERROR_MESSAGES).filter(
    ([code]) => code !== "invalid_amount" && code !== "memo_required" && code !== "unknown_account",
  ),
);

/**
 * The status a code deserves. `ExpenseError` carries its own, and the routes
 * keep using it; this is the map for callers that only have the *code* — the
 * import engine and the autopilot executor, which must not turn a missing
 * party into a 400 or a reversed expense into a 500.
 */
const EXPENSE_ERROR_STATUS: Record<ExpenseErrorCode, number> = {
  invalid_amount: 400,
  memo_required: 400,
  unknown_account: 400,
  invalid_expense_account: 400,
  invalid_payment_account: 400,
  same_account: 400,
  invalid_expense_date: 400,
  expense_date_in_future: 400,
  vat_amount_invalid: 400,
  vat_account_missing: 409,
  receipt_asset_not_found: 404,
  party_not_found: 404,
  invalid_location: 400,
  expense_not_found: 404,
  expense_already_reversed: 409,
  expense_is_reversal: 409,
};

export function expenseErrorStatus(code: string): number {
  return EXPENSE_ERROR_STATUS[code as ExpenseErrorCode] ?? 400;
}

/** The Persian text for a code, or null when the code is not an expense one. */
export function expenseErrorMessage(code: string): string | null {
  return EXPENSE_ERROR_MESSAGES[code as ExpenseErrorCode] ?? null;
}
