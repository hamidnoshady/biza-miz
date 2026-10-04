"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cardClass } from "@/app/dashboard/page-chrome";
import {
  MfaStep,
  TENANT_MFA_THEME,
  type MfaMethod,
} from "@/components/auth/mfa-step";
import { lockoutMessage, useNextPath } from "@/components/auth/login-helpers";
import { toPersianDigits } from "@/lib/digits";
import { clearRememberedLoginDoor } from "@/lib/login-door";

/** What `/api/auth/login` can answer with, beyond the plain success shape. */
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
}

/**
 * The owner/manager door of a tenant's origin, at `/admin`.
 *
 * Before the login split this password form shared `/login` with the staff
 * quick login behind a two-tab switch. The tenant origin's root is now the
 * staff door only; owners and managers sign in here, on the same business
 * origin — the API underneath (`/api/auth/login`, MFA interstitial, grace
 * nag) is unchanged, only the address moved.
 */
export default function AdminLoginForm() {
  const router = useRouter();
  // Root routes owners/managers to the wizard until setup is complete, so it
  // stays the fallback rather than /dashboard.
  const next = useNextPath("/");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Phase 24 Wave 2 — the second-factor interstitial.
   *
   * `/api/auth/login` answers `{ mfaRequired: true, mfaToken, mfaState }` for
   * an account past its grace window instead of setting a session cookie. Until
   * now nothing in the UI read that, so the response looked to the user exactly
   * like a wrong password.
   */
  const [pending, setPending] = useState<{
    token: string;
    method: MfaMethod | null;
    availableMethods: MfaMethod[];
  } | null>(null);
  /**
   * The grace nag: `mfaState: "grace"` arrives *alongside* a real session, so
   * this is a prompt, not a gate — the user is already signed in and may
   * dismiss it. Persisted for the length of the visit only; the countdown comes
   * back on the next login, which is the point of a countdown.
   */
  const [graceNotice, setGraceNotice] = useState<{ daysLeft: number | null } | null>(null);

  function goNext() {
    router.push(next);
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data: LoginResponse = await res.json().catch(() => ({}));
    setBusy(false);

    // A locked account answers 423 with the time it unlocks. Reporting that as
    // "wrong email or password" sends the user off to re-check a password that
    // is perfectly correct, and to keep trying, which is exactly what extends
    // the lockout.
    if (res.status === 423) {
      setError(lockoutMessage(data.lockedUntil));
      return;
    }

    if (res.ok && data.mfaRequired && data.mfaToken) {
      setPending({
        token: data.mfaToken,
        method: data.mfaMethod ?? null,
        availableMethods: data.availableMethods ?? [],
      });
      return;
    }

    if (res.ok) {
      if (data.mfaState === "grace") {
        setGraceNotice({ daysLeft: data.graceDaysLeft ?? null });
        return;
      }
      goNext();
      return;
    }

    setError("ایمیل یا رمز عبور نادرست است.");
  }

  // The MFA interstitial and the grace nag replace the form *inside* the same
  // card chrome — MfaStep's theme is only its inner spacing, not a page.
  let body: React.ReactNode;
  if (pending) {
    body = (
      <MfaStep
        mfaToken={pending.token}
        mfaMethod={pending.method}
        availableMethods={pending.availableMethods}
        theme={TENANT_MFA_THEME}
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
  } else if (graceNotice) {
    body = <GracePrompt daysLeft={graceNotice.daysLeft} onContinue={goNext} />;
  } else {
    body = (
      <form onSubmit={submit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="mb-1 block text-sm text-muted-foreground"
            >
              ایمیل
            </label>
            <input
              id="email"
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-sm text-muted-foreground"
            >
              رمز عبور
            </label>
            <input
              id="password"
              type="password"
              dir="ltr"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            {busy ? "در حال ورود…" : "ورود"}
          </button>
        </form>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className={`w-full max-w-sm ${cardClass} p-8`}>
        <h1 className="mb-1 text-center text-xl font-bold">
          پلتفرم مدیریت کسب‌وکار
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          ورود مدیر / مالک
        </p>

        {body}

        {/*
          The audit fix's other half: an owner who lands here by mistake (or
          who wants to switch this device back to the staff door) must not be
          stuck on a password form with no way out. Clearing the remembered
          door sends `/login` back to the chooser on its next visit.
        */}
        <button
          type="button"
          onClick={() => {
            clearRememberedLoginDoor();
            router.push("/login");
          }}
          className="mx-auto mt-4 block text-center text-xs text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          کارمند هستید؟ ورود کارکنان
        </button>
      </div>
    </main>
  );
}

/**
 * Phase 24 Wave 2 — the "set up 2FA, N days left" nag.
 *
 * Shown *after* a successful sign-in, never instead of one. The phase spec is
 * explicit that during the grace window login shows "an enrolment prompt with
 * a 'later' button and a visible countdown", and that the hard gate only
 * follows once the window closes — a business cannot be locked out of its own
 * till by a security feature it has not been given time to adopt.
 *
 * Enrolment itself lives in the dashboard rather than here: at this point the
 * session cookie is already set, so «همین حالا فعال می‌کنم» is a normal
 * authenticated navigation, not a second login step.
 */
function GracePrompt({ daysLeft, onContinue }: { daysLeft: number | null; onContinue: () => void }) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
        <p className="mb-1 font-semibold">ورود دومرحله‌ای را فعال کنید</p>
        <p className="text-muted-foreground">
          {daysLeft === null
            ? "حساب مالک باید به‌زودی با ورود دومرحله‌ای محافظت شود."
            : daysLeft <= 0
              ? "مهلت فعال‌سازی ورود دومرحله‌ای امروز تمام می‌شود."
              : `${toPersianDigits(String(daysLeft))} روز تا اجباری‌شدن ورود دومرحله‌ای باقی مانده است.`}
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
        onClick={onContinue}
        className="w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        بعداً
      </button>
    </div>
  );
}
