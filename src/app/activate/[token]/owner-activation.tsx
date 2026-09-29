"use client";

/**
 * Issue #755 §14 — the owner's side of provisioning.
 *
 * Everything here belongs to the owner and to nobody else: the password is
 * theirs to choose, the second factor is enrolled against *their* record in
 * their own browser, and the recovery codes are displayed here — once — and
 * never returned to the platform operator who created the business.
 *
 * The link alone is deliberately not enough. It travels through the operator
 * (there is no mail transport), so finishing activation also requires a
 * six-digit code texted to the owner's own mobile — a channel the operator can
 * trigger and cannot read. Without that second field the operator could simply
 * redeem their own link and hold a permanent credential to the tenant, which is
 * the exact risk this flow replaced.
 */
import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { formatJalali } from "@/lib/jalali";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessage,
  inputClass,
} from "../../dashboard/ui";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";

interface Preview {
  businessName: string;
  businessSubdomain: string;
  ownerName: string;
  email: string;
  phoneHint: string | null;
  expiresAt: string;
}

interface MfaHandover {
  method: "sms_otp" | "totp";
  phoneE164: string | null;
  /** The identity already had a second factor, which this activation left alone. */
  existing: boolean;
  recoveryCodes: string[];
}

/** How long a texted code is good for, in the service's own terms. */
const CODE_LENGTH = 6;

interface Activated {
  businessName: string;
  businessSubdomain: string;
  email: string;
  mfa: MfaHandover;
}

const MIN_PASSWORD_LENGTH = 8;

export function OwnerActivation({ token }: { token: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [activated, setActivated] = useState<Activated | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [codeHint, setCodeHint] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await api<Preview & { error?: string }>(
        `/api/auth/owner-activation?token=${encodeURIComponent(token)}`,
      );
      if (res.ok) setPreview(res.data);
      else setError(errorMessage(res.data.error));
      setLoading(false);
    })();
  }, [token]);

  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    password.length >= MIN_PASSWORD_LENGTH && password === confirm && code.length === CODE_LENGTH;

  /**
   * Texts the code to the owner's own mobile.
   *
   * This is the half the operator cannot take over: the link itself travels
   * through them, so the right to set this password rests on a message only the
   * owner receives. The button is here rather than automatic so the owner is not
   * made to wait on a text they did not ask for.
   */
  async function sendCode() {
    setSending(true);
    setError("");
    const res = await api<{ phoneHint: string; expiresAt: string; error?: string }>(
      "/api/auth/owner-activation",
      { method: "POST", body: JSON.stringify({ token, action: "send_code" }) },
    );
    setSending(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    // A clock time, not a date: the window is ten minutes, so naming the day
    // would tell the reader nothing (and a Persian-locale format keeps it out of
    // any Gregorian display by construction).
    setCodeHint(
      `کد به شمارهٔ ${res.data.phoneHint} پیامک شد. تا ${new Date(
        res.data.expiresAt,
      ).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })} اعتبار دارد.`,
    );
  }

  async function activate() {
    setBusy(true);
    setError("");
    const res = await api<Activated & { error?: string }>("/api/auth/owner-activation", {
      method: "POST",
      body: JSON.stringify({ token, password, code }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    setActivated(res.data);
  }

  if (loading) {
    return <FormLoadingSkeleton rows={3} className="p-8" label="در حال بررسی لینک فعال‌سازی" />;
  }

  if (activated) {
    return <HandoverPanel data={activated} />;
  }

  return (
    <div className="mx-auto max-w-md space-y-4 p-8">
      <h1 className="text-xl font-bold">فعال‌سازی حساب مالک</h1>
      <ErrorBox>{error}</ErrorBox>

      {preview ? (
        <>
          <InfoBox>
            «{preview.businessName}» آماده است. برای ورود، رمز عبور خودتان را تعیین کنید. هیچ‌کس جز شما این
            رمز را نمی‌داند — حتی اپراتور پلتفرم که این کسب‌وکار را ساخته است. برای همین، تکمیل
            فعال‌سازی به کد پیامک‌شده به موبایل خودتان هم نیاز دارد؛ آن کد تنها به دست شما می‌رسد.
          </InfoBox>

          <Field label="نام مالک">
            <input className={inputClass} readOnly value={preview.ownerName} />
          </Field>

          {/* Addresses and secrets are Latin-script data inside an RTL page:
              without an explicit `dir` the browser reorders the dots and the
              user cannot tell what they are confirming. */}
          <Field label="ایمیل (نام کاربری)">
            <input className={inputClass} dir="ltr" readOnly value={preview.email} />
          </Field>

          {preview.phoneHint ? (
            <p className="text-xs text-muted-foreground">
              کد فعال‌سازی و کد ورود دومرحله‌ای به این شماره پیامک می‌شود:{" "}
              <span dir="ltr">{preview.phoneHint}</span>
            </p>
          ) : null}

          <Field label={`رمز عبور (حداقل ${MIN_PASSWORD_LENGTH} نویسه)`}>
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Field
            label="تکرار رمز عبور"
            hint={mismatch ? "دو رمز یکسان نیستند." : undefined}
          >
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>

          {/* The owner-controlled half of the exchange. The operator can hand
              over the link but cannot read the code, so only the owner can
              finish this — which is the whole point of the second field. */}
          <Field label="کد پیامک‌شده" hint={codeHint || "برای دریافت کد، دکمهٔ زیر را بزنید."}>
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={CODE_LENGTH}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
              <SecondaryButton onClick={sendCode} disabled={sending}>
                {sending ? "در حال ارسال…" : "ارسال کد"}
              </SecondaryButton>
            </div>
          </Field>

          <PrimaryButton onClick={activate} disabled={busy || !ready}>
            {busy ? "در حال فعال‌سازی…" : "تعیین رمز و فعال‌سازی"}
          </PrimaryButton>

          <p className="text-xs text-muted-foreground">
            این لینک تا {formatJalali(preview.expiresAt)} اعتبار دارد و تنها یک‌بار قابل استفاده است.
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * The one and only showing of the owner's own recovery codes. Held until they
 * confirm they have saved them: the codes are stored only as hashes, so none of
 * this can be recovered.
 */
function HandoverPanel({ data }: { data: Activated }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="mx-auto max-w-md space-y-4 p-8">
      <h1 className="text-xl font-bold">حساب شما فعال شد</h1>
      <InfoBox>
        رمز عبور شما ثبت شد. موارد زیر را همین حالا ذخیره کنید؛ پس از بستن این صفحه دیگر نمایش داده
        نمی‌شوند و هیچ‌کس — از جمله پشتیبانی — به آن‌ها دسترسی ندارد.
      </InfoBox>

      {data.mfa.existing ? (
        // Nothing was enrolled and nothing replaced: a person who already had a
        // second factor keeps it, and keeps the recovery codes they saved when
        // they set it up. Saying so matters — otherwise the absence of codes
        // below reads as something having gone wrong.
        <p className="text-sm text-foreground">
          ورود دومرحله‌ای شما از قبل تنظیم شده بود و دست‌نخورده باقی می‌ماند؛ فقط رمز عبور تازه ثبت شد.
          کدهای بازیابی قبلی شما همچنان معتبرند.
        </p>
      ) : (
        <p className="text-sm text-foreground">
          رمز عبور شما تعیین شد. ورود دومرحله‌ای شما با پیامک یک‌بارمصرف به شمارهٔ{" "}
          <span dir="ltr">{data.mfa.phoneE164}</span> انجام می‌شود. در نخستین ورود، کد پیامک‌شده را وارد
          کنید تا شماره تأیید شود.
        </p>
      )}

      {data.mfa.recoveryCodes.length > 0 ? (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">
            {data.mfa.recoveryCodes.length} کد بازیابی یک‌بارمصرف — تنها راه ورود در صورت گم‌شدن گوشی:
          </p>
          <div dir="ltr" className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm tracking-wider">
            {data.mfa.recoveryCodes.map((code) => (
              <span key={code}>{code}</span>
            ))}
          </div>
          <SecondaryButton
            className="mt-2"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(data.mfa.recoveryCodes.join("\n"));
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "کپی شد" : "کپی کدها"}
          </SecondaryButton>
        </div>
      ) : null}

      <label className="flex items-start gap-2 text-sm text-foreground">
        <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
        <span>این اطلاعات را ذخیره کردم.</span>
      </label>

      {/* A real navigation, but through the shared button primitive: the page
          has no router session to push with, and hand-written button classes
          are what the design lint exists to stop. */}
      <PrimaryButton
        type="button"
        disabled={!confirmed}
        onClick={() => {
          window.location.href = "/login";
        }}
      >
        ورود به «{data.businessName}»
      </PrimaryButton>
    </div>
  );
}
