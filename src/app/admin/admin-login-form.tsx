"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import {
  MfaStep,
  TENANT_MFA_THEME,
  type MfaMethod,
} from "@/components/auth/mfa-step";
import { lockoutMessage, useNextPath } from "@/components/auth/login-helpers";
import {
  networkErrorMessage,
  useLoginRequest,
} from "@/components/auth/use-login-request";
import { loginErrorMessage, withLoginNextParam } from "@/lib/login-contract";
import { toPersianDigits } from "@/lib/digits";
import { clearRememberedLoginDoor } from "@/lib/login-door";

/** What `/api/auth/login` can answer with, beyond the plain success shape. */
interface LoginResponse {
  error?: string;
  /**
   * Issue #885 L08 — a host-routing-off install with more than one business
   * answers this *without* setting a session. Treating any 2xx as "signed in"
   * sent the user to a destination they had no session for.
   */
  needsBusinessSelection?: boolean;
  businesses?: { id: string; name: string }[];
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
  /** The password is hidden by default; the toggle is an explicit, labelled action. */
  const [showPassword, setShowPassword] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  /**
   * Issue #885 L08 — a multi-business install with host routing off answers
   * `needsBusinessSelection` and sets no session. Until the user picks, the
   * form must not navigate.
   */
  const [businessChoice, setBusinessChoice] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const { busy, send } = useLoginRequest();
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

  /**
   * One attempt, addressed to one business.
   *
   * Issue #885 L05: the request goes through `useLoginRequest`, which aborts
   * on a timeout, catches a network rejection and always releases `busy` in a
   * `finally`. The previous shape awaited a bare `fetch` with neither, so a
   * dropped connection left the button permanently disabled reading «در حال
   * ورود…» with no way to recover short of reloading.
   */
  async function attempt(targetBusinessId?: string) {
    setError(null);
    setBusinessChoice(null);
    const outcome = await send<LoginResponse>((signal) =>
      fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(targetBusinessId ? { businessId: targetBusinessId } : {}),
        }),
        signal,
      }),
    );

    // A newer attempt superseded this one; its result is not ours to render.
    if (outcome.stale) return;

    // Issue #885 L09 — a request that never reached the server is its own
    // message. Calling it "wrong password" sends the user to re-type a
    // credential that was never the problem.
    if (outcome.networkError) {
      setError(networkErrorMessage(outcome.networkError));
      return;
    }

    const { status, data } = outcome;

    // A locked account answers 423 with the time it unlocks. Reporting that as
    // "wrong email or password" sends the user off to re-check a password that
    // is perfectly correct, and to keep trying, which is exactly what extends
    // the lockout.
    if (status === 423) {
      setError(lockoutMessage(data.lockedUntil));
      return;
    }

    if (outcome.ok && data.mfaRequired && data.mfaToken) {
      setPending({
        token: data.mfaToken,
        method: data.mfaMethod ?? null,
        availableMethods: data.availableMethods ?? [],
      });
      return;
    }

    // Issue #885 L08 — no session was set here. Ask which business, then
    // re-attempt with it named; navigating now would land on a destination
    // this browser has no session for.
    if (outcome.ok && data.needsBusinessSelection) {
      setBusinessChoice(data.businesses ?? []);
      setError(null);
      return;
    }

    if (outcome.ok) {
      if (data.mfaState === "grace") {
        setGraceNotice({ daysLeft: data.graceDaysLeft ?? null });
        return;
      }
      goNext();
      return;
    }

    setError(loginErrorMessage({ status, code: data.error, retryAfterMs: null }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void attempt();
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
  } else if (businessChoice) {
    body = (
      <BusinessPicker
        businesses={businessChoice}
        busy={busy}
        onPick={(id) => void attempt(id)}
        onBack={() => setBusinessChoice(null)}
      />
    );
  } else if (graceNotice) {
    body = <GracePrompt daysLeft={graceNotice.daysLeft} onContinue={goNext} />;
  } else {
    body = (
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm text-muted-foreground">
            ایمیل
          </label>
          <input
            id="email"
            type="email"
            dir="ltr"
            required
            // Issue #885 L12/L16 — the autocomplete purpose. Without it the
            // browser cannot offer to fill a saved credential, and password
            // managers cannot tell which field is the identifier.
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm text-muted-foreground">
            رمز عبور
          </label>
          <div className="relative">
            <input
              id="password"
              // A real toggle, not a second field: screen readers hear the
              // field's type change, and the button announces its own state.
              type={showPassword ? "text" : "password"}
              dir="ltr"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-input px-3 py-2 pe-11 text-start focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label={showPassword ? "پنهان‌کردن رمز عبور" : "نمایش رمز عبور"}
              className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              {showPassword ? (
                <EyeOffIcon className="size-4" aria-hidden="true" />
              ) : (
                <EyeIcon className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {/*
          Issue #885 L10 — the recovery path. This deployment has no
          transactional email transport wired for platform identities (the
          message outbox is campaign-scoped and billing-metered), so the
          honest answer is the one that actually works today: an owner or
          admin issues a single-use reset link from the team screen. Saying
          "we sent you an email" would be a promise nothing keeps.
        */}
        <div className="text-end">
          <button
            type="button"
            onClick={() => setShowRecovery((v) => !v)}
            aria-expanded={showRecovery}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            رمز عبور را فراموش کرده‌اید؟
          </button>
        </div>
        {showRecovery ? <RecoveryHelp /> : null}

        {/*
          Issue #885 L12 — a live region, not an ordinary paragraph. A
          screen-reader user submitting this form previously heard nothing at
          all when it failed, because focus stays on the submit button and the
          error appeared elsewhere in the tree.
        */}
        <p aria-live="assertive" role="alert" className="min-h-5 text-sm text-destructive">
          {error ?? ""}
        </p>

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
            // Issue #885 L06 — carry the destination back with the user. The
            // hard-coded "/login" here is what dropped ?next=/settings/profile
            // the moment someone switched doors.
            router.push(withLoginNextParam("/login", next));
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

/**
 * Issue #885 L08 — "which business?" for a multi-business install that does
 * not route by hostname.
 *
 * `/api/auth/login` answers `needsBusinessSelection` with no session set. The
 * old form read any 2xx as "signed in" and navigated, landing the user on a
 * destination their browser had no session for. This is the missing state:
 * pick one, and the attempt runs again with it named.
 *
 * It is a picker over businesses the credentials already matched — the
 * password was proven before this list existed, so naming them here discloses
 * nothing that was not already proven.
 */
function BusinessPicker({
  businesses,
  busy,
  onPick,
  onBack,
}: {
  businesses: { id: string; name: string }[];
  busy: boolean;
  onPick: (businessId: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        این ایمیل به بیش از یک کسب‌وکار دسترسی دارد. کدام را می‌خواهید؟
      </p>
      <div className="space-y-2">
        {businesses.map((business) => (
          <button
            key={business.id}
            type="button"
            disabled={busy}
            onClick={() => onPick(business.id)}
            className="w-full rounded-lg border border-input px-3 py-2.5 text-start text-sm font-semibold transition hover:border-primary/60 hover:bg-primary/5 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            {business.name}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onBack}
        className="w-full rounded-lg border border-input py-2 text-sm text-muted-foreground transition hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        بازگشت
      </button>
    </div>
  );
}

/**
 * Issue #885 L10 — how a locked-out manager actually gets back in.
 *
 * Deliberately not a "we emailed you" flow: this deployment has no
 * transactional email transport wired for platform identities. The message
 * outbox in `message-outbox-service.ts` is campaign-scoped and reserves
 * billing credit per send, which is the wrong subsystem for a security
 * credential — so rather than pretend, this names the path that works today.
 */
function RecoveryHelp() {
  return (
    <div className="rounded-lg border border-border/80 bg-muted/40 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
      پیوند بازنشانی رمز عبور را مدیر یا مالک کسب‌وکار از صفحهٔ «تیم» برای شما
      صادر می‌کند. اگر خودتان مالک هستید و دسترسی ندارید، از مدیر سامانه کمک
      بگیرید. این پیوند یک‌بار مصرف است و ۲۴ ساعت اعتبار دارد.
    </div>
  );
}
