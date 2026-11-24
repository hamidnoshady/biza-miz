"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { Button } from "@/components/ui/button";
import { BRAND_NAME_FA } from "@/lib/brand";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";

/**
 * ESH-200 / #1385 — the public phone-first signup screen.
 *
 * Two steps, three fields: first name, last name, mobile. No email, password,
 * national ID, business name, app or payment is asked for. The account does not
 * exist until the SMS code is redeemed (`/api/auth/signup/verify`), which is the
 * whole point of the screen rather than an implementation detail.
 *
 * Persian-first: RTL, Persian digits for everything the person reads back (the
 * masked number, the countdown and the code). Latin digits are accepted by the
 * API and normalised there. Errors live in one accessible region; nothing on
 * this screen reveals whether a number already has an account.
 */
type Step = "details" | "code";

const SIGNUP_ERRORS: Record<string, string> = {
  invalid_name: "نام و نام خانوادگی را کامل وارد کنید.",
  invalid_phone: "شمارهٔ موبایل معتبر نیست. نمونه: ۰۹۱۲۱۲۳۴۵۶۷",
  signup_disabled: "ثبت‌نام عمومی در حال حاضر غیرفعال است. اگر فکر می‌کنید اشتباهی رخ داده، با پشتیبانی تماس بگیرید.",
  // Issue #1388 — a maintenance pause is its own state with recovery guidance,
  // never the same sentence as an administratively disabled door.
  signup_maintenance:
    "ثبت‌نام عمومی موقتاً برای تعمیرات متوقف شده است. لطفاً کمی بعد دوباره تلاش کنید. حساب قبلی شما دست‌نخورده است.",
  rate_limited: "درخواست‌های زیاد از این شماره. کمی بعد دوباره تلاش کنید.",
  sms_dispatch_failed: "ارسال پیامک انجام نشد. لطفاً دوباره تلاش کنید.",
  invalid_code: "کد وارد‌شده درست یا معتبر نیست.",
  account_ambiguous: "برای این شماره بیش از یک حساب ثبت شده است. با پشتیبانی تماس بگیرید.",
  account_unavailable: "این حساب در حال حاضر قابل استفاده نیست. با پشتیبانی تماس بگیرید.",
  continuation_failed: "حساب ساخته شد اما ادامهٔ راه‌اندازی آماده نشد. دوباره تلاش کنید.",
  bad_request: "درخواست کامل نیست. دوباره تلاش کنید.",
};

function messageFor(error: string | undefined): string {
  return SIGNUP_ERRORS[error ?? ""] ?? "انجام نشد. لطفاً دوباره تلاش کنید.";
}

/** `۳:۰۵` from a millisecond remaining value, never negative. */
function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return toPersianDigits(`${minutes}:${String(seconds).padStart(2, "0")}`);
}

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("details");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [requestToken, setRequestToken] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step !== "code") return;
    codeRef.current?.focus();
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [step]);

  const expired = step === "code" && expiresAt > 0 && now >= expiresAt;
  const resendWaitMs = Math.max(0, resendAt - (now || Date.now()));

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!firstName.trim() || !lastName.trim()) {
      setError(SIGNUP_ERRORS.invalid_name);
      return;
    }
    if (!phone.trim()) {
      setError(SIGNUP_ERRORS.invalid_phone);
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/auth/signup/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName, lastName, phone }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        maskedPhone?: string;
        requestToken?: string;
        expiresInSeconds?: number;
        resendAfterSeconds?: number;
        error?: string;
        retryAfterMs?: number;
      };

      if (res.status === 429 && typeof data.retryAfterMs === "number") {
        const waitMs = Math.max(0, data.retryAfterMs);
        if (step === "code") setResendAt(Date.now() + waitMs);
        setError(
          `درخواست‌های زیاد از این شماره. ${countdown(waitMs)} دیگر دوباره تلاش کنید.`,
        );
        return;
      }
      if (!res.ok || !data.ok || !data.requestToken) {
        setError(messageFor(data.error));
        return;
      }

      const issuedAt = Date.now();
      setRequestToken(data.requestToken);
      setMaskedPhone(data.maskedPhone ?? "");
      setExpiresAt(issuedAt + (data.expiresInSeconds ?? 300) * 1_000);
      setResendAt(issuedAt + (data.resendAfterSeconds ?? 60) * 1_000);
      setCode("");
      setStep("code");
      setNotice(`کد تأیید به شمارهٔ ${toPersianDigits(data.maskedPhone ?? "")} پیامک شد.`);
      // On a resend the step is already "code", so the effect below will not
      // run again; return the keyboard to the field the person needs next.
      codeRef.current?.focus();
    } catch {
      setError(messageFor(undefined));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (expired) {
      setError("مهلت این کد تمام شده است. کد تازه بگیرید.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName, lastName, phone, requestToken, code }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        next?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(messageFor(data.error));
        if (data.error === "invalid_code") {
          setCode("");
          codeRef.current?.focus();
        }
        return;
      }
      if (data.message === "account_exists" || data.next === "/login") {
        setNotice("این شماره از قبل حساب دارد. برای ورود به صفحهٔ ورود می‌روید.");
        router.push("/login");
        return;
      }
      router.push(data.next ?? "/onboarding");
    } catch {
      setError(messageFor(undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 sm:px-6">
      <div className={`w-full max-w-md ${cardClass} p-6 sm:p-8`}>
        <div className="mb-6 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{BRAND_NAME_FA}</p>
          <h1 className="text-xl font-bold text-foreground">
            {step === "details" ? "ساخت حساب شخصی" : "تأیید شمارهٔ موبایل"}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {step === "details"
              ? "با نام و شمارهٔ موبایل شروع کنید. حساب شما فقط بعد از تأیید کد پیامکی ساخته می‌شود."
              : `کد ۶ رقمی ارسال‌شده به ${toPersianDigits(maskedPhone)} را وارد کنید.`}
          </p>
        </div>

        {notice ? (
          <p role="status" className="mb-4 text-sm leading-6 text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {error ? <ErrorBox>{error}</ErrorBox> : null}

        {busy && step === "details" ? (
          <FormLoadingSkeleton rows={3} label="در حال ارسال کد تأیید" />
        ) : step === "details" ? (
          <form onSubmit={requestCode} className="space-y-4" noValidate>
            <Field label="نام">
              <input
                id="signup-first-name"
                name="firstName"
                className={inputClass}
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                autoComplete="given-name"
                required
              />
            </Field>
            <Field label="نام خانوادگی">
              <input
                id="signup-last-name"
                name="lastName"
                className={inputClass}
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                autoComplete="family-name"
                required
              />
            </Field>
            <Field label="شمارهٔ موبایل" hint="نمونه: ۰۹۱۲۱۲۳۴۵۶۷">
              <input
                id="signup-phone"
                name="phone"
                className={inputClass}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                inputMode="tel"
                autoComplete="tel"
                dir="ltr"
                required
              />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "در حال ارسال کد…" : "ارسال کد تأیید"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="space-y-4" noValidate>
            <Field
              label="کد تأیید"
              hint={
                expired
                  ? "مهلت این کد تمام شده است."
                  : `اعتبار کد: ${countdown(expiresAt - (now || Date.now()))}`
              }
            >
              <input
                ref={codeRef}
                id="signup-code"
                name="code"
                className={inputClass}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onPaste={(event) => {
                  // A copied SMS often carries spaces or Persian digits; let the
                  // one field accept it rather than truncating at maxLength.
                  const pasted = toLatinDigits(
                    event.clipboardData?.getData("text") ?? "",
                  ).replace(/\D+/g, "");
                  if (!pasted) return;
                  event.preventDefault();
                  setCode(pasted.slice(0, 6));
                }}
                inputMode="numeric"
                autoComplete="one-time-code"
                dir="ltr"
                maxLength={6}
                aria-invalid={Boolean(error) || undefined}
                required
              />
            </Field>
            <Button type="submit" className="w-full" disabled={busy || expired}>
              {busy ? "در حال بررسی…" : "تأیید و ساخت حساب"}
            </Button>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={busy || resendWaitMs > 0}
                onClick={requestCode}
                className="w-full rounded-lg border border-input px-3 py-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {resendWaitMs > 0
                  ? `ارسال دوباره تا ${countdown(resendWaitMs)}`
                  : "ارسال دوبارهٔ کد"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep("details");
                  setCode("");
                  setRequestToken("");
                  setError(null);
                  setNotice(null);
                }}
                className="w-full rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring focus-visible:ring-ring/50"
              >
                تغییر شماره
              </button>
            </div>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-muted-foreground">
          حساب دارید؟{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            ورود
          </Link>
        </p>
      </div>
    </main>
  );
}
