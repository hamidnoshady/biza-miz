"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import { Switch } from "@/components/ui/switch";
import { RecoveryCodeSheet, TENANT_MFA_THEME, type MfaMethod } from "@/components/auth/mfa-step";
import { toPersianDigits } from "@/lib/digits";

interface SelfMfaStatus {
  methods: Array<MfaMethod | { method: MfaMethod; isPrimary?: boolean; phoneHint?: string | null }>;
  methodNames?: MfaMethod[];
  pendingMethods?: MfaMethod[];
  primaryMethod: MfaMethod | null;
  phone: string | null;
  requireForManagers: boolean;
  graceDaysLeft: number | null;
  unusedRecoveryCodes: number;
  recoveryCodesRemaining?: number;
  recentAuth?: boolean;
}

interface EnrolResult {
  status?: string;
  method?: MfaMethod;
  totpSecret?: string | null;
  totpQr?: string | null;
  phone?: string | null;
  maskedPhone?: string | null;
  recoveryCodes?: string[];
  error?: string;
  message?: string;
}

function selfErrorMessage(code: string | undefined, fallbackMessage?: string): string {
  if (fallbackMessage) return fallbackMessage;
  const map: Record<string, string> = {
    invalid_action: "درخواست نامعتبر است.",
    invalid_method: "روش انتخاب‌شده معتبر نیست.",
    invalid_phone: "شمارهٔ موبایل معتبر نیست.",
    invalid_code: "کد ۶ رقمی واردشده نادرست است.",
    missing_code: "کد ۶ رقمی تأیید را وارد کنید.",
    already_enrolled: "این روش قبلاً فعال شده است.",
    not_enrolled: "این روش هنوز ثبت نشده است.",
    sms_dispatch_failed: "ارسال پیامک تأیید ممکن نشد. کمی بعد دوباره تلاش کنید.",
    rate_limited: "تعداد درخواست‌ها بیش از حد مجاز است؛ کمی صبر کنید.",
    cannot_remove_last_factor:
      "ورود دومرحله‌ای برای نقش شما اجباری است؛ پیش از حذف این روش، روش دیگری را فعال کنید.",
    recent_auth_required:
      "برای انجام این تغییر امنیتی، ابتدا هویت خود را مجدداً تأیید کنید.",
    forbidden: "فقط مالک کسب‌وکار می‌تواند این سیاست را تغییر دهد.",
  };
  return (code && map[code]) || "خطای غیرمنتظره. دوباره تلاش کنید.";
}

export function TwoFactorSettings({
  isOwner,
  scope = "personal",
}: {
  isOwner: boolean;
  scope?: "personal" | "policy";
}) {
  const [status, setStatus] = useState<SelfMfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [smsFormOpen, setSmsFormOpen] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [pendingSetup, setPendingSetup] = useState<EnrolResult | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [shownCodes, setShownCodes] = useState<string[]>([]);

  // Step-up authentication state when `recent_auth_required` is returned
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [stepUpMfaCode, setStepUpMfaCode] = useState("");
  const [pendingAction, setPendingAction] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<SelfMfaStatus & { error?: string }>(
      "/api/auth/mfa/self",
    );
    if (ok) {
      setStatus(data);
    } else {
      setError(selfErrorMessage(data.error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>): Promise<EnrolResult | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status: httpStatus, data } = await api<EnrolResult>("/api/auth/mfa/self", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      if (httpStatus === 403 && data.error === "recent_auth_required") {
        setPendingAction(body);
        setStepUpOpen(true);
        return null;
      }
      setError(selfErrorMessage(data.error, data.message));
      return null;
    }
    await load();
    return data;
  }

  async function submitStepUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api<{ ok?: boolean; error?: string }>("/api/auth/step-up", {
      method: "POST",
      body: JSON.stringify({
        password: stepUpPassword || undefined,
        mfaCode: stepUpMfaCode.trim() || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("تأیید مجدد هویت ناموفق بود؛ رمز عبور یا کد دومرحله‌ای را بررسی کنید.");
      return;
    }
    setStepUpOpen(false);
    setStepUpPassword("");
    setStepUpMfaCode("");
    const retry = pendingAction;
    setPendingAction(null);
    if (retry) {
      const data = await act(retry);
      if (data) handleActionSuccess(retry, data);
    } else {
      await load();
    }
  }

  function handleActionSuccess(body: Record<string, unknown>, data: EnrolResult) {
    if (body.action === "enrol") {
      setPendingSetup(data);
      setConfirmCode("");
      setSmsFormOpen(false);
    } else if (body.action === "confirm") {
      setPendingSetup(null);
      setConfirmCode("");
      if (data.recoveryCodes?.length) {
        setShownCodes(data.recoveryCodes);
      }
      setNotice("روش دومرحله‌ای با موفقیت تأیید و فعال شد.");
    } else if (body.action === "regenerate_recovery_codes" && data.recoveryCodes?.length) {
      setShownCodes(data.recoveryCodes);
      setNotice("کدهای بازیابی جدید صادر شدند.");
    } else if (body.action === "set_primary") {
      setNotice("روش اصلی ورود دومرحله‌ای تغییر کرد.");
    }
  }

  async function startTotp() {
    setShownCodes([]);
    const data = await act({ action: "enrol", method: "totp" });
    if (data) handleActionSuccess({ action: "enrol", method: "totp" }, data);
  }

  async function startSms(e: React.FormEvent) {
    e.preventDefault();
    setShownCodes([]);
    const body = { action: "enrol", method: "sms_otp", phone: phoneInput };
    const data = await act(body);
    if (data) handleActionSuccess(body, data);
  }

  async function confirmFactor(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingSetup?.method) return;
    const body = {
      action: "confirm",
      method: pendingSetup.method,
      code: confirmCode.trim(),
    };
    const data = await act(body);
    if (data) handleActionSuccess(body, data);
  }

  async function resendSmsChallenge() {
    const data = await act({ action: "resend_challenge", method: "sms_otp" });
    if (data) {
      setNotice("کد تأیید پیامکی مجدداً ارسال شد.");
    }
  }

  async function removeMethod(method: MfaMethod) {
    setPendingSetup(null);
    setShownCodes([]);
    await act({ action: "remove", method });
  }

  async function makePrimary(method: MfaMethod) {
    const body = { action: "set_primary", method };
    const data = await act(body);
    if (data) handleActionSuccess(body, data);
  }

  async function regenerateCodes() {
    setPendingSetup(null);
    const body = { action: "regenerate_recovery_codes" };
    const data = await act(body);
    if (data) handleActionSuccess(body, data);
  }

  async function toggleManagers(next: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string }>("/api/settings/mfa-policy", {
      method: "PUT",
      body: JSON.stringify({ requireForManagers: next }),
    });
    setBusy(false);
    if (!ok) {
      setError(selfErrorMessage(data.error));
      return;
    }
    await load();
  }

  if (scope === "policy") {
    return (
      <SectionCard
        title="سیاست ورود دومرحله‌ای کسب‌وکار"
        description="تنظیم سیاست اجباری‌شدن ورود دومرحله‌ای برای مدیران کسب‌وکار. تنظیمات روش‌های دومرحله‌ای شخصی هر کاربر در بخش «حساب کاربری من» قرار دارد."
      >
        <ErrorBox>{error}</ErrorBox>
        {!status ? (
          <LoadingSkeleton rows={2} />
        ) : (
          <div className="space-y-4">
            {isOwner ? (
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
                <div>
                  <p className="text-sm font-semibold">الزام ورود دومرحله‌ای برای مدیران</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    برای مالک همیشه اجباری است. با روشن‌کردن این گزینه، مدیران کسب‌وکار نیز موظف به
                    تأیید دومرحله‌ای هنگام ورود خواهند بود.
                  </p>
                </div>
                <Switch
                  checked={status.requireForManagers}
                  disabled={busy}
                  onCheckedChange={toggleManagers}
                />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/30 p-4 text-xs">
              <div>
                <p className="font-semibold text-foreground">ورود دومرحله‌ای و امنیت حساب شخصی شما</p>
                <p className="mt-1 text-muted-foreground">
                  فعال‌سازی برنامهٔ رمزساز، پیامک دومرحله‌ای، کدهای بازیابی، تغییر رمز عبور و نشست‌های
                  فعال حساب خودتان در صفحهٔ حساب کاربری مدیریت می‌شوند.
                </p>
              </div>
              <Link
                href="/settings/profile"
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted"
              >
                مدیریت حساب کاربری من
              </Link>
            </div>
          </div>
        )}
      </SectionCard>
    );
  }

  const activeMethodNames: MfaMethod[] =
    status?.methodNames ??
    (status?.methods.map((m) => (typeof m === "string" ? m : m.method)) ?? []);
  const hasTotp = activeMethodNames.includes("totp");
  const hasSms = activeMethodNames.includes("sms_otp");
  const pendingTotp = status?.pendingMethods?.includes("totp") ?? false;
  const pendingSms = status?.pendingMethods?.includes("sms_otp") ?? false;
  const anyEnrolled = hasTotp || hasSms;

  return (
    <SectionCard
      title="ورود دومرحله‌ای حساب من"
      description="یک کد ۶ رقمی علاوه بر رمز عبور هنگام ورود. هر روش تنها پس از تأیید کد ۶ رقمی فعال می‌شود."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {stepUpOpen ? (
        <form
          onSubmit={submitStepUp}
          className="mb-4 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
        >
          <p className="text-sm font-semibold text-foreground">
            تأیید مجدد هویت برای تغییر تنظیمات امنیتی
          </p>
          <p className="text-xs text-muted-foreground">
            برای افزودن، حذف یا تغییر روش‌های دومرحله‌ای، رمز عبور فعلی یا کد دومرحله‌ای خود را وارد کنید.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="رمز عبور فعلی">
              <input
                type="password"
                dir="ltr"
                value={stepUpPassword}
                onChange={(e) => setStepUpPassword(e.target.value)}
                className={inputClass}
              />
            </Field>
            {anyEnrolled ? (
              <Field label="یا کد دومرحله‌ای فعلی">
                <input
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={6}
                  value={stepUpMfaCode}
                  onChange={(e) => setStepUpMfaCode(e.target.value)}
                  className={inputClass}
                />
              </Field>
            ) : null}
          </div>
          <div className="flex gap-2">
            <PrimaryButton
              type="submit"
              disabled={busy || (!stepUpPassword && !stepUpMfaCode.trim())}
            >
              تأیید و ادامه
            </PrimaryButton>
            <SecondaryButton
              onClick={() => {
                setStepUpOpen(false);
                setPendingAction(null);
              }}
            >
              انصراف
            </SecondaryButton>
          </div>
        </form>
      ) : null}

      {!status ? (
        <LoadingSkeleton rows={3} />
      ) : (
        <div className="space-y-4">
          {!anyEnrolled && status.graceDaysLeft !== null ? (
            <InfoBox>
              حساب شما هنوز ورود دومرحله‌ای تاییدشده ندارد؛{" "}
              {status.graceDaysLeft <= 0
                ? "مهلت فعال‌سازی تمام شده است."
                : `${toPersianDigits(String(status.graceDaysLeft))} روز تا اجباری‌شدن باقی مانده است.`}
            </InfoBox>
          ) : null}

          {/* TOTP row */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold">
                  برنامهٔ رمزساز (Google Authenticator)
                </p>
                {hasTotp && status.primaryMethod === "totp" ? (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    روش اصلی
                  </span>
                ) : null}
                {!hasTotp && pendingTotp ? (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                    در انتظار تأیید کد
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {hasTotp
                  ? "فعال — بدون نیاز به اینترنت و پیامک کار می‌کند."
                  : "توصیه‌شده؛ روی نصب محلی و بدون اینترنت هم همیشه کار می‌کند."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {hasTotp && status.primaryMethod !== "totp" ? (
                <SecondaryButton onClick={() => void makePrimary("totp")} disabled={busy}>
                  انتخاب به‌عنوان روش اصلی
                </SecondaryButton>
              ) : null}
              {hasTotp ? (
                <SecondaryButton
                  onClick={() => void removeMethod("totp")}
                  disabled={busy}
                >
                  حذف
                </SecondaryButton>
              ) : (
                <PrimaryButton onClick={() => void startTotp()} disabled={busy}>
                  {pendingTotp ? "ادامهٔ فعال‌سازی" : "فعال‌سازی"}
                </PrimaryButton>
              )}
            </div>
          </div>

          {/* Pending TOTP confirmation */}
          {pendingSetup?.method === "totp" ? (
            <form
              onSubmit={confirmFactor}
              className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
            >
              <p className="text-sm font-semibold">
                گام ۲: اسکن کد QR و وارد کردن کد ۶ رقمی برای تأیید نهایی
              </p>
              <p className="text-xs text-muted-foreground">
                تا زمانی که یک کد ۶ رقمی معتبر از برنامهٔ رمزساز وارد نکنید، این روش فعال نمی‌شود.
              </p>
              {pendingSetup.totpQr ? (
                <div className="flex justify-center">
                  <img
                    src={pendingSetup.totpQr}
                    alt="کد QR ورود دومرحله‌ای"
                    className="size-44 rounded-lg bg-white p-2"
                  />
                </div>
              ) : null}
              {pendingSetup.totpSecret ? (
                <p
                  dir="ltr"
                  className="rounded-lg border border-input bg-muted/50 px-3 py-2 font-mono text-xs tracking-wider"
                >
                  {pendingSetup.totpSecret}
                </p>
              ) : null}
              <Field label="کد ۶ رقمی برنامهٔ رمزساز">
                <input
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  placeholder="123456"
                  className={inputClass}
                />
              </Field>
              <div className="flex gap-2">
                <PrimaryButton
                  type="submit"
                  disabled={busy || confirmCode.trim().length < 6}
                >
                  تأیید و فعال‌سازی نهایی
                </PrimaryButton>
                <SecondaryButton
                  onClick={() => {
                    setPendingSetup(null);
                    setConfirmCode("");
                  }}
                >
                  انصراف
                </SecondaryButton>
              </div>
            </form>
          ) : null}

          {/* SMS row */}
          <div className="space-y-3 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">پیامک یک‌بارمصرف</p>
                  {hasSms && status.primaryMethod === "sms_otp" ? (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                      روش اصلی
                    </span>
                  ) : null}
                  {!hasSms && pendingSms ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                      در انتظار تأیید کد پیامکی
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {hasSms && status.phone
                    ? `فعال — ارسال به ${toPersianDigits(status.phone)}`
                    : "ارسال کد ۶ رقمی به شمارهٔ موبایل شما در هر ورود با رمز عبور."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {hasSms && status.primaryMethod !== "sms_otp" ? (
                  <SecondaryButton onClick={() => void makePrimary("sms_otp")} disabled={busy}>
                    انتخاب به‌عنوان روش اصلی
                  </SecondaryButton>
                ) : null}
                {hasSms ? (
                  <SecondaryButton
                    onClick={() => void removeMethod("sms_otp")}
                    disabled={busy}
                  >
                    حذف
                  </SecondaryButton>
                ) : (
                  <SecondaryButton
                    onClick={() => {
                      setSmsFormOpen((v) => !v);
                      setPhoneInput(status.phone ?? "");
                    }}
                    disabled={busy}
                  >
                    {pendingSms ? "ادامهٔ تأیید پیامکی" : "فعال‌سازی"}
                  </SecondaryButton>
                )}
              </div>
            </div>

            {smsFormOpen && !hasSms ? (
              <form onSubmit={startSms} className="flex flex-wrap items-end gap-2 pt-2">
                <div className="min-w-56 flex-1">
                  <Field label="شمارهٔ موبایل">
                    <input
                      dir="ltr"
                      inputMode="tel"
                      required
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder="09121234567"
                      className={inputClass}
                    />
                  </Field>
                </div>
                <PrimaryButton type="submit" disabled={busy}>
                  ارسال کد تأیید پیامکی
                </PrimaryButton>
              </form>
            ) : null}

            {pendingSetup?.method === "sms_otp" ? (
              <form
                onSubmit={confirmFactor}
                className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3"
              >
                <p className="text-xs font-semibold">
                  کد ۶ رقمی ارسال‌شده به{" "}
                  {toPersianDigits(pendingSetup.maskedPhone ?? pendingSetup.phone ?? "")} را برای
                  تأیید نهایی وارد کنید:
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-44 flex-1">
                    <input
                      dir="ltr"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      value={confirmCode}
                      onChange={(e) => setConfirmCode(e.target.value)}
                      placeholder="123456"
                      className={inputClass}
                    />
                  </div>
                  <PrimaryButton
                    type="submit"
                    disabled={busy || confirmCode.trim().length < 6}
                  >
                    تأیید شماره و فعال‌سازی
                  </PrimaryButton>
                  <SecondaryButton
                    onClick={() => void resendSmsChallenge()}
                    disabled={busy}
                  >
                    ارسال مجدد کد
                  </SecondaryButton>
                </div>
              </form>
            ) : null}
          </div>

          {/* Recovery codes */}
          {anyEnrolled ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
              <div>
                <p className="text-sm font-semibold">کدهای بازیابی یک‌بارمصرف</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {toPersianDigits(String(status.unusedRecoveryCodes))} کد استفاده‌نشده باقی مانده
                  است. ساخت کدهای تازه، کدهای قبلی را باطل می‌کند.
                </p>
              </div>
              <SecondaryButton onClick={() => void regenerateCodes()} disabled={busy}>
                ساخت کدهای جدید
              </SecondaryButton>
            </div>
          ) : null}

          {shownCodes.length > 0 ? (
            <RecoveryCodeSheet codes={shownCodes} theme={TENANT_MFA_THEME} />
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
