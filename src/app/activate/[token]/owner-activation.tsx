"use client";

/**
 * Issue #755 §14 — the owner's side of provisioning.
 *
 * Everything here belongs to the owner and to nobody else: the password is
 * theirs to choose, the second factor is enrolled against *their* record in
 * their own browser, and the recovery codes are displayed here — once — and
 * never returned to the platform operator who created the business. That is the
 * whole point of the flow: a super-admin can hand over the link, but the link
 * is single-use and the material behind it never passes through them.
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
  totpSecret: string | null;
  totpQr: string | null;
  recoveryCodes: string[];
}

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
  const ready = password.length >= MIN_PASSWORD_LENGTH && password === confirm;

  async function activate() {
    setBusy(true);
    setError("");
    const res = await api<Activated & { error?: string }>("/api/auth/owner-activation", {
      method: "POST",
      body: JSON.stringify({ token, password }),
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
            رمز را نمی‌داند — حتی اپراتور پلتفرم که این کسب‌وکار را ساخته است.
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
              کد ورود دومرحله‌ای به این شماره پیامک می‌شود: <span dir="ltr">{preview.phoneHint}</span>
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
 * The one and only showing of the owner's own second-factor material. Held
 * until they confirm they have saved it: the TOTP secret is stored encrypted
 * and the recovery codes only as hashes, so none of this can be recovered.
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

      {data.mfa.method === "sms_otp" ? (
        <p className="text-sm text-foreground">
          ورود دومرحله‌ای شما با پیامک یک‌بارمصرف به شمارهٔ{" "}
          <span dir="ltr">{data.mfa.phoneE164}</span> انجام می‌شود. در نخستین ورود، کد پیامک‌شده را وارد
          کنید تا شماره تأیید شود.
        </p>
      ) : (
        <p className="text-sm text-foreground">
          این نصب به اینترنت وصل نیست، پس ورود دومرحله‌ای با برنامهٔ رمزساز انجام می‌شود. کد QR را با
          برنامهٔ رمزساز اسکن کنید.
        </p>
      )}

      {data.mfa.totpQr ? (
        <div className="flex justify-center">
          <img src={data.mfa.totpQr} alt="کد QR ورود دومرحله‌ای" className="size-44 rounded-lg bg-card p-2" />
        </div>
      ) : null}

      {data.mfa.totpSecret ? (
        <div>
          <p className="mb-1 text-sm text-muted-foreground">کد دستی برنامهٔ رمزساز:</p>
          <p dir="ltr" className="rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm tracking-wider">
            {data.mfa.totpSecret}
          </p>
        </div>
      ) : null}

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
