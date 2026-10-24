"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CloudIcon,
  DatabaseIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import type { ConnectionStatus, PlatformConnectionState } from "@/lib/connection-state";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import type { LocalActivationRecordView } from "@/lib/local-activation-site-service";
import { toPersianDigits } from "@/lib/digits";
import { Button } from "@/components/ui/button";
import { useOfflineQueue } from "@/app/dashboard/offline-queue";
import { credentialSyncLabel } from "@/lib/iam/credential-health";
import {
  isIamFailureCode,
  operationalSyncBlockedSummary,
  operationalSyncBlockLabel,
  type OperationalSyncBlockView,
} from "@/lib/iam/operational-sync-health";

interface StatusResponse extends PlatformConnectionState {
  profile: DeploymentProfile;
  siteProfile?: { appliedAt: string | null; lastError: string | null } | null;
  operationalBlock?: OperationalSyncBlockView | null;
  localActivation?: LocalActivationRecordView | null;
}

const LABEL: Record<ConnectionStatus, string> = {
  connected: "متصل",
  unreachable: "در دسترس نیست",
  unknown: "نامشخص",
  connecting: "در حال اتصال",
  paused: "موقتاً متوقف",
  not_configured: "تنظیم نشده",
  attention_required: "نیازمند بررسی",
  not_applicable: "کاربرد ندارد",
};

const IDENTITY_LABEL: Record<string, string> = {
  healthy: "سالم",
  pending: "در انتظار",
  syncing: "در حال همگام‌سازی",
  degraded: "نیازمند بررسی",
  conflict: "تعارض",
  snapshot_required: "نیازمند همگام‌سازی کامل",
  offline: "آفلاین",
  not_configured: "تنظیم نشده",
};

const OVERALL_NOTE: Record<string, string> = {
  healthy: "هویت و ورود کارکنان کامل همگام شده است.",
  degraded: "همگام‌سازی هویت کامل نیست؛ برای تکمیل، «همگام‌سازی دوباره» را بزنید.",
  limited: "نسخهٔ ابری این کسب‌وکار سرویس رمز/پین کارکنان را ندارد؛ کارکنان ساخته‌شده در ابر روی این دستگاه قابل ورود نیستند.",
  syncing: "همگام‌سازی هویت در جریان است.",
  not_configured: "این دستگاه به ابر متصل نیست.",
};

const LOCAL_REPAIR_ERRORS: Record<string, string> = {
  invalid_token: "توکن فعال‌سازی آفلاین معتبر نیست.",
  token_expired: "این توکن منقضی شده است. در پنل ابری توکن جدید بسازید.",
  token_revoked: "این توکن لغو شده است.",
  token_already_used: "این توکن قبلاً مصرف شده است.",
  token_pairing_code: "این مقدار کد اتصال هیبرید است؛ توکن تمام‌آفلاین (OFL1-…) وارد کنید.",
  token_sync_token: "این مقدار توکن همگام‌سازی (POS1-…) است؛ توکن تمام‌آفلاین (OFL1-…) وارد کنید.",
  token_bad_format: "فرمت توکن باید OFL1-XXXX-XXXX-XXXX باشد.",
  https_required: "آدرس سرور ابری باید با HTTPS شروع شود.",
  invalid_cloud_url: "آدرس سرور ابری معتبر نیست.",
  private_or_loopback_address_forbidden: "آدرس شبکهٔ داخلی یا محلی مجاز نیست.",
  business_mismatch: "توکن واردشده به کسب‌وکار دیگری تعلق دارد و روی این پایگاه داده مجاز نیست.",
  business_disabled: "کسب‌وکار در پنل ابری غیرفعال یا معلق است.",
  forbidden: "این عملیات فقط با حساب مالک کسب‌وکار مجاز است.",
};

function formatShamsiDateTime(iso: string | null | undefined): string {
  if (!iso) return "هنوز ثبت نشده";
  return toPersianDigits(
    new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }),
  );
}

export function CloudSyncSettings() {
  const { serverStatus } = useOfflineQueue();
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [localView, setLocalView] = useState<LocalActivationRecordView | null>(null);
  const [canManageActivation, setCanManageActivation] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const [repairFormMode, setRepairFormMode] = useState<
    null | "enroll_existing" | "replace_token" | "update_cloud_url"
  >(null);
  const [cloudUrlInput, setCloudUrlInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");

  useEffect(() => {
    if (!serverStatus || (serverStatus as StatusResponse).profile !== "local") return;
    const offlineHint = typeof navigator !== "undefined" && navigator.onLine === false ? "1" : "0";
    fetch(`/api/local-activation/status?probe=1&offlineHint=${offlineHint}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            applicable?: boolean;
            canManageActivation?: boolean;
            activation?: LocalActivationRecordView;
          } | null,
        ) => {
          if (data?.applicable && data.activation) {
            setLocalView(data.activation);
            setCanManageActivation(Boolean(data.canManageActivation));
            setCloudUrlInput((cur) => cur || data.activation?.cloudOrigin || "");
          }
        },
      )
      .catch(() => {});
  }, [serverStatus]);

  if (!serverStatus) return <SectionCardSkeleton rows={4} label="در حال بررسی وضعیت اتصال" />;
  const state = serverStatus as StatusResponse & {
    identitySync?: { state: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null } | null;
    credentialSync?: {
      state: string;
      lastAttemptAt: string | null;
      lastSuccessAt: string | null;
      lastError: string | null;
      membershipsExpected: number;
      identitiesExpected: number;
      identitiesLinked: number;
      pinMembersExpected: number;
      pinMembersUsable: number;
      pinMembersMissing: number;
      missingIdentityBindings: number;
      pinsRevoked?: number;
      identityMismatches?: number;
      identitiesRekeyed?: number;
      identityContract?: string | null;
    } | null;
    overallIdentity?: string;
  };
  const local = state.profile === "local";
  const activation = localView ?? state.localActivation ?? null;
  const identity = state.identitySync ?? null;
  const credentials = state.credentialSync ?? null;
  const overall = state.overallIdentity ?? "not_configured";
  const block = state.operationalBlock ?? null;
  const operationalBlocked = block?.state === "blocked";

  async function revalidateLocalNow() {
    setLocalBusy(true);
    setLocalFeedback(null);
    try {
      const res = await fetch("/api/local-activation/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revalidate" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        activation?: LocalActivationRecordView;
        result?: { refreshed?: boolean; error?: string | null };
      };
      if (data.activation) setLocalView(data.activation);
      if (res.ok && data.ok) {
        if (data.result?.error) {
          setLocalFeedback({
            tone: "error",
            text:
              LOCAL_REPAIR_ERRORS[data.result.error] ??
              "سرور ابری در دسترس نبود یا تأیید انجام نشد؛ عملیات آفلاین ادامه دارد.",
          });
        } else {
          setLocalFeedback({
            tone: "ok",
            text: data.result?.refreshed
              ? "وضعیت دستگاه تأیید شد و مشخصات کسب‌وکار از ابر به‌روزرسانی گردید."
              : "وضعیت فعال‌سازی دستگاه با موفقیت توسط سرور ابری تأیید شد.",
          });
        }
      } else {
        setLocalFeedback({
          tone: "error",
          text: LOCAL_REPAIR_ERRORS[data.error ?? ""] ?? "بررسی وضعیت ابری ممکن نشد.",
        });
      }
    } catch {
      setLocalFeedback({ tone: "error", text: "ارتباط با سرور محلی برقرار نشد." });
    } finally {
      setLocalBusy(false);
      window.dispatchEvent(new Event("online"));
    }
  }

  async function submitLocalRepair() {
    if (!repairFormMode) return;
    setLocalBusy(true);
    setLocalFeedback(null);
    try {
      const res = await fetch("/api/local-activation/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: repairFormMode,
          cloudUrl: cloudUrlInput.trim(),
          token: tokenInput.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        activation?: LocalActivationRecordView;
      };
      if (!res.ok || !data.ok) {
        setLocalFeedback({
          tone: "error",
          text:
            LOCAL_REPAIR_ERRORS[data.error ?? ""] ??
            "ثبت توکن یا آدرس ابری ناموفق بود. مقادیر را بررسی کنید.",
        });
        return;
      }
      if (data.activation) setLocalView(data.activation);
      setTokenInput("");
      setRepairFormMode(null);
      setLocalFeedback({
        tone: "ok",
        text: "فعال‌سازی ابری با موفقیت ثبت و تأیید شد؛ داده‌های محلی بدون تغییر حفظ شدند.",
      });
    } catch {
      setLocalFeedback({ tone: "error", text: "خطا در برقراری ارتباط." });
    } finally {
      setLocalBusy(false);
      window.dispatchEvent(new Event("online"));
    }
  }

  async function repairIam() {
    setRepairBusy(true);
    setRepairMessage(null);
    try {
      const response = await fetch("/api/team/iam-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repair" }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; reason?: string | null; credentialSync?: { pinMembersMissing?: number } } | null;
      if (body?.ok) setRepairMessage("همگام‌سازی هویت و رمز کارکنان کامل شد.");
      else {
        const missing = body?.credentialSync?.pinMembersMissing ?? 0;
        setRepairMessage(
          response.status === 403
            ? "برای تعمیر همگام‌سازی، دسترسی مدیریت تیم لازم است."
            : missing > 0
              ? `تعمیر انجام شد اما ${missing.toLocaleString("fa-IR")} حساب پین‌دار هنوز آماده نیست؛ دوباره تلاش کنید.`
              : "تعمیر کامل نشد؛ اتصال ابری را بررسی و دوباره تلاش کنید.",
        );
      }
    } catch {
      setRepairMessage("ارتباط با سرور ممکن نشد.");
    } finally {
      setRepairBusy(false);
      window.dispatchEvent(new Event("online"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatusCard icon={ServerIcon} title="سیستم محلی" value={LABEL[state.localServer]} />
        <StatusCard icon={CloudIcon} title="حساب ابری" value={LABEL[state.cloud]} />
        <StatusCard
          icon={RefreshCwIcon}
          title={local ? "همگام‌سازی تراکنش‌ها" : "همگام‌سازی"}
          value={local ? "غیرفعال (تمام‌آفلاین)" : LABEL[state.sync]}
        />
      </div>

      {local && activation ? (
        <section className={`${cardClass} p-5`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <ShieldCheckIcon className="size-5 text-amber-700 dark:text-amber-300" />
                <h3 className="font-bold text-foreground">فعال‌سازی و اعتبارسنجی ابری (حالت تمام‌آفلاین)</h3>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    activation.state === "active"
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                      : activation.state === "locked_invalid"
                        ? "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
                  }`}
                >
                  {activation.summary.headlineFa}
                </span>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {activation.summary.detailFa}
              </p>
            </div>
            {activation.enrolled ? (
              <Button variant="outline" onClick={() => void revalidateLocalNow()} disabled={localBusy}>
                <RefreshCwIcon className="size-4" />
                {localBusy ? "در حال بررسی…" : "بررسی و به‌روزرسانی با ابر"}
              </Button>
            ) : null}
          </div>

          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-lg bg-muted p-3">
              <dt className="text-xs text-muted-foreground">آخرین تأیید موفق با ابر</dt>
              <dd className="mt-1 font-semibold">{formatShamsiDateTime(activation.lastVerifiedAt)}</dd>
            </div>
            <div className="rounded-lg bg-muted p-3">
              <dt className="text-xs text-muted-foreground">آخرین به‌روزرسانی مشخصات کسب‌وکار</dt>
              <dd className="mt-1 font-semibold">{formatShamsiDateTime(activation.lastBusinessUpdatedAt)}</dd>
            </div>
            <div className="rounded-lg bg-muted p-3">
              <dt className="text-xs text-muted-foreground">آدرس سرور ابری متصل</dt>
              <dd dir="ltr" className="mt-1 truncate font-mono text-xs font-semibold">
                {activation.cloudOrigin ?? "ثبت نشده"}
              </dd>
            </div>
          </dl>

          {localFeedback ? (
            <p
              className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-6 ${
                localFeedback.tone === "ok"
                  ? "border-emerald-300 bg-emerald-50/70 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                  : "border-rose-300 bg-rose-50/70 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
              }`}
            >
              {localFeedback.text}
            </p>
          ) : null}

          {canManageActivation ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {!activation.enrolled ? (
                <Button
                  onClick={() => setRepairFormMode("enroll_existing")}
                  disabled={localBusy}
                >
                  فعال‌سازی امن نصب موجود (با حفظ کامل داده‌ها)
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setRepairFormMode("replace_token")}
                    disabled={localBusy}
                  >
                    جایگزینی توکن فعال‌سازی
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setCloudUrlInput(activation.cloudOrigin ?? "");
                      setRepairFormMode("update_cloud_url");
                    }}
                    disabled={localBusy}
                  >
                    تغییر آدرس سرور ابری
                  </Button>
                </>
              )}
            </div>
          ) : null}

          {repairFormMode ? (
            <div className="mt-4 space-y-3 rounded-xl border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/50">
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                {repairFormMode === "enroll_existing"
                  ? "ثبت اولیهٔ نصب موجود در پنل ابری (پیش از اعمال، نسخهٔ پشتیبان مشخصات محلی در گزارش حسابرسی ثبت می‌شود و هیچ دادهٔ عملیاتی تغییر نمی‌کند)"
                  : repairFormMode === "update_cloud_url"
                    ? "تغییر آدرس سرور ابری همراه با توکن تأیید جدید برای همین کسب‌وکار"
                    : "جایگزینی توکن فعال‌سازی برای همین کسب‌وکار"}
              </p>
              {repairFormMode !== "replace_token" ? (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-foreground">
                    آدرس سرور ابری (HTTPS)
                  </span>
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
                <span className="mb-1 block text-xs font-medium text-foreground">
                  توکن یک‌بارمصرف تمام‌آفلاین (OFL1-…)
                </span>
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
                  onClick={() => void submitLocalRepair()}
                  disabled={
                    localBusy ||
                    !tokenInput.trim() ||
                    (repairFormMode !== "replace_token" && !cloudUrlInput.trim())
                  }
                >
                  {localBusy ? "در حال تأیید با ابر…" : "تأیید و ذخیره"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setRepairFormMode(null)}
                  disabled={localBusy}
                >
                  انصراف
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {!local && identity ? (
        <section className={`${cardClass} p-5`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="size-5 text-muted-foreground" />
                <h3 className="font-bold text-foreground">هویت و ورود کارکنان</h3>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {OVERALL_NOTE[overall] ?? OVERALL_NOTE.degraded}
              </p>
            </div>
            <Button variant="outline" onClick={() => void repairIam()} disabled={repairBusy}>
              <RefreshCwIcon className="size-4" />
              {repairBusy ? "در حال همگام‌سازی…" : "همگام‌سازی دوباره"}
            </Button>
          </div>
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
            <IdentityRow
              icon={ServerIcon}
              label="عضویت و نقش‌ها"
              value={IDENTITY_LABEL[identity.state] ?? identity.state}
              detail={
                credentials
                  ? `${credentials.identitiesLinked.toLocaleString("fa-IR")} از ${credentials.identitiesExpected.toLocaleString("fa-IR")} هویت ورود پیوند خورده` +
                    (identity.lastSuccessAt ? ` — آخرین موفقیت: ${new Date(identity.lastSuccessAt).toLocaleString("fa-IR")}` : "")
                  : identity.lastSuccessAt
                    ? `آخرین موفقیت: ${new Date(identity.lastSuccessAt).toLocaleString("fa-IR")}`
                    : "هنوز همگام نشده"
              }
              healthy={identity.state === "healthy"}
            />
            <IdentityRow
              icon={KeyRoundIcon}
              label="رمز و پین ورود کارکنان"
              value={credentials ? credentialSyncLabel(credentials.state as never) : "در انتظار"}
              detail={
                credentials
                  ? `${credentials.pinMembersUsable.toLocaleString("fa-IR")} از ${credentials.pinMembersExpected.toLocaleString("fa-IR")} حساب پین‌دار آماده است` +
                    ((credentials.pinsRevoked ?? 0) > 0
                      ? ` — ${(credentials.pinsRevoked ?? 0).toLocaleString("fa-IR")} پین حذف‌شده در ابر روی این دستگاه هم باطل شد`
                      : "")
                  : "وضعیت رمز کارکنان دریافت نشده"
              }
              healthy={
                credentials?.state === "healthy"
                && credentials.pinMembersMissing === 0
                && (credentials.missingIdentityBindings ?? 0) === 0
              }
            />
            <IdentityRow
              icon={DatabaseIcon}
              label="داده‌های عملیاتی"
              value={operationalBlocked ? operationalSyncBlockLabel("blocked") : LABEL[state.sync]}
              detail={
                operationalBlocked
                  ? `${block.consecutiveBlockedTicks.toLocaleString("fa-IR")} تلاش پشت سر هم بدون همگام‌سازی عملیاتی`
                  : state.lastConvergedAt
                    ? `آخرین همگرایی: ${new Date(state.lastConvergedAt).toLocaleString("fa-IR")}`
                    : "هنوز همگرا نشده"
              }
              healthy={state.sync === "connected" && !operationalBlocked}
            />
          </dl>
          {operationalBlocked ? (
            <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-6 text-amber-900 dark:text-amber-200">
              {operationalSyncBlockedSummary({
                since: block.blockedSince ? new Date(block.blockedSince).toLocaleString("fa-IR") : null,
                pendingOutbox: block.pendingOutbox ?? 0,
                code: isIamFailureCode(block.code) ? block.code : null,
              })}
              {` «همگام‌سازی دوباره» را بزنید.`}
            </p>
          ) : null}
          {credentials && credentials.pinMembersMissing > 0 ? (
            <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              {`${credentials.pinMembersMissing.toLocaleString("fa-IR")} حساب پین‌دار (صندوق‌دار، گارسون، آشپزخانه) هنوز روی این دستگاه قابل ورود نیست.`}
              {credentials.lastError ? <span title={credentials.lastError}> — آخرین خطا ثبت شده است.</span> : null}
            </p>
          ) : null}
          {credentials && credentials.missingIdentityBindings > 0 ? (
            <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              {`${credentials.missingIdentityBindings.toLocaleString("fa-IR")} حساب مدیریتی/کارشناسی هنوز هویت جهانی متصل ندارند؛ «ورود با حساب ابری» فقط برای اعضایی ممکن است که هویتشان همگام شده باشد.`}
            </p>
          ) : null}
          {(credentials?.identityMismatches ?? 0) > 0 ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              {`${(credentials?.identityMismatches ?? 0).toLocaleString("fa-IR")} پیوند هویت پس از آخرین همگام‌سازی هنوز درست نیست (یا تداخل ایمیل دارد). «همگام‌سازی دوباره» را بزنید؛ در صورت تداوم، پشتیبانی باید بررسی کند.`}
            </p>
          ) : null}
          {(credentials?.identitiesRekeyed ?? 0) > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {`آخرین همگام‌سازی ${(credentials?.identitiesRekeyed ?? 0).toLocaleString("fa-IR")} هویت قدیمی را به شناسهٔ جهانی ابر منتقل کرد.`}
            </p>
          ) : null}
          {repairMessage ? <p className="mt-3 text-xs text-muted-foreground">{repairMessage}</p> : null}
        </section>
      ) : null}

      <section className={`${cardClass} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-foreground">{local ? "تبدیل به حالت هیبرید (اختیاری)" : "وضعیت داده‌ها"}</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {local
                ? "این دستگاه در حالت «تمام‌آفلاین (محلی)» قرار دارد و بدون همگام‌سازی تراکنش‌ها کار می‌کند. در صورت تمایل به تبدیل به حالت ترکیبی (هیبرید)، این فرآیند فقط با هماهنگی و بررسی سازگاری داده‌ها انجام می‌شود."
                : `آخرین همگرایی دوطرفه: ${state.lastConvergedAt ? new Date(state.lastConvergedAt).toLocaleString("fa-IR") : "هنوز انجام نشده"}`}
            </p>
            {!local ? (
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {`تنظیمات شعبه از ابر: ${state.siteProfile?.appliedAt ? new Date(state.siteProfile.appliedAt).toLocaleString("fa-IR") : "هنوز دریافت نشده"}`}
                {state.siteProfile?.lastError ? (
                  <span title={state.siteProfile.lastError}> — دریافت تنظیمات شعبه از ابر ناموفق بود</span>
                ) : null}
              </p>
            ) : null}
          </div>
          {local ? (
            <Button asChild><Link href="/support"><CloudIcon className="size-4" /> درخواست تبدیل امن</Link></Button>
          ) : (
            <Button variant="outline" onClick={() => window.dispatchEvent(new Event("online"))}><RefreshCwIcon className="size-4" /> به‌روزرسانی</Button>
          )}
        </div>
        {!local ? (
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-5">
            <Metric label="خروجی در انتظار" value={state.outboundPending} />
            <Metric label="ورودی در انتظار" value={state.inboundPending} />
            <Metric label="در انتظار پیش‌نیاز" value={state.deferred} />
            <Metric label="تعارض" value={state.conflicts} />
            <Metric label="نیازمند بررسی" value={state.deadLetters} />
          </dl>
        ) : null}
      </section>

      <section className={`${cardClass} p-5`}>
        <div className="flex items-center gap-2"><DatabaseIcon className="size-5 text-muted-foreground" /><h3 className="font-bold">دامنه‌های داده</h3></div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {local
            ? "در حالت تمام‌آفلاین: مشخصات رسمی کسب‌وکار، اشتراک، مجوزها و سیاست امنیتی به‌صورت خودکار و یک‌طرفه از سرور ابری به‌روزرسانی می‌شوند؛ اما سفارش‌ها، پرداخت‌ها، حسابداری، انبار، منو، مشتریان، چاپگرها و پشتیبان‌ها کاملاً محلی روی همین دستگاه باقی می‌مانند."
            : "صندوق، میزها، آشپزخانه و شیفت روی این دستگاه کار می‌کنند و با برگشت اینترنت به ابر فرستاده می‌شوند. حسابداری، گزارش‌ها، انبار، مشتریان و تنظیمات کسب‌وکار در نسخهٔ ابری‌اند؛ مسیر پشتیبان و چاپگر فقط روی این دستگاه می‌مانند."}
        </p>
      </section>
    </div>
  );
}
function StatusCard({ icon: Icon, title, value }: { icon: typeof CloudIcon; title: string; value: string }) {
  return <div className={`${cardClass} p-4`}><Icon className="size-5 text-amber-700 dark:text-amber-300" /><p className="mt-3 text-xs text-muted-foreground">{title}</p><p className="mt-1 font-semibold">{value}</p></div>;
}
function IdentityRow({ icon: Icon, label, value, detail, healthy }: { icon: typeof CloudIcon; label: string; value: string; detail: string; healthy: boolean }) {
  return (
    <div className="rounded-lg bg-muted p-3">
      <dt className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-4" aria-hidden="true" />{label}</dt>
      <dd className="mt-1 font-semibold">
        <span className={healthy ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}>{value}</span>
      </dd>
      <dd className="mt-1 text-xs text-muted-foreground">{detail}</dd>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-lg bg-muted p-3"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-bold">{value.toLocaleString("fa-IR")}</dd></div>; }
