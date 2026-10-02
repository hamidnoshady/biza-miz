"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cardClass } from "@/app/dashboard/page-chrome";
import { Skeleton } from "@/components/ui/skeleton";
import {
  browserSupportsWebAuthn,
  startAuthentication,
} from "@simplewebauthn/browser";
import { PinPad } from "@/components/auth/pin-pad";
import { PhoneOtpStep, type PhoneOtpSendSpec } from "@/components/auth/phone-otp-step";
import {
  ChangeLoginTypeLink,
  LoginDoorChooser,
  OfflineLoginNote,
  type DoorChoice,
} from "@/components/auth/login-door-chooser";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { readDeviceToken } from "@/lib/device-token";
import { clearRememberedLoginDoor, readRememberedLoginDoor } from "@/lib/login-door";
import { CloudLoginButton } from "@/components/auth/cloud-login-button";
import {
  lockoutMessage,
  retryAfterMs,
  useNextPath,
} from "@/components/auth/login-helpers";
import { roleLabel } from "@/lib/role-labels";

/**
 * The client half of the login page. Kept separate from the route so the
 * route itself can be a server component that resolves host aliases (Phase
 * 23): a visit to a renamed business's *old* host is forwarded to the current
 * host's login before this form ever renders, because a session minted on an
 * alias host can never stick.
 *
 * Since the login split this page is the *staff* door only: name-then-PIN
 * (plus biometrics where registered). The owner/manager password login moved
 * to the tenant origin's `/admin` subdirectory (src/app/admin), so the till's
 * front screen no longer offers a password form — the business's origin simply
 * *is* the staff quick login.
 *
 * Phase 42 added the phone axis to the same door. After a name is picked, the
 * step the door shows follows that member's `loginMode` (decided server-side
 * by the roster): the PIN pad as before, the OTP screen for a member whose
 * 7-day PIN window has closed or whose number is still unproven, or the PIN
 * pad followed by a set-and-verify number for a member with none on file.
 * Under the roster, «ورود با شمارهٔ موبایل» opens the direct phone login that
 * every member — managers and owners included — can use once their number is
 * verified; admins keep the email+password door at /admin.
 *
 * Login-type chooser (audit fix): before this fix the route jumped straight
 * into the staff roster on every single visit — a fresh install, a brand-new
 * browser, a cleared profile — with no way to discover that `/admin` existed
 * at all. `LoginDoorChooser` is the missing front door: shown once per
 * browser unless that browser asked to be remembered, and always reachable
 * again through «تغییر نوع ورود» underneath the roster, so a device that
 * picked "staff" and needs to switch to "admin" (or just doesn't want to be
 * remembered anymore) is never stuck.
 */
export default function LoginForm() {
  // `null` = "not decided yet" (still reading localStorage, first paint must
  // not flash the wrong screen); `false` = show the chooser now.
  const [remembered, setRemembered] = useState<boolean | null>(null);
  const [offlineNote, setOfflineNote] = useState(false);

  useEffect(() => {
    setRemembered(readRememberedLoginDoor() === "staff");
  }, []);

  function chooseDoor(choice: DoorChoice) {
    // "admin" already navigated away inside the chooser; only "staff" and
    // "offline" (the same staff door, with a note) render in place.
    setOfflineNote(choice === "offline");
    setRemembered(true);
  }

  function changeLoginType() {
    clearRememberedLoginDoor();
    setRemembered(false);
    setOfflineNote(false);
  }

  if (remembered === null) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className={`w-full max-w-sm ${cardClass} p-8`}>
          <Skeleton className="mx-auto mb-2 h-6 w-40" />
          <Skeleton className="mx-auto mb-6 h-4 w-28" />
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (!remembered) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-3xl">
          <LoginDoorChooser onChoose={chooseDoor} />
          <div className="mx-auto max-w-sm">
            <CloudLoginButton />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className={`w-full max-w-sm ${cardClass} p-8`}>
        <h1 className="mb-1 text-center text-xl font-bold">
          پلتفرم مدیریت کسب‌وکار
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          ورود سریع کارکنان
        </p>

        <PinLogin />
        <CloudLoginButton />
        {offlineNote ? <OfflineLoginNote /> : null}
        <ChangeLoginTypeLink onClick={changeLoginType} />
      </div>
    </main>
  );
}

interface RosterEmployee {
  id: string;
  fullName: string;
  role: string;
  photoUrl: string | null;
  hasWebauthn: boolean;
  /** Phase 42 — which step follows this name; decided server-side, never re-derived here. */
  loginMode: "pin" | "otp" | "pin_then_otp";
  phoneState: "none" | "unverified" | "verified";
}

/** Phase 42 — the business's phone-OTP adoption state, once per roster load. */
interface RosterPolicy {
  state: "off" | "grace" | "pending_sms" | "enforced";
  daysLeft: number | null;
  enforcedAt: string | null;
}

/** Device-local "who signed in here recently" — never synced, just a UI shortcut. */
const RECENTS_KEY = "pos:lastEmployees";
const MAX_RECENTS = 5;

/**
 * Why the staff list did not arrive. They are told apart because they read
 * completely differently to the person standing at the till, and because only
 * one of them is worth waiting out:
 *
 *  - `rate_limited` — a 429: the per-IP ceiling on this read is momentarily
 *    spent (every terminal in the building shares one address, and this page
 *    loads on every visit to the business's origin), which clears by itself
 *    in seconds.
 *  - `no_business` — the server could not say which business this origin
 *    belongs to (`unknown_business`/`business_required`). Nothing the cashier
 *    can retry their way out of: it is a deployment that has not been pointed
 *    at a tenant, so the message names that instead of blaming the roster,
 *    and carries the operator-facing hint in the same shape the unresolvable-
 *    host page uses.
 *  - `error` — anything else, which is a fault worth reporting as one.
 *
 * All three used to render the same dead-end sentence, which is why an origin
 * that simply had no business attached read as "your staff list is broken".
 */
type RosterFailure = "rate_limited" | "no_business" | "error";

const ROSTER_FAILURE_MESSAGES: Record<RosterFailure, string> = {
  rate_limited: "درخواست‌ها از حد مجاز گذشت؛ چند لحظه دیگر دوباره تلاش می‌کنیم.",
  no_business: "این نشانی به کسب‌وکاری وصل نیست؛ با پشتیبانی تماس بگیرید.",
  error: "دریافت فهرست کارکنان ممکن نشد.",
};

/** How many times a 429 is waited out before the retry button is all that is left. */
const MAX_ROSTER_RETRIES = 2;

/**
 * Phase 20 Wave 4 — this terminal's paired-device token, if an owner/manager
 * registered it from Settings → دستگاه‌های ثبت‌شده. `readDeviceToken` is
 * shared with that Settings screen and the self-service biometric panel, so
 * every browser path reads the same optional local identity.
 */

function readRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function rememberRecent(employeeId: string) {
  try {
    const next = [
      employeeId,
      ...readRecents().filter((id) => id !== employeeId),
    ].slice(0, MAX_RECENTS);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode, quota) — the shortcut is a nicety, not a requirement.
  }
}

/**
 * Phase 20 Wave 2 — name-then-login. Step 1 shows the eligible staff (photo,
 * name, role), most-recently-used-on-this-device first; step 2 is whatever
 * that member's door step is — the PIN pad (Phase 42: PINs are 4–12 digits
 * now), the OTP screen, or the PIN pad followed by «شمارهٔ موبایل».
 */
function PinLogin() {
  const router = useRouter();
  const next = useNextPath("/dashboard");
  const [employees, setEmployees] = useState<RosterEmployee[] | null>(null);
  const [policy, setPolicy] = useState<RosterPolicy | null>(null);
  const [rosterFailure, setRosterFailure] = useState<RosterFailure | null>(null);
  /** Bumped by the retry button; the roster effect keys off it. */
  const [rosterReloadKey, setRosterReloadKey] = useState(0);
  const [selected, setSelected] = useState<RosterEmployee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [webauthnSupported, setWebauthnSupported] = useState(false);

  /** The door's step for the selected member: the pad, the number input, or the OTP. */
  const [doorStep, setDoorStep] = useState<"pin" | "set_phone" | "otp">("pin");
  /**
   * Phase 42 — the ten-minute `phone_pending` token pin-login hands back when
   * the PIN was proven but the phone step must run first. Carries the member
   * (and, after the number input, the candidate number) through
   * request/verify.
   */
  const [pinPending, setPinPending] = useState<{ token: string; maskedPhone: string | null } | null>(null);
  /** The member chose to verify their number on this login (the adoption-window button). */
  const [verifyMode, setVerifyMode] = useState(false);
  /** The set-phone input (first-time verify, nothing on file yet). */
  const [phoneInput, setPhoneInput] = useState("");
  /**
   * The live OTP exchange: `otpSpec` is how the next send is addressed (set
   * the moment a send starts, so a failed first send can be retried), and
   * `otpSent` is what came back — the pending token and masked number the
   * code entry runs on.
   */
  const [otpSpec, setOtpSpec] = useState<PhoneOtpSendSpec | null>(null);
  const [otpSent, setOtpSent] = useState<{ token: string; maskedPhone: string | null } | null>(null);

  /** The direct «ورود با شمارهٔ موبایل» tab — offered once the policy turns the feature on. */
  const [phoneTab, setPhoneTab] = useState(false);
  const [tabPhone, setTabPhone] = useState("");
  const [tabBusinesses, setTabBusinesses] = useState<{ id: string; name: string }[] | null>(null);

  useEffect(() => {
    // Checked client-side only (guarded, not called during the server render)
    // so the initial HTML never claims support the browser doesn't have.
    setWebauthnSupported(browserSupportsWebAuthn());
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(attempt: number) {
      const deviceToken = readDeviceToken();
      const url = deviceToken
        ? `/api/auth/pin-login/roster?deviceToken=${encodeURIComponent(deviceToken)}`
        : "/api/auth/pin-login/roster";

      let res: Response;
      try {
        res = await fetch(url);
      } catch {
        // Offline, or the server unreachable — the till's own message, not a
        // claim about who works here.
        if (!cancelled) setRosterFailure("error");
        return;
      }

      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {
          employees?: RosterEmployee[];
          policy?: RosterPolicy;
        } | null;
        if (cancelled) return;
        setRosterFailure(null);
        setEmployees(data?.employees ?? []);
        setPolicy(data?.policy ?? null);
        return;
      }

      if (res.status === 429 && attempt < MAX_ROSTER_RETRIES) {
        // Wait out the window the server named instead of parking the screen on
        // an error; a second tablet waking up is not a fault the cashier can
        // do anything about, and it clears on its own.
        if (!cancelled) setRosterFailure("rate_limited");
        timer = setTimeout(
          () => void load(attempt + 1),
          retryAfterMs(res.headers.get("Retry-After")),
        );
        return;
      }

      if (res.status === 429) {
        if (!cancelled) setRosterFailure("rate_limited");
        return;
      }

      // The 400 the login family answers when it cannot name a tenant for this
      // origin. Worth reading the body for: it is the difference between "the
      // roster call failed" and "this address serves no business", and only the
      // second one tells whoever deployed it what to change.
      const reason = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const code = typeof reason?.error === "string" ? reason.error : "";
      if (!cancelled) {
        setRosterFailure(
          code === "unknown_business" || code === "business_required" ? "no_business" : "error",
        );
      }
    }

    void load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [rosterReloadKey]);

  const ordered = useMemo(() => {
    if (!employees) return [];
    const recents = readRecents();
    return [...employees].sort((a, b) => {
      const ra = recents.indexOf(a.id);
      const rb = recents.indexOf(b.id);
      if (ra === -1 && rb === -1)
        return a.fullName.localeCompare(b.fullName, "fa");
      if (ra === -1) return 1;
      if (rb === -1) return -1;
      return ra - rb;
    });
  }, [employees]);

  /** Re-asks for the roster from scratch — the button under a failed load. */
  function retryRoster() {
    setEmployees(null);
    setPolicy(null);
    setRosterFailure(null);
    setRosterReloadKey((key) => key + 1);
  }

  function pick(employee: RosterEmployee) {
    setSelected(employee);
    setError(null);
    setVerifyMode(false);
    setPinPending(null);
    setOtpSpec(null);
    setOtpSent(null);
    setPhoneInput("");
    // The server already decided this member's step (loginMode) — the client
    // only follows it. `otp` means the code is the credential this time: send
    // to the number already on file as soon as the name is picked.
    setDoorStep(employee.loginMode === "otp" ? "otp" : "pin");
    if (employee.loginMode === "otp") {
      void startOtp({ kind: "employee", employeeId: employee.id });
    }
  }

  function goNext(employeeId?: string) {
    if (employeeId) rememberRecent(employeeId);
    router.push(next);
    router.refresh();
  }

  /**
   * Send the first OTP for any of the door's paths, then hand the live
   * exchange to PhoneOtpStep. One function because every path's first send
   * differs only in how it is addressed (see /api/auth/phone-otp/request).
   * The spec is remembered the moment the send starts, so a failed first
   * send has a retry button that re-addresses the exact same send.
   */
  async function startOtp(spec: PhoneOtpSendSpec, employeeId?: string) {
    setBusy(true);
    setError(null);
    setOtpSpec(spec);
    setOtpSent(null);
    setDoorStep("otp");
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let body: Record<string, unknown> = {};
      if (spec.kind === "token") {
        headers.Authorization = `Bearer ${spec.token}`;
        body = { phone: spec.phone };
      } else if (spec.kind === "employee") {
        body = { employeeId: spec.employeeId, businessId: spec.businessId };
      } else {
        body = { phone: spec.phone, businessId: spec.businessId };
      }

      const res = await fetch("/api/auth/phone-otp/request", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        maskedPhone?: string | null;
        error?: string;
        message?: string;
        retryAfterMs?: number;
        needsBusinessSelection?: boolean;
        businesses?: { id: string; name: string }[];
      };

      if (data.needsBusinessSelection) {
        // The typed number belongs to members of more than one business and
        // this origin does not name one — ask which, then re-send addressed
        // to it. (Only the direct tab can land here.)
        setTabBusinesses(data.businesses ?? []);
        return;
      }
      if (res.status === 429) {
        const ms = typeof data.retryAfterMs === "number" ? data.retryAfterMs : 0;
        const seconds = Math.max(1, Math.ceil(ms / 1000));
        setError(`درخواست بعدی تا ${toPersianDigits(String(seconds))} ثانیهٔ دیگر ممکن نیست.`);
        return;
      }
      if (!res.ok || !data.token) {
        const map: Record<string, string> = {
          invalid_phone: "شمارهٔ موبایل معتبر نیست.",
          phone_missing: "برای این حساب شمارهٔ موبایلی ثبت نشده است.",
          sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",
          unauthorized: "مهلت این مرحله تمام شده است؛ از ابتدا تلاش کنید.",
        };
        setError(data.message ?? map[data.error ?? ""] ?? "ارسال کد ممکن نشد.");
        return;
      }

      setTabBusinesses(null);
      setOtpSent({ token: data.token, maskedPhone: data.maskedPhone ?? null });
      if (employeeId) rememberRecent(employeeId);
    } catch {
      setError("ارتباط با سرور برقرار نشد.");
    } finally {
      setBusy(false);
    }
  }

  async function submitPin(pin: string) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/pin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin,
        employeeId: selected.id,
        deviceToken: readDeviceToken(),
        // The adoption-window button: prove the PIN, then verify the number
        // this same login — the OTP step that follows is voluntary today and
        // becomes the gate the day the window closes.
        ...(verifyMode ? { verifyPhone: true } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      phoneVerification?: "otp" | "set_phone";
      phoneToken?: string;
      maskedPhone?: string | null;
      lockedUntil?: unknown;
    };
    setBusy(false);

    if (res.status === 423) {
      setError(lockoutMessage(data.lockedUntil));
      return;
    }

    if (res.ok) {
      if (data.phoneVerification && data.phoneToken) {
        // PIN proven, phone step owed. `otp` — a number is on file (unproven,
        // or proven with a closed window): send to it straight away.
        // `set_phone` — nothing on file: ask for the number first.
        setPinPending({ token: data.phoneToken, maskedPhone: data.maskedPhone ?? null });
        if (data.phoneVerification === "otp") {
          await startOtp({ kind: "token", token: data.phoneToken });
        } else {
          setDoorStep("set_phone");
        }
        return;
      }
      goNext(selected.id);
      return;
    }

    setError("پین نادرست است.");
  }

  async function submitBiometric() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const deviceToken = readDeviceToken();
      const optionsRes = await fetch("/api/auth/webauthn/login/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: selected.id, deviceToken }),
      });
      if (!optionsRes.ok) throw new Error("no_credentials");
      const { options, challengeToken } = await optionsRes.json();

      const response = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/webauthn/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: selected.id,
          response,
          challengeToken,
          deviceToken,
        }),
      });
      if (verifyRes.status === 423) {
        const data = await verifyRes.json().catch(() => ({}));
        setError(
          lockoutMessage((data as { lockedUntil?: unknown }).lockedUntil),
        );
        return;
      }
      if (!verifyRes.ok) throw new Error("invalid_credentials");

      goNext(selected.id);
    } catch {
      // Covers a failed verification as well as the user cancelling the
      // browser's own biometric prompt — either way, the PIN pad below is
      // always right there as a fallback, so this doesn't need to explain
      // which happened.
      setError("ورود بیومتریک ناموفق بود؛ از پین استفاده کنید.");
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // The direct phone tab
  // -------------------------------------------------------------------------
  if (phoneTab) {
    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              setPhoneTab(false);
              setTabBusinesses(null);
              setError(null);
              setOtpSpec(null);
              setOtpSent(null);
            }}
            className="rounded text-sm text-muted-foreground hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            ← بازگشت
          </button>
          <span className="text-sm font-semibold">ورود با شمارهٔ موبایل</span>
        </div>

        {otpSent && otpSpec ? (
          <PhoneOtpStep
            sendSpec={otpSpec}
            initialToken={otpSent.token}
            initialMaskedPhone={otpSent.maskedPhone}
            deviceToken={readDeviceToken()}
            onVerified={() => goNext()}
            onCancel={() => {
              setOtpSpec(null);
              setOtpSent(null);
              setError(null);
            }}
          />
        ) : tabBusinesses ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              این شماره در چند کسب‌وکار ثبت شده است؛ وارد کدام می‌شوید؟
            </p>
            {tabBusinesses.map((b) => (
              <button
                key={b.id}
                type="button"
                disabled={busy}
                onClick={() => void startOtp({ kind: "phone", phone: tabPhone, businessId: b.id })}
                className="w-full rounded-lg border border-input px-3 py-2.5 text-sm font-semibold transition hover:bg-primary/10 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
              >
                {b.name}
              </button>
            ))}
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (tabPhone.trim()) void startOtp({ kind: "phone", phone: tabPhone });
            }}
          >
            <p className="text-sm text-muted-foreground">
              شمارهٔ موبایل تأییدشدهٔ خود را وارد کنید تا کد یک‌بارمصرف پیامک شود.
            </p>
            <input
              dir="ltr"
              inputMode="tel"
              autoFocus
              required
              value={tabPhone}
              onChange={(e) => setTabPhone(e.target.value)}
              placeholder="09121234567"
              aria-label="شمارهٔ موبایل"
              className="w-full rounded-lg border border-input px-3 py-2 text-center focus:border-primary focus:outline-none"
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || !tabPhone.trim()}
              className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              {busy ? "در حال ارسال…" : "ارسال کد"}
            </button>
            <p className="text-xs text-muted-foreground">
              مدیران و مالکان می‌توانند با ایمیل و رمز عبور نیز از صفحهٔ /admin وارد شوند.
            </p>
          </form>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------
  if (!selected) {
    const showPhoneTab = policy?.state === "grace" || policy?.state === "enforced";
    return (
      <div>
        {policy?.state === "grace" && (
          // The adoption window, said out loud where everyone walks past it.
          // A countdown nobody can see is a lockout nobody was warned about.
          <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            <p className="font-semibold">
              ورود با کد پیامکی از{" "}
              {policy.enforcedAt
                ? toPersianDigits(formatJalali(policy.enforcedAt, { withMonthName: true }))
                : "به‌زودی"}{" "}
              برای همه الزامی می‌شود
            </p>
            <p className="mt-1 text-muted-foreground">
              {policy.daysLeft !== null
                ? `${toPersianDigits(String(policy.daysLeft))} روز فرصت دارید شمارهٔ موبایل کارکنان را ثبت و تأیید کنید.`
                : "شمارهٔ موبایل کارکنان را ثبت و تأیید کنید."}
            </p>
          </div>
        )}
        <p className="mb-3 text-center text-sm text-muted-foreground">
          نام خود را انتخاب کنید
        </p>
        {rosterFailure && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-destructive">{ROSTER_FAILURE_MESSAGES[rosterFailure]}</p>
            {rosterFailure === "no_business" && (
              // Same shape as the unresolvable-host page (src/app/page.tsx):
              // the Persian line is for the person at the till, this one is for
              // whoever deployed the app, because they are the only one who can
              // fix it and they will not be reading the server log.
              <p className="text-start text-xs text-muted-foreground" dir="ltr">
                This origin resolves to no business. Set ROOT_DOMAIN (and
                TRUST_FORWARDED_HOST=on behind a platform that rewrites Host), or give
                the business a subdomain matching this hostname&rsquo;s first label;{" "}
                <code>/api/host/resolve?debug=1</code> shows what the app sees.
              </p>
            )}
            {/* The screen is the till's front door, so a failure here must never
                be a dead end: one tap re-asks, without reloading the page and
                losing the device token and recents that live beside it. */}
            <button
              type="button"
              onClick={retryRoster}
              className="rounded-lg border border-input px-4 py-2 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              تلاش دوباره
            </button>
          </div>
        )}
        {!rosterFailure && !employees && (
          <div
            className="grid grid-cols-3 gap-2"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="در حال بارگذاری فهرست کارکنان"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} aria-hidden="true" className="h-16 rounded-xl" />
            ))}
          </div>
        )}
        {!rosterFailure && employees && employees.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">
            کارمندی برای ورود سریع یافت نشد.
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">
          {ordered.map((employee) => (
            <button
              key={employee.id}
              type="button"
              onClick={() => pick(employee)}
              className="flex flex-col items-center gap-1.5 rounded-lg p-2 text-center transition hover:bg-primary/10 active:scale-95 outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              <EmployeeAvatar employee={employee} />
              <span className="line-clamp-1 text-xs font-semibold">
                {employee.fullName}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {roleLabel(employee.role)}
              </span>
            </button>
          ))}
        </div>
        {showPhoneTab && (
          <button
            type="button"
            onClick={() => {
              setPhoneTab(true);
              setError(null);
              setOtpSpec(null);
              setOtpSent(null);
            }}
            className="mt-4 w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            ورود با شمارهٔ موبایل
          </button>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // The selected member's door step
  // -------------------------------------------------------------------------
  if (doorStep === "otp") {
    return (
      <div>
        <DoorHeader employee={selected} onBack={() => pick(selected)} />
        {otpSent && otpSpec ? (
          <PhoneOtpStep
            sendSpec={otpSpec}
            initialToken={otpSent.token}
            initialMaskedPhone={otpSent.maskedPhone}
            deviceToken={readDeviceToken()}
            onVerified={() => goNext(selected.id)}
            onCancel={() => pick(selected)}
          />
        ) : (
          // The first send is in flight (or just failed). Never a dead end:
          // one tap re-addresses the exact same send.
          <div className="space-y-4 text-center">
            <p role="status" className="text-sm text-muted-foreground">
              {busy ? "در حال ارسال کد…" : "ارسال کد انجام نشد."}
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {!busy && otpSpec ? (
              <button
                type="button"
                onClick={() => void startOtp(otpSpec)}
                className="rounded-lg border border-input px-4 py-2 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
              >
                تلاش دوباره
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  if (doorStep === "set_phone" && pinPending) {
    return (
      <div>
        <DoorHeader employee={selected} onBack={() => pick(selected)} />
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (phoneInput.trim()) {
              void startOtp({ kind: "token", token: pinPending.token, phone: phoneInput });
            }
          }}
        >
          <div>
            <h2 className="text-base font-bold">شمارهٔ موبایل خود را ثبت کنید</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              یک بار کد پیامکی به این شماره می‌رسد؛ از آن پس می‌توانید با همان شماره
              وارد شوید و تا ۷ روز از رمز عددی برای ورود سریع استفاده کنید.
            </p>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <input
            dir="ltr"
            inputMode="tel"
            autoFocus
            required
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            placeholder="09121234567"
            aria-label="شمارهٔ موبایل"
            className="w-full rounded-lg border border-input px-3 py-2 text-center focus:border-primary focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !phoneInput.trim()}
            className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            {busy ? "در حال ارسال…" : "ارسال کد تأیید"}
          </button>
        </form>
      </div>
    );
  }

  // doorStep === "pin"
  const graceVerifyOffer =
    policy?.state === "grace" && selected.phoneState !== "verified";
  return (
    <div>
      <DoorHeader employee={selected} onBack={() => pick(selected)} />
      {graceVerifyOffer && (
        <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
          {verifyMode ? (
            <p>
              رمز عددی را وارد کنید؛ پس از آن، شمارهٔ موبایل شما با یک کد پیامکی
              تأیید و ورود کامل می‌شود.
            </p>
          ) : (
            <>
              <p className="font-semibold">
                {selected.phoneState === "none"
                  ? "شمارهٔ موبایل شما هنوز ثبت نشده است."
                  : "شمارهٔ موبایل شما هنوز تأیید نشده است."}
              </p>
              <p className="mt-1 text-muted-foreground">
                تا چند روز دیگر ورود با کد پیامکی الزامی می‌شود؛ همین حالا ثبت/تأیید
                کنید تا بعداً درِ ورود برایتان بسته نماند.
              </p>
              <button
                type="button"
                onClick={() => setVerifyMode(true)}
                className="mt-2 rounded-lg border border-primary/40 px-3 py-1.5 font-semibold text-primary transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
              >
                تأیید شمارهٔ موبایل و ورود
              </button>
            </>
          )}
        </div>
      )}
      {selected.hasWebauthn && webauthnSupported && (
        <button
          type="button"
          onClick={submitBiometric}
          disabled={busy}
          className="mb-4 w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          ورود با اثر انگشت یا چهره
        </button>
      )}
      <PinPad
        onComplete={submitPin}
        busy={busy}
        error={error}
        resetKey={selected.id + (verifyMode ? ":verify" : "")}
      />
    </div>
  );
}

/** The «کارمند دیگر» bar every post-roster step shares. */
function DoorHeader({
  employee,
  onBack,
}: {
  employee: RosterEmployee;
  onBack: () => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        className="rounded text-sm text-muted-foreground hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        ← کارمند دیگر
      </button>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{employee.fullName}</span>
        <EmployeeAvatar employee={employee} size="sm" />
      </div>
    </div>
  );
}

function EmployeeAvatar({
  employee,
  size = "md",
}: {
  employee: RosterEmployee;
  size?: "sm" | "md";
}) {
  const dims = size === "sm" ? "size-8 text-xs" : "size-14 text-lg";
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);

  useEffect(() => {
    setPhotoLoaded(false);
    setPhotoFailed(false);
  }, [employee.photoUrl]);

  if (employee.photoUrl && !photoFailed) {

    return (
      <span className={`${dims} relative inline-block shrink-0 overflow-hidden rounded-full`}>
        {!photoLoaded ? <Skeleton aria-hidden="true" className="absolute inset-0 size-full rounded-full" /> : null}
        <img
          src={employee.photoUrl}
          alt=""
          onLoad={() => setPhotoLoaded(true)}
          onError={() => setPhotoFailed(true)}
          className={`size-full object-cover transition-opacity motion-reduce:transition-none ${photoLoaded ? "opacity-100" : "opacity-0"}`}
        />
      </span>
    );
  }
  const initials = employee.fullName.trim().slice(0, 1);
  return (
    <span
      className={`${dims} flex items-center justify-center rounded-full bg-primary/15 font-bold text-primary`}
    >
      {initials}
    </span>
  );
}
