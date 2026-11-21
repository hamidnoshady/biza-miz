"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";

/**
 * ESH-200 / #1385 — the public phone-first signup screen.
 *
 * Two steps, three fields: first name, last name, mobile. No email, password,
 * national ID, business name, app or payment is asked for. The account does not
 * exist until the SMS code is redeemed (`/api/auth/signup/verify`), which is the
 * whole point of the screen rather than an implementation detail.
 *
 * Persian-first: RTL, Persian digits for anything the person reads back (the
 * masked number and the code), Latin digits accepted by the API and normalised
 * there. Errors are one accessible live region, never a per-field reveal of
 * whether an account exists.
 */
type Step = "details" | "code";

const SIGNUP_ERRORS: Record<string, string> = {
  invalid_name: "نام و نام خانوادگی را کامل وارد کنید.",
  invalid_phone: "شمارهٔ موبایل معتبر نیست. نمونه: ۰۹۱۲۱۲۳۴۵۶۷",
  signup_disabled: "ثبت‌نام عمومی در حال حاضر غیرفعال است.",
  rate_limited: "درخواست‌های زیاد از این شماره. کمی بعد دوباره تلاش کنید.",
  sms_dispatch_failed: "ارسال پیامک انجام نشد. لطفاً دوباره تلاش کنید.",
  invalid_code: "کد وارد‌شده درست یا معتبر نیست.",
  account_ambiguous: "برای این شماره بیش از یک حساب ثبت شده است. با پشتیبانی تماس بگیرید.",
  bad_request: "درخواست کامل نیست. دوباره تلاش کنید.",
};

function messageFor(error: string | undefined): string {
  return SIGNUP_ERRORS[error ?? ""] ?? "انجام نشد. لطفاً دوباره تلاش کنید.";
}

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("details");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName, lastName, phone }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        maskedPhone?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(messageFor(data.error));
        return;
      }
      setMaskedPhone(data.maskedPhone ?? "");
      setStep("code");
      setNotice("کد تأیید به شمارهٔ شما پیامک شد. تا ۵ دقیقه معتبر است.");
    } catch {
      setError(messageFor(undefined));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName, lastName, phone, code }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        created?: boolean;
        next?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(messageFor(data.error));
        return;
      }
      if (data.created === false) {
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
          <p className="text-xs font-medium text-muted-foreground">بیزامیز</p>
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
        {error ? (
          <div className="mb-4">
            <ErrorBox>{error}</ErrorBox>
          </div>
        ) : null}

        {step === "details" ? (
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
            <Field label="کد تأیید">
              <input
                id="signup-code"
                name="code"
                className={inputClass}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                dir="ltr"
                maxLength={6}
                required
              />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "در حال بررسی…" : "تأیید و ساخت حساب"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setStep("details");
                setCode("");
                setError(null);
                setNotice(null);
              }}
              className="w-full rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring focus-visible:ring-ring/50"
            >
              تغییر شماره یا ارسال دوباره
            </button>
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
