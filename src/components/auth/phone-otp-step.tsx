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
import { toPersianDigits } from "@/lib/digits";
import { MfaStep } from "./mfa-step";

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

function phoneOtpErrorMessage(
  code: string | undefined,
  status: number,
  serverMessage?: string,
): string {
  const map: Record<string, string> = {
    invalid_code: "کد واردشده درست نیست.",
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
  const [busy, setBusy] = useState(false);
  const [mfaPending, setMfaPending] = useState<{
    token: string;
    method: "totp" | "sms_otp" | null;
    availableMethods: ("totp" | "sms_otp")[];
  } | null>(null);

  useEffect(() => {
    setToken(initialToken);
    setMaskedPhone(initialMaskedPhone);
  }, [initialToken, initialMaskedPhone]);

  async function resend() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
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

      const res = await fetch("/api/auth/phone-otp/request", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as RequestResponse;
      if (res.status === 429) {
        setError(retryAfterMessage(data.retryAfterMs));
        return;
      }
      if (!res.ok) {
        setError(phoneOtpErrorMessage(data.error, res.status, data.message));
        return;
      }
      if (data.token) setToken(data.token);
      if (data.maskedPhone) setMaskedPhone(data.maskedPhone);
      setCode("");
      setNotice(`کد تازه به ${toPersianDigits(data.maskedPhone ?? maskedPhone ?? "")} پیامک شد.`);
    } catch {
      setError("ارتباط با سرور برقرار نشد.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/phone-otp/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code, deviceToken }),
      });
      const data = (await res.json().catch(() => ({}))) as RequestResponse & {
        mfaRequired?: boolean;
        mfaToken?: string;
        mfaMethod?: "totp" | "sms_otp" | null;
        availableMethods?: ("totp" | "sms_otp")[];
      };
      if (res.ok) {
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
      setError(phoneOtpErrorMessage(data.error, res.status, data.message));
      setCode("");
    } catch {
      setError("ارتباط با سرور برقرار نشد.");
    } finally {
      setBusy(false);
    }
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
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="------"
        aria-label="کد تأیید ۶ رقمی"
        className="w-full rounded-lg border border-input px-3 py-2 text-center text-lg tracking-[0.4em] focus:border-primary focus:outline-none"
      />

      <button
        type="submit"
        disabled={busy || code.length !== 6}
        className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {busy ? "در حال بررسی…" : "تأیید و ورود"}
      </button>

      <button
        type="button"
        disabled={busy}
        onClick={() => void resend()}
        className="w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        ارسال دوبارهٔ کد
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
