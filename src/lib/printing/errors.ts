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
  | "printer_unavailable";

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
  job_timeout: "ارسال به چاپگر بیش از حد طول کشید.",
  template_invalid: "قالب چاپ قابل استفاده نیست.",
  template_not_found: "قالب چاپ انتخاب‌شده پیدا نشد؛ قوانین چاپ را بازخوانی کنید.",
  printer_unavailable: "چاپگر تنظیم‌شدهٔ این سند الان در دسترس نیست؛ چاپگر را بررسی یا چاپگر جایگزین تعیین کنید.",
};

/** The one place a code becomes the sentence a user reads. */
export function printerErrorMessage(code: string | undefined | null): string {
  if (code && code in PRINTER_ERROR_MESSAGES) return PRINTER_ERROR_MESSAGES[code as PrinterErrorCode];
  return PRINTER_ERROR_MESSAGES.print_failed;
}

/**
 * Classify a low-level delivery failure into the canonical code, so callers
 * can word their message for the right family of printer:
 * a Windows queue that exists but refuses the job vs a TCP address nothing
 * answers on are different problems in the operator's world.
 */
export function classifyDeliveryError(detail: string | undefined, target: { type: string }): PrinterErrorCode {
  const value = (detail ?? "").toLowerCase();
  if (target.type === "network") {
    if (value.includes("refused") || value.includes("unreachable") || value.includes("timed out") || value.includes("timeout")) {
      return "network_unreachable";
    }
    return "print_failed";
  }
  if (value.includes("not found") || value.includes("printer_not_found") || value.includes("invalid printer name")) {
    return "printer_not_found";
  }
  return "print_failed";
}
