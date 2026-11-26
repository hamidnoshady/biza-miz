"use client";

/**
 * The cloud account door: verified mobile number (or a legacy email) +
 * password is the default, then the second factor, then the optional
 * «اعتماد به این دستگاه برای ۷ روز».
 *
 * This is the cloud deployment's primary way in (the hybrid/offline install
 * keeps its PIN-only door). Two deliberate things it offers:
 *
 *  - **Phone as the default identifier.** A member types their verified mobile
 *    number; `/api/auth/login` resolves either a number or a legacy email, so
 *    existing email accounts keep working without a second form.
 *  - **Two distinct one-time-code journeys.** «ورود با رمز یک‌بارمصرف» is the
 *    passwordless **login** (a correct code mints a session). «فراموشی رمز
 *    عبور؟» is **recovery** (a purpose-bound code lets the member set
 *    a new password and never mints a session). They are separate server
 *    purposes and separate screens; conflating them was the pre-#1386 bug.
 *
 * Everything below the fields is the existing contract: the MFA interstitial
 * (`MfaStep`), the business picker for a member of several businesses, the
 * seven-day device trust, and the shared wording for every failure. The parent
 * screen supplies the card, heading and the link to the PIN roster.
 *
 * `/admin` renders this same component (`identifierLabel="ایمیل"`,
 * `defaultNext="/"`), so the owner door cannot drift from the cloud door: one
 * MFA interstitial, one business picker, one set of failure messages.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import {
  MfaStep,
  TENANT_MFA_THEME,
  type MfaMethod,
} from "@/components/auth/mfa-step";
import { BusinessPicker, useBusinessSelection } from "@/components/auth/business-picker";
import { lockoutMessage, useNextPath } from "@/components/auth/login-helpers";
import {
  PhoneOtpStep,
  type PhoneOtpSendSpec,
} from "@/components/auth/phone-otp-step";
import { PhonePasswordRecovery } from "@/components/auth/phone-password-recovery";
import { loginErrorMessage, TRUSTED_DEVICE_DAYS } from "@/lib/login-contract";
import { networkErrorMessage, useLoginRequest } from "@/components/auth/use-login-request";
import { toPersianDigits } from "@/lib/digits";
import { readDeviceToken } from "@/lib/device-token";

interface LoginResponse {
  error?: string;
  lockedUntil?: string;
  mfaRequired?: boolean;
  mfaToken?: string;
  mfaMethod?: MfaMethod | null;
  availableMethods?: MfaMethod[];
  mfaState?: "grace" | "required";
  graceUntil?: string | null;
  graceDaysLeft?: number | null;
  /** Present only on a real session. */
  user?: { id: string; role: string; fullName: string };
  business?: { id: string; name: string; slug: string };
  needsBusinessSelection?: boolean;
  businesses?: { id: string; name: string }[];
}

export function AccountLoginForm({
  onStaffPin,
  identifierLabel = "شمارهٔ موبایل",
  identifierType = "text",
  defaultNext = "/dashboard",
  trustDeviceDefault = true,
}: {
  /** Shown only on a door that also offers the PIN roster (the cloud login). */
  onStaffPin?: () => void;
  /** `/admin` keeps its historical "ایمیل" label; the cloud door names the phone. */
  identifierLabel?: string;
  identifierType?: "text" | "email";
  /** Where a successful sign-in lands when no `?next=` was carried. */
  defaultNext?: string;
  /**
   * Whether the seven-day device-trust box starts ticked. The cloud door asks
   * for it up front (the member came to do exactly one login and expects the
   * PIN screen next time); `/admin` keeps it opt-in, because there it would
   * otherwise pre-authorise a seven-day MFA bypass nobody asked for.
   */
  trustDeviceDefault?: boolean;
}) {
  const router = useRouter();
  const next = useNextPath(defaultNext);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  /** Show the typed password. Local UI state only; hidden again whenever the password is cleared. */
  const [showPassword, setShowPassword] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(trustDeviceDefault);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, send } = useLoginRequest();

  const [pending, setPending] = useState<{
    token: string;
    method: MfaMethod | null;
    availableMethods: MfaMethod[];
  } | null>(null);
  const { selection, capture, clear } = useBusinessSelection();
  const [graceNotice, setGraceNotice] = useState<{ daysLeft: number | null } | null>(null);

  /**
   * `password` is the default. `otp` is the passwordless **login**; `recovery`
   * replaces the password and returns here. They are never the same screen.
   */
  const [mode, setMode] = useState<"password" | "otp" | "recovery">("password");
  const [otpPhone, setOtpPhone] = useState("");
  const [otpSpec, setOtpSpec] = useState<PhoneOtpSendSpec | null>(null);
  const [otpSent, setOtpSent] = useState<{ token: string; maskedPhone: string | null } | null>(null);

  function goNext() {
    router.push(next);
    router.refresh();
  }

  /** A typed identifier that is an email stays empty for the phone field. */
  function typedPhone(): string {
    const value = identifier.trim();
    return value.includes("@") ? "" : value;
  }

  async function submit(e: React.FormEvent | null, businessId?: string) {
    e?.preventDefault();
    setError(null);
    setNotice(null);

    const outcome = await send<LoginResponse>((signal) =>
      fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password, ...(businessId ? { businessId } : {}) }),
        signal,
      }),
    );
    if (outcome.stale) return;
    if (outcome.networkError) {
      setError(networkErrorMessage(outcome.networkError));
      return;
    }

    const { ok, status, data } = outcome;
    if (status === 423) {
      setError(lockoutMessage(data.lockedUntil));
      return;
    }
    if (ok && capture(data)) return;
    if (ok && data.mfaRequired && data.mfaToken) {
      setPending({
        token: data.mfaToken,
        method: data.mfaMethod ?? null,
        availableMethods: data.availableMethods ?? [],
      });
      return;
    }
    if (ok && data.user && data.business) {
      if (data.mfaState === "grace") {
        setGraceNotice({ daysLeft: data.graceDaysLeft ?? null });
        return;
      }
      goNext();
      return;
    }
    setError(loginErrorMessage({ status, code: data.error ?? null }));
  }

  /** Send the first code to the typed number and hand the exchange to PhoneOtpStep. */
  async function startOtp() {
    const phone = otpPhone.trim();
    if (!phone) return;
    setError(null);
    setNotice(null);
    setOtpSent(null);
    const spec: PhoneOtpSendSpec = { kind: "phone", phone };
    setOtpSpec(spec);
    try {
      const res = await fetch("/api/auth/phone-otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        maskedPhone?: string | null;
        error?: string;
        message?: string;
        retryAfterMs?: number;
      };
      if (res.status === 429) {
        const seconds = Math.max(1, Math.ceil((data.retryAfterMs ?? 0) / 1000));
        setError(`درخواست بعدی تا ${toPersianDigits(String(seconds))} ثانیهٔ دیگر ممکن نیست.`);
        return;
      }
      if (!res.ok || !data.token) {
        setError(data.message ?? "ارسال کد ممکن نشد.");
        return;
      }
      setOtpSent({ token: data.token, maskedPhone: data.maskedPhone ?? null });
    } catch {
      setError("ارتباط با سرور برقرار نشد.");
    }
  }

  // -------------------------------------------------------------------------
  // Passwordless login — a separate primary method, not "forgot password".
  // -------------------------------------------------------------------------
  if (mode === "otp") {
    if (otpSent && otpSpec) {
      return (
        <PhoneOtpStep
          sendSpec={otpSpec}
          initialToken={otpSent.token}
          initialMaskedPhone={otpSent.maskedPhone}
          deviceToken={readDeviceToken()}
          onVerified={() => goNext()}
          onCancel={() => {
            setOtpSent(null);
            setOtpSpec(null);
            setError(null);
          }}
        />
      );
    }
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void startOtp();
        }}
      >
        <div>
          <h2 className="text-base font-bold">ورود با رمز یک‌بارمصرف</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            شمارهٔ موبایل تأییدشدهٔ خود را وارد کنید تا کد ورود پیامک شود. با این روش
            نیازی به رمز عبور نیست و همین یک کد شما را وارد می‌کند.
          </p>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div>
          <label htmlFor="otp-phone" className="mb-1 block text-sm text-muted-foreground">
            شمارهٔ موبایل
          </label>
          <input
            id="otp-phone"
            type="tel"
            dir="ltr"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            required
            value={otpPhone}
            onChange={(e) => setOtpPhone(e.target.value)}
            placeholder="09121234567"
            className="w-full rounded-lg border border-input px-3 py-2 text-center focus:border-primary focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !otpPhone.trim()}
          className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          ارسال کد
        </button>
        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setMode("password");
              setError(null);
            }}
            className="rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            بازگشت به ورود با رمز عبور
          </button>
        </div>
      </form>
    );
  }

  // -------------------------------------------------------------------------
  // Password recovery — proves the phone, replaces the password, no session.
  // -------------------------------------------------------------------------
  if (mode === "recovery") {
    return (
      <PhonePasswordRecovery
        initialPhone={typedPhone()}
        onDone={() => {
          setMode("password");
          setPassword("");
          setShowPassword(false);
          setError(null);
          setNotice("رمز عبور شما تغییر کرد. اکنون با رمز جدید وارد شوید.");
        }}
        onCancel={() => {
          setMode("password");
          setError(null);
        }}
      />
    );
  }

  // -------------------------------------------------------------------------
  // Business selection / MFA / grace
  // -------------------------------------------------------------------------
  if (selection) {
    return (
      <BusinessPicker
        selection={selection}
        busy={busy}
        error={error}
        onChoose={(businessId) => void submit(null, businessId)}
        onCancel={() => {
          clear();
          setPassword("");
          setShowPassword(false);
        }}
      />
    );
  }
  if (pending) {
    return (
      <MfaStep
        mfaToken={pending.token}
        mfaMethod={pending.method}
        availableMethods={pending.availableMethods}
        theme={TENANT_MFA_THEME}
        offerTrustDevice
        trustDeviceDefault={rememberDevice}
        endpoints={{
          challenge: "/api/auth/mfa/challenge",
          verify: "/api/auth/mfa/verify",
          enrol: "/api/auth/mfa/enrol",
        }}
        onVerified={goNext}
        onCancel={() => {
          setPending(null);
          setPassword("");
          setShowPassword(false);
        }}
      />
    );
  }
  if (graceNotice) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
          <p className="mb-1 font-semibold">ورود دومرحله‌ای را فعال کنید</p>
          <p className="text-muted-foreground">
            {graceNotice.daysLeft === null
              ? "حساب شما باید به‌زودی با ورود دومرحله‌ای محافظت شود."
              : `${toPersianDigits(String(graceNotice.daysLeft))} روز تا اجباری‌شدن ورود دومرحله‌ای باقی مانده است.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            router.push("/settings/profile");
            router.refresh();
          }}
          className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          همین حالا فعال می‌کنم
        </button>
        <button
          type="button"
          onClick={goNext}
          className="w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          بعداً
        </button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Identifier + password (the default)
  // -------------------------------------------------------------------------
  const legacyEmailHint =
    identifierType === "email"
      ? null
      : "حساب‌های قدیمی می‌توانند به‌جای شمارهٔ موبایل، ایمیل خود را وارد کنند.";
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="identifier" className="mb-1 block text-sm text-muted-foreground">
          {identifierLabel}
        </label>
        <input
          id="identifier"
          type={identifierType}
          dir="ltr"
          inputMode={identifierType === "email" ? "email" : "text"}
          autoComplete="username"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
        {legacyEmailHint ? (
          <p className="mt-1 text-xs text-muted-foreground">{legacyEmailHint}</p>
        ) : null}
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm text-muted-foreground">
          رمز عبور
        </label>
        <div className="relative">
          <input
            id="password"
            type={showPassword ? "text" : "password"}
            dir="ltr"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-input py-2 pe-3 ps-10 text-start focus:border-primary focus:outline-none"
          />
          {/* The field is LTR, so its start edge is the left: the toggle sits
              opposite the caret and never covers what is being typed. Its
              name is visually hidden *content*, not an `aria-label`: a label
              lookup for «رمز عبور» (substring, as browser tests use) must
              still find only the field, never this button. */}
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            aria-controls="password"
            className="absolute inset-y-0 left-0 flex w-10 items-center justify-center rounded-lg text-muted-foreground transition hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            {showPassword ? (
              <EyeOffIcon className="size-4" aria-hidden="true" />
            ) : (
              <EyeIcon className="size-4" aria-hidden="true" />
            )}
            <span className="sr-only">
              {showPassword ? "پنهان کردن رمز عبور" : "نمایش رمز عبور"}
            </span>
          </button>
        </div>
      </div>
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-input px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={rememberDevice}
          onChange={(e) => setRememberDevice(e.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          اعتماد به این دستگاه برای {toPersianDigits(String(TRUSTED_DEVICE_DAYS))} روز
          <span className="mt-0.5 block text-xs text-muted-foreground">
            پس از تأیید مرحلهٔ دوم، دفعهٔ بعد روی این دستگاه کد دومرحله‌ای پرسیده نمی‌شود.
            اگر برای ورود سریع پین ساخته باشید، فقط پین پرسیده می‌شود.
          </span>
        </span>
      </label>
      {notice ? (
        <p role="status" className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <button
        type="submit"
        disabled={busy || !identifier.trim() || !password}
        className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {busy ? "در حال ورود…" : "ورود"}
      </button>
      <div className="space-y-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => {
            setOtpPhone(typedPhone());
            setMode("otp");
            setError(null);
            setNotice(null);
          }}
          className="w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          ورود با رمز یک‌بارمصرف
        </button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setMode("recovery");
              setError(null);
              setNotice(null);
            }}
            className="rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            فراموشی رمز عبور؟
          </button>
          {onStaffPin ? (
            <button
              type="button"
              onClick={onStaffPin}
              className="rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              ورود کارکنان با پین
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
