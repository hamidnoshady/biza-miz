/**
 * Every refusal the commission settlement API can answer, in Persian (issue #869),
 * and the words for the calculation warnings a run carries.
 *
 * One map, so a code the screen can meet is never shown raw. The settlement
 * screens look here first; a code that is not here falls back to the generic
 * sentence, never to the bare code. `commission-settlement-messages.test.ts`
 * scans the settlement sources and fails when a code they raise has no sentence.
 */
import type { PlanWarning } from "@/lib/commission-settlement-plan";

export const COMMISSION_SETTLEMENT_ERROR_MESSAGES: Record<string, string> = {
  // The run
  run_not_found: "دورهٔ تسویه پیدا نشد.",
  run_not_draft: "فقط دورهٔ پیش‌نویس را می‌توان محاسبه کرد؛ این دوره قبلاً محاسبه شده است.",
  run_not_calculated: "برای بازبینی، ابتدا دوره باید محاسبه شده باشد.",
  run_not_reviewed: "برای تأیید، ابتدا دوره باید بازبینی شود.",
  run_not_rejectable: "این دوره در وضعیتی نیست که به پیش‌نویس بازگردد.",
  run_not_approved: "برای آزادسازی پرداخت، ابتدا دوره باید تأیید شود.",
  run_not_voidable: "این دوره در وضعیتی نیست که ابطال شود.",
  run_not_payable: "این دوره آماده پرداخت نیست؛ ابتدا آن را تأیید و برای پرداخت آزاد کنید.",
  run_not_closable: "برای بستن دوره، ابتدا باید پرداختی ثبت شده باشد.",
  run_has_payouts: "برای این دوره پرداخت ثبت شده است؛ پیش از ابطال یا بازگشت به پیش‌نویس، پرداخت‌ها را ابطال کنید.",
  nothing_to_settle:
    "پورسانتی برای تسویه در این دوره نیست: یا همه ردیف‌ها قبلاً تسویه شده‌اند، یا مانده هیچ فروشنده‌ای مثبت نیست.",
  approver_is_calculator: "کسی که دوره را ساخته، نمی‌تواند همان را تأیید کند؛ تأیید باید توسط فرد دیگری انجام شود.",
  permission_required: "دسترسی لازم برای این کار را ندارید.",
  commission_already_settled:
    "پورسانتی که می‌خواستید تسویه کنید همزمان در لیست دیگری تسویه شد؛ دوباره تلاش کنید.",
  void_reason_required: "برای ابطال دوره، دلیل آن را بنویسید.",
  note_too_long: "متن یادداشت بیش از حد طولانی است.",

  // Creating a run
  location_not_found: "شعبهٔ انتخاب‌شده پیدا نشد.",
  employee_not_found: "یکی از فروشنده‌های انتخاب‌شده پیدا نشد.",
  period_in_future: "دورهٔ تسویه نمی‌تواند تا تاریخی در آینده برود.",
  invalid_period: "تاریخ دوره معتبر نیست.",
  invalid_period_range: "تاریخ پایان دوره نمی‌تواند پیش از تاریخ شروع باشد.",
  invalid_employee_ids: "فهرست فروشنده‌ها معتبر نیست.",
  invalid_location: "شعبهٔ انتخاب‌شده معتبر نیست.",
  invalid_title: "عنوان دوره باید حداکثر ۱۲۰ نویسه باشد.",

  // Retrying safely
  idempotency_key_required: "شناسهٔ تکرار درخواست لازم است.",
  idempotency_key_invalid: "شناسهٔ تکرار درخواست معتبر نیست.",
  idempotency_key_conflict:
    "این شناسهٔ درخواست قبلاً برای درخواست دیگری به‌کار رفته است؛ صفحه را تازه کنید و دوباره تلاش کنید.",

  // Paying
  no_allocations: "هیچ مبلغی برای پرداخت انتخاب نشده است.",
  invalid_allocations: "فهرست پرداخت به فروشنده‌ها معتبر نیست.",
  invalid_amount: "مبلغ وارد‌شده معتبر نیست.",
  duplicate_allocation: "یک فروشنده بیش از یک بار در این پرداخت آمده است.",
  employee_not_in_run: "این فروشنده در این دوره ردیفی ندارد.",
  nothing_outstanding: "این فروشنده در این دوره مانده‌ای برای پرداخت ندارد.",
  allocation_exceeds_outstanding: "مبلغ بیش از مانده‌ای است که این فروشنده در این دوره طلب دارد.",
  paid_date_in_future: "تاریخ پرداخت نمی‌تواند در آینده باشد.",
  invalid_paid_date: "تاریخ پرداخت معتبر نیست.",
  invalid_method: "حساب پرداخت معتبر نیست.",
  invalid_payment_account: "حساب پرداخت انتخاب‌شده معتبر نیست؛ یکی از حساب‌های صندوق، بانک یا تنخواه را انتخاب کنید.",
  payout_not_found: "پرداخت پیدا نشد.",
  payout_not_reversible: "این پرداخت قابل ابطال نیست؛ یا قبلاً ابطال شده، یا دوره بسته شده است.",

  // The lists and exports
  invalid_run_status: "وضعیت انتخاب‌شده معتبر نیست.",
  invalid_limit: "تعداد نتایج معتبر نیست.",
  invalid_offset: "شمارهٔ صفحه معتبر نیست.",
  invalid_format: "قالب خروجی معتبر نیست.",
  invalid_employee: "فروشنده انتخاب‌شده معتبر نیست.",
  employee_required: "فروشنده را انتخاب کنید.",
  bad_request: "درخواست معتبر نیست.",

  // Shared with payroll: the books refuse these whichever screen posts
  ledger_account_missing: "یکی از حساب‌های لازم برای ثبت سند در دفتر پیدا نشد.",
  fiscal_period_locked: "دورهٔ مالی این تاریخ بسته است؛ تاریخ دیگری انتخاب کنید.",
  fiscal_period_soft_closed: "دورهٔ مالی این تاریخ بسته شده است؛ با مسئول حسابداری هماهنگ کنید.",
};

export const COMMISSION_SETTLEMENT_FALLBACK_MESSAGE = "خطای غیرمنتظره. دوباره تلاش کنید.";

/** A Persian sentence for a refusal code, or the generic one for a code this screen has not been given. */
export function commissionSettlementErrorMessage(code: string | undefined): string {
  if (!code) return COMMISSION_SETTLEMENT_FALLBACK_MESSAGE;
  return COMMISSION_SETTLEMENT_ERROR_MESSAGES[code] ?? COMMISSION_SETTLEMENT_FALLBACK_MESSAGE;
}

/**
 * The words for one calculation warning. Counts are passed in as text (already
 * in the form the screen shows); names come from the run's own snapshot.
 */
export function commissionWarningText(warning: PlanWarning, formatCount: (n: number) => string): string {
  switch (warning.code) {
    case "balance_not_positive": {
      const names = warning.employees.map((e) => e.fullName).join("، ");
      return `مانده این فروشندگان در این دوره مثبت نیست و پرداخت نشد؛ ردیف‌هایشان برای دورهٔ بعد باز می‌ماند: ${names}.`;
    }
    case "claimed_by_payroll":
      return `${formatCount(warning.rows)} ردیف پورسانت در یک فیش حقوق ثبت شده است و در این دوره نیامده است.`;
    case "earlier_rows_included":
      return `${formatCount(warning.rows)} ردیف مربوط به پیش از شروع این دوره، که هنوز پرداخت نشده، در این دوره آمده است.`;
    case "inactive_member": {
      const names = warning.employees.map((e) => e.fullName).join("، ");
      return `فروشندهٔ غیرفعال در این دوره است؛ پیش از پرداخت، تأیید کنید: ${names}.`;
    }
    case "rule_missing":
      return `${formatCount(warning.rows)} ردیف قانون پورسانت خود را از دست داده است؛ مبلغ آن‌ها در این دوره آمده است.`;
  }
}
