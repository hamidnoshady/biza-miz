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
  errorMessage,
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
import { signOutDestination, signOutResultMessage, useSignOut } from "@/components/auth/sign-out";
import type { ProfileBranchInfo } from "@/lib/profile-branch";
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
  /** #854 follow-up (F13): active vs home branch, server-resolved. */
  branch?: ProfileBranchInfo | null;
  /**
   * #854 follow-up (F02): whether the biometric card is shown at all —
   * server-computed from `webauthn-policy.ts` (the role may enrol) or from the
   * member already holding an authenticator they must be able to see and
   * remove. A manager with no authenticator is not offered a ceremony the
   * registration routes refuse.
   */
  showBiometric?: boolean;
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
  branch = null,
  showBiometric = true,
}: ProfileSectionProps) {
  const router = useRouter();
  const { busy: signingOut, result: signOutResult, run: runSignOut } = useSignOut();
  const signOutMessage = signOutResult ? signOutResultMessage(signOutResult) : null;
  /** The cookie is gone but the server could not confirm the end of the session. */
  const signedOutUnconfirmed =
    signOutResult?.kind === "unconfirmed" && signOutResult.sessionCookieCleared;

  /**
   * Where a signed-out browser goes: the sign-in page, unless the server named
   * somewhere else — a support operator's sign-out closes the support session
   * and returns to the console (`redirectTo`).
   */
  const signOutTarget = signOutResult ? signOutDestination(signOutResult, "/login") : "/login";

  // `replace` keeps Back from returning to a page that now belongs to nobody,
  // and `refresh` drops the cached server tree.
  function leave(destination: string) {
    router.replace(destination);
    router.refresh();
  }

  /**
   * #854 follow-up (F10 + logout): leave only once the server has confirmed
   * the sign-out. The old handler ignored the response, so a 5xx or a dropped
   * connection still navigated to /login and looked like success while the
   * session stayed open. Now a failure keeps the member here with the reason
   * and a retry — and an *unconfirmed* end (the cookie is already gone, the
   * server could not confirm the session ended) says so, retries through the
   * server's retry ticket, and offers the way to the login page.
   */
  async function signOut() {
    const result = await runSignOut();
    if (result?.kind === "signed_out") leave(signOutDestination(result, "/login"));
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
          {branch?.active ? (
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">شعبهٔ فعال</dt>
              <dd className="font-semibold text-foreground">
                {branch.active.name}
                {/* Only when it really is the home branch — never inferred from a missing one. */}
                {branch.homeStatus === "same" ? (
                  <span className="ms-2 text-xs font-normal text-muted-foreground">
                    (شعبهٔ اصلی شما)
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
          {branch && branch.homeStatus !== "same" ? (
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted-foreground">شعبهٔ اصلی</dt>
              {branch.homeStatus === "different" && branch.home ? (
                <dd className="font-semibold text-foreground">{branch.home.name}</dd>
              ) : (
                <dd className="text-xs text-muted-foreground">
                  {branch.homeStatus === "unavailable"
                    ? "دیگر فعال نیست؛ با مدیر کسب‌وکار هماهنگ کنید"
                    : "تعیین نشده"}
                </dd>
              )}
            </div>
          ) : null}
        </dl>
        {branch?.active && branch.canSwitch ? (
          <p className="mt-2 text-xs text-muted-foreground">
            شعبهٔ فعال را از انتخابگر شعبه در بالای صفحه تغییر دهید؛ شعبهٔ اصلی را مدیر کسب‌وکار
            تعیین می‌کند.
          </p>
        ) : null}

        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <ErrorBox>{signOutMessage}</ErrorBox>
          <div className="flex flex-wrap justify-end gap-2">
            {signedOutUnconfirmed ? (
              <SecondaryButton onClick={() => leave(signOutTarget)} disabled={signingOut}>
                {signOutTarget === "/login" ? "رفتن به صفحهٔ ورود" : "بازگشت به کنسول"}
              </SecondaryButton>
            ) : null}
            <SecondaryButton onClick={() => void signOut()} disabled={signingOut}>
              {signingOut
                ? "در حال خروج…"
                : signedOutUnconfirmed
                  ? "تلاش دوباره برای پایان نشست"
                  : signOutMessage
                    ? "تلاش دوباره برای خروج"
                    : "خروج از حساب"}
            </SecondaryButton>
          </div>
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
        here. #854 follow-up (F02): shown to the roles `webauthn-policy.ts`
        lets enrol, and to anyone who already holds an authenticator (they
        must be able to see and remove it) — never as an offer the
        registration routes then refuse.
      */}
      {showBiometric ? (
        <SectionCard
          title="ورود بیومتریک (اثر انگشت / چهره)"
          description="دستگاه‌های ثبت‌شده برای ورود بیومتریک این حساب."
        >
          <WebAuthnManager surface={credentialSurfaces.webauthn_credential} />
        </SectionCard>
      ) : null}

      <SelfSessionsCard
        onSignedOutEverywhere={() => {
          router.push("/login");
          router.refresh();
        }}
      />

      <SelfNativeDevicesCard />
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
 *
 * #854 follow-up (F01): ending a single other session now needs the same
 * recent authentication as the bulk actions, so «خاتمه دادن» goes through the
 * step-up prompt on `recent_auth_required` and then retries that exact session
 * — it used to report the refusal as a generic failure.
 */

/** A revocation waiting behind the step-up prompt — one session, or a bulk action. */
type RevokeRetry =
  | { action: "revoke_one"; sessionId: string }
  | { action: Exclude<SessionRevokeAction, "revoke_one"> };

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
  const [pending, setPending] = useState<Exclude<SessionRevokeAction, "revoke_one"> | null>(null);
  const [retryAfterStepUp, setRetryAfterStepUp] = useState<RevokeRetry | null>(null);

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
    const { ok, status, data } = await api<{ error?: string; signedOut?: boolean }>(
      "/api/sessions/self",
      {
        method: "DELETE",
        body: JSON.stringify({ action: "revoke_one", sessionId }),
      },
    );
    setBusy(false);
    if (!ok) {
      if (status === 403 && data.error === "recent_auth_required") {
        setRetryAfterStepUp({ action: "revoke_one", sessionId });
        setStepUpOpen(true);
        return;
      }
      setError(
        status === 0
          ? "ارتباط با سرور برقرار نشد و نشست بسته نشد؛ دوباره تلاش کنید."
          : authErrorMessage(data.error) || "خاتمه دادن به نشست ممکن نشد.",
      );
      // Already gone (ended elsewhere, or expired): show the list as it is now.
      if (status === 404) await load();
      return;
    }
    if (data.signedOut) {
      onSignedOutEverywhere();
      return;
    }
    setNotice("نشست انتخاب‌شده خاتمه یافت.");
    await load();
  }

  async function runAction(action: Exclude<SessionRevokeAction, "revoke_one">) {
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
        setRetryAfterStepUp({ action });
        setStepUpOpen(true);
        return;
      }
      setError(
        status === 0
          ? "ارتباط با سرور برقرار نشد و نشست‌ها بسته نشدند؛ دوباره تلاش کنید."
          : authErrorMessage(data.error) || "خاتمه دادن به نشست‌ها ممکن نشد.",
      );
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
          const retry = retryAfterStepUp;
          setRetryAfterStepUp(null);
          if (!retry) return;
          if (retry.action === "revoke_one") void revokeOne(retry.sessionId);
          else void runAction(retry.action);
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

interface SelfNativeDevice {
  id: string;
  appEnvironment: "development" | "staging" | "production";
  appVersionName: string;
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  hasPushToken?: boolean;
  biometricEnabled?: boolean;
  callerIdRoleHeld?: boolean;
  lastSyncAt?: string | null;
}

function nativeEnvironmentLabel(env: SelfNativeDevice["appEnvironment"]): string {
  if (env === "production") return "نسخهٔ اصلی";
  if (env === "staging") return "نسخهٔ آزمایشی";
  return "نسخهٔ توسعه";
}

/**
 * Issue #884 — the caller's own registered Android app installations (owner
 * decision #1, docs/plans/ISSUE_884_PLAN.md: "a plain member manages only their own
 * devices"). This is `/settings/profile`'s exact reason to exist — the one
 * settings surface every role can open — because the business-wide
 * equivalent (every member's installations, revoke-as-admin) sits behind
 * `native_devices.manage` in the "دستگاه‌های ثبت‌شده" settings tab, which a
 * plain member never sees.
 *
 * Revoking here only ever reaches the caller's own row
 * (`/api/native-devices/self/[id]`, scoped server-side to `session.sub`) —
 * never another member's installation, even on a shared device. Revocation
 * ends that installation's authenticated access from its next request
 * onward; it cannot reach the phone itself if it is offline (the same
 * documented limitation as the admin side).
 */
function SelfNativeDevicesCard() {
  const [devices, setDevices] = useState<SelfNativeDevice[] | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<SelfNativeDevice | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ devices?: SelfNativeDevice[] }>("/api/native-devices/self");
    if (ok) {
      setDevices(data.devices ?? []);
    } else {
      setError("دریافت فهرست نصب‌های اپ اندروید ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeDevices = (devices ?? []).filter((device) => !device.revokedAt);
  const revokedDevices = (devices ?? []).filter((device) => device.revokedAt);

  async function revoke() {
    if (!pendingRevoke) return;
    const device = pendingRevoke;
    setRevokingId(device.id);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/native-devices/self/${device.id}`, {
      method: "DELETE",
    });
    setRevokingId(null);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setPendingRevoke(null);
    setNotice("ثبت این نصب لغو شد. از درخواست بعدی، دسترسی آن به کسب‌وکار قطع می‌شود.");
    await load();
  }

  // Native app installs are optional (a member may never have opened the
  // Android app), so an empty list here is not shown as a problem — unlike
  // the sessions card above, which always has at least the current session.
  if (devices !== null && devices.length === 0) return null;

  return (
    <SectionCard
      title="نصب‌های اپ اندروید"
      description="دستگاه‌هایی که با همین حساب وارد اپ اندروید شده‌اند. لغو ثبت، دسترسی آن نصب را از درخواست بعدی‌اش قطع می‌کند؛ اگر دستگاه آفلاین باشد، این کار تا اتصال دوبارهٔ آن اعمال نمی‌شود."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {devices === null ? (
        <LoadingSkeleton rows={1} />
      ) : (
        <div className="space-y-4">
          {activeDevices.length > 0 ? (
            <div className="divide-y divide-border rounded-xl border border-border">
              {activeDevices.map((device) => (
                <div
                  key={device.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3 text-xs"
                >
                  <div>
                    <p className="font-semibold text-foreground">
                      اپ اندروید — نسخهٔ {toPersianDigits(device.appVersionName)}
                      {device.appEnvironment !== "production" ? (
                        <span className="ms-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                          {nativeEnvironmentLabel(device.appEnvironment)}
                        </span>
                      ) : null}
                      {device.hasPushToken ? (
                        <span className="ms-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                          اعلان فعال
                        </span>
                      ) : null}
                      {device.biometricEnabled ? (
                        <span className="ms-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                          بیومتریک
                        </span>
                      ) : null}
                      {device.callerIdRoleHeld ? (
                        <span className="ms-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                          شناسایی تماس
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      ثبت: {formatJalali(device.registeredAt, { withTime: true })} · آخرین فعالیت:{" "}
                      {device.lastSeenAt ? formatJalali(device.lastSeenAt, { withTime: true }) : "—"}
                      {device.lastSyncAt
                        ? ` · همگام‌سازی: ${formatJalali(device.lastSyncAt, { withTime: true })}`
                        : ""}
                    </p>
                  </div>
                  <SecondaryButton
                    onClick={() => {
                      setError("");
                      setNotice("");
                      setPendingRevoke(device);
                    }}
                    disabled={revokingId === device.id}
                  >
                    لغو ثبت
                  </SecondaryButton>
                </div>
              ))}
            </div>
          ) : null}

          {pendingRevoke ? (
            <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
              <p className="text-sm font-semibold text-foreground">لغو ثبت این نصب؟</p>
              <p className="text-xs text-muted-foreground">
                این نصب دیگر نمی‌تواند به کسب‌وکار دسترسی داشته باشد. برای استفادهٔ دوباره، یک مدیر
                مجاز باید آن را فعال کند و سپس دوباره وارد شوید.
              </p>
              <div className="flex gap-2">
                <PrimaryButton onClick={() => void revoke()} disabled={Boolean(revokingId)}>
                  {revokingId ? "در حال لغو…" : "تأیید و لغو ثبت"}
                </PrimaryButton>
                <SecondaryButton onClick={() => setPendingRevoke(null)} disabled={Boolean(revokingId)}>
                  انصراف
                </SecondaryButton>
              </div>
            </div>
          ) : null}

          {revokedDevices.length > 0 ? (
            <details className="rounded-xl border border-border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                سابقهٔ نصب‌های لغوشده ({toPersianDigits(String(revokedDevices.length))})
              </summary>
              <div className="divide-y divide-border border-t border-border">
                {revokedDevices.map((device) => (
                  <div key={device.id} className="p-3 text-xs opacity-70">
                    اپ اندروید — نسخهٔ {toPersianDigits(device.appVersionName)} · ثبت:{" "}
                    {formatJalali(device.registeredAt, { withTime: true })} · لغو:{" "}
                    {device.revokedAt ? formatJalali(device.revokedAt, { withTime: true }) : "—"}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

interface SelfPhonePendingChallenge {
  maskedPhone: string | null;
  purpose: "change_login_phone" | "verify_login_phone";
  /** When the code was sent — the resend cooldown counts from here (P2.25). */
  requestedAt: string;
  expiresAt: string;
}

interface SelfPhoneStatus {
  phone: string | null;
  phoneState: "none" | "unverified" | "verified";
  otpWindowOpen?: boolean;
  recentAuth?: boolean;
  /** A live challenge, so a reload can resume the verification (P2.19). */
  pendingChallenge?: SelfPhonePendingChallenge | null;
  credential?: CredentialSurface;
  error?: string;
  message?: string;
}

/** `POST /api/auth/phone/self` — every action answers in this shape. */
interface SelfPhoneActionResult {
  status?: "sent" | "verified" | "cancelled";
  maskedPhone?: string;
  purpose?: SelfPhonePendingChallenge["purpose"];
  expiresInSeconds?: number;
  error?: string;
  message?: string;
  retryAfterMs?: number;
}

const PHONE_ERROR_MESSAGES: Record<string, string> = {
  invalid_phone: "شمارهٔ موبایل معتبر نیست.",
  phone_missing: "شمارهٔ موبایل را وارد کنید.",
  invalid_code: "کد ۶ رقمی واردشده نادرست است.",
  rate_limited: "تعداد درخواست‌ها بیش از حد مجاز است؛ کمی صبر کنید.",
  sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",
  recent_auth_required: "برای تغییر شمارهٔ موبایل ورود، ابتدا هویت خود را مجدداً تأیید کنید.",
  network_error: "ارتباط با سرور برقرار نشد؛ اتصال را بررسی کنید و دوباره تلاش کنید.",
};

/** The server's verdicts that mean "this code is finished; start again". */
const PHONE_RESTART_ERRORS = new Set(["challenge_expired", "code_wrong_phone", "phone_taken"]);

function phoneErrorMessage(data: { error?: string; message?: string }, fallback: string): string {
  return (
    data.message ||
    (data.error && PHONE_ERROR_MESSAGES[data.error]) ||
    (data.error ? authErrorMessage(data.error) : null) ||
    fallback
  );
}

/**
 * The member's login phone (Phase 42 / #854 P1.16 / P2.19 / P2.25).
 *
 * #854 follow-up:
 *  - **F06** — the verification in flight is the *server's* challenge
 *    (`pendingChallenge` from `GET`), never the browser's memory of a number.
 *    After a reload the card used to know only a masked string, so «ارسال مجدد
 *    کد» sent no number and the server re-sent to the number *on file* under
 *    the verify purpose — the code for the new number never came again. Resend
 *    is now `action: "resend"` (the server re-sends to the challenge's own
 *    candidate), cancel is `action: "cancel"` (the server burns the code), and
 *    verify names nothing but the code.
 *  - **F11** — with the login phone read-only (Hybrid), no form is rendered at
 *    all, including a pending verification adopted from the server.
 */
function SelfPhoneCard({ surface }: { surface?: CredentialSurface }) {
  const [status, setStatus] = useState<SelfPhoneStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retryAfterStepUp, setRetryAfterStepUp] = useState<(() => void) | null>(null);

  const readOnly = (surface ?? status?.credential)?.readOnly === true;
  /** The verification in flight — the server's copy, or nothing (F06/F11). */
  const pending = readOnly ? null : (status?.pendingChallenge ?? null);

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
  const nowTick = useNowTick(Boolean(pending?.expiresAt));
  const expired = Boolean(pending && new Date(pending.expiresAt).getTime() <= nowTick);

  const load = useCallback(async () => {
    const { ok, data } = await api<SelfPhoneStatus>("/api/auth/phone/self");
    if (ok) {
      // The error box is left alone: a refresh that follows a refused action
      // must not wipe the explanation of why it was refused.
      setStatus(data);
      if (data.pendingChallenge) seedFromRequestedAt(data.pendingChallenge.requestedAt);
    } else {
      setError(
        (data.error && PHONE_ERROR_MESSAGES[data.error]) ||
          "بارگذاری شمارهٔ موبایل ممکن نشد.",
      );
    }
  }, [seedFromRequestedAt]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Forget the local half of a finished or abandoned ceremony. */
  function resetCeremony() {
    setCodeInput("");
    clearCooldown();
  }

  /**
   * Adopt a code the server just sent, without waiting for the next `GET`:
   * the response names the purpose and the masked destination, and the
   * follow-up `load()` replaces this with the challenge row itself.
   */
  function adoptSentChallenge(data: SelfPhoneActionResult) {
    const now = Date.now();
    setStatus((current) =>
      current && data.purpose
        ? {
            ...current,
            pendingChallenge: {
              maskedPhone: data.maskedPhone ?? null,
              purpose: data.purpose,
              requestedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + (data.expiresInSeconds ?? 300) * 1000).toISOString(),
            },
          }
        : current,
    );
    setCodeInput("");
    startCooldown();
  }

  /** POST one action; owns the busy flag, the step-up hand-off and the 429 countdown. */
  async function post(
    body: Record<string, unknown>,
    retry: () => void,
  ): Promise<{ ok: boolean; data: SelfPhoneActionResult; stepUp: boolean }> {
    setBusy(true);
    setError(null);
    const { ok, status: httpStatus, data } = await api<SelfPhoneActionResult>(
      "/api/auth/phone/self",
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!ok && httpStatus === 403 && data.error === "recent_auth_required") {
      setRetryAfterStepUp(() => retry);
      setStepUpOpen(true);
      return { ok, data, stepUp: true };
    }
    // Issue #854 (P2.25) — the limiter's own answer drives the countdown.
    if (!ok && httpStatus === 429) applyRetryAfterMs(data.retryAfterMs);
    return { ok, data, stepUp: false };
  }

  /** A first code — to the typed candidate while editing, else to the number on file. */
  async function sendOtp(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setNotice(null);
    const typed = editing ? phoneInput.trim() : "";
    const { ok, data, stepUp } = await post(
      { action: "send", phone: typed || undefined },
      () => void sendOtp(),
    );
    if (stepUp) return;
    if (!ok) {
      setError(phoneErrorMessage(data, "ارسال کد تأیید ممکن نشد."));
      return;
    }
    adoptSentChallenge(data);
    void load();
  }

  /** Re-send the code in flight — the server picks the number and the purpose (F06). */
  async function resendOtp() {
    setNotice(null);
    const { ok, data, stepUp } = await post({ action: "resend" }, () => void resendOtp());
    if (stepUp) return;
    if (!ok) {
      setError(phoneErrorMessage(data, "ارسال مجدد کد ممکن نشد."));
      if (data.error && PHONE_RESTART_ERRORS.has(data.error)) {
        resetCeremony();
        await load();
      }
      return;
    }
    adoptSentChallenge(data);
    setNotice("کد تأیید دوباره ارسال شد.");
    void load();
  }

  async function verifyOtp(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setNotice(null);
    const { ok, data, stepUp } = await post(
      { action: "verify", code: codeInput.trim() },
      () => void verifyOtp(),
    );
    if (stepUp) return;
    if (!ok) {
      setError(phoneErrorMessage(data, "تأیید کد پیامکی ممکن نشد."));
      if (data.error && PHONE_RESTART_ERRORS.has(data.error)) {
        resetCeremony();
        await load();
      }
      return;
    }
    resetCeremony();
    setEditing(false);
    setPhoneInput("");
    setNotice(
      data.purpose === "change_login_phone"
        ? "شمارهٔ موبایل ورود شما تغییر کرد و تأیید شد."
        : "شمارهٔ موبایل ورود شما با موفقیت تأیید شد.",
    );
    await load();
  }

  /** Cancel burns the code on the server, so a reload cannot bring it back (F06). */
  async function cancelOtp() {
    setNotice(null);
    const { ok, data } = await post({ action: "cancel" }, () => void cancelOtp());
    if (!ok) {
      setError(phoneErrorMessage(data, "لغو کد ممکن نشد؛ دوباره تلاش کنید."));
      return;
    }
    resetCeremony();
    setEditing(false);
    setPhoneInput("");
    await load();
  }

  const verified = status?.phoneState === "verified";

  return (
    <SectionCard
      title="شمارهٔ موبایل ورود"
      description="برای ورود با کد پیامکی؛ پس از هر تأیید شماره، رمز عددی تا ۷ روز برای همهٔ ورودهای این عضویت کار می‌کند (نه فقط یک دستگاه)."
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <CloudManagedNotice surface={surface ?? status?.credential} />

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
      ) : pending ? (
        <form onSubmit={verifyOtp} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {pending.purpose === "change_login_phone"
              ? "کد ۶ رقمی ارسال‌شده به شمارهٔ جدید"
              : "کد ۶ رقمی ارسال‌شده به"}{" "}
            <span dir="ltr">{toPersianDigits(pending.maskedPhone ?? "")}</span> را وارد کنید:
          </p>
          {/*
            Issue #854 (P2.25) — the challenge has a deadline; say how long is
            left instead of letting a correct-looking code fail unexplained.
          */}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {expired
              ? "اعتبار این کد تمام شده است؛ برای ادامه، کد تازه‌ای درخواست کنید."
              : smsChallengeExpiryMessage(pending.expiresAt, nowTick)}
          </p>
          {expired ? (
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                type="button"
                onClick={() => {
                  // The server has already let the code lapse; start over from
                  // the right place — the number field for a change, the
                  // «ارسال کد تأیید» button for a re-verification.
                  resetCeremony();
                  setEditing(pending.purpose === "change_login_phone");
                  setPhoneInput("");
                  void load();
                }}
                disabled={busy}
              >
                درخواست کد تازه
              </PrimaryButton>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-44 flex-1">
                <input
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-label="کد ۶ رقمی تأیید"
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
                onClick={() => void resendOtp()}
                disabled={busy || coolingDown}
              >
                {coolingDown
                  ? `ارسال مجدد کد (${toPersianDigits(resendWait)})`
                  : "ارسال مجدد کد"}
              </SecondaryButton>
              <SecondaryButton type="button" onClick={() => void cancelOtp()} disabled={busy}>
                انصراف
              </SecondaryButton>
            </div>
          )}
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
                    autoComplete="tel"
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
 *
 * #854 follow-up:
 *  - **F07** — `pin_unchanged` is refused server-side (against the member's
 *    own PIN only) and said in Persian here;
 *  - **F08** — all three PIN fields are masked (`type="password"`) while still
 *    opening the numeric keyboard and normalising Persian/Arabic digits, so a
 *    PIN typed at a shared till is not readable over a shoulder;
 *  - a `recent_auth_required` refusal now retries the same change after the
 *    step-up instead of making the member submit the form again.
 */

/** Shared attributes of a masked numeric secret field (#854 F08). */
const PIN_INPUT_PROPS = {
  type: "password",
  dir: "ltr",
  inputMode: "numeric",
  // Not "new-password": a password manager's generated suggestion is never a PIN.
  autoComplete: "off",
  maxLength: 12,
  required: true,
} as const;

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

  async function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (confirmPin !== newPin) {
      setError(PIN_ERROR_MESSAGES.pin_confirmation_mismatch);
      return;
    }
    if (status?.hasPin && currentPin === newPin) {
      setError(PIN_ERROR_MESSAGES.pin_unchanged);
      return;
    }
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
        // Same values, same request, once the session is fresh again.
        setRetryAfterStepUp(() => () => void submit());
        setStepUpOpen(true);
        return;
      }
      setError(
        data.message ||
          (data.error && PIN_ERROR_MESSAGES[data.error]) ||
          (httpStatus === 0
            ? "ارتباط با سرور برقرار نشد و رمز عددی تغییر نکرد؛ دوباره تلاش کنید."
            : "تغییر رمز عددی ممکن نشد."),
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
                    {...PIN_INPUT_PROPS}
                    value={currentPin}
                    onChange={(e) => setCurrentPin(normalizeSecurityDigits(e.target.value, 12))}
                    className={inputClass}
                  />
                </Field>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="رمز عددی جدید" hint={status.pinPolicyHint}>
                  <input
                    {...PIN_INPUT_PROPS}
                    value={newPin}
                    onChange={(e) => setNewPin(normalizeSecurityDigits(e.target.value, 12))}
                    className={inputClass}
                  />
                </Field>
                <Field label="تکرار رمز عددی جدید">
                  <input
                    {...PIN_INPUT_PROPS}
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(normalizeSecurityDigits(e.target.value, 12))}
                    className={inputClass}
                  />
                </Field>
              </div>
              <div className="flex gap-2">
                <PrimaryButton
                  type="submit"
                  disabled={busy || !newPin || !confirmPin || (status.hasPin && !currentPin)}
                >
                  {busy ? "در حال ذخیره…" : "ذخیرهٔ رمز عددی"}
                </PrimaryButton>
                <SecondaryButton
                  onClick={() => {
                    setOpen(false);
                    setCurrentPin("");
                    setNewPin("");
                    setConfirmPin("");
                    setError(null);
                  }}
                  disabled={busy}
                >
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
