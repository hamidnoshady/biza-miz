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
import { StepUpPrompt, RECENT_AUTH_MESSAGE } from "@/components/auth/step-up-prompt";
import { SecurityConfirmDialog } from "@/components/auth/security-confirm-dialog";
import {
  smsChallengeExpiryMessage,
  useNowTick,
  useResendCooldown,
} from "@/components/auth/use-resend-cooldown";
import type { CredentialSurface } from "@/lib/credential-authority";
import { toPersianDigits } from "@/lib/digits";

interface SelfMfaStatus {
  methods: Array<MfaMethod | { method: MfaMethod; isPrimary?: boolean; phoneHint?: string | null }>;
  methodNames?: MfaMethod[];
  pendingMethods?: MfaMethod[];
  primaryMethod: MfaMethod | null;
  phone: string | null;
  requireForManagers: boolean;
  requireForAccountants?: boolean;
  /** Server-computed: does the second factor apply to this role here? (P1.1/P1.2) */
  applies?: boolean;
  requirement?: "not_required" | "grace" | "required";
  graceDaysLeft: number | null;
  unusedRecoveryCodes: number;
  recoveryCodesRemaining?: number;
  recentAuth?: boolean;
  smsChallengeRequestedAt?: string | null;
  smsChallengeExpiresAt?: string | null;
  /** Issue #854 (P2.21) — the number a reloaded fresh enrolment is proving. */
  pendingSmsPhone?: string | null;
  /** True when the deployment merely applies the cloud's factors (P1.15). */
  loginManagedByCloud?: boolean;
  credential?: CredentialSurface;
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
  retryAfterMs?: number;
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
  surface,
}: {
  isOwner: boolean;
  scope?: "personal" | "policy";
  /** The deployment's authority over the factor set; read-only in Hybrid. */
  surface?: CredentialSurface;
}) {
  const [status, setStatus] = useState<SelfMfaStatus | null>(null);
  /**
   * Issue #854 (P1.1) — the organization policy is a *different read* from the
   * personal factor state: `/api/settings/mfa-policy` returns both knobs and is
   * the owner's source of truth, while `/api/auth/mfa/self` answers "what does
   * this account hold". Keeping them apart is what lets the policy card stop
   * inferring one knob's value from the other's.
   */
  const [policy, setPolicy] = useState<{ requireForManagers: boolean; requireForAccountants: boolean } | null>(
    null,
  );
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

  /**
   * Issue #854 (P2.25) — the expiry countdown must keep moving on its own;
   * the resend-cooldown ticker stops ticking once its own window lapses.
   */
  const nowTick = useNowTick(
    pendingSetup?.method === "sms_otp" && Boolean(status?.smsChallengeExpiresAt),
  );

  /**
   * Issue #854 (P2.26) — destructive security mutations wait behind a product
   * confirmation. The dialog's `onConfirm` is the only path that sends the
   * mutation; closing it sends nothing.
   */
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "remove"; method: MfaMethod }
    | { kind: "regenerate_codes" }
    | null
  >(null);

  /**
   * Issue #854 (P2.21) — the replacement's own confirmation: typing the code
   * proves possession of the new number, and the dialog before the swap spells
   * out that the old number stops receiving codes the moment it lands.
   */
  const [replaceConfirm, setReplaceConfirm] = useState<{
    method: MfaMethod;
    code: string;
    phone: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (scope === "policy") {
      const { ok, data } = await api<{
        policy?: { requireForManagers: boolean; requireForAccountants: boolean };
        error?: string;
      }>("/api/settings/mfa-policy");
      if (ok && data.policy) {
        setPolicy(data.policy);
        setError(null);
      } else if (isOwner) {
        // A viewer without `settings.manage` never reaches the switches, so a
        // refused read is only worth reporting to the owner who can act on it.
        setError(selfErrorMessage(data.error));
      }
      return;
    }
    const { ok, data } = await api<SelfMfaStatus & { error?: string }>(
      "/api/auth/mfa/self",
    );
    if (ok) {
      setStatus(data);
      seedFromRequestedAt(data.smsChallengeRequestedAt);
      /**
       * Issue #854 (P2.21) — resume a fresh-enrolment ceremony a reload left
       * mid-flight: the pending row names the number being proven, so the
       * confirm panel comes back with its destination and binding intact.
       * A *replacement* stages no row, so there is nothing to resume — the
       * member starts it again, which is what the empty state below them says.
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
    } else {
      setError(selfErrorMessage(data.error));
    }
  }, [scope, isOwner, seedFromRequestedAt]);

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
      // Issue #854 (P2.25) — the limiter's own answer drives the countdown:
      // it names a longer window than the base cooldown once caps engage.
      if (httpStatus === 429) applyRetryAfterMs(data.retryAfterMs);
      setError(selfErrorMessage(data.error, data.message));
      return null;
    }
    await load();
    return data;
  }

  /**
   * Issue #854 (P1.9 / P1.10): the shared prompt posts the typed contract
   * (`stepUpBody`) and can start an SMS challenge, so this component no longer
   * carries a second, divergent spelling of the step-up request.
   */
  async function completeStepUp() {
    setStepUpOpen(false);
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
      // The code that just went out starts the cooldown clock now (P2.25).
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

  /**
   * Issue #854 (P2.21) — confirm always names the number being proven, so the
   * redemption stays bound to exactly that destination. When a confirmed SMS
   * factor already exists, the same field is what turns the confirmation into
   * the atomic replacement — which first goes through the swap dialog (P2.26),
   * never straight to the mutation.
   */
  async function confirmFactor(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingSetup?.method) return;
    if (pendingSetup.method === "sms_otp" && hasSms && pendingSetup.phone) {
      setReplaceConfirm({
        method: pendingSetup.method,
        code: confirmCode.trim(),
        phone: pendingSetup.phone,
      });
      return;
    }
    const body = {
      action: "confirm",
      method: pendingSetup.method,
      code: confirmCode.trim(),
      phone:
        pendingSetup.method === "sms_otp" && pendingSetup.phone
          ? pendingSetup.phone
          : undefined,
    };
    const data = await act(body);
    if (data) handleActionSuccess(body, data);
  }

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

  /**
   * Issue #854 (P2.21) — a resend during a *replacement* names the number
   * being proven: the stored factor still points at the old one, and a resend
   * that did not say where it was going would text the number being replaced.
   */
  async function resendSmsChallenge() {
    const replacing = Boolean(hasSms && pendingSetup?.method === "sms_otp");
    const body = {
      action: "resend_challenge",
      method: "sms_otp",
      ...(replacing && pendingSetup?.phone ? { phone: pendingSetup.phone } : {}),
    };
    const data = await act(body);
    if (data) {
      setNotice("کد تأیید پیامکی مجدداً ارسال شد.");
    }
  }

  /**
   * Issue #854 (P2.26) — removal opens the confirmation dialog; the mutation
   * only leaves from the dialog's confirm path, so cancelling sends nothing.
   */
  function removeMethod(method: MfaMethod) {
    setConfirmAction({ kind: "remove", method });
  }

  async function executeRemove(method: MfaMethod) {
    setConfirmAction(null);
    setPendingSetup(null);
    setShownCodes([]);
    await act({ action: "remove", method });
  }

  async function makePrimary(method: MfaMethod) {
    const body = { action: "set_primary", method };
    const data = await act(body);
    if (data) handleActionSuccess(body, data);
  }

  function regenerateCodes() {
    setConfirmAction({ kind: "regenerate_codes" });
  }

  async function executeRegenerateCodes() {
    setConfirmAction(null);
    setPendingSetup(null);
    const body = { action: "regenerate_recovery_codes" };
    const data = await act(body);
    if (data) handleActionSuccess(body, data);
  }

  /** Cancel the SMS ceremony in flight. Cancellation sends no mutation. */
  function cancelSmsCeremony() {
    setPendingSetup(null);
    setConfirmCode("");
    setSmsFormOpen(false);
    clearCooldown();
  }

  /**
   * Issue #854 (P1.1) — the policy has two knobs now, and `PUT` takes both.
   *
   * The route normalises a missing key to `false` (`normalizeMfaPolicy`), so
   * sending only the switch that moved silently cleared the other one. Both
   * current values travel on every write here.
   */
  async function savePolicy(next: { requireForManagers?: boolean; requireForAccountants?: boolean }) {
    if (!policy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string }>("/api/settings/mfa-policy", {
      method: "PUT",
      body: JSON.stringify({
        requireForManagers: next.requireForManagers ?? policy.requireForManagers,
        requireForAccountants: next.requireForAccountants ?? policy.requireForAccountants,
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(selfErrorMessage(data.error));
      return;
    }
    setNotice("سیاست ورود دومرحله‌ای به‌روز شد.");
    await load();
  }

  if (scope === "policy") {
    return (
      <SectionCard
        title="سیاست ورود دومرحله‌ای کسب‌وکار"
        description="سیاست سازمانی ورود دومرحله‌ای. تنظیمات روش‌های دومرحله‌ای شخصی هر کاربر در بخش «حساب کاربری من» قرار دارد."
      >
        <ErrorBox>{error}</ErrorBox>
        <InfoBox>{notice}</InfoBox>
        {isOwner && !policy && !error ? (
          <LoadingSkeleton rows={2} />
        ) : (
          <div className="space-y-4">
            {isOwner && policy ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-border/80 bg-muted/30 p-4 text-xs">
                  <p className="font-semibold text-foreground">اجباری برای مالک و مدیر</p>
                  <p className="mt-1 text-muted-foreground">
                    ورود دومرحله‌ای برای «مالک» و «مدیر» همیشه اجباری است و از این‌جا خاموش نمی‌شود؛
                    حسابی که می‌تواند کسب‌وکار را اداره کند نباید فقط با رمز عبور باز شود.
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
                  <div>
                    <p className="text-sm font-semibold">الزام ورود دومرحله‌ای برای مدیران</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      با روشن‌کردن این گزینه، مدیران کسب‌وکار نیز موظف به تأیید دومرحله‌ای هنگام
                      ورود خواهند بود.
                    </p>
                  </div>
                  <Switch
                    checked={policy.requireForManagers}
                    disabled={busy}
                    onCheckedChange={(next) => void savePolicy({ requireForManagers: next })}
                  />
                </div>
                {/*
                  Issue #854 (P1.1): the accountant reaches the ledger and was
                  outside the policy entirely. Off by default — an external
                  accountant is often a contractor on a personal phone — but a
                  business that wants the ledger covered can say so here.
                */}
                <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
                  <div>
                    <p className="text-sm font-semibold">الزام ورود دومرحله‌ای برای حسابداران</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      حسابدار به دفتر کل دسترسی دارد. با روشن‌کردن این گزینه، ورود او نیز به
                      تأیید دومرحله‌ای نیاز خواهد داشت.
                    </p>
                  </div>
                  <Switch
                    checked={policy.requireForAccountants}
                    disabled={busy}
                    onCheckedChange={(next) => void savePolicy({ requireForAccountants: next })}
                  />
                </div>
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
  /**
   * Issue #854 (P2.21) — replacement mode: a confirmed SMS factor exists and
   * an SMS ceremony is in flight. Until the new number's code is redeemed the
   * old factor keeps receiving and authenticating.
   */
  const replacingSms = hasSms && pendingSetup?.method === "sms_otp";
  /**
   * Issue #854 (P1.15): a deployment that only *applies* the cloud's factors
   * shows them but offers no controls, and says why. The old surface rendered
   * full controls and let the API answer `login_managed_by_cloud`.
   */
  const readOnly = (surface ?? status?.credential)?.readOnly === true;
  const mandate =
    status?.applies === true
      ? status.requirement === "grace"
        ? "برای نقش شما اجباری است و مهلت فعال‌سازی در جریان است."
        : "برای نقش شما اجباری است."
      : "برای نقش شما اختیاری است، اما فعال‌کردن آن امنیت حساب را به‌شکل محسوسی بالا می‌برد.";

  return (
    <SectionCard
      title="ورود دومرحله‌ای حساب من"
      description="یک کد ۶ رقمی علاوه بر رمز عبور هنگام ورود. هر روش تنها پس از تأیید کد ۶ رقمی فعال می‌شود."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {readOnly ? (
        <InfoBox>
          {(surface ?? status?.credential)?.notice ??
            "این مورد در نسخهٔ ابری مدیریت می‌شود."}{" "}
          روش‌های تأییدشدهٔ حساب شما در همین صفحه نمایش داده می‌شوند.
        </InfoBox>
      ) : (
        <p className="mb-4 text-xs text-muted-foreground">{mandate}</p>
      )}

      <StepUpPrompt
        open={stepUpOpen}
        title="تأیید مجدد هویت برای تغییر تنظیمات امنیتی"
        description={`${RECENT_AUTH_MESSAGE} ${
          status?.loginManagedByCloud ? "این تنظیمات در نسخهٔ ابری مدیریت می‌شود." : ""
        }`.trim()}
        onCancel={() => {
          setStepUpOpen(false);
          setPendingAction(null);
        }}
        onVerified={() => void completeStepUp()}
      />

      {!status ? (
        <LoadingSkeleton rows={3} />
      ) : (
        <div className="space-y-4">
          {!anyEnrolled && status.applies === true && status.requirement === "required" ? (
            <InfoBox>
              ورود دومرحله‌ای برای نقش شما اجباری است و هنوز روشی فعال نکرده‌اید. تا فعال‌سازی،
              ورود شما با درخواست راه‌اندازی دومرحله‌ای همراه خواهد بود.
            </InfoBox>
          ) : null}

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
            {readOnly ? null : (
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
            )}
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
                  {pendingSms || replacingSms ? (
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
              {readOnly ? null : (
              <div className="flex flex-wrap gap-2">
                {hasSms && status.primaryMethod !== "sms_otp" ? (
                  <SecondaryButton onClick={() => void makePrimary("sms_otp")} disabled={busy}>
                    انتخاب به‌عنوان روش اصلی
                  </SecondaryButton>
                ) : null}
                {hasSms ? (
                  <>
                    {/*
                      Issue #854 (P2.21) — replacement entry: members who
                      already have a confirmed SMS factor could never reach
                      this form before; now the same staging/confirmation
                      pathway doubles as "prove a new number, then swap".
                    */}
                    <SecondaryButton
                      onClick={() => {
                        setSmsFormOpen((v) => !v);
                        setPhoneInput("");
                      }}
                      disabled={busy || replacingSms}
                    >
                      تغییر شمارهٔ دریافت
                    </SecondaryButton>
                    <SecondaryButton onClick={() => removeMethod("sms_otp")} disabled={busy}>
                      حذف
                    </SecondaryButton>
                  </>
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
              )}
            </div>

            {smsFormOpen && !replacingSms ? (
              <form onSubmit={startSms} className="flex flex-wrap items-end gap-2 pt-2">
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
                <PrimaryButton type="submit" disabled={busy}>
                  ارسال کد تأیید پیامکی
                </PrimaryButton>
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
                onSubmit={confirmFactor}
                className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3"
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
                {/*
                  Issue #854 (P2.25) — the challenge has a deadline; name it
                  instead of leaving the member guessing why a correct code
                  gets rejected.
                */}
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
                  <PrimaryButton
                    type="submit"
                    disabled={busy || confirmCode.trim().length < 6}
                  >
                    {replacingSms ? "تأیید شماره و جایگزینی" : "تأیید شماره و فعال‌سازی"}
                  </PrimaryButton>
                  <SecondaryButton
                    type="button"
                    onClick={() => void resendSmsChallenge()}
                    disabled={busy || coolingDown}
                  >
                    {coolingDown
                      ? `ارسال مجدد کد (${toPersianDigits(resendWait)})`
                      : "ارسال مجدد کد"}
                  </SecondaryButton>
                  <SecondaryButton type="button" onClick={cancelSmsCeremony} disabled={busy}>
                    انصراف
                  </SecondaryButton>
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
              {readOnly ? null : (
                <SecondaryButton onClick={() => void regenerateCodes()} disabled={busy}>
                  ساخت کدهای جدید
                </SecondaryButton>
              )}
            </div>
          ) : null}

          {shownCodes.length > 0 ? (
            <RecoveryCodeSheet codes={shownCodes} theme={TENANT_MFA_THEME} />
          ) : null}
        </div>
      )}

      {/*
        Issue #854 (P2.26) — the destructive mutations leave only from here:
        removing a factor or regenerating recovery codes asks for a deliberate
        confirmation that spells out exactly what changes, and closing the
        dialog sends no request at all.
      */}
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
                activeMethodNames.filter((m) => m !== confirmAction.method).length === 0
                  ? "این آخرین روش دومرحله‌ای شماست؛ اگر سیاست کسب‌وکار برای نقش شما اجباری باشد، سرور حذف را رد می‌کند."
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

      {/* Issue #854 (P2.21 + P2.26) — the atomic swap gets its own confirmation. */}
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
    </SectionCard>
  );
}
