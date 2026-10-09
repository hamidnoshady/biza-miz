"use client";

/**
 * Phase 20 Wave 7 — the admin security center's first landing point
 * (team.manage-gated, same permission as shift history and the audit log):
 * every employee currently signed in, on which device, with a way to end a
 * session immediately; and the most recent failed PIN/biometric login
 * attempts, previously invisible to any admin view (Wave 6's third open
 * question). The full history of every security event — including these
 * same sessions' own creation/revocation — stays the audit log tab's job;
 * this tab is the actionable subset, not a replacement for it.
 *
 * Phase 20 Wave 8 — a third section, "کارمندان قفل‌شده": repeated failed
 * attempts (LOGIN_LOCKOUT_THRESHOLD within LOGIN_LOCKOUT_WINDOW_MINUTES, see
 * employee.ts's lockoutStatus) now automatically blocks further login
 * attempts for that employee, not just showing up in the list below — this
 * section is where an owner/manager sees who's currently locked and can end
 * it early instead of waiting out the window.
 *
 * Every section loads, fails and refreshes on its own: one request going
 * down (or one fetch throwing) must not leave the other cards spinning
 * skeletons forever, and feedback from an action shows in the card that
 * action lives in — a lockout cleared up top never prints its notice inside
 * the sessions card below.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { credentialKindFromId, credentialKindLabel } from "@/lib/audit";
import { formatPhoneDisplay } from "@/lib/phone";
import { roleLabel } from "@/lib/role-labels";
import { ErrorBox, InfoBox, api, errorMessage } from "@/app/dashboard/ui";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";

interface ActiveSession {
  id: string;
  employeeName: string;
  role: string;
  deviceLabel: string | null;
  credentialId: string | null;
  issuedAt: string;
  lastSeenAt: string | null;
}

interface FailedAttempt {
  id: number;
  entityName: string | null;
  createdAt: string;
  payload: unknown;
}

interface LockedEmployee {
  employeeId: string;
  employeeName: string;
  failedCount: number;
  lockedUntil: string;
}

/** A lockout window is measured in minutes, so every timestamp here carries the time of day. */
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return toPersianDigits(formatJalali(iso, { withMonthName: true, withTime: true }));
}

/**
 * Every `reason` the login routes write with `auditLoginFailure`. Anything
 * unmapped stays out of the UI (the «—» at the call site) rather than
 * leaking a raw English code like "invalid_pin_reverify" into a Persian list.
 */
const FAILURE_REASONS: Record<string, string> = {
  invalid_pin: "پین نادرست",
  invalid_pin_reverify: "تأیید مجدد پین ناموفق",
  invalid_assertion: "احرازهویت بیومتریک ناموفق",
  employee_inactive: "کارمند غیرفعال",
  invalid_phone_otp: "کد پیامکی ورود نادرست",
};

function failureReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" ? (FAILURE_REASONS[reason] ?? null) : null;
}

/** Card-header refresh control; spins while any section of the tab is reloading. */
function RefreshButton({ refreshing, onClick }: { refreshing: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="xs" disabled={refreshing} onClick={onClick}>
      <RefreshCwIcon aria-hidden="true" className={refreshing ? "ops-sync-rotate" : undefined} />
      به‌روزرسانی
    </Button>
  );
}

export function SecurityCenterSettings() {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState("");
  const [sessionsNotice, setSessionsNotice] = useState("");
  const [failedAttempts, setFailedAttempts] = useState<FailedAttempt[] | null>(null);
  const [attemptsError, setAttemptsError] = useState("");
  const [lockedEmployees, setLockedEmployees] = useState<LockedEmployee[] | null>(null);
  const [lockoutsError, setLockoutsError] = useState("");
  const [lockoutsNotice, setLockoutsNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [busyEmployeeId, setBusyEmployeeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      // allSettled: a network-level rejection on one request is a card-level
      // error message, not an unhandled rejection that blanks all three cards.
      const [sessionsResult, attemptsResult, lockoutsResult] = await Promise.allSettled([
        api<{ sessions: ActiveSession[]; error?: string }>("/api/sessions"),
        api<{ entries: FailedAttempt[]; error?: string }>(
          "/api/audit-log?action=employee.login_failed&limit=20",
        ),
        api<{ lockouts: LockedEmployee[]; error?: string }>("/api/security/lockouts"),
      ]);

      if (sessionsResult.status === "fulfilled" && sessionsResult.value.ok) {
        setSessions(sessionsResult.value.data.sessions);
        setSessionsError("");
      } else {
        setSessionsError(
          errorMessage(sessionsResult.status === "fulfilled" ? sessionsResult.value.data.error : undefined),
        );
      }

      if (attemptsResult.status === "fulfilled" && attemptsResult.value.ok) {
        setFailedAttempts(attemptsResult.value.data.entries);
        setAttemptsError("");
      } else {
        setAttemptsError(
          errorMessage(attemptsResult.status === "fulfilled" ? attemptsResult.value.data.error : undefined),
        );
      }

      if (lockoutsResult.status === "fulfilled" && lockoutsResult.value.ok) {
        setLockedEmployees(lockoutsResult.value.data.lockouts);
        setLockoutsError("");
      } else {
        setLockoutsError(
          errorMessage(lockoutsResult.status === "fulfilled" ? lockoutsResult.value.data.error : undefined),
        );
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function endSession(id: string) {
    setBusySessionId(id);
    setSessionsError("");
    setSessionsNotice("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/sessions/${id}`, { method: "DELETE" });
      if (!ok) {
        setSessionsError(errorMessage(data.error));
        return;
      }
      setSessionsNotice("نشست پایان یافت.");
      await load();
    } catch {
      setSessionsError(errorMessage(undefined));
    } finally {
      setBusySessionId(null);
    }
  }

  async function clearLockout(employeeId: string) {
    setBusyEmployeeId(employeeId);
    setLockoutsError("");
    setLockoutsNotice("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/security/lockouts/${employeeId}`, {
        method: "DELETE",
      });
      if (!ok) {
        setLockoutsError(errorMessage(data.error));
        return;
      }
      setLockoutsNotice("قفل ورود برداشته شد.");
      await load();
    } catch {
      setLockoutsError(errorMessage(undefined));
    } finally {
      setBusyEmployeeId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PhoneLoginCard />
      <TrustedDevicesCard />

      <SectionCard
        title="دسترسی پشتیبانی"
        description="نشست‌های فعال و تاریخچهٔ ورود تیم پشتیبانی را ببینید، سیاست دسترسی را تعیین کنید یا یک نشست را فوراً پایان دهید."
        actions={<Button asChild variant="outline"><Link href="/settings/security/support-access">مدیریت دسترسی پشتیبانی</Link></Button>}
      />

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">امنیت و دسترسی</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">کارمندان قفل‌شده</h2>
          </div>
        }
        description="به‌دلیل تلاش‌های ناموفق مکرر، ورود این کارکنان موقتاً مسدود شده است."
        actions={<RefreshButton refreshing={refreshing} onClick={() => void load()} />}
      >
        <ErrorBox>{lockoutsError}</ErrorBox>
        <InfoBox>{lockoutsNotice}</InfoBox>

        {lockedEmployees === null && !lockoutsError && <LoadingSkeleton rows={2} />}
        {lockedEmployees !== null && lockedEmployees.length === 0 && (
          <p className="text-sm text-muted-foreground">هیچ کارمندی قفل نیست.</p>
        )}
        {lockedEmployees !== null && lockedEmployees.length > 0 && (
          <div className="space-y-2">
            {lockedEmployees.map((entry) => (
              <div
                key={entry.employeeId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-input px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium break-words">{entry.employeeName}</p>
                  <p className="text-xs text-muted-foreground">
                    {toPersianDigits(String(entry.failedCount))} تلاش ناموفق پیاپی · تا{" "}
                    {formatTime(entry.lockedUntil)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => clearLockout(entry.employeeId)}
                  disabled={busyEmployeeId === entry.employeeId}
                >
                  رفع قفل
                </Button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">نشست‌ها و دستگاه‌ها</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">نشست‌های فعال</h2>
          </div>
        }
        description="کارکنانی که هم‌اکنون وارد سیستم هستند. پایان‌دادن به یک نشست بلافاصله اثر می‌کند."
        actions={<RefreshButton refreshing={refreshing} onClick={() => void load()} />}
      >
        <ErrorBox>{sessionsError}</ErrorBox>
        <InfoBox>{sessionsNotice}</InfoBox>

        {sessions === null && !sessionsError && <LoadingSkeleton rows={3} />}
        {sessions !== null && sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">هیچ نشست فعالی وجود ندارد.</p>
        )}
        {sessions !== null && sessions.length > 0 && (
          <div className="space-y-2">
            {sessions.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-input px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium break-words">{entry.employeeName}</p>
                  <p className="text-xs text-muted-foreground">
                    {credentialKindLabel(credentialKindFromId(entry.credentialId))}
                    {entry.deviceLabel ? ` · ${entry.deviceLabel}` : ""}
                    {/* No last_seen_at yet means the session was *just* minted;
                        the issued time is its login time, not an activity. */}
                    {entry.lastSeenAt
                      ? ` · آخرین فعالیت: ${formatTime(entry.lastSeenAt)}`
                      : ` · زمان ورود: ${formatTime(entry.issuedAt)}`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => endSession(entry.id)}
                  disabled={busySessionId === entry.id}
                >
                  پایان نشست
                </Button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ممیزی ورود</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">تلاش‌های ورود ناموفق</h2>
          </div>
        }
        description="آخرین تلاش‌های ناموفق ورود با پین، بیومتریک یا کد پیامکی."
        actions={<RefreshButton refreshing={refreshing} onClick={() => void load()} />}
      >
        <ErrorBox>{attemptsError}</ErrorBox>

        {failedAttempts === null && !attemptsError && <LoadingSkeleton rows={3} />}
        {failedAttempts !== null && failedAttempts.length === 0 && (
          <p className="text-sm text-muted-foreground">تلاش ناموفقی ثبت نشده است.</p>
        )}
        {failedAttempts !== null && failedAttempts.length > 0 && (
          <div className="space-y-2">
            {failedAttempts.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-input px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 font-medium break-words">{entry.entityName ?? "کارمند ناشناس"}</p>
                  <p className="shrink-0 text-xs text-muted-foreground">{formatTime(entry.createdAt)}</p>
                </div>
                <p className="text-xs text-muted-foreground">{failureReason(entry.payload) ?? "—"}</p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * Phase 42 — the phone-login card: the member's own number, and the
 * business's adoption window.
 *
 * Two halves, and both exist because a 14-day window only works if someone
 * can see it counting down and spend it: the top half is the signed-in
 * member setting and verifying *their own* number (the OTP proves
 * possession, which is why it lives here and not on the team screen), and
 * the bottom half is the owner's view of the whole door — the countdown, and
 * the list of members whose number is still missing or unproven, exactly the
 * list to work through before the date arrives.
 */
interface PhoneSelfState {
  phone: string | null;
  phoneState: "none" | "unverified" | "verified";
  otpWindowOpen: boolean;
  policy: { state: "off" | "grace" | "pending_sms" | "enforced"; daysLeft: number | null };
}

interface TeamPhoneMember {
  id: string;
  fullName: string;
  role: string;
  isActive: boolean;
  phone: string | null;
  phoneVerified: boolean;
}

function PhoneLoginCard() {
  const [state, setState] = useState<PhoneSelfState | null>(null);
  const [members, setMembers] = useState<TeamPhoneMember[] | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  /**
   * Issue #885 L02 — the challenge the last `send` minted, echoed back on
   * `verify`. Verification is bound to the exact code that was sent rather
   * than to "the newest one for this member", so a stale pair simply fails
   * instead of quietly matching something else.
   */
  const [challenge, setChallenge] = useState<{
    challengeId: string;
    destination: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const [selfResult, teamResult] = await Promise.allSettled([
      api<PhoneSelfState & { error?: string }>("/api/auth/phone/self"),
      // The security center is team.manage-gated like every tab it shares,
      // so the member list is readable from here; a 403 would mean the tab
      // was reached without it, in which case the self half still matters.
      api<{ members?: TeamPhoneMember[]; error?: string }>("/api/team"),
    ]);
    if (selfResult.status === "fulfilled" && selfResult.value.ok) {
      setState(selfResult.value.data);
      setError("");
    } else {
      setError(
        errorMessage(selfResult.status === "fulfilled" ? selfResult.value.data.error : undefined),
      );
    }
    if (teamResult.status === "fulfilled" && teamResult.value.ok) {
      setMembers(teamResult.value.data.members ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    let ok: boolean;
    let data: {
      status?: string;
      maskedPhone?: string;
      error?: string;
      message?: string;
      retryAfterMs?: number;
      challengeId?: string | null;
      destination?: string | null;
    };
    try {
      ({ ok, data } = await api<typeof data>("/api/auth/phone/self", {
        method: "POST",
        body: JSON.stringify(body),
      }));
    } catch {
      setBusy(false);
      setError(errorMessage(undefined));
      return null;
    }
    setBusy(false);
    if (!ok) {
      const map: Record<string, string> = {
        invalid_phone: "شمارهٔ موبایل معتبر نیست.",
        phone_missing: "شماره‌ای برای ارسال کد ثبت نشده است.",
        invalid_code: "کد واردشده درست نیست.",
        sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",
        rate_limited: "درخواست‌های پیاپی مجاز نیست؛ کمی صبر کنید.",
        account_locked: "حساب شما موقتاً قفل شده است.",
        code_expired: "مهلت این کد تمام شده است. کد تازه‌ای درخواست دهید.",
        challenge_required: "ابتدا کد را ارسال کنید.",
      };
      setError(data.message ?? map[data.error ?? ""] ?? errorMessage(data.error));
      return null;
    }
    return data;
  }

  async function sendCode() {
    const target = phone.trim() || state?.phone || "";
    const data = await post({ action: "send", ...(phone.trim() ? { phone: phone.trim() } : {}) });
    if (data) {
      setCodeSentTo(data.maskedPhone ?? target);
      // Issue #885 L02 — remember which challenge this send minted, so the
      // verify below redeems that one and nothing else.
      setChallenge(
        data.challengeId && data.destination
          ? { challengeId: data.challengeId, destination: data.destination }
          : null,
      );
      // Clear any half-typed digits from a previous try on resend.
      setCode("");
    }
  }

  async function verifyCode() {
    if (!challenge) {
      setError("ابتدا کد را ارسال کنید.");
      return;
    }
    const data = await post({
      action: "verify",
      code,
      challengeId: challenge.challengeId,
      destination: challenge.destination,
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    });
    if (data) {
      setNotice("شمارهٔ موبایل تأیید شد. از این پس می‌توانید با همین شماره وارد شوید.");
      setPhone("");
      setCode("");
      setCodeSentTo(null);
      setChallenge(null);
      await load();
    }
  }

  const unverified = (members ?? []).filter((m) => m.isActive && !(m.phone && m.phoneVerified));
  const typedPhone = phone.trim();

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">امنیت و دسترسی</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">ورود با شمارهٔ موبایل</h2>
        </div>
      }
      description="هر عضو با شمارهٔ موبایل خود و یک کد پیامکی وارد می‌شود؛ رمز عددی تا ۷ روز بعد از هر تأیید کار می‌کند."
    >
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      {state === null ? (
        error ? (
          <Button type="button" variant="outline" size="xs" onClick={() => void load()}>
            تلاش مجدد
          </Button>
        ) : (
          <LoadingSkeleton rows={2} />
        )
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">شمارهٔ شما:</span>
            {state.phone ? (
              <>
                <span dir="ltr">{toPersianDigits(formatPhoneDisplay(state.phone))}</span>
                {state.phoneState === "verified" ? (
                  <span className="rounded-full bg-emerald-600/10 px-2.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                    تأییدشده
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-600/10 px-2.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                    تأییدنشده
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">ثبت نشده</span>
            )}
          </div>

          {!codeSentTo ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-52 grow sm:grow-0">
                <label className="mb-1 block text-sm text-muted-foreground" htmlFor="phone-self">
                  {state.phone ? "تغییر شماره (اختیاری)" : "شمارهٔ موبایل"}
                </label>
                <input
                  id="phone-self"
                  dir="ltr"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="09121234567"
                  className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
                />
              </div>
              <Button
                type="button"
                disabled={busy || (!typedPhone && !(state.phone && state.phoneState !== "verified"))}
                onClick={() => void sendCode()}
              >
                {/* The button's only job is sending a code — the verify step is
                    the next screen, so name it after what actually happens. */}
                {typedPhone ? "ارسال کد به شمارهٔ جدید" : "ارسال کد تأیید"}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                کد پیامک‌شده به <span dir="ltr">{toPersianDigits(codeSentTo)}</span> را وارد کنید.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-36 grow sm:grow-0">
                  <label className="mb-1 block text-sm text-muted-foreground" htmlFor="phone-self-code">
                    کد ۶ رقمی
                  </label>
                  <input
                    id="phone-self-code"
                    dir="ltr"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="------"
                    className="w-full rounded-lg border border-input px-3 py-2 text-center tracking-[0.3em] focus:border-primary focus:outline-none"
                  />
                </div>
                <Button type="button" disabled={busy || code.length !== 6} onClick={() => void verifyCode()}>
                  تأیید کد
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void sendCode()}>
                  ارسال دوبارهٔ کد
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setCodeSentTo(null);
                    setCode("");
                  }}
                >
                  تغییر شماره
                </Button>
              </div>
            </div>
          )}

          {state.policy.state === "grace" && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <p className="font-semibold">
                ورود با کد پیامکی از این تاریخ برای همه الزامی می‌شود
                {state.policy.daysLeft !== null
                  ? ` — ${toPersianDigits(String(state.policy.daysLeft))} روز دیگر`
                  : ""}
              </p>
              <p className="mt-1 text-muted-foreground">
                تا آن زمان ورود با رمز عددی بدون تغییر می‌ماند؛ همین حالا شماره‌ها را ثبت و تأیید کنید.
              </p>
            </div>
          )}
          {state.policy.state === "pending_sms" && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
              تاریخ الزام رسیده اما سرویس پیامک (کاوه‌نگار) هنوز تنظیم نشده است؛ تا تنظیم آن، ورود با رمز عددی بدون تغییر می‌ماند.
            </div>
          )}
          {state.policy.state === "enforced" && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-muted-foreground">
              ورود با کد پیامکی فعال است؛ هر عضو هر ۷ روز یک‌بار با کد پیامکی وارد می‌شود.
            </div>
          )}

          {members !== null && state.policy.state !== "off" && (
            <div>
              <p className="mb-2 text-sm font-medium">
                اعضای بدون شمارهٔ تأییدشده ({toPersianDigits(String(unverified.length))})
              </p>
              {unverified.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  همهٔ اعضای فعال شمارهٔ تأییدشده دارند.
                </p>
              ) : (
                <ul className="divide-y divide-border/80 rounded-lg border border-input text-sm">
                  {unverified.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 break-words">
                        {m.fullName}
                        <span className="ms-2 text-xs text-muted-foreground">{roleLabel(m.role)}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {m.phone ? "تأییدنشده" : "بدون شماره"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                شمارهٔ اعضا را از «تیم» ثبت کنید؛ هر عضو شماره‌اش را با یک کد پیامکی تأیید می‌کند.
              </p>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** What `/api/auth/trusted-devices` answers for the caller's own membership. */
interface TrustedDevice {
  id: string;
  deviceLabel: string | null;
  factorSummary: string | null;
  trustedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/**
 * Issue #885 — the seven-day trusted devices this member has earned.
 *
 * The policy is that skipping a routine OTP/MFA on a known device must stay
 * visible and revocable: trust is a convenience granted by a verification, and
 * the moment that device is lost, lent or sold the member needs a way to take
 * it back without waiting seven days for it to lapse on its own.
 *
 * Listed per membership, from the session, so this card can only ever show or
 * clear the caller's own devices. It is deliberately separate from the
 * "remember login type" preference on the login screen: that one is a
 * device-local UI shortcut stored in localStorage and worth nothing; this one
 * is a server-side credential that waives a verification step.
 */
function TrustedDevicesCard() {
  const [devices, setDevices] = useState<TrustedDevice[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { ok, data } = await api<{ devices: TrustedDevice[]; error?: string }>(
        "/api/auth/trusted-devices",
      );
      if (ok) {
        setDevices(data.devices);
        setError("");
      } else {
        setError(errorMessage(data.error));
      }
    } catch {
      setError(errorMessage(undefined));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      const { ok, data } = await api<{ error?: string }>("/api/auth/trusted-devices", {
        method: "DELETE",
        body: JSON.stringify({ id }),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setNotice("اعتماد این دستگاه لغو شد؛ ورود بعدی از آن دوباره تأیید می‌خواهد.");
      await load();
    } catch {
      setError(errorMessage(undefined));
    } finally {
      setBusyId(null);
    }
  }

  const live = (devices ?? []).filter((d) => !d.revokedAt);
  const past = (devices ?? []).filter((d) => d.revokedAt);

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">امنیت و دسترسی</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">
            دستگاه‌های مورد اعتماد
          </h2>
        </div>
      }
      description="دستگاه‌هایی که پس از تأیید کامل، برای ۷ روز از پرسش دوبارهٔ کد پیامکی یا ورود دومرحله‌ای معاف شده‌اند. رمز عبور یا پین در هر ورود همچنان لازم است."
      actions={<RefreshButton refreshing={busyId !== null} onClick={() => void load()} />}
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice && !error ? <InfoBox>{notice}</InfoBox> : null}

      {devices === null ? (
        <LoadingSkeleton rows={2} />
      ) : live.length === 0 && past.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          هیچ دستگاهی را برای این حساب اعتماد نکرده‌اید. در ورود بعدی می‌توانید
          «اعتماد به این دستگاه برای ۷ روز» را انتخاب کنید.
        </p>
      ) : (
        <ul className="space-y-2">
          {[...live, ...past].map((device) => {
            const revoked = Boolean(device.revokedAt);
            const expired = new Date(device.expiresAt).getTime() <= Date.now();
            const state = revoked
              ? "لغو شده"
              : expired
                ? "منقضی شده"
                : `تا ${formatTime(device.expiresAt)} معتبر است`;
            return (
              <li
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {device.deviceLabel || "دستگاه ناشناخته"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {state}
                    {device.lastSeenAt ? ` · آخرین استفاده ${formatTime(device.lastSeenAt)}` : ""}
                  </p>
                </div>
                {!revoked ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === device.id}
                    onClick={() => void revoke(device.id)}
                  >
                    لغو اعتماد
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
