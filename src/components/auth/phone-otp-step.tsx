"use client";

/**
 * Phase 42 — the code-entry half of the phone-OTP door.
 *
 * Deliberately *not* part of MfaStep: that component serves the
 * email/password realm's second factor (enrolment, recovery codes, a
 * method picker); this one is the till door's login itself — a member, a
 * masked number, six digits, one button. The parent (login-form) performs
 * the *first* send, because how the send is addressed (a PIN-verified
 * pending token, a roster employeeId, or a typed number) is a decision the
 * door makes before this component exists; resends stay here so the
 * rate-limit sentence can live beside the button it describes.
 */
import { useEffect, useState } from "react";
import { normalizeSecurityDigits, toPersianDigits } from "@/lib/digits";
import { otpFromPastedText } from "@/lib/login-contract";
import { MfaStep } from "./mfa-step";
import { BusinessPicker, useBusinessSelection } from "./business-picker";
import { networkErrorMessage, useLoginRequest } from "./use-login-request";
import { useResendCooldown } from "./use-resend-cooldown";

/** How long the trusted-device choice is offered for, in days. Policy-fixed at seven. */
const TRUST_DAYS = 7;

/** How to address a resend — mirrors the three modes of /api/auth/phone-otp/request. */
export type PhoneOtpSendSpec =
  | { kind: "token"; token: string; phone?: string }
  | { kind: "employee"; employeeId: string; businessId?: string }
  | { kind: "phone"; phone: string; businessId?: string };

interface RequestResponse {
  status?: string;
  maskedPhone?: string | null;
  token?: string;
  error?: string;
  message?: string;
  retryAfterMs?: number;
}

/*
 * Issue #854 (P1.18) — the multi-business answer to a *verified* code.
 *
 * The number matched members of more than one business, so nothing about those
 * businesses was revealed until the code checked out. What comes back is the
 * list plus a short-lived selection token; the member names a business and the
 * server resolves the membership from the proven number, never from the id.
 *
 * The step itself lives in `business-picker.tsx` (P1.19) so the password door
 * renders the same one.
 */

function phoneOtpErrorMessage(
  code: string | undefined,
  status: number,
  serverMessage?: string,
): string {
  const map: Record<string, string> = {
    invalid_code: "کد واردشده درست نیست.",
    code_expired: "مهلت این کد تمام شده است. کد تازه‌ای درخواست دهید.",
    challenge_required: "مرحلهٔ تأیید به‌درستی آغاز نشده است. ارسال دوبارهٔ کد را بزنید.",
    phone_missing: "برای این حساب شمارهٔ موبایلی ثبت نشده است.",
    invalid_phone: "شمارهٔ موبایل معتبر نیست.",
    sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",
    account_locked: "حساب شما موقتاً قفل شده است؛ کمی بعد دوباره تلاش کنید.",
    unauthorized: "مهلت این مرحله تمام شده است؛ از ابتدا تلاش کنید.",
  };
  // Kavenegar's own status, mapped to Persian, but only when fixing it is in
  // the member's hands (a bad receptor — not the platform's empty credit).
  if (serverMessage) return serverMessage;
  if (code && map[code]) return map[code];
  if (status === 401) return "کد واردشده درست نیست.";
  return "خطای غیرمنتظره. دوباره تلاش کنید.";
}

/** «۲ دقیقهٔ دیگر» — the same sentence MfaStep renders for its limiter. */
function retryAfterMessage(retryAfterMs: unknown): string {
  const ms = typeof retryAfterMs === "number" ? retryAfterMs : 0;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) {
    return `درخواست بعدی تا ${toPersianDigits(String(seconds))} ثانیهٔ دیگر ممکن نیست.`;
  }
  return `درخواست بعدی تا ${toPersianDigits(String(Math.ceil(seconds / 60)))} دقیقهٔ دیگر ممکن نیست.`;
}

export function PhoneOtpStep({
  sendSpec,
  initialToken,
  initialMaskedPhone,
  onVerified,
  onCancel,
  deviceToken = null,
}: {
  sendSpec: PhoneOtpSendSpec;
  /** The token the parent's first send minted — verify starts from it. */
  initialToken: string;
  initialMaskedPhone: string | null;
  onVerified: () => void;
  onCancel: () => void;
  deviceToken?: string | null;
}) {
  const [token, setToken] = useState(initialToken);
  const [maskedPhone, setMaskedPhone] = useState(initialMaskedPhone);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Issue #885 L17 — the OTP step's async could outlive a cancelled step.
   *
   * These calls used to be a bare `await fetch` behind a local `busy` flag.
   * Nothing moved on when the member backed out mid-verify, so a response
   * that landed afterwards still ran its handlers: `onVerified()` completed a
   * login the member had already abandoned, and `setError` wrote to a step
   * that was gone. `useLoginRequest` owns the generation counter, so an
   * overtaken call resolves as `{ stale: true }` and touches nothing — and it
   * adds the bounded timeout this component never had (L14).
   */
  const { busy, send, cancel } = useLoginRequest();
  /**
   * Issue #885 — «اعتماد به این دستگاه برای ۷ روز».
   *
   * Off by default and explicit. It is offered here rather than granted
   * silently because trust is the member's choice made *after* every required
   * factor has succeeded; sending `trustDevice: true` on a verification that
   * does not complete simply does nothing, because the server only registers
   * trust on the path where all factors passed.
   */
  const [trustDevice, setTrustDevice] = useState(false);
  const [mfaPending, setMfaPending] = useState<{
    token: string;
    method: "totp" | "sms_otp" | null;
    availableMethods: ("totp" | "sms_otp")[];
  } | null>(null);
  const { selection, capture, clear } = useBusinessSelection();

  /**
   * Issue #854 (P2.25) — the door's resend button gets the same live cooldown
   * as every other OTP surface. The parent performs the *first* send just
   * before mounting this step, so the window starts when we mount; each resend
   * and each 429 answer then rewrites it from the server's own word.
   */
  const {
    waitSeconds: resendWait,
    coolingDown,
    start: startCooldown,
    applyRetryAfterMs,
  } = useResendCooldown(60);

  useEffect(() => {
    startCooldown();
    // Deliberately once per mount: this mirrors the parent's first send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setToken(initialToken);
    setMaskedPhone(initialMaskedPhone);
  }, [initialToken, initialMaskedPhone]);

  // Leaving the step abandons whatever is in flight rather than letting it
  // land on a component that no longer exists.
  useEffect(() => cancel, [cancel]);

  async function resend() {
    setError(null);
    setNotice(null);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: Record<string, unknown> = {};
    if (sendSpec.kind === "token") {
      headers.Authorization = `Bearer ${sendSpec.token}`;
      body = { phone: sendSpec.phone };
    } else if (sendSpec.kind === "employee") {
      body = { employeeId: sendSpec.employeeId, businessId: sendSpec.businessId };
    } else {
      body = { phone: sendSpec.phone, businessId: sendSpec.businessId };
    }

    const outcome = await send<RequestResponse>((signal) =>
      fetch("/api/auth/phone-otp/request", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      }),
    );
    if (outcome.stale) return;
    if (outcome.networkError) {
      setError(networkErrorMessage(outcome.networkError));
      return;
    }
    const data = outcome.data;
    if (outcome.status === 429) {
      applyRetryAfterMs(data.retryAfterMs);
      setError(retryAfterMessage(data.retryAfterMs));
      return;
    }
    if (!outcome.ok) {
      setError(phoneOtpErrorMessage(data.error, outcome.status, data.message));
      return;
    }
    if (data.token) setToken(data.token);
    if (data.maskedPhone) setMaskedPhone(data.maskedPhone);
    setCode("");
    startCooldown();
    setNotice(`کد تازه به ${toPersianDigits(data.maskedPhone ?? maskedPhone ?? "")} پیامک شد.`);
  }

  /**
   * POST /api/auth/phone-otp/verify with whatever the current step proves.
   *
   * One function for all three steps — the typed code, and the business choice
   * that spends an already-proven code — because they differ only in the body
   * and in which response shape comes back.
   */
  async function verify(body: Record<string, unknown>, bearer: string) {
    setError(null);

    const outcome = await send<
      RequestResponse & {
        mfaRequired?: boolean;
        mfaToken?: string;
        mfaMethod?: "totp" | "sms_otp" | null;
        availableMethods?: ("totp" | "sms_otp")[];
        needsBusinessSelection?: boolean;
        businesses?: { id: string; name: string }[];
        selectionToken?: string;
      }
    >((signal) =>
      fetch("/api/auth/phone-otp/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
        signal,
      }),
    );
    // Overtaken by a later call or by leaving the step: touch nothing.
    if (outcome.stale) return;
    if (outcome.networkError) {
      setError(networkErrorMessage(outcome.networkError));
      return;
    }
    const data = outcome.data;
    if (outcome.ok) {
      /*
       * A code that proves a multi-business number answers with the list and a
       * selection token and *no* session; the shared hook holds that pending
       * choice so the picker below can finish it.
       */
      if (capture(data)) return;
      if (data.mfaRequired && data.mfaToken) {
        setMfaPending({
          token: data.mfaToken,
          method: data.mfaMethod ?? null,
          availableMethods: data.availableMethods ?? [],
        });
        return;
      }
      onVerified();
      return;
    }
    setError(phoneOtpErrorMessage(data.error, outcome.status, data.message));
    setCode("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await verify({ code, deviceToken, trustDevice }, token);
  }

  async function chooseBusiness(businessId: string) {
    if (!selection?.token) return;
    await verify({ businessId, deviceToken }, selection.token);
  }

  if (mfaPending) {
    return (
      <MfaStep
        mfaToken={mfaPending.token}
        initialMethod={mfaPending.method}
        availableMethods={mfaPending.availableMethods}
        primaryAuth="phone_otp"
        endpointPrefix="/api/auth/mfa"
        onVerified={onVerified}
        onCancel={() => {
          setMfaPending(null);
          onCancel();
        }}
      />
    );
  }

  if (selection) {
    return (
      <BusinessPicker
        selection={selection}
        busy={busy}
        error={error}
        onChoose={(businessId) => void chooseBusiness(businessId)}
        onCancel={() => {
          clear();
          onCancel();
        }}
      />
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h2 className="text-base font-bold">کد تأیید پیامکی</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {maskedPhone
            ? `کد ۶ رقمی پیامک‌شده به ${toPersianDigits(maskedPhone)} را وارد کنید.`
            : "کد ۶ رقمی پیامک‌شده را وارد کنید."}
        </p>
      </div>

      {notice && !error ? (
        <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

      <input
        dir="ltr"
        autoFocus
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
        required
        value={code}
        onChange={(e) => setCode(normalizeSecurityDigits(e.target.value, 6))}
        /*
          Issue #885 L16 — pasting a whole SMS used to leave the box empty.
          `maxLength={6}` makes the browser truncate the paste *before*
          onChange fires, so "Your code is 123456." arrived as "Your c" and
          normalised to nothing. clipboardData still holds the untruncated
          text, so extract the code here and suppress the default insertion.
        */
        onPaste={(e) => {
          const pasted = otpFromPastedText(e.clipboardData.getData("text"));
          if (!pasted) return; // not a code — let the normal path handle it
          e.preventDefault();
          setCode(pasted);
        }}
        placeholder="------"
        aria-label="کد تأیید ۶ رقمی"
        className="w-full rounded-lg border border-input px-3 py-2 text-center text-lg tracking-[0.4em] focus:border-primary focus:outline-none"
      />

      {/*
        Issue #885 — the trust choice, offered at the verification step. It is
        a convenience, not a credential: on a trusted device the PIN or
        password is still required at every login, and only this routine OTP
        is skipped. Kept visually separate from the code field so it cannot be
        read as part of the ceremony.
      */}
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-input px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={trustDevice}
          onChange={(e) => setTrustDevice(e.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          اعتماد به این دستگاه برای {toPersianDigits(String(TRUST_DAYS))} روز
          <span className="mt-0.5 block text-xs text-muted-foreground">
            دفعهٔ بعد روی این دستگاه کد پیامکی پرسیده نمی‌شود. از تنظیمات امنیتی
            قابل لغو است.
          </span>
        </span>
      </label>

      <button
        type="submit"
        disabled={busy || code.length !== 6}
        className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {busy ? "در حال بررسی…" : "تأیید و ورود"}
      </button>

      <button
        type="button"
        disabled={busy || coolingDown}
        onClick={() => void resend()}
        className="w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {coolingDown
          ? `ارسال دوبارهٔ کد (${toPersianDigits(resendWait)})`
          : "ارسال دوبارهٔ کد"}
      </button>

      <div className="text-center">
        <button
          type="button"
          onClick={onCancel}
          className="rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          انصراف و بازگشت
        </button>
      </div>
    </form>
  );
}
