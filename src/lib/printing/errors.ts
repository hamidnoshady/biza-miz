/**
 * The canonical printer error model.
 *
 * Every failure in the printing pipeline maps to one of these codes — the
 * browser client, the app-server routes and the Windows connector all speak
 * them. User-facing screens translate the codes to the Persian text below and
 * never show a raw exception (`ECONNREFUSED`, `usb_claim_failed`, Win32
 * errors) to a restaurant employee; technical detail belongs to the server
 * and connector logs.
 */

export type PrinterErrorCode =
  | "connector_not_installed"
  | "connector_outdated"
  | "connector_unreachable"
  | "printer_not_found"
  | "printer_inactive"
  | "printer_offline"
  | "network_unreachable"
  | "print_failed"
  | "render_failed"
  | "reconnect_required"
  | "invalid_printer"
  | "not_in_browser"
  | "printer_not_configured"
  | "incompatible_printer"
  | "spooler_rejected"
  | "job_timeout"
  | "template_invalid"
  | "template_not_found"
  | "document_required"
  | "document_not_found"
  | "document_type_mismatch"
  | "printer_unavailable"
  | "fallback_already_reserved"
  | "fallback_parent_pending"
  | "fallback_snapshot_missing"
  | "fallback_parent_not_found";

/** Persian, human, non-technical — what the operator should do next. */
export const PRINTER_ERROR_MESSAGES: Record<PrinterErrorCode, string> = {
  connector_not_installed:
    "برای چاپ از مرورگر، سرویس چاپ اشوبه باید یک‌بار روی همین کامپیوتر نصب شود.",
  connector_outdated:
    "سرویس چاپ اشوبه قدیمی است. آن را یک‌بار به‌روز کنید.",
  connector_unreachable:
    "سرویس چاپ اشوبه پاسخ نداد. نصب را بررسی کنید و اجازهٔ دسترسی محلی مرورگر را بدهید.",
  printer_not_found: "این چاپگر پیدا نشد. ممکن است حذف شده باشد؛ فهرست چاپگرها را بازخوانی کنید.",
  printer_inactive: "این چاپگر غیرفعال است. از تنظیمات چاپگر آن را فعال کنید.",
  printer_offline: "چاپگر پاسخ نداد. مطمئن شوید روشن است و کاغذ دارد.",
  network_unreachable:
    "چاپگر پاسخ نداد. مطمئن شوید روشن است و به همان شبکهٔ این کامپیوتر وصل است.",
  print_failed: "چاپ انجام نشد. چاپگر را بررسی کنید و دوباره امتحان کنید.",
  render_failed: "ساخت فایل چاپ ناموفق بود. لطفاً دوباره تلاش کنید.",
  reconnect_required: "این چاپگر باید دوباره متصل شود.",
  invalid_printer: "تنظیمات چاپگر کامل نیست؛ چاپگر را دوباره وصل کنید.",
  not_in_browser: "چاپ فقط از داخل برنامه ممکن است.",
  printer_not_configured: "برای این سند چاپگری تنظیم نشده است.",
  incompatible_printer: "این چاپگر برای این نوع سند مناسب نیست.",
  spooler_rejected: "ویندوز این کار چاپ را نپذیرفت.",
  job_timeout: "ارسال به چاپگر بیش از حد طول کشید؛ پیش از چاپ دوباره، خروجی چاپگر را بررسی کنید.",
  template_invalid: "قالب چاپ قابل استفاده نیست.",
  template_not_found: "قالب چاپ انتخاب‌شده پیدا نشد؛ قوانین چاپ را بازخوانی کنید.",
  // The three document codes only ever arrive from a client that is out of
  // date (or hand-edited): since the printing audit the browser names a stored
  // document instead of shipping one of its own. The wording therefore tells
  // the operator the one thing that fixes it — reload the screen.
  document_required: "این صفحه قدیمی است؛ یک‌بار تازه‌سازی کنید و دوباره چاپ کنید.",
  document_not_found: "سند موردنظر برای چاپ در این شعبه پیدا نشد.",
  document_type_mismatch: "نوع چاپ انتخاب‌شده با این سند هم‌خوان نیست.",
  printer_unavailable: "چاپگر تنظیم‌شدهٔ این سند الان در دسترس نیست؛ چاپگر را بررسی یا چاپگر جایگزین تعیین کنید.",
  fallback_already_reserved:
    "چاپ جایگزین برای این تلاش قبلاً ثبت شده است؛ برای جلوگیری از چاپ تکراری، ارسال مجدد خودکار متوقف شد.",
  fallback_parent_pending:
    "نتیجهٔ تلاش چاپگر اصلی هنوز ثبت نشده است؛ تا مشخص شدن عدم تحویل، چاپ جایگزین مجاز نیست.",
  fallback_snapshot_missing:
    "اطلاعات ثبت‌شدهٔ تلاش اول ناقص یا نامعتبر است؛ برای جلوگیری از تغییر محتوا، لطفاً سند را دوباره چاپ کنید.",
  fallback_parent_not_found:
    "تلاش اولیهٔ چاپ در این شعبه پیدا نشد؛ چاپ جایگزین خودکار مجاز نیست.",
};

/** The one place a code becomes the sentence a user reads. */
export function printerErrorMessage(code: string | undefined | null): string {
  if (code && code in PRINTER_ERROR_MESSAGES) return PRINTER_ERROR_MESSAGES[code as PrinterErrorCode];
  return PRINTER_ERROR_MESSAGES.print_failed;
}

/**
 * Three-state delivery classification for duplicate-print protection and
 * automatic fallback decisions:
 *  - `handed_off`: the local bridge or connector confirmed handoff to the
 *    OS spooler or network socket; do not retry.
 *  - `not_delivered`: confirmed pre-handoff non-delivery (printer missing,
 *    offline/paused before job creation, TCP connect failed before writing
 *    bytes, or spooler rejected document start); safe to attempt a configured
 *    compatible fallback printer.
 *  - `ambiguous`: bytes may already have been written (HTTP/PowerShell/socket
 *    timeout after write started, or partial write failure); NEVER
 *    automatically resend or fall back — require explicit operator action.
 *  - `connector_unavailable`: the local connector/bridge itself is missing or
 *    outdated, so no local printer can be reached through it.
 */
export type DeliveryOutcome =
  | "handed_off"
  | "not_delivered"
  | "ambiguous"
  | "connector_unavailable";

export const CONNECTOR_UNAVAILABLE_ERROR_LIST: readonly PrinterErrorCode[] = [
  "connector_not_installed",
  "connector_outdated",
  "connector_unreachable",
  "not_in_browser",
];

export const CONNECTOR_UNAVAILABLE_ERRORS: ReadonlySet<PrinterErrorCode> = new Set<PrinterErrorCode>(
  CONNECTOR_UNAVAILABLE_ERROR_LIST,
);

/**
 * Error codes that positively establish no bytes or document handoff reached
 * the OS spooler or printer socket. Generic `print_failed`, `job_timeout`, and
 * any unclassified failure are deliberately excluded — they default to
 * `ambiguous` so automatic fallback can never cause a duplicate print.
 */
export const CONFIRMED_PRE_HANDOFF_ERROR_LIST: readonly PrinterErrorCode[] = [
  "printer_not_found",
  "printer_inactive",
  "printer_offline",
  "network_unreachable",
  "spooler_rejected",
  "reconnect_required",
  "invalid_printer",
  "incompatible_printer",
  "render_failed",
];

export const CONFIRMED_PRE_HANDOFF_ERRORS: ReadonlySet<PrinterErrorCode> = new Set<PrinterErrorCode>(
  CONFIRMED_PRE_HANDOFF_ERROR_LIST,
);

/**
 * Whether a persisted print_jobs attempt row has positively confirmed
 * pre-handoff non-delivery and is eligible to act as a parent for a single
 * runtime fallback attempt.
 */
export function isConfirmedNonDeliveryAttempt(attempt: {
  status?: string | null;
  delivery_outcome?: string | null;
  error_code?: string | null;
}): boolean {
  if (attempt.status !== "failed") return false;
  if (attempt.delivery_outcome !== "not_delivered") return false;
  if (!attempt.error_code) return false;
  return CONFIRMED_PRE_HANDOFF_ERRORS.has(attempt.error_code as PrinterErrorCode);
}

const AMBIGUOUS_DETAIL_PATTERN =
  /write_ambiguous|writeprinter|after_write|print_document_ambiguous|printdocument\.print|powershell timed out|socket destroyed|econnreset|epipe|broken pipe/i;

export function classifyDeliveryOutcome(result: {
  ok: boolean;
  error?: PrinterErrorCode;
  unreachable?: boolean;
  ambiguous?: boolean;
  confirmedNonDelivery?: boolean;
  detail?: string;
}): DeliveryOutcome {
  if (result.ok) return "handed_off";
  if (
    result.unreachable === true ||
    (result.error !== undefined && CONNECTOR_UNAVAILABLE_ERRORS.has(result.error))
  ) {
    return "connector_unavailable";
  }
  if (
    result.ambiguous === true ||
    result.confirmedNonDelivery === false ||
    result.error === "job_timeout" ||
    result.error === "print_failed" ||
    (typeof result.detail === "string" && AMBIGUOUS_DETAIL_PATTERN.test(result.detail))
  ) {
    return "ambiguous";
  }
  if (
    result.error !== undefined &&
    CONFIRMED_PRE_HANDOFF_ERRORS.has(result.error)
  ) {
    return "not_delivered";
  }
  // Safe default: any unknown, missing, or unverified failure is treated as
  // ambiguous so automatic fallback never risks printing twice.
  return "ambiguous";
}

/**
 * Classify a low-level delivery failure into the canonical code, so callers
 * can word their message for the right family of printer:
 * a Windows queue that exists but refuses the job vs a TCP address nothing
 * answers on are different problems in the operator's world.
 */
export function classifyDeliveryError(detail: string | undefined, target: { type: string }): PrinterErrorCode {
  const value = (detail ?? "").toLowerCase();
  if (value.includes("write_ambiguous") || value.includes("writeprinterpartial")) {
    return "job_timeout";
  }
  if (value.includes("writeprinter") || value.includes("print_document_ambiguous") || value.includes("printdocument.print")) {
    return "print_failed";
  }
  if (target.type === "network") {
    if (value.includes("refused") || value.includes("unreachable") || value.includes("timed out") || value.includes("timeout")) {
      return "network_unreachable";
    }
    return "print_failed";
  }
  if (value.includes("not found") || value.includes("printer_not_found") || value.includes("invalid printer name")) {
    return "printer_not_found";
  }
  if (value.includes("printer_offline") || value.includes("workoffline") || value.includes("offline")) {
    return "printer_offline";
  }
  if (value.includes("startdocprinter") || value.includes("startpageprinter") || value.includes("spooler")) {
    return "spooler_rejected";
  }
  return "print_failed";
}
