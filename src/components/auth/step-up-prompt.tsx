"use client";

/**
 * Issue #854 (P1.6 / P1.9 / P1.10) — one recent-authentication prompt, used
 * everywhere a sensitive account action needs it.
 *
 * Three surfaces needed step-up (Profile's session card, Profile's phone card,
 * the 2FA settings panel) and each had grown its own copy of the ceremony. The
 * copies had drifted in exactly the way copies do:
 *
 *  - they posted `{ password }` and, in one case, `{ password, mfaCode }` while
 *    the route read `{ code }`, so a code-based step-up was unreachable from the
 *    UI (#854 P1.9);
 *  - they described availability from hard-coded assumptions, so a PIN-only
 *    cashier was shown a password box for an account that has no password
 *    (#854 P1.6);
 *  - none of them could start an SMS challenge, so the SMS factor could be
 *    enrolled but never used to re-prove identity (#854 P1.10).
 *
 * This component asks the server what the member actually holds
 * (`GET /api/auth/step-up` → `availableMethods` + `methodLabels`), renders
 * exactly that, and posts through `stepUpBody()` so the field names cannot
 * drift from the route's parser again. Nothing here decides policy: the server
 * still refuses a method the account lacks, and the caller still retries its
 * own action after `onVerified`.
 *
 * #854 follow-up:
 *  - **F03** — only methods a server ceremony can verify are ever rendered
 *    (`isVerifiableStepUpMethod`). WebAuthn used to arrive here and render as a
 *    *text box*; a typed string is not a WebAuthn assertion, so even a stale
 *    server that still advertised it gets no field from this component.
 *  - **F08** — the PIN is a secret like the password: a masked field that still
 *    opens the numeric keyboard and normalises Persian/Arabic digits.
 */
import { useCallback, useEffect, useState } from "react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import {
  authErrorMessage,
  isVerifiableStepUpMethod,
  stepUpBody,
  type StepUpMethod,
  type VerifiableStepUpMethod,
} from "@/lib/auth-contracts";
import { normalizeSecurityDigits, toLatinDigits } from "@/lib/digits";

interface StepUpStatus {
  availableMethods?: StepUpMethod[];
  methodLabels?: Partial<Record<StepUpMethod, string>>;
  hasPassword?: boolean;
  hasPin?: boolean;
  loginManagedByCloud?: boolean;
  error?: string;
}

/** Methods whose credential is a code typed from somewhere else. */
const CODE_METHODS: readonly VerifiableStepUpMethod[] = ["totp", "sms_otp", "recovery", "pin"];

/** Longest PIN the policy allows (`pin-policy.ts`: 4–12 digits). */
const PIN_MAX_DIGITS = 12;

/**
 * What a keystroke becomes, per method. Digit-only secrets are normalised as
 * they are typed (Persian/Arabic digits → ASCII, everything else dropped), so
 * the masked PIN field never holds a character the server would refuse.
 * Recovery codes may carry letters and dashes, so only their digits are
 * transliterated, at submit time.
 */
function normalizeStepUpInput(method: VerifiableStepUpMethod, value: string): string {
  if (method === "pin") return normalizeSecurityDigits(value, PIN_MAX_DIGITS);
  if (method === "totp" || method === "sms_otp") return normalizeSecurityDigits(value, 8);
  return value;
}

/** The server's list, minus anything no ceremony can verify (#854 F03). */
function verifiableMethods(status: StepUpStatus | null): VerifiableStepUpMethod[] {
  return (status?.availableMethods ?? []).filter(isVerifiableStepUpMethod);
}

export function StepUpPrompt({
  open,
  title = "تأیید مجدد هویت",
  description,
  onCancel,
  onVerified,
}: {
  open: boolean;
  title?: string;
  description?: string;
  onCancel: () => void;
  /** Called after the server accepted the proof and refreshed the session cookie. */
  onVerified: () => void;
}) {
  const [status, setStatus] = useState<StepUpStatus | null>(null);
  const [method, setMethod] = useState<VerifiableStepUpMethod | null>(null);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<StepUpStatus>("/api/auth/step-up");
    if (!ok) {
      setError("بارگذاری روش‌های تأیید هویت ممکن نشد.");
      return;
    }
    setStatus(data);
    const methods = verifiableMethods(data);
    setMethod((current) => (current && methods.includes(current) ? current : (methods[0] ?? null)));
  }, []);

  useEffect(() => {
    if (!open) return;
    setCredential("");
    setError(null);
    setNotice(null);
    void load();
  }, [open, load]);

  async function sendSmsChallenge() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ maskedPhone?: string; error?: string; message?: string }>(
      "/api/auth/step-up",
      { method: "POST", body: JSON.stringify({ action: "send_sms" }) },
    );
    setBusy(false);
    if (!ok) {
      setError(data.message || authErrorMessage(data.error) || "ارسال کد پیامکی ممکن نشد.");
      return;
    }
    setNotice(
      data.maskedPhone
        ? `کد ۶ رقمی به شمارهٔ ${data.maskedPhone} ارسال شد.`
        : "کد ۶ رقمی پیامکی ارسال شد.",
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!method) return;
    const offered = CODE_METHODS.includes(method) ? toLatinDigits(credential.trim()) : credential;
    if (!offered) {
      setError("مقدار خواسته‌شده را وارد کنید.");
      return;
    }
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/auth/step-up", {
      method: "POST",
      body: stepUpBody({ method, credential: offered }),
    });
    setBusy(false);
    if (!ok) {
      setError(data.message || authErrorMessage(data.error) || "تأیید هویت ناموفق بود.");
      return;
    }
    setCredential("");
    onVerified();
  }

  if (!open) return null;

  const methods = verifiableMethods(status);
  const label = (m: VerifiableStepUpMethod) => status?.methodLabels?.[m] ?? m;

  return (
    <form
      onSubmit={submit}
      className="mb-4 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
    >
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description ? (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {status === null ? (
        <LoadingSkeleton rows={1} />
      ) : methods.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          برای حساب شما روش تأیید هویتی ثبت نشده است. با مدیر کسب‌وکار تماس بگیرید.
        </p>
      ) : (
        <>
          {methods.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {methods.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMethod(m);
                    setCredential("");
                    setError(null);
                    setNotice(null);
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                    method === m
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {label(m)}
                </button>
              ))}
            </div>
          ) : null}

          {method ? (
            <div className="space-y-2">
              <Field
                label={label(method)}
                hint={
                  method === "sms_otp" && status.hasPassword === false
                    ? undefined
                    : method === "sms_otp"
                      ? "اگر کد را دریافت نکردید، دوباره درخواست دهید."
                      : undefined
                }
              >
                <input
                  dir="ltr"
                  /*
                   * #854 F08 — the PIN and the password are secrets and are
                   * masked; one-time codes (TOTP/SMS/recovery) are read off
                   * another device and stay visible while being typed.
                   */
                  type={method === "password" || method === "pin" ? "password" : "text"}
                  inputMode={
                    method === "password" ? undefined : method === "recovery" ? "text" : "numeric"
                  }
                  autoComplete={
                    method === "password"
                      ? "current-password"
                      : method === "pin"
                        ? "off"
                        : "one-time-code"
                  }
                  maxLength={
                    method === "password"
                      ? undefined
                      : method === "recovery"
                        ? 32
                        : method === "pin"
                          ? PIN_MAX_DIGITS
                          : 8
                  }
                  value={credential}
                  onChange={(e) => setCredential(normalizeStepUpInput(method, e.target.value))}
                  className={inputClass}
                />
              </Field>
              {method === "sms_otp" ? (
                <SecondaryButton onClick={() => void sendSmsChallenge()} disabled={busy}>
                  ارسال کد پیامکی
                </SecondaryButton>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={busy || !method || !credential.trim()}>
          تأیید
        </PrimaryButton>
        <SecondaryButton onClick={onCancel} disabled={busy}>
          انصراف
        </SecondaryButton>
      </div>
    </form>
  );
}

/** Copy for a `403 recent_auth_required` response, so callers word it once. */
export const RECENT_AUTH_MESSAGE =
  "برای انجام این تغییر امنیتی، ابتدا هویت خود را مجدداً تأیید کنید.";
