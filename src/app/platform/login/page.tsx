"use client";

/**
 * Phase 15 — the super-admin console's own front door.
 *
 * A separate login from the tenant one, POSTing to the platform auth realm
 * (`/api/platform/auth/login`) which sets the `pos_platform_session` cookie —
 * never the tenant `pos_session`. Deliberately spartan and dark-first, so an
 * operator is never in doubt about which realm they are entering.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage, ErrorBox, Field, inputClass } from "../ui";
import { MfaStep, PLATFORM_MFA_THEME, type MfaMethod } from "@/components/auth/mfa-step";
import { toPersianDigits } from "@/lib/digits";

/** Everything `/api/platform/auth/login` can answer beyond the plain success shape. */
interface PlatformLoginResponse {
  error?: string;
  lockedUntil?: string;
  mfaRequired?: boolean;
  mfaToken?: string;
  mfaMethod?: MfaMethod | null;
  availableMethods?: MfaMethod[];
  mfaState?: "grace" | "required";
  graceDaysLeft?: number | null;
}

/** «۳ دقیقه دیگر» for a 423 from the platform lockout policy. */
function lockoutMessage(lockedUntil: unknown): string {
  const until = typeof lockedUntil === "string" ? new Date(lockedUntil) : null;
  if (!until || Number.isNaN(until.getTime())) {
    return "به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است.";
  }
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return `به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است؛ ${toPersianDigits(String(minutes))} دقیقه دیگر دوباره تلاش کنید.`;
}

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The `mfa_pending` token an admin past their grace window receives. */
  const [pending, setPending] = useState<{
    token: string;
    method: MfaMethod | null;
    availableMethods: MfaMethod[];
  } | null>(null);
  /** Grace: the session is already set: this is a nag with a countdown, not a gate. */
  const [graceDaysLeft, setGraceDaysLeft] = useState<number | null | undefined>(undefined);

  function enterConsole() {
    router.push("/platform");
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok, status, data } = await api<PlatformLoginResponse>(
      "/api/platform/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      },
    );
    setBusy(false);

    // 423 = locked. Same reasoning as the tenant form: a generic "wrong
    // password" here sends an operator round the loop that extends the lock.
    if (status === 423) {
      setError(lockoutMessage(data.lockedUntil));
      return;
    }

    if (ok && data.mfaRequired && data.mfaToken) {
      setPending({
        token: data.mfaToken,
        method: data.mfaMethod ?? null,
        availableMethods: data.availableMethods ?? [],
      });
      return;
    }

    if (ok) {
      if (data.mfaState === "grace") {
        setGraceDaysLeft(data.graceDaysLeft ?? null);
        return;
      }
      enterConsole();
      return;
    }

    setError(errorMessage(data.error));
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8">
        <div className="mb-6 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-sky-600/80 dark:text-sky-400/80">
            Platform Console
          </p>
          <h1 className="mt-2 text-lg font-bold">کنسول مدیریت سکو</h1>
          <p className="mt-1 text-sm text-muted-foreground">ورود مدیران سکو</p>
        </div>

        {pending ? (
          <MfaStep
            mfaToken={pending.token}
            mfaMethod={pending.method}
            availableMethods={pending.availableMethods}
            theme={PLATFORM_MFA_THEME}
            endpoints={{
              challenge: "/api/platform/auth/mfa/challenge",
              verify: "/api/platform/auth/mfa/verify",
              enrol: "/api/platform/auth/mfa/enrol",
            }}
            onVerified={enterConsole}
            onCancel={() => {
              setPending(null);
              setPassword("");
            }}
          />
        ) : graceDaysLeft !== undefined ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-900 dark:text-sky-100">
              <p className="mb-1 font-semibold">ورود دومرحله‌ای را فعال کنید</p>
              <p className="text-sky-900/70 dark:text-sky-100/70">
                {graceDaysLeft === null
                  ? "حساب مدیر سکو باید به‌زودی با ورود دومرحله‌ای محافظت شود."
                  : graceDaysLeft <= 0
                    ? "مهلت فعال‌سازی امروز تمام می‌شود."
                    : `${toPersianDigits(String(graceDaysLeft))} روز تا اجباری‌شدن ورود دومرحله‌ای باقی مانده است.`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                router.push("/platform/account");
                router.refresh();
              }}
              className="h-10 w-full rounded-lg bg-sky-500 text-sm font-semibold text-foreground transition-colors hover:bg-sky-400"
            >
              همین حالا فعال می‌کنم
            </button>
            <button
              type="button"
              onClick={enterConsole}
              className="h-10 w-full rounded-lg border border-border text-sm font-semibold text-foreground transition-colors hover:bg-muted"
            >
              بعداً
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <ErrorBox>{error}</ErrorBox>
            <Field label="ایمیل">
              <input
                type="email"
                dir="ltr"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`${inputClass} text-start`}
              />
            </Field>
            <Field label="رمز عبور">
              <input
                type="password"
                dir="ltr"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
            </Field>
            <div className="mt-2">
              <button
                type="submit"
                disabled={busy}
                className="h-10 w-full rounded-lg bg-sky-500 text-sm font-semibold text-foreground transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-sky-500/50"
              >
                {busy ? "در حال ورود…" : "ورود"}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
