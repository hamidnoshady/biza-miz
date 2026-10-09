"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  smsChallengeExpiryMessage,
  useNowTick,
  useResendCooldown,
} from "@/components/auth/use-resend-cooldown";
import { SecurityConfirmDialog } from "@/components/auth/security-confirm-dialog";
import {
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  api,
  errorMessage,
  fmtDate,
  inputClass,
} from "../ui";
import {
  PLATFORM_MFA_THEME,
  RecoveryCodeSheet,
  type MfaMethod,
} from "@/components/auth/mfa-step";
import { toPersianDigits } from "@/lib/digits";
import { PLATFORM_ROLE_LABELS, type PlatformAdminRole } from "@/lib/platform-admin";

interface PlatformMeResponse {
  id: string;
  email: string;
  fullName: string;
  role: string;
}

export default function PlatformAccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<PlatformMeResponse | null>(null);

  useEffect(() => {
    void api<{ admin?: PlatformMeResponse }>("/api/platform/auth/me").then(
      ({ ok, data }) => {
        if (ok && data.admin) setMe(data.admin);
      },
    );
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">حساب کاربری و امنیت من</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          مدیریت رمز عبور، ورود دومرحله‌ای، کدهای بازیابی و نشست‌های فعال شما در کنسول مدیریت سکو.
        </p>
      </header>

      {me ? (
        <Card title="مشخصات حساب سکو">
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">نام</p>
              <p className="mt-1 font-semibold">{me.fullName}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">ایمیل</p>
              <p dir="ltr" className="mt-1 font-mono text-xs">
                {me.email}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">نقش سکو</p>
              <p className="mt-1 font-semibold">
                {PLATFORM_ROLE_LABELS[me.role as PlatformAdminRole] ?? me.role}
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <PlatformSelfPasswordSection />
      <PlatformSelfMfaSection />
      <PlatformSelfSessionsSection
        onSignedOutEverywhere={() => {
          router.push("/platform/login");
          router.refresh();
        }}
      />
    </div>
  );
}

function PlatformSelfPasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const lengthOk = newPassword.length >= 8;
  const matchOk = newPassword.length > 0 && newPassword === confirmPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!lengthOk) {
      setError("رمز عبور جدید باید حداقل ۸ نویسه باشد.");
      return;
    }
    if (!matchOk) {
      setError("تکرار رمز عبور جدید با رمز جدید یکسان نیست.");
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ ok?: boolean; error?: string }>(
      "/api/platform/auth/password",
      {
        method: "POST",
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      const map: Record<string, string> = {
        missing_current_password: "رمز عبور فعلی را وارد کنید.",
        invalid_current_password: "رمز عبور فعلی نادرست است.",
        password_confirmation_mismatch: "تکرار رمز عبور جدید با رمز جدید یکسان نیست.",
        password_unchanged: "رمز عبور جدید باید با رمز فعلی متفاوت باشد.",
        password_too_short: "رمز عبور جدید باید حداقل ۸ نویسه باشد.",
      };
      setError((data.error && map[data.error]) || errorMessage(data.error));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setNotice(
      "رمز عبور حساب سکو با موفقیت تغییر یافت و سایر نشست‌های فعال بسته شدند.",
    );
  }

  return (
    <Card title="تغییر رمز عبور حساب سکو">
      <p className="mb-4 text-xs text-muted-foreground">
        با تغییر رمز عبور، نسخهٔ توکن شما افزایش یافته و سایر نشست‌های باز بلافاصله باطل می‌شوند.
      </p>
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>
      <form onSubmit={submit} className="space-y-4">
        <Field label="رمز عبور فعلی">
          <input
            type="password"
            dir="ltr"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className={inputClass}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="رمز عبور جدید (حداقل ۸ نویسه)">
            <input
              type="password"
              dir="ltr"
              required
              minLength={8}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="تکرار رمز عبور جدید">
            <input
              type="password"
              dir="ltr"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={busy || !currentPassword || !lengthOk || !matchOk}
          >
            {busy ? "در حال ذخیره…" : "تغییر رمز عبور"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

interface PlatformSelfMfa {
  methods: MfaMethod[];
  pendingMethods?: MfaMethod[];
  primaryMethod: MfaMethod | null;
  phone: string | null;
  graceDaysLeft: number | null;
  unusedRecoveryCodes: number;
  recentAuth?: boolean;
  smsChallengeRequestedAt?: string | null;
  smsChallengeExpiresAt?: string | null;
  /** Issue #854 (P2.21) — the number a reloaded fresh enrolment is proving. */
  pendingSmsPhone?: string | null;
}

interface PlatformEnrolResult {
  status?: string;
  method?: MfaMethod;
  totpSecret?: string | null;
  totpQr?: string | null;
  phone?: string | null;
  maskedPhone?: string | null;
  recoveryCodes?: string[];
  error?: string;
  message?: string;
  retryAfterMs?: number;
}

function PlatformSelfMfaSection() {
  const [status, setStatus] = useState<PlatformSelfMfa | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [smsOpen, setSmsOpen] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [pendingSetup, setPendingSetup] = useState<PlatformEnrolResult | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [shownCodes, setShownCodes] = useState<string[]>([]);

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [stepUpMfaCode, setStepUpMfaCode] = useState("");
  const [pendingAction, setPendingAction] = useState<Record<string, unknown> | null>(null);

  /**
   * Issue #854 (P2.25) — live countdown of the server's 60-second resend
   * cooldown, seeded from the challenge's actual request time so a reload
   * mid-window shows the honest remaining seconds instead of a fresh 60.
   */
  const {
    waitSeconds: resendWait,
    coolingDown,
    seedFromRequestedAt,
    start: startCooldown,
    applyRetryAfterMs,
    clear: clearCooldown,
  } = useResendCooldown(60);
  const nowTick = useNowTick(
    pendingSetup?.method === "sms_otp" && Boolean(status?.smsChallengeExpiresAt),
  );

  /** Issue #854 (P2.26) — destructive mutations wait behind a confirmation. */
  const [confirmAction, setConfirmAction] = useState<
    { kind: "remove"; method: MfaMethod } | { kind: "regenerate_codes" } | null
  >(null);

  /** Issue #854 (P2.21) — the replacement's own confirmation before the swap. */
  const [replaceConfirm, setReplaceConfirm] = useState<{
    method: MfaMethod;
    code: string;
    phone: string;
  } | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<PlatformSelfMfa & { error?: string }>(
      "/api/platform/mfa",
    );
    if (ok) {
      setStatus(data);
      seedFromRequestedAt(data.smsChallengeRequestedAt);
      /**
       * Issue #854 (P2.21) — resume a fresh-enrolment ceremony a reload left
       * mid-flight; a replacement stages no row and is started again instead.
       */
      if (data.pendingMethods?.includes("sms_otp") && data.pendingSmsPhone) {
        setPendingSetup((current) =>
          current ?? {
            method: "sms_otp",
            status: "pending_confirmation",
            phone: data.pendingSmsPhone ?? null,
            maskedPhone: data.phone ?? null,
          },
        );
      }
    } else setError(errorMessage(data.error));
  }, [seedFromRequestedAt]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>): Promise<PlatformEnrolResult | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status: httpStatus, data } = await api<PlatformEnrolResult>(
      "/api/platform/mfa",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!ok) {
      if (httpStatus === 403 && data.error === "recent_auth_required") {
        setPendingAction(body);
        setStepUpOpen(true);
        return null;
      }
      // Issue #854 (P2.25) — the limiter's own answer drives the countdown.
      if (httpStatus === 429) applyRetryAfterMs(data.retryAfterMs);
      setError(data.message || errorMessage(data.error));
      return null;
    }
    await load();
    return data;
  }

  function handleActionSuccess(body: Record<string, unknown>, data: PlatformEnrolResult) {
    if (body.action === "enrol") {
      setPendingSetup(data);
      setConfirmCode("");
      setSmsOpen(false);
      if (body.method === "sms_otp") startCooldown();
    } else if (body.action === "confirm") {
      setPendingSetup(null);
      setConfirmCode("");
      clearCooldown();
      if (data.recoveryCodes?.length) {
        setShownCodes(data.recoveryCodes);
      }
      setNotice("روش دومرحله‌ای با موفقیت تأیید و فعال شد.");
    } else if (body.action === "resend_challenge") {
      startCooldown();
    } else if (body.action === "regenerate_recovery_codes" && data.recoveryCodes?.length) {
      setShownCodes(data.recoveryCodes);
      setNotice("کدهای بازیابی جدید صادر شدند.");
    } else if (body.action === "set_primary") {
      setNotice("روش اصلی ورود دومرحله‌ای تغییر کرد.");
    }
  }

  /** Cancel the SMS ceremony in flight. Cancellation sends no mutation. */
  function cancelSmsCeremony() {
    setPendingSetup(null);
    setConfirmCode("");
    setSmsOpen(false);
    clearCooldown();
  }

  /** Issue #854 (P2.21 + P2.26) — the confirmed atomic swap. */
  async function submitReplaceConfirm() {
    if (!replaceConfirm) return;
    const body = {
      action: "confirm",
      method: replaceConfirm.method,
      code: replaceConfirm.code,
      phone: replaceConfirm.phone,
    };
    setReplaceConfirm(null);
    const data = await act(body);
    if (data) {
      handleActionSuccess(body, data);
      setNotice("شمارهٔ دریافت کد پیامکی با موفقیت جایگزین شد.");
    }
  }

  async function executeRemove(method: MfaMethod) {
    setConfirmAction(null);
    setPendingSetup(null);
    setShownCodes([]);
    await act({ action: "remove", method });
  }

  async function executeRegenerateCodes() {
    setConfirmAction(null);
    setPendingSetup(null);
    const body = { action: "regenerate_recovery_codes" };
    const data = await act(body);
    if (data) handleActionSuccess(body, data);
  }

  async function submitStepUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok } = await api("/api/platform/auth/step-up", {
      method: "POST",
      body: JSON.stringify({
        password: stepUpPassword || undefined,
        mfaCode: stepUpMfaCode.trim() || undefined,
      }),
    });
    setBusy(false);
    if (!ok) {
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

  const hasTotp = status?.methods.includes("totp") ?? false;
  const hasSms = status?.methods.includes("sms_otp") ?? false;
  const pendingTotp = status?.pendingMethods?.includes("totp") ?? false;
  const pendingSms = status?.pendingMethods?.includes("sms_otp") ?? false;
  const anyEnrolled = hasTotp || hasSms;
  /** Issue #854 (P2.21) — replacement mode (see the tenant card for notes). */
  const replacingSms = hasSms && pendingSetup?.method === "sms_otp";

  return (
    <Card title="ورود دومرحله‌ای حساب من">
      <p className="mb-4 text-xs text-muted-foreground">
        برای همهٔ حساب‌های مدیریت سکو اجباری است. هر روش تنها پس از تأیید کد ۶ رقمی فعال می‌شود.
      </p>
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      {stepUpOpen ? (
        <form
          onSubmit={submitStepUp}
          className="mb-4 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
        >
          <p className="text-sm font-semibold">تأیید مجدد هویت</p>
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
            <Button
              type="submit"
              disabled={busy || (!stepUpPassword && !stepUpMfaCode.trim())}
            >
              تأیید و ادامه
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setStepUpOpen(false);
                setPendingAction(null);
              }}
            >
              انصراف
            </Button>
          </div>
        </form>
      ) : null}

      {!status ? (
        <SkeletonRows rows={2} />
      ) : (
        <div className="space-y-3">
          {!anyEnrolled && status.graceDaysLeft !== null ? (
            <InfoBox>
              حساب شما هنوز ورود دومرحله‌ای تأییدشده ندارد؛{" "}
              {status.graceDaysLeft <= 0
                ? "مهلت فعال‌سازی تمام شده است."
                : `${toPersianDigits(String(status.graceDaysLeft))} روز تا اجباری‌شدن باقی مانده است.`}
            </InfoBox>
          ) : null}

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
                {hasTotp ? "فعال." : "توصیه‌شده؛ بدون وابستگی به پیامک کار می‌کند."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {hasTotp && status.primaryMethod !== "totp" ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    const body = { action: "set_primary", method: "totp" };
                    void act(body).then((d) => d && handleActionSuccess(body, d));
                  }}
                  disabled={busy}
                >
                  انتخاب به‌عنوان روش اصلی
                </Button>
              ) : null}
              {hasTotp ? (
                <Button
                  variant="ghost"
                  onClick={() => setConfirmAction({ kind: "remove", method: "totp" })}
                  disabled={busy}
                >
                  حذف
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    const body = { action: "enrol", method: "totp" };
                    void act(body).then((d) => d && handleActionSuccess(body, d));
                  }}
                  disabled={busy}
                >
                  {pendingTotp ? "ادامهٔ فعال‌سازی" : "فعال‌سازی"}
                </Button>
              )}
            </div>
          </div>

          {pendingSetup?.method === "totp" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const body = {
                  action: "confirm",
                  method: "totp",
                  code: confirmCode.trim(),
                };
                void act(body).then((d) => d && handleActionSuccess(body, d));
              }}
              className="space-y-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4"
            >
              <p className="text-sm font-semibold">
                گام ۲: اسکن کد QR و وارد کردن کد ۶ رقمی برای تأیید نهایی
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
                  className="rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs tracking-wider"
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
                <Button
                  type="submit"
                  disabled={busy || confirmCode.trim().length < 6}
                >
                  تأیید و فعال‌سازی نهایی
                </Button>
                <Button variant="ghost" onClick={() => setPendingSetup(null)}>
                  انصراف
                </Button>
              </div>
            </form>
          ) : null}

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
                  {pendingSms || replacingSms ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                      در انتظار تأیید کد پیامکی
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {hasSms && status.phone
                    ? `فعال — ارسال به ${toPersianDigits(status.phone)}`
                    : "ارسال کد ۶ رقمی به شمارهٔ موبایل در هر ورود."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {hasSms && status.primaryMethod !== "sms_otp" ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const body = { action: "set_primary", method: "sms_otp" };
                      void act(body).then((d) => d && handleActionSuccess(body, d));
                    }}
                    disabled={busy}
                  >
                    انتخاب به‌عنوان روش اصلی
                  </Button>
                ) : null}
                {hasSms ? (
                  <>
                    {/* Issue #854 (P2.21) — replacement entry for admins too. */}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setSmsOpen((v) => !v);
                        setPhoneInput("");
                      }}
                      disabled={busy || replacingSms}
                    >
                      تغییر شمارهٔ دریافت
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmAction({ kind: "remove", method: "sms_otp" })}
                      disabled={busy}
                    >
                      حذف
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSmsOpen((v) => !v);
                      setPhoneInput(status.phone ?? "");
                    }}
                    disabled={busy}
                  >
                    {pendingSms ? "ادامهٔ تأیید پیامکی" : "فعال‌سازی"}
                  </Button>
                )}
              </div>
            </div>

            {smsOpen && !replacingSms ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const body = {
                    action: "enrol",
                    method: "sms_otp",
                    phone: phoneInput,
                  };
                  void act(body).then((d) => d && handleActionSuccess(body, d));
                }}
                className="flex flex-wrap items-end gap-2 pt-2"
              >
                <div className="min-w-56 flex-1">
                  <Field label={hasSms ? "شمارهٔ جدید برای دریافت کدها" : "شمارهٔ موبایل"}>
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
                <Button type="submit" disabled={busy}>
                  ارسال کد تأیید پیامکی
                </Button>
              </form>
            ) : null}
            {hasSms && !replacingSms ? (
              <p className="text-xs text-muted-foreground">
                برای تغییر شماره، شمارهٔ جدید را وارد کنید؛ کد تأیید به شمارهٔ تازه می‌رود و تا
                تأیید نهایی، همین شمارهٔ فعلی فعال می‌ماند.
              </p>
            ) : null}

            {pendingSetup?.method === "sms_otp" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  /**
                   * Issue #854 (P2.21 + P2.26) — naming the number binds the
                   * redemption to it; with a confirmed factor present the same
                   * request is the atomic swap, gated behind its own dialog.
                   */
                  if (replacingSms && pendingSetup.phone) {
                    setReplaceConfirm({
                      method: "sms_otp",
                      code: confirmCode.trim(),
                      phone: pendingSetup.phone,
                    });
                    return;
                  }
                  const body = {
                    action: "confirm",
                    method: "sms_otp",
                    code: confirmCode.trim(),
                    phone: pendingSetup.phone ?? undefined,
                  };
                  void act(body).then((d) => d && handleActionSuccess(body, d));
                }}
                className="space-y-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3"
              >
                <p className="text-xs font-semibold">
                  {replacingSms ? (
                    <>
                      کد ۶ رقمی ارسال‌شده به شمارهٔ جدید{" "}
                      {toPersianDigits(pendingSetup.phone ?? pendingSetup.maskedPhone ?? "")} را
                      وارد کنید؛ پس از تأیید، این شماره جایگزین شمارهٔ فعلی می‌شود:
                    </>
                  ) : (
                    <>
                      کد ۶ رقمی ارسال‌شده به{" "}
                      {toPersianDigits(pendingSetup.maskedPhone ?? pendingSetup.phone ?? "")} را
                      برای تأیید نهایی وارد کنید:
                    </>
                  )}
                </p>
                {status?.smsChallengeExpiresAt ? (
                  <p className="text-xs text-muted-foreground">
                    {smsChallengeExpiryMessage(status.smsChallengeExpiresAt, nowTick)}
                  </p>
                ) : null}
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
                  <Button
                    type="submit"
                    disabled={busy || confirmCode.trim().length < 6}
                  >
                    {replacingSms ? "تأیید شماره و جایگزینی" : "تأیید شماره و فعال‌سازی"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const body = {
                        action: "resend_challenge",
                        method: "sms_otp",
                        // Issue #854 (P2.21) — a replacement resend must name
                        // the new number, not the stored (old) one.
                        ...(replacingSms && pendingSetup?.phone
                          ? { phone: pendingSetup.phone }
                          : {}),
                      };
                      void act(body).then((d) => d && handleActionSuccess(body, d));
                    }}
                    disabled={busy || coolingDown}
                  >
                    {coolingDown
                      ? `ارسال مجدد کد (${toPersianDigits(resendWait)})`
                      : "ارسال مجدد کد"}
                  </Button>
                  <Button variant="ghost" onClick={cancelSmsCeremony} disabled={busy}>
                    انصراف
                  </Button>
                </div>
                {replacingSms ? (
                  <p className="text-xs text-muted-foreground">
                    شمارهٔ فعلی تا پایان تأیید شمارهٔ جدید فعال می‌ماند؛ انصراف هیچ تغییری در روش
                    فعال ایجاد نمی‌کند.
                  </p>
                ) : null}
              </form>
            ) : null}
          </div>

          {anyEnrolled ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
              <div>
                <p className="text-sm font-semibold">کدهای بازیابی یک‌بارمصرف</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {toPersianDigits(String(status.unusedRecoveryCodes))} کد استفاده‌نشده باقی مانده
                  است.
                </p>
              </div>
              <Button
                variant="ghost"
                onClick={() => setConfirmAction({ kind: "regenerate_codes" })}
                disabled={busy}
              >
                ساخت کدهای جدید
              </Button>
            </div>
          ) : null}

          {shownCodes.length > 0 ? (
            <RecoveryCodeSheet codes={shownCodes} theme={PLATFORM_MFA_THEME} />
          ) : null}
        </div>
      )}

      {/* Issue #854 (P2.26) — the same confirmation contract as the tenant card. */}
      <SecurityConfirmDialog
        open={confirmAction !== null}
        title={
          confirmAction?.kind === "remove"
            ? confirmAction.method === "totp"
              ? "حذف برنامهٔ رمزساز"
              : "حذف پیامک یک‌بارمصرف"
            : "ساخت کدهای بازیابی جدید"
        }
        description={
          confirmAction?.kind === "remove"
            ? "این روش بلافاصله از حساب شما حذف می‌شود."
            : "کدهای بازیابی تازه صادر می‌شوند و فهرست قبلی باطل می‌گردد."
        }
        consequences={
          confirmAction?.kind === "remove"
            ? [
                confirmAction.method === "totp"
                  ? "از این پس کد برنامهٔ رمزساز برای ورود شما پذیرفته نمی‌شود."
                  : "از این پس کدی به شمارهٔ فعلی پیامک نمی‌شود و ورود پیامکی این حساب قطع می‌گردد.",
                (status?.methods ?? []).filter((m) => m !== confirmAction.method).length === 0
                  ? "این آخرین روش دومرحله‌ای شماست؛ ورود دومرحله‌ای برای حساب‌های مدیریت سکو اجباری است و سرور حذف را رد می‌کند."
                  : "بقیهٔ روش‌های دومرحله‌ای شما دست‌نخورده می‌مانند.",
                "کدهای بازیابی قبلی همچنان به‌عنوان راه پشتیبان باقی می‌مانند.",
              ]
            : [
                "تمام کدهای بازیابی قبلی همان لحظه باطل می‌شوند و دیگر در هیچ ورودی کار نمی‌کنند.",
                "فهرست تازه تنها یک بار نمایش داده می‌شود؛ آن را در جای امنی نگهداری کنید.",
                "روش‌های دومرحله‌ای شما (رمزساز یا پیامک) تغییری نمی‌کنند.",
              ]
        }
        confirmLabel={confirmAction?.kind === "remove" ? "بله، حذف شود" : "بله، کدهای جدید بساز"}
        busy={busy}
        onOpenChange={(next) => {
          if (!next) setConfirmAction(null);
        }}
        onConfirm={() => {
          if (confirmAction?.kind === "remove") void executeRemove(confirmAction.method);
          if (confirmAction?.kind === "regenerate_codes") void executeRegenerateCodes();
        }}
      />
      <SecurityConfirmDialog
        open={replaceConfirm !== null}
        title="جایگزینی شمارهٔ دریافت کد پیامکی"
        description={
          replaceConfirm
            ? `کد واردشده برای ${toPersianDigits(replaceConfirm.phone)} تأیید شد؛ با ثبت این تغییر، شمارهٔ دریافت عوض می‌شود.`
            : ""
        }
        consequences={[
          "شمارهٔ فعلی از همین لحظه دیگر کدی دریافت نمی‌کند.",
          "ورودهای بعدی با رمز عبور، کد را به شمارهٔ تازه می‌فرستند.",
          "این تغییر به‌صورت اتمی ثبت می‌شود: هیچ لحظه‌ای حساب بدون عامل دومرحله‌ای نمی‌ماند.",
        ]}
        confirmLabel="بله، شماره جایگزین شود"
        variant="default"
        busy={busy}
        onOpenChange={(next) => {
          if (!next) setReplaceConfirm(null);
        }}
        onConfirm={() => void submitReplaceConfirm()}
      />
    </Card>
  );
}

interface PlatformSessionItem {
  id: string;
  deviceLabel: string | null;
  ipAddress: string | null;
  startedAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

function PlatformSelfSessionsSection({
  onSignedOutEverywhere,
}: {
  onSignedOutEverywhere: () => void;
}) {
  const [sessions, setSessions] = useState<PlatformSessionItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ sessions?: PlatformSessionItem[] }>(
      "/api/platform/auth/sessions",
    );
    if (ok) setSessions(data.sessions ?? []);
    else setError("بارگذاری نشست‌های فعال ممکن نشد.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string }>("/api/platform/auth/sessions", {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    if (body.action === "revoke_all") {
      onSignedOutEverywhere();
      return;
    }
    setNotice("عملیات مدیریت نشست با موفقیت انجام شد.");
    await load();
  }

  return (
    <Card title="نشست‌های فعال کنسول سکو">
      <p className="mb-4 text-xs text-muted-foreground">
        فهرست نشست‌های باز حساب مدیریتی شما در کنسول سکو.
      </p>
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      {sessions === null ? (
        <SkeletonRows rows={2} />
      ) : (
        <div className="space-y-4">
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              نشست فعالی ثبت نشده است.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3 text-xs"
                >
                  <div>
                    <p className="font-semibold text-foreground">
                      {s.deviceLabel || "مرورگر وب"}
                      {s.isCurrent ? (
                        <span className="ms-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                          نشست فعلی
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {s.ipAddress ? `IP: ${s.ipAddress} · ` : ""}
                      آخرین فعالیت: {fmtDate(s.lastSeenAt)}
                    </p>
                  </div>
                  {!s.isCurrent ? (
                    <Button
                      variant="ghost"
                      onClick={() => void act({ action: "revoke_one", sessionId: s.id })}
                      disabled={busy}
                    >
                      خاتمه دادن
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {sessions.some((s) => !s.isCurrent) ? (
              <Button
                variant="ghost"
                onClick={() => void act({ action: "revoke_others" })}
                disabled={busy}
              >
                خروج از سایر دستگاه‌ها
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => void act({ action: "revoke_all" })}
              disabled={busy}
            >
              خروج از همهٔ دستگاه‌ها
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
