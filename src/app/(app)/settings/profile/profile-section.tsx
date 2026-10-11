"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { normalizeSecurityDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import { roleLabel } from "@/lib/role-labels";
import { authErrorMessage } from "@/lib/auth-contracts";
import type { CredentialSurface } from "@/lib/credential-authority";
import {
  sessionActivityIso,
  sessionLoginMethodLabel,
  sessionRevokeDescription,
  type SelfSessionView,
  type SessionRevokeAction,
} from "@/lib/session-contract";
import { StepUpPrompt, RECENT_AUTH_MESSAGE } from "@/components/auth/step-up-prompt";
import {
  smsChallengeExpiryMessage,
  useNowTick,
  useResendCooldown,
} from "@/components/auth/use-resend-cooldown";
import { WebAuthnManager } from "@/components/auth/webauthn-manager";
import { TwoFactorSettings } from "../two-factor-settings";

export interface ProfileSectionProps {
  fullName: string;
  phone?: string | null;
  email?: string | null;
  role: string;
  isOwner: boolean;
  /**
   * Whether this membership has a global login at all. Server-computed
   * (`readSelfCredentialState().hasGlobalIdentity`), because the card must be
   * absent for a PIN-only member rather than offer controls the API refuses —
   * and must be *present* for an `admin`/`accountant`, which is the half of
   * #854 P1.2 the old hard-coded `["owner","manager"]` list got wrong.
   */
  canUseMfa?: boolean;
  /** `apply`-only deployments render the cloud-owned cards read-only (P1.15). */
  credentialSurfaces?: Partial<Record<CredentialFieldName, CredentialSurface>>;
}

type CredentialFieldName =
  | "global_password"
  | "login_phone"
  | "totp_secret"
  | "staff_pin"
  /** Issue #854 (P2.28) — WebAuthn/biometric credentials join the profile. */
  | "webauthn_credential";

/** Shown in place of any control this deployment does not own (P1.15). */
function CloudManagedNotice({ surface }: { surface?: CredentialSurface }) {
  if (!surface?.readOnly) return null;
  return <InfoBox>{surface.notice ?? authErrorMessage("login_managed_by_cloud")}</InfoBox>;
}

export function ProfileSection({
  fullName,
  phone,
  email,
  role,
  isOwner,
  canUseMfa = true,
  credentialSurfaces = {},
}: ProfileSectionProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="مشخصات ورود"
        description="نام و نقش از سوی مدیر کسب‌وکار تعیین می‌شود."
      >
        <dl className="divide-y divide-border text-sm">
          <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
            <dt className="text-muted-foreground">نام</dt>
            <dd className="font-semibold text-foreground">{fullName || "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <dt className="text-muted-foreground">نقش</dt>
            <dd className="font-semibold text-foreground">{roleLabel(role)}</dd>
          </div>
          {email ? (
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">ایمیل</dt>
              <dd dir="ltr" className="font-mono text-xs text-foreground">
                {email}
              </dd>
            </div>
          ) : null}
          {phone ? (
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">شمارهٔ ورود</dt>
              <dd dir="ltr" className="font-semibold tabular-nums text-foreground">
                {toPersianDigits(formatPhoneDisplay(phone))}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-4 flex justify-end border-t border-border pt-4">
          <SecondaryButton onClick={signOut} disabled={signingOut}>
            {signingOut ? "در حال خروج…" : "خروج از حساب"}
          </SecondaryButton>
        </div>
      </SectionCard>

      {email ? (
        <SelfPasswordCard surface={credentialSurfaces.global_password} />
      ) : null}

      <SelfPhoneCard surface={credentialSurfaces.login_phone} />

      <SelfPinCard surface={credentialSurfaces.staff_pin} />

      {canUseMfa ? (
        <TwoFactorSettings
          isOwner={isOwner}
          scope="personal"
          surface={credentialSurfaces.totp_secret}
        />
      ) : (
        <SectionCard
          title="ورود دومرحله‌ای"
          description="برای این حساب ورود با رمز عبور ثبت نشده است."
        >
          <p className="text-xs text-muted-foreground">
            این عضویت با رمز عددی روی دستگاه وارد می‌شود و رمز عبور سراسری ندارد؛ بنابراین ورود
            دومرحله‌ای روی آن تعریف نمی‌شود. برای فعال‌سازی، از مدیر کسب‌وکار بخواهید نقش شما را
            به یک نقش دارای رمز عبور تغییر دهد.
          </p>
        </SectionCard>
      )}

      {/*
        Issue #854 (P2.28) — the canonical WebAuthn/biometric surface. It used
        to live only in the sidebar's overlay panel (unreachable from this
        page); the profile page now owns it, and the sidebar shortcut links
        here. Available to every role: biometric login is per-device
        self-service, not a business configuration.
      */}
      <SectionCard
        title="ورود بیومتریک (اثر انگشت / چهره)"
        description="دستگاه‌های ثبت‌شده برای ورود بیومتریک این حساب."
      >
        <WebAuthnManager surface={credentialSurfaces.webauthn_credential} />
      </SectionCard>

      <SelfSessionsCard
        onSignedOutEverywhere={() => {
          router.push("/login");
          router.refresh();
        }}
      />
    </div>
  );
}

const PASSWORD_ERROR_MESSAGES: Record<string, string> = {
  missing_current_password: "رمز عبور فعلی را وارد کنید.",
  invalid_current_password: "رمز عبور فعلی نادرست است.",
  password_confirmation_mismatch: "تکرار رمز عبور جدید با رمز جدید یکسان نیست.",
  password_unchanged: "رمز عبور جدید باید با رمز فعلی متفاوت باشد.",
  password_too_short: "رمز عبور جدید باید حداقل ۸ نویسه باشد.",
  password_too_long: "رمز عبور جدید بیش از حد طولانی است.",
  password_blank: "رمز عبور نمی‌تواند فقط فاصله باشد.",
};

function SelfPasswordCard({ surface }: { surface?: CredentialSurface }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const lengthOk = newPassword.length >= 8;
  const matchOk = newPassword.length > 0 && newPassword === confirmPassword;
  /**
   * Issue #854 (P1.14 / P1.15): a deployment that merely *applies* the global
   * password renders the card read-only, with the reason — instead of a form
   * that fills in and then fails with `login_managed_by_cloud`.
   */
  const readOnly = surface?.readOnly === true;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!lengthOk) {
      setError(PASSWORD_ERROR_MESSAGES.password_too_short);
      return;
    }
    if (!matchOk) {
      setError(PASSWORD_ERROR_MESSAGES.password_confirmation_mismatch);
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ ok?: boolean; error?: string; message?: string }>(
      "/api/auth/password/self",
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
      setError(
        (data.error && PASSWORD_ERROR_MESSAGES[data.error]) ||
          data.message ||
          "تغییر رمز عبور ممکن نشد.",
      );
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setNotice(
      "رمز عبور شما با موفقیت تغییر یافت و سایر نشست‌های فعال در همهٔ دستگاه‌ها بسته شدند.",
    );
  }

  return (
    <SectionCard
      title="تغییر رمز عبور"
      description="تغییر رمز عبور سراسری شما بلافاصله تمام نشست‌های دیگر را در همهٔ دستگاه‌ها باطل می‌کند."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      <CloudManagedNotice surface={surface} />
      {readOnly ? null : (
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
          <Field
            label="رمز عبور جدید"
            hint={`حداقل ${toPersianDigits("8")} نویسه`}
          >
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
          <PrimaryButton
            type="submit"
            disabled={busy || !currentPassword || !lengthOk || !matchOk}
          >
            {busy ? "در حال ذخیره…" : "تغییر رمز عبور"}
          </PrimaryButton>
        </div>
      </form>
      )}
    </SectionCard>
  );
}

/**
 * The caller's own sessions (Issue #854 P1.4 / P1.5 / P2.26).
 *
 * Three things the old card got wrong, all of them about *saying what it does*:
 *
 *  - it read `startedAt`/`lastSeenAt` from a route that returns
 *    `issuedAt`/`lastSeenAt`, so the date column rendered nothing (P1.5);
 *  - it offered «خروج از سایر دستگاه‌ها» next to a route that used to sweep
 *    every business the identity belonged to, while the list above it showed
 *    one business (P1.4) — the two now agree, and the global sign-out is its
 *    own button that names what it reaches;
 *  - it revoked everything with no confirmation (P2.26).
 *
 * The step-up prompt is the shared one, so a PIN-only member is offered the PIN
 * door instead of a password box for an account that has no password (P1.6).
 */
function SelfSessionsCard({
  onSignedOutEverywhere,
}: {
  onSignedOutEverywhere: () => void;
}) {
  const [sessions, setSessions] = useState<SelfSessionView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pending, setPending] = useState<SessionRevokeAction | null>(null);
  const [retryAfterStepUp, setRetryAfterStepUp] = useState<SessionRevokeAction | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ sessions?: SelfSessionView[] }>("/api/sessions/self");
    if (ok) {
      setSessions(data.sessions ?? []);
    } else {
      setError("بارگذاری نشست‌های فعال ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeOne(sessionId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string }>("/api/sessions/self", {
      method: "DELETE",
      body: JSON.stringify({ action: "revoke_one", sessionId }),
    });
    setBusy(false);
    if (!ok) {
      setError(authErrorMessage(data.error) || "خاتمه دادن به نشست ممکن نشد.");
      return;
    }
    setNotice("نشست انتخاب‌شده خاتمه یافت.");
    await load();
  }

  async function runAction(action: SessionRevokeAction) {
    setPending(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status, data } = await api<{ error?: string; scope?: string; revokedCount?: number }>(
      "/api/sessions/self",
      { method: "DELETE", body: JSON.stringify({ action }) },
    );
    setBusy(false);
    if (!ok) {
      if (status === 403 && data.error === "recent_auth_required") {
        setRetryAfterStepUp(action);
        setStepUpOpen(true);
        return;
      }
      setError(authErrorMessage(data.error) || "خاتمه دادن به نشست‌ها ممکن نشد.");
      return;
    }
    if (action === "revoke_all") {
      onSignedOutEverywhere();
      return;
    }
    setNotice(
      data.scope === "global"
        ? "همهٔ نشست‌های شما در همهٔ کسب‌وکارها خاتمه یافتند."
        : "نشست‌های دیگر شما در این کسب‌وکار خاتمه یافتند.",
    );
    await load();
  }

  return (
    <SectionCard
      title="نشست‌ها و دستگاه‌های فعال"
      description="نشست‌های باز حساب شما در همین کسب‌وکار. برای خروج از حساب در همهٔ کسب‌وکارها از دکمهٔ «خروج از همهٔ کسب‌وکارها» استفاده کنید."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <StepUpPrompt
        open={stepUpOpen}
        title="تأیید مجدد هویت برای خاتمه دادن به نشست‌ها"
        description={RECENT_AUTH_MESSAGE}
        onCancel={() => {
          setStepUpOpen(false);
          setRetryAfterStepUp(null);
        }}
        onVerified={() => {
          setStepUpOpen(false);
          const action = retryAfterStepUp;
          setRetryAfterStepUp(null);
          if (action) void runAction(action);
        }}
      />

      {pending ? (
        <div className="mb-4 space-y-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-semibold text-foreground">
            {pending === "revoke_all" ? "خروج از همهٔ کسب‌وکارها" : "خاتمه دادن به نشست‌های دیگر"}
          </p>
          <p className="text-xs text-muted-foreground">{sessionRevokeDescription(pending)}</p>
          <div className="flex gap-2">
            <PrimaryButton onClick={() => void runAction(pending)} disabled={busy}>
              تأیید و ادامه
            </PrimaryButton>
            <SecondaryButton onClick={() => setPending(null)} disabled={busy}>
              انصراف
            </SecondaryButton>
          </div>
        </div>
      ) : null}

      {sessions === null ? (
        <LoadingSkeleton rows={2} />
      ) : (
        <div className="space-y-4">
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              نشست فعالی در فهرست دستگاه‌ها ثبت نشده است.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border">
              {sessions.map((s) => {
                const method = sessionLoginMethodLabel(s.loginMethod);
                return (
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
                        {s.businessName ? `کسب‌وکار: ${s.businessName} · ` : ""}
                        {s.locationName ? `شعبه: ${s.locationName} · ` : ""}
                        {method ? `${method} · ` : ""}
                        آخرین فعالیت: {formatJalali(sessionActivityIso(s), { withTime: true })}
                      </p>
                    </div>
                    {!s.isCurrent ? (
                      <SecondaryButton onClick={() => void revokeOne(s.id)} disabled={busy}>
                        خاتمه دادن
                      </SecondaryButton>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {sessions.some((s) => !s.isCurrent) ? (
              <SecondaryButton onClick={() => setPending("revoke_others")} disabled={busy}>
                خروج از سایر دستگاه‌ها (این کسب‌وکار)
              </SecondaryButton>
            ) : null}
            <SecondaryButton onClick={() => setPending("revoke_all")} disabled={busy}>
              خروج از همهٔ کسب‌وکارها
            </SecondaryButton>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

interface SelfPhoneStatus {
  phone: string | null;
  phoneState: "none" | "unverified" | "verified";
  otpWindowOpen?: boolean;
  recentAuth?: boolean;
  /** A live challenge, so a reload can resume the verification (P2.19). */
  pendingChallenge?: {
    maskedPhone: string | null;
    purpose: "change_login_phone" | "verify_login_phone";
    /** When the code was sent — the resend cooldown counts from here (P2.25). */
    requestedAt: string;
    expiresAt: string;
  } | null;
  credential?: CredentialSurface;
  error?: string;
  message?: string;
}

const PHONE_ERROR_MESSAGES: Record<string, string> = {
  invalid_phone: "شمارهٔ موبایل معتبر نیست.",
  phone_missing: "شمارهٔ موبایل را وارد کنید.",
  invalid_code: "کد ۶ رقمی واردشده نادرست است.",
  rate_limited: "تعداد درخواست‌ها بیش از حد مجاز است؛ کمی صبر کنید.",
  sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",
  recent_auth_required: "برای تغییر شمارهٔ موبایل ورود، ابتدا هویت خود را مجدداً تأیید کنید.",
};

function SelfPhoneCard({ surface }: { surface?: CredentialSurface }) {
  const [status, setStatus] = useState<SelfPhoneStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [maskedSentTo, setMaskedSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retryAfterStepUp, setRetryAfterStepUp] = useState<(() => void) | null>(null);

  /**
   * Issue #854 (P2.25) — the resend cooldown, seeded from the challenge's
   * actual send time so a reload mid-window shows the honest remaining seconds.
   */
  const {
    waitSeconds: resendWait,
    coolingDown,
    seedFromRequestedAt,
    start: startCooldown,
    applyRetryAfterMs,
    clear: clearCooldown,
  } = useResendCooldown(60);
  const nowTick = useNowTick(Boolean(maskedSentTo && status?.pendingChallenge?.expiresAt));

  const load = useCallback(async () => {
    const { ok, data } = await api<SelfPhoneStatus>("/api/auth/phone/self");
    if (ok) {
      setStatus(data);
      /** Reopen a verification that was already in flight. */
      if (data.pendingChallenge && !maskedSentTo) {
        setMaskedSentTo(data.pendingChallenge.maskedPhone);
        setEditing(data.pendingChallenge.purpose === "change_login_phone");
        seedFromRequestedAt(data.pendingChallenge.requestedAt);
      }
    } else {
      setError(
        (data.error && PHONE_ERROR_MESSAGES[data.error]) ||
          "بارگذاری شمارهٔ موبایل ممکن نشد.",
      );
    }
    // `maskedSentTo` is intentionally not a dependency: this effect must run
    // once, and reading it only decides whether an in-flight challenge is
    // adopted on first load. `seedFromRequestedAt` is a stable hook callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedFromRequestedAt]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendOtp(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status: httpStatus, data } = await api<{
      status?: string;
      maskedPhone?: string;
      error?: string;
      message?: string;
      retryAfterMs?: number;
    }>("/api/auth/phone/self", {
      method: "POST",
      body: JSON.stringify({
        action: "send",
        phone: editing ? phoneInput.trim() : undefined,
      }),
    });
    setBusy(false);
    if (!ok) {
      if (httpStatus === 403 && data.error === "recent_auth_required") {
        setRetryAfterStepUp(() => () => void sendOtp());
        setStepUpOpen(true);
        return;
      }
      // Issue #854 (P2.25) — the limiter's own answer drives the countdown.
      if (httpStatus === 429) applyRetryAfterMs(data.retryAfterMs);
      setError(
        data.message ||
          (data.error && PHONE_ERROR_MESSAGES[data.error]) ||
          "ارسال کد تأیید ممکن نشد.",
      );
      return;
    }
    setMaskedSentTo(data.maskedPhone ?? phoneInput.trim());
    setCodeInput("");
    startCooldown();
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok, status: httpStatus, data } = await api<{
      status?: string;
      error?: string;
      message?: string;
    }>("/api/auth/phone/self", {
      method: "POST",
      body: JSON.stringify({
        action: "verify",
        code: codeInput.trim(),
        phone: editing ? phoneInput.trim() : undefined,
      }),
    });
    setBusy(false);
    if (!ok) {
      if (httpStatus === 403 && data.error === "recent_auth_required") {
        setRetryAfterStepUp(() => () => void verifyOtp(e));
        setStepUpOpen(true);
        return;
      }
      setError(
        data.message ||
          (data.error && PHONE_ERROR_MESSAGES[data.error]) ||
          "تأیید کد پیامکی ممکن نشد.",
      );
      return;
    }
    setMaskedSentTo(null);
    setEditing(false);
    setCodeInput("");
    clearCooldown();
    setNotice("شمارهٔ موبایل ورود شما با موفقیت تأیید شد.");
    await load();
  }

  const verified = status?.phoneState === "verified";
  const readOnly = surface?.readOnly === true;

  return (
    <SectionCard
      title="شمارهٔ موبایل ورود"
      description="برای ورود با کد پیامکی؛ پس از هر تأیید شماره، رمز عددی تا ۷ روز برای همهٔ ورودهای این عضویت کار می‌کند (نه فقط یک دستگاه)."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <CloudManagedNotice surface={surface} />

      <StepUpPrompt
        open={stepUpOpen}
        title="تأیید مجدد هویت برای تغییر شمارهٔ موبایل"
        description={RECENT_AUTH_MESSAGE}
        onCancel={() => {
          setStepUpOpen(false);
          setRetryAfterStepUp(null);
        }}
        onVerified={() => {
          setStepUpOpen(false);
          const retry = retryAfterStepUp;
          setRetryAfterStepUp(null);
          setNotice("هویت شما تأیید شد؛ اکنون می‌توانید شماره را ثبت یا تأیید کنید.");
          if (retry) retry();
        }}
      />

      {!status ? (
        <LoadingSkeleton rows={2} />
      ) : maskedSentTo ? (
        <form onSubmit={verifyOtp} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            کد ۶ رقمی ارسال‌شده به {toPersianDigits(maskedSentTo)} را وارد کنید:
          </p>
          {/*
            Issue #854 (P2.25) — the challenge has a deadline; say how long is
            left instead of letting a correct-looking code fail unexplained.
          */}
          {status.pendingChallenge?.expiresAt ? (
            <p className="text-xs text-muted-foreground">
              {smsChallengeExpiryMessage(status.pendingChallenge.expiresAt, nowTick)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-44 flex-1">
              <input
                dir="ltr"
                inputMode="numeric"
                maxLength={6}
                required
                value={codeInput}
                onChange={(e) => setCodeInput(normalizeSecurityDigits(e.target.value, 6))}
                placeholder="123456"
                className={inputClass}
              />
            </div>
            <PrimaryButton type="submit" disabled={busy || codeInput.trim().length < 6}>
              تأیید کد
            </PrimaryButton>
            <SecondaryButton
              type="button"
              onClick={() => void sendOtp()}
              disabled={busy || coolingDown}
            >
              {coolingDown
                ? `ارسال مجدد کد (${toPersianDigits(resendWait)})`
                : "ارسال مجدد کد"}
            </SecondaryButton>
            <SecondaryButton
              type="button"
              onClick={() => {
                // Cancellation sends no mutation; the in-flight challenge
                // simply expires on the server's own clock.
                setMaskedSentTo(null);
                clearCooldown();
              }}
              disabled={busy}
            >
              انصراف
            </SecondaryButton>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          {!verified ? (
            <InfoBox>
              تا زمانی که شمارهٔ موبایل تأیید نشود، ورود با پیامک فعال نیست.
            </InfoBox>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              {status.phone ? (
                <p className="text-sm font-semibold">
                  <span dir="ltr">{toPersianDigits(formatPhoneDisplay(status.phone))}</span>
                  {verified ? (
                    <span className="ms-2 text-xs font-normal text-emerald-600 dark:text-emerald-400">
                      تأییدشده
                    </span>
                  ) : (
                    <span className="ms-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                      تأییدنشده
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">هنوز شماره‌ای ثبت نشده است.</p>
              )}
            </div>
            {readOnly ? null : (
              <div className="flex flex-wrap gap-2">
                {status.phone && !verified ? (
                  <PrimaryButton onClick={() => void sendOtp()} disabled={busy}>
                    ارسال کد تأیید
                  </PrimaryButton>
                ) : null}
                <SecondaryButton
                  onClick={() => {
                    setEditing((v) => !v);
                    setPhoneInput(status.phone ?? "");
                    setError(null);
                  }}
                  disabled={busy}
                >
                  {status.phone ? "تغییر شماره" : "ثبت شماره"}
                </SecondaryButton>
              </div>
            )}
          </div>

          {editing && !readOnly ? (
            <form onSubmit={sendOtp} className="flex flex-wrap items-end gap-2 pt-2">
              <div className="min-w-56 flex-1">
                <Field
                  label="شمارهٔ موبایل"
                  hint="یک کد پیامکی برای تأیید این شماره ارسال می‌شود."
                >
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
              <PrimaryButton type="submit" disabled={busy || !phoneInput.trim()}>
                ارسال کد تأیید
              </PrimaryButton>
            </form>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

interface SelfPinStatus {
  hasPin: boolean;
  pinPolicyHint?: string;
  recentAuth?: boolean;
  credential?: CredentialSurface;
  error?: string;
  message?: string;
}

const PIN_ERROR_MESSAGES: Record<string, string> = {
  invalid_pin: "رمز عددی باید ۴ تا ۱۲ رقم باشد.",
  invalid_current_pin: "رمز عددی فعلی نادرست است.",
  current_pin_required: "برای تغییر رمز عددی، ابتدا رمز عددی فعلی را وارد کنید.",
  pin_missing: "رمز عددی جدید را وارد کنید.",
  pin_confirmation_mismatch: "تکرار رمز عددی جدید یکسان نیست.",
  pin_taken: "این رمز عددی برای عضو دیگری ثبت شده است؛ رمز دیگری انتخاب کنید.",
  pin_unchanged: "رمز عددی جدید باید با رمز فعلی متفاوت باشد.",
  account_locked: "حساب موقتاً قفل شده است؛ کمی بعد دوباره تلاش کنید.",
  recent_auth_required: RECENT_AUTH_MESSAGE,
  login_managed_by_cloud: "این مورد در نسخهٔ ابری مدیریت می‌شود.",
};

/**
 * Issue #854 (P1.7) — the member's *own* PIN, on the member's own screen.
 *
 * This is the half the Team screen must not own: an administrator reset exists
 * for somebody who has forgotten their PIN, but a member who simply wants a new
 * one should not have to ask an admin (and tell them the moment it changed).
 * The route behind this card verifies the current PIN and requires the session's
 * recent-authentication window, so an unlocked terminal is not enough.
 */
function SelfPinCard({ surface }: { surface?: CredentialSurface }) {
  const [status, setStatus] = useState<SelfPinStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retryAfterStepUp, setRetryAfterStepUp] = useState<(() => void) | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<SelfPinStatus>("/api/auth/pin/self");
    if (ok) setStatus(data);
    else setError("بارگذاری وضعیت رمز عددی ممکن نشد.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const readOnly = (surface ?? status?.credential)?.readOnly === true;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status: httpStatus, data } = await api<{ error?: string; message?: string }>(
      "/api/auth/pin/self",
      {
        method: "POST",
        body: JSON.stringify({
          currentPin: status?.hasPin ? currentPin : undefined,
          newPin,
          confirmPin,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      if (httpStatus === 403 && data.error === "recent_auth_required") {
        setRetryAfterStepUp(() => () => undefined);
        setStepUpOpen(true);
        return;
      }
      setError(
        data.message ||
          (data.error && PIN_ERROR_MESSAGES[data.error]) ||
          "تغییر رمز عددی ممکن نشد.",
      );
      return;
    }
    setCurrentPin("");
    setNewPin("");
    setConfirmPin("");
    setOpen(false);
    setNotice("رمز عددی شما تغییر کرد. از این پس با رمز عددی جدید وارد می‌شوید.");
    await load();
  }

  return (
    <SectionCard
      title="رمز عددی دستگاه"
      description="رمز عددی برای ورود سریع روی دستگاه‌های فروش و تأیید هویت در همین صفحه به کار می‌رود."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      <CloudManagedNotice surface={surface ?? status?.credential} />

      <StepUpPrompt
        open={stepUpOpen}
        title="تأیید مجدد هویت"
        description={RECENT_AUTH_MESSAGE}
        onCancel={() => {
          setStepUpOpen(false);
          setRetryAfterStepUp(null);
        }}
        onVerified={() => {
          setStepUpOpen(false);
          const retry = retryAfterStepUp;
          setRetryAfterStepUp(null);
          setNotice("هویت شما تأیید شد؛ اکنون می‌توانید رمز عددی را تغییر دهید.");
          if (retry) retry();
        }}
      />

      {!status ? (
        <LoadingSkeleton rows={1} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            {status.hasPin ? (
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                رمز عددی فعال است
              </span>
            ) : (
              <span className="text-muted-foreground">رمز عددی ثبت نشده است.</span>
            )}
          </p>

          {readOnly ? null : !open ? (
            <div className="flex justify-end">
              <SecondaryButton onClick={() => setOpen(true)} disabled={busy}>
                {status.hasPin ? "تغییر رمز عددی" : "ثبت رمز عددی"}
              </SecondaryButton>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              {status.hasPin ? (
                <Field label="رمز عددی فعلی">
                  <input
                    dir="ltr"
                    inputMode="numeric"
                    maxLength={12}
                    required
                    value={currentPin}
                    onChange={(e) => setCurrentPin(normalizeSecurityDigits(e.target.value, 12))}
                    className={inputClass}
                  />
                </Field>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="رمز عددی جدید" hint={status.pinPolicyHint}>
                  <input
                    dir="ltr"
                    inputMode="numeric"
                    maxLength={12}
                    required
                    value={newPin}
                    onChange={(e) => setNewPin(normalizeSecurityDigits(e.target.value, 12))}
                    className={inputClass}
                  />
                </Field>
                <Field label="تکرار رمز عددی جدید">
                  <input
                    dir="ltr"
                    inputMode="numeric"
                    maxLength={12}
                    required
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(normalizeSecurityDigits(e.target.value, 12))}
                    className={inputClass}
                  />
                </Field>
              </div>
              <div className="flex gap-2">
                <PrimaryButton
                  type="submit"
                  disabled={busy || !newPin || (status.hasPin && !currentPin)}
                >
                  {busy ? "در حال ذخیره…" : "ذخیرهٔ رمز عددی"}
                </PrimaryButton>
                <SecondaryButton onClick={() => setOpen(false)} disabled={busy}>
                  انصراف
                </SecondaryButton>
              </div>
            </form>
          )}
        </div>
      )}
    </SectionCard>
  );
}
