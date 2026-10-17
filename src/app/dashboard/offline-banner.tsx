"use client";

import { toPersianDigits } from "@/lib/digits";
import { useOfflineQueue } from "./offline-queue";

/** Distinguishes LAN/server availability from the optional outbound cloud link. */
export function OfflineBanner() {
  const { pendingCount, connectionState } = useOfflineQueue();
  const localUnavailable = connectionState.localServer === "local_server_unreachable";
  const cloudPaused = connectionState.cloudSync === "cloud_sync_paused";
  const needsAttention = connectionState.attentionNeeded > 0;
  if (!localUnavailable && !cloudPaused && !needsAttention && !connectionState.pairingPending && pendingCount === 0) return null;

  let message: string;
  let className: string;
  if (needsAttention) {
    // Highest priority: a failed/conflicted entry needs a human decision and
    // will not resolve itself just because the connection comes back — see
    // the Sync Queue panel under Settings → Devices.
    message = `${toPersianDigits(connectionState.attentionNeeded)} اقدام در صف همگام‌سازی نیازمند بررسی است (ناموفق یا در تداخل). برای بررسی به «تنظیمات ← دستگاه‌ها» بروید.`;
    className = "bg-destructive/10 text-destructive";
  } else if (localUnavailable) {
    message = "سرور محلی در دسترس نیست — فقط عملیات‌های پشتیبانی‌شده در این دستگاه ذخیره می‌شوند؛ سایر تغییرها تا بازگشت اتصال مسدودند.";
    className = "bg-destructive/10 text-destructive";
  } else if (pendingCount > 0) {
    message = "سرور محلی متصل است؛ اقدام‌های ذخیره‌شده در حال ارسال هستند.";
    className = "bg-primary/10 text-primary";
  } else if (connectionState.pairingPending) {
    // Issue #987 — pairing snapshot committed locally but the cloud has not
    // acknowledged it yet. The sync tick retries automatically.
    message = "سرور محلی و عملیات کسب‌وکار فعال است؛ جفت‌شدن با ابر در حال تکمیل است و همگام‌سازی به‌زودی آغاز می‌شود.";
    className = "bg-primary/10 text-primary";
  } else {
    // Issue #948 P0/P1-5 — say which plane is stopped, and never claim the
    // Internet is gone while the operator may be standing on a working
    // connection with only the IAM/auth stage broken.
    const fault = connectionState.syncFault;
    if (fault === "auth_expired" || fault === "forbidden") {
      message = "سرور محلی و عملیات کسب‌وکار فعال است؛ همگام‌سازی ابری به دلیل پایان نشست حساب ابری متوقف است. از «تنظیمات ← ابر و همگام‌سازی» دوباره وارد شوید.";
    } else if (fault === "identity_blocked") {
      message = "سرور محلی و عملیات کسب‌وکار فعال است؛ همگام‌سازی به دلیل مشکل هویت/حساب کارکنان متوقف است. وضعیت را از «تنظیمات ← ابر و همگام‌سازی» بررسی و تعمیر کنید.";
    } else if (fault === "server_error") {
      message = "سرور محلی و عملیات کسب‌وکار فعال است؛ سرویس ابری موقتاً خطا می‌دهد و همگام‌سازی خودکار دوباره تلاش می‌شود.";
    } else if (fault === "transport_unreachable" || fault === "timeout" || fault === null) {
      message = "سرور محلی و عملیات کسب‌وکار فعال است؛ همگام‌سازی ابری موقتاً متوقف شده و به‌محض برقراری اتصال خودکار ادامه می‌یابد.";
    } else {
      message = "سرور محلی و عملیات کسب‌وکار فعال است؛ همگام‌سازی ابری موقتاً متوقف شده و به‌صورت خودکار دوباره تلاش می‌شود.";
    }
    className = "bg-amber-500/10 text-amber-800 dark:text-amber-200";
  }

  return (
    <div className={`px-4 py-2 text-center text-sm font-medium ${className}`}>
      {message}
      {pendingCount > 0 && !needsAttention ? ` (${toPersianDigits(pendingCount)} اقدام در صف محلی)` : ""}
    </div>
  );
}
