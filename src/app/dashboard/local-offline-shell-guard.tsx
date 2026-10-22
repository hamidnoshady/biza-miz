"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  DatabaseBackupIcon,
  EyeIcon,
  FileSearchIcon,
  KeyRoundIcon,
  LockIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import type { LocalActivationRecordView } from "@/lib/local-activation-site-service";
import type { LocalRemoteSupportUiSession } from "@/lib/local-remote-support-service";
import type { LocalSupportSessionMode } from "@/lib/local-activation-contract";

interface RemoteSupportState {
  pendingConsent: LocalRemoteSupportUiSession | null;
  activeSession: LocalRemoteSupportUiSession | null;
  serverNow: string;
}

const MODE_LABELS: Record<LocalSupportSessionMode, string> = {
  read_only: "فقط خواندنی (مشاهدهٔ وضعیت فنی)",
  controlled: "دسترسی محدود فنی (عیب‌یابی مجاز)",
  recovery_only: "بازیابی محدود دستگاه قفل‌شده",
};

const REPAIR_ERRORS: Record<string, string> = {
  invalid_token: "توکن فعال‌سازی آفلاین معتبر نیست.",
  token_expired: "این توکن منقضی شده است. در پنل ابری توکن جدید بسازید.",
  token_revoked: "این توکن لغو شده است.",
  token_already_used: "این توکن قبلاً مصرف شده است.",
  token_pairing_code: "این مقدار کد اتصال هیبرید است؛ توکن تمام‌آفلاین (OFL1-…) وارد کنید.",
  token_sync_token: "این مقدار توکن همگام‌سازی است؛ توکن تمام‌آفلاین (OFL1-…) وارد کنید.",
  token_bad_format: "فرمت توکن باید OFL1-XXXX-XXXX-XXXX باشد.",
  https_required: "آدرس سرور ابری باید با HTTPS شروع شود.",
  invalid_cloud_url: "آدرس سرور ابری معتبر نیست.",
  private_or_loopback_address_forbidden: "آدرس شبکهٔ داخلی یا محلی مجاز نیست.",
  business_mismatch: "توکن واردشده به کسب‌وکار دیگری تعلق دارد.",
  business_disabled: "کسب‌وکار در پنل ابری غیرفعال یا معلق است.",
};

function isAllowedLockedPagePath(pathname: string): boolean {
  return (
    pathname.startsWith("/settings") ||
    pathname.startsWith("/dashboard/backup") ||
    pathname.startsWith("/dashboard/audit") ||
    pathname.startsWith("/account")
  );
}

function formatShamsi(iso: string | null | undefined): string {
  if (!iso) return "ثبت نشده";
  return toPersianDigits(
    new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }),
  );
}

function remainingMinutesLabel(expiresAtIso: string | null): string {
  if (!expiresAtIso) return "";
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  if (diffMs <= 0) return "رو به اتمام";
  const mins = Math.max(1, Math.ceil(diffMs / 60_000));
  return `${toPersianDigits(String(mins))} دقیقه باقی‌مانده`;
}

export function LocalOfflineShellGuard({
  initialActivation,
  initialRemoteSupport,
  canManageActivation,
  canManageSupport,
  showLegacyUnenrolledBanner,
  children,
}: {
  initialActivation: LocalActivationRecordView;
  initialRemoteSupport: RemoteSupportState;
  canManageActivation: boolean;
  canManageSupport: boolean;
  showLegacyUnenrolledBanner: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [activation, setActivation] = useState<LocalActivationRecordView>(initialActivation);
  const [remoteSupport, setRemoteSupport] = useState<RemoteSupportState>(initialRemoteSupport);
  const [busy, setBusy] = useState(false);
  const [refreshingSkeleton, setRefreshingSkeleton] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [cloudUrlInput, setCloudUrlInput] = useState(initialActivation.cloudOrigin ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [changeUrlOpen, setChangeUrlOpen] = useState(false);

  const pollStatus = useCallback(async (probe = false) => {
    try {
      const offlineHint =
        typeof navigator !== "undefined" && navigator.onLine === false ? "1" : "0";
      const res = await fetch(
        `/api/local-activation/status?probe=${probe ? "1" : "0"}&offlineHint=${offlineHint}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        applicable?: boolean;
        activation?: LocalActivationRecordView;
        remoteSupport?: RemoteSupportState;
      };
      if (data.applicable) {
        if (data.activation) setActivation(data.activation);
        if (data.remoteSupport) setRemoteSupport(data.remoteSupport);
      }
    } catch {
      // Keep last known local state on transient loopback hiccups.
    }
  }, []);

  useEffect(() => {
    const intervalMs =
      remoteSupport.activeSession || remoteSupport.pendingConsent ? 6_000 : 20_000;
    const timer = window.setInterval(() => {
      void pollStatus(Boolean(remoteSupport.activeSession || remoteSupport.pendingConsent));
    }, intervalMs);
    const onOnline = () => void pollStatus(true);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [pollStatus, remoteSupport.activeSession, remoteSupport.pendingConsent]);

  async function respondConsent(sessionId: string, approve: boolean) {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/local-activation/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: approve ? "approve_remote_support" : "deny_remote_support",
          sessionId,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        remoteSupport?: RemoteSupportState;
      };
      if (data.remoteSupport) setRemoteSupport(data.remoteSupport);
      if (!res.ok || !data.ok) {
        setFeedback({
          tone: "error",
          text:
            data.error === "cloud_support_offline"
              ? "سرور ابری در دسترس نیست؛ تأیید جلسهٔ پشتیبانی فقط در حالت آنلاین امکان‌پذیر است."
              : "ثبت پاسخ به درخواست پشتیبانی ناموفق بود.",
        });
      }
    } catch {
      setFeedback({ tone: "error", text: "خطا در برقراری ارتباط." });
    } finally {
      setBusy(false);
    }
  }

  async function revokeRemoteSession(sessionId: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/local-activation/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke_remote_support", sessionId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        remoteSupport?: RemoteSupportState;
      };
      if (data.remoteSupport) setRemoteSupport(data.remoteSupport);
    } finally {
      setBusy(false);
    }
  }

  async function revalidateNow() {
    setRefreshingSkeleton(true);
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/local-activation/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revalidate" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        activation?: LocalActivationRecordView;
      };
      if (data.activation) {
        setActivation(data.activation);
        if (data.activation.state === "active") {
          router.refresh();
        }
      }
    } finally {
      setRefreshingSkeleton(false);
      setBusy(false);
    }
  }

  async function submitUnlockToken() {
    setBusy(true);
    setFeedback(null);
    try {
      const action = changeUrlOpen ? "update_cloud_url" : "replace_token";
      const res = await fetch("/api/local-activation/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          cloudUrl: changeUrlOpen ? cloudUrlInput.trim() : undefined,
          token: tokenInput.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        activation?: LocalActivationRecordView;
      };
      if (!res.ok || !data.ok) {
        setFeedback({
          tone: "error",
          text:
            REPAIR_ERRORS[data.error ?? ""] ??
            "تأیید توکن جدید ناموفق بود. توکن و اتصال اینترنت را بررسی کنید.",
        });
        return;
      }
      if (data.activation) setActivation(data.activation);
      setTokenInput("");
      setChangeUrlOpen(false);
      setFeedback({
        tone: "ok",
        text: "دستگاه با موفقیت تأیید و بازگشایی شد. تمام داده‌های محلی حفظ شده‌اند.",
      });
      router.refresh();
    } catch {
      setFeedback({ tone: "error", text: "ارتباط با سرور برقرار نشد." });
    } finally {
      setBusy(false);
    }
  }

  const activeSession = remoteSupport.activeSession;
  const pendingConsent = remoteSupport.pendingConsent;
  const lockedBlockedPage =
    activation.state === "locked_invalid" && !isAllowedLockedPagePath(pathname);

  return (
    <>
      {activeSession ? (
        <div
          role="region"
          aria-label="جلسهٔ پشتیبانی از راه دور"
          className="mb-4 rounded-xl border border-amber-300 bg-amber-50/90 p-3.5 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              {activeSession.mode === "read_only" ? (
                <EyeIcon className="mt-0.5 size-5 shrink-0 text-amber-800 dark:text-amber-200" />
              ) : (
                <WrenchIcon className="mt-0.5 size-5 shrink-0 text-amber-800 dark:text-amber-200" />
              )}
              <div className="text-xs leading-6 sm:text-sm">
                <p className="font-bold">
                  {activeSession.state === "paused_disconnected"
                    ? "جلسهٔ پشتیبانی از راه دور (موقتاً متوقف — ارتباط ابری قطع است)"
                    : "جلسهٔ پشتیبانی از راه دور فعال است"}
                </p>
                <p className="text-xs text-amber-900/90 dark:text-amber-200/90">
                  اپراتور: <span className="font-semibold">{activeSession.operatorName}</span>
                  {" • "}سطح دسترسی: <span className="font-semibold">{MODE_LABELS[activeSession.mode]}</span>
                  {activeSession.ticketId ? ` • تیکت: ${activeSession.ticketId}` : ""}
                  {activeSession.expiresAt ? ` • ${remainingMinutesLabel(activeSession.expiresAt)}` : ""}
                </p>
              </div>
            </div>
            {canManageSupport ? (
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void revokeRemoteSession(activeSession.id)}
              >
                پایان و لغو فوری دسترسی
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {pendingConsent && canManageActivation ? (
        <div
          role="alertdialog"
          aria-label="درخواست پشتیبانی از راه دور"
          className={`mb-4 ${cardClass} border-teal-300 p-4 dark:border-teal-500/40`}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-bold text-teal-800 dark:text-teal-200">
                <ShieldAlertIcon className="size-5" />
                <span>درخواست جلسهٔ پشتیبانی از راه دور توسط تیم پلتفرم</span>
              </div>
              <p className="text-xs leading-6 text-muted-foreground">
                اپراتور <span className="font-semibold text-foreground">{pendingConsent.operatorName}</span>{" "}
                درخواست دسترسی <span className="font-semibold text-foreground">{MODE_LABELS[pendingConsent.mode]}</span>{" "}
                به مدت {toPersianDigits(String(pendingConsent.requestedDurationMinutes))} دقیقه ثبت کرده است.
                {pendingConsent.ticketId ? ` (شناسهٔ تیکت: ${pendingConsent.ticketId})` : ""}
              </p>
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-foreground">
                علت اعلام‌شده: {pendingConsent.reason}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void respondConsent(pendingConsent.id, true)}
              >
                تأیید و شروع جلسه
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void respondConsent(pendingConsent.id, false)}
              >
                رد درخواست
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showLegacyUnenrolledBanner && !activation.enrolled && !lockedBlockedPage ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50/80 px-4 py-3 text-xs text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon className="size-4 shrink-0" />
            <span>
              این نصب تمام‌آفلاین هنوز در سرور ابری ثبت و فعال‌سازی نشده است. داده‌های محلی شما کاملاً محفوظ‌اند؛ برای فعال‌سازی پشتیبانی آنلاین و دریافت مجوزها، ثبت ابری را تکمیل کنید.
            </span>
          </div>
          {canManageActivation ? (
            <Button size="sm" variant="outline" asChild>
              <Link href="/settings">تکمیل فعال‌سازی ابری</Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      {lockedBlockedPage ? (
        refreshingSkeleton ? (
          <SectionCardSkeleton rows={4} label="در حال بررسی وضعیت فعال‌سازی ابری" />
        ) : (
          <div className={`mx-auto my-6 max-w-2xl ${cardClass} p-6 sm:p-8`}>
            <div className="flex items-start gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200">
                <LockIcon className="size-6" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">
                  {activation.summary.headlineFa}
                </h1>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {activation.summary.lockReasonFa ?? activation.summary.detailFa}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-4 text-xs leading-6 text-foreground dark:border-stone-800 dark:bg-stone-900/50">
              <p className="font-semibold text-emerald-800 dark:text-emerald-300">
                داده‌های محلی شما کاملاً امن و دست‌نخورده باقی مانده‌اند
              </p>
              <p className="mt-1 text-muted-foreground">
                هیچ سفارش، سند حسابداری، موجودی انبار یا فایل پشتیبانی پاک نشده است. آخرین تأیید موفق ابری:{" "}
                {formatShamsi(activation.lastVerifiedAt)}.
              </p>
            </div>

            {feedback ? (
              <p
                className={`mt-4 rounded-lg border px-3 py-2 text-xs leading-6 ${
                  feedback.tone === "ok"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                    : "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
                }`}
              >
                {feedback.text}
              </p>
            ) : null}

            {canManageActivation ? (
              <div className="mt-5 space-y-4">
                <div className="space-y-3 rounded-xl border border-border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      <KeyRoundIcon className="size-4 text-amber-700 dark:text-amber-300" />
                      بازگشایی با توکن فعال‌سازی جدید (OFL1-…)
                    </span>
                    <button
                      type="button"
                      onClick={() => setChangeUrlOpen((v) => !v)}
                      className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {changeUrlOpen ? "استفاده از آدرس فعلی" : "تغییر آدرس سرور ابری"}
                    </button>
                  </div>

                  {changeUrlOpen ? (
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium">آدرس سرور ابری (HTTPS)</span>
                      <input
                        dir="ltr"
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                        value={cloudUrlInput}
                        onChange={(e) => setCloudUrlInput(e.target.value)}
                        placeholder="https://mybusiness.example.com"
                      />
                    </label>
                  ) : null}

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium">توکن یک‌بارمصرف جدید</span>
                    <input
                      dir="ltr"
                      className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm"
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      placeholder="OFL1-XXXX-XXXX-XXXX"
                      autoComplete="off"
                    />
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy || !tokenInput.trim() || (changeUrlOpen && !cloudUrlInput.trim())}
                      onClick={() => void submitUnlockToken()}
                    >
                      {busy ? "در حال تأیید با ابر…" : "تأیید توکن و بازگشایی"}
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => void revalidateNow()}>
                      <RefreshCwIcon className="size-4" />
                      بررسی مجدد وضعیت فعلی
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/dashboard/backup">
                      <DatabaseBackupIcon className="size-4" />
                      پشتیبان‌گیری و خروجی محلی
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/dashboard/audit">
                      <FileSearchIcon className="size-4" />
                      گزارش حسابرسی
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/settings">تنظیمات اتصال</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-5 rounded-lg bg-muted p-3 text-xs leading-6 text-muted-foreground">
                برای بازگشایی دستگاه و ثبت توکن فعال‌سازی جدید، از مالک کسب‌وکار بخواهید با حساب کاربری خود وارد شود.
              </p>
            )}
          </div>
        )
      ) : (
        children
      )}
    </>
  );
}
