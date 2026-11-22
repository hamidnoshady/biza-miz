"use client";

/**
 * #1386 — forgotten-password recovery through the verified phone.
 *
 * Kept separate from `PhoneOtpStep` on purpose. That component is the
 * **passwordless login** door: a correct code mints a session. This flow proves
 * the same number but is only allowed to replace a password (the server checks
 * the `password_recovery` purpose), and it never creates a session.
 *
 * The request step deliberately answers the same way for a number that belongs
 * to an account and one that does not. The screen can therefore say only
 * "if this number is connected, a code was sent", which is exactly what the
 * server's body says.
 */
import { useState } from "react";
import { normalizeSecurityDigits, toPersianDigits } from "@/lib/digits";
import { otpFromPastedText } from "@/lib/login-contract";
import { useLoginRequest, networkErrorMessage } from "./use-login-request";
import { useResendCooldown } from "./use-resend-cooldown";

const PASSWORD_ERRORS: Record<string, string> = {
  password_too_short: "رمز عبور جدید باید حداقل ۸ نویسه باشد.",
  password_too_long: "رمز عبور جدید بیش از حد طولانی است.",
  password_blank: "رمز عبور نمی‌تواند فقط فاصله باشد.",
  password_confirmation_mismatch: "تکرار رمز عبور جدید با رمز جدید یکسان نیست.",
};

function retryAfterMessage(ms: unknown): string {
  const seconds = Math.max(1, Math.ceil((typeof ms === "number" ? ms : 0) / 1000));
  return `درخواست بعدی تا ${toPersianDigits(String(seconds))} ثانیهٔ دیگر ممکن نیست.`;
}

export function PhonePasswordRecovery({
  initialPhone = "",
  onDone,
  onCancel,
}: {
  initialPhone?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, send } = useLoginRequest();
  const { coolingDown, waitSeconds, start: startCooldown, applyRetryAfterMs } =
    useResendCooldown(60);

  const lengthOk = newPassword.length >= 8;
  const matchOk = newPassword.length > 0 && newPassword === confirmPassword;

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setNotice(null);
    if (!phone.trim()) return;

    const outcome = await send<{ error?: string; message?: string; retryAfterMs?: number }>(
      (signal) =>
        fetch("/api/auth/password-recovery/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone }),
          signal,
        }),
    );
    if (outcome.stale) return;
    if (outcome.networkError) {
      setError(networkErrorMessage(outcome.networkError));
      return;
    }

    if (outcome.status === 429) {
      applyRetryAfterMs(outcome.data.retryAfterMs);
      setError(retryAfterMessage(outcome.data.retryAfterMs));
      return;
    }
    if (outcome.status === 400 && outcome.data.error === "invalid_phone") {
      setError("شمارهٔ موبایل معتبر نیست.");
      return;
    }
    if (!outcome.ok) {
      setError(outcome.data.message ?? "ارسال کد بازیابی ممکن نشد. کمی بعد دوباره تلاش کنید.");
      return;
    }

    setStep("code");
    setCode("");
    startCooldown();
    setNotice(
      "اگر این شماره به یک حساب متصل باشد، کد ۶ رقمی بازیابی برایش پیامک شده است.",
    );
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!lengthOk) {
      setError(PASSWORD_ERRORS.password_too_short);
      return;
    }
    if (!matchOk) {
      setError(PASSWORD_ERRORS.password_confirmation_mismatch);
      return;
    }

    const outcome = await send<{ ok?: boolean; error?: string; passwordChanged?: boolean }>(
      (signal) =>
        fetch("/api/auth/password-recovery/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone,
            code,
            newPassword,
            confirmPassword,
          }),
          signal,
        }),
    );
    if (outcome.stale) return;
    if (outcome.networkError) {
      setError(networkErrorMessage(outcome.networkError));
      return;
    }

    if (!outcome.ok || outcome.data.passwordChanged !== true) {
      if (outcome.status === 401 || outcome.data.error === "invalid_code") {
        setError("کد واردشده درست نیست یا مهلت آن تمام شده است.");
        return;
      }
      setError(
        (outcome.data.error && PASSWORD_ERRORS[outcome.data.error]) ||
          "تغییر رمز عبور ممکن نشد. دوباره تلاش کنید.",
      );
      return;
    }

    onDone();
  }

  if (step === "phone") {
    return (
      <form className="space-y-4" onSubmit={requestCode}>
        <div>
          <h2 className="text-base font-bold">بازیابی رمز عبور</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            شمارهٔ موبایل تأییدشدهٔ حساب را وارد کنید تا کد بازیابی برایتان پیامک شود.
            این روش رمز عبور را عوض می‌کند و شما را وارد حساب نمی‌کند.
          </p>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <input
          dir="ltr"
          inputMode="tel"
          autoFocus
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="09121234567"
          aria-label="شمارهٔ موبایل"
          className="w-full rounded-lg border border-input px-3 py-2 text-center focus:border-primary focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !phone.trim()}
          className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          {busy ? "در حال ارسال…" : "ارسال کد بازیابی"}
        </button>
        <div className="text-center">
          <button
            type="button"
            onClick={onCancel}
            className="rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            بازگشت به ورود
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submitCode}>
      <div>
        <h2 className="text-base font-bold">کد بازیابی و رمز عبور تازه</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {notice}
        </p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div>
        <label htmlFor="recovery-code" className="mb-1 block text-sm text-muted-foreground">
          کد ۶ رقمی پیامک‌شده
        </label>
        <input
          id="recovery-code"
          dir="ltr"
          autoFocus
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(normalizeSecurityDigits(e.target.value, 6))}
          onPaste={(e) => {
            const pasted = otpFromPastedText(e.clipboardData.getData("text"));
            if (!pasted) return;
            e.preventDefault();
            setCode(pasted);
          }}
          placeholder="------"
          aria-label="کد بازیابی ۶ رقمی"
          className="w-full rounded-lg border border-input px-3 py-2 text-center text-lg tracking-[0.4em] focus:border-primary focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor="recovery-password" className="mb-1 block text-sm text-muted-foreground">
          رمز عبور جدید
        </label>
        <input
          id="recovery-password"
          type="password"
          dir="ltr"
          autoComplete="new-password"
          minLength={8}
          required
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          حداقل {toPersianDigits("8")} نویسه
        </p>
      </div>
      <div>
        <label htmlFor="recovery-password-confirm" className="mb-1 block text-sm text-muted-foreground">
          تکرار رمز عبور جدید
        </label>
        <input
          id="recovery-password-confirm"
          type="password"
          dir="ltr"
          autoComplete="new-password"
          minLength={8}
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
      </div>
      <button
        type="submit"
        disabled={busy || code.length !== 6 || !lengthOk || !matchOk}
        className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {busy ? "در حال ذخیره…" : "تغییر رمز عبور"}
      </button>
      <button
        type="button"
        disabled={busy || coolingDown}
        onClick={() => void requestCode()}
        className="w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {coolingDown
          ? `ارسال دوبارهٔ کد (${toPersianDigits(waitSeconds)})`
          : "ارسال دوبارهٔ کد"}
      </button>
      <div className="text-center">
        <button
          type="button"
          onClick={onCancel}
          className="rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          بازگشت به ورود
        </button>
      </div>
    </form>
  );
}
