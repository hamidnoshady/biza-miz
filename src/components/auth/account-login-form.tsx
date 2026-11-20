"use client";

/**
 * The cloud account door: email **or** mobile number + password, then the
 * second factor, then the optional «اعتماد به این دستگاه برای ۷ روز».
 *
 * This is the cloud deployment's primary way in (the hybrid/offline install
 * keeps its PIN-only door). Two things it adds over the owner-only `/admin`
 * form:
 *
 *  - **Phone as an identifier.** A member may type their verified mobile
 *    number instead of their email; `/api/auth/login` resolves either.
 *  - **A way out when the password is forgotten.** «رمز عبورم را فراموش
 *    کردهام» switches to a one-time code sent to the member's phone, which is
 *    the same phone-OTP exchange the staff door already uses. It mints a real
 *    session on verify, so a forgotten password no longer means a locked-out
 *    owner.
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
  identifierLabel = "ایمیل یا شمارهٔ موبایل",
  identifierType = "text",
  defaultNext = "/dashboard",
  trustDeviceDefault = true,
}: {
  /** Shown only on a door that also offers the PIN roster (the cloud login). */
  onStaffPin?: () => void;
  /** `/admin` keeps its historical "ایمیل" label; the cloud door names both. */
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
  const [rememberDevice, setRememberDevice] = useState(trustDeviceDefault);
  const [error, setError] = useState<string | null>(null);
  const { busy, send } = useLoginRequest();

  const [pending, setPending] = useState<{
    token: string;
    method: MfaMethod | null;
    availableMethods: MfaMethod[];
  } | null>(null);
  const { selection, capture, clear } = useBusinessSelection();
  const [graceNotice, setGraceNotice] = useState<{ daysLeft: number | null } | null>(null);

  /** The forgotten-password path: a code to the member's own phone. */
  const [otpMode, setOtpMode] = useState(false);
  const [otpPhone, setOtpPhone] = useState("");
  const [otpSpec, setOtpSpec] = useState<PhoneOtpSendSpec | null>(null);
  const [otpSent, setOtpSent] = useState<{ token: string; maskedPhone: string | null } | null>(null);

  function goNext() {
    router.push(next);
    router.refresh();
  }

  async function submit(e: React.FormEvent | null, businessId?: string) {
    e?.preventDefault();
    setError(null);

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
  // Forgotten password → one-time code
  // -------------------------------------------------------------------------
  if (otpMode) {
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
          <h2 className="text-base font-bold">ورود با کد یک‌بارمصرف</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            شمارهٔ موبایل تأییدشدهٔ خود را وارد کنید تا کد ورود پیامک شود. با این روش
            نیازی به رمز عبور نیست.
          </p>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <input
          dir="ltr"
          inputMode="tel"
          autoFocus
          required
          value={otpPhone}
          onChange={(e) => setOtpPhone(e.target.value)}
          placeholder="09121234567"
          aria-label="شمارهٔ موبایل"
          className="w-full rounded-lg border border-input px-3 py-2 text-center focus:border-primary focus:outline-none"
        />
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
              setOtpMode(false);
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
  // Identifier + password
  // -------------------------------------------------------------------------
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
          autoComplete="username"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm text-muted-foreground">
          رمز عبور
        </label>
        <input
          id="password"
          type="password"
          dir="ltr"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
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
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <button
        type="submit"
        disabled={busy || !identifier.trim() || !password}
        className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {busy ? "در حال ورود…" : "ورود"}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            setOtpMode(true);
            setError(null);
          }}
          className="rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          رمز عبورم را فراموش کرده‌ام
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
    </form>
  );
}
