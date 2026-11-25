"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CloudIcon } from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/app/dashboard/ui";
import { normalizeServerAddress } from "@/lib/connection-code";
import { recordDesktopBusinessIdentity } from "@/lib/desktop-business-identity";
import { toPersianDigits } from "@/lib/digits";
import { ENROLLMENT_POLL_INTERVAL_MS, formatUserCode } from "@/lib/desktop-enroll-shared";

/**
 * Issue #1115 §A.3 — Hybrid first run, browser-based, on the Windows side.
 *
 * The owner no longer copies a pairing code out of the Cloud panel: they type
 * the Cloud address once (the same address they sign in at), sign in in the
 * system browser, and confirm this device there. The app holds a secret that
 * never leaves the machine, shows the user code the Cloud issued so the owner
 * can match it on screen, and polls its own server until the Cloud hands it a
 * one-time code — which it then redeems through the ordinary pairing path.
 *
 * The typed-code flow is still one click away (`onUsePairingCode`): a Cloud
 * build that predates this endpoint, or an owner who already has a code from
 * the panel, must not be blocked by the new default.
 */
interface Enrollment {
  requestId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string | null;
  remoteUrl: string;
  deviceSecret: string;
}

const ERRORS: Record<string, string> = {
  remote_unreachable: "سرور ابری در این آدرس پاسخ نداد. آدرس و اتصال اینترنت را بررسی کنید.",
  unknown_business: "در این آدرس کسب‌وکار فعالی پیدا نشد. همان آدرسی را وارد کنید که با آن وارد پنل ابری می‌شوید.",
  not_central_server: "این آدرس نسخهٔ ابری پلتفرم نیست. آدرس درست پنل ابری را وارد کنید.",
  insecure_origin: "اتصال به پنل ابری باید با HTTPS باشد.",
  enrollment_invalid: "پاسخ سرور ابری معتبر نبود. سرور ابری را به‌روز کنید و دوباره تلاش کنید.",
  invalid_url: "آدرس سرور معتبر نیست.",
  missing_fields: "آدرس سرور ابری را وارد کنید.",
  expired: "مهلت تأیید در مرورگر تمام شد. دوباره درخواست بسازید.",
  denied: "درخواست اتصال این دستگاه در مرورگر رد شد.",
  not_found: "این درخواست دیگر معتبر نیست. دوباره درخواست بسازید.",
  sync_failed: "دریافت تنظیمات از سرور ابری ناموفق بود. دوباره تلاش کنید.",
};

/** The pairing failures this path can still produce, in the owner's language. */
const PAIR_ERRORS: Record<string, string> = {
  code_expired: "مهلت اتصال تمام شد. دوباره درخواست بسازید.",
  code_already_redeemed: "این اتصال قبلاً انجام شده است. دوباره درخواست بسازید.",
  code_revoked: "درخواست اتصال لغو شد. دوباره درخواست بسازید.",
  pairing_session_unavailable: "سرور ابری نتوانست تنظیمات را آماده کند. دوباره تلاش کنید.",
  pairing_payment_routing_unsupported:
    "این شعبه از مسیردهی پرداخت آنلاین استفاده می‌کند و فعلاً امکان اتصال نسخهٔ دسکتاپ را ندارد.",
  server_predates_account_state:
    "سرور ابری هنوز از حساب‌های بایگانی‌شده و متضاد پشتیبانی نمی‌کند. ابتدا سرور ابری را به‌روز کنید.",
};

/** What `/api/setup/pair` reports about the login-credential plane it converged. */
interface CredentialSync {
  status: string;
  pinMembersExpected: number;
  pinMembersUsable: number;
  pinMembersMissing: number;
  error: string | null;
}

type Phase = "address" | "waiting" | "applying" | "paired" | "signin" | "error";

export function CloudEnrollForm({
  onBack,
  onUsePairingCode,
}: {
  onBack: () => void;
  onUsePairingCode: () => void;
}) {
  const router = useRouter();
  const [remoteUrl, setRemoteUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("address");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  /** Paired, but the credential plane may not have fully converged yet. */
  const [pairResult, setPairResult] = useState<{
    identitySyncPending: boolean;
    credentialSync: CredentialSync | null;
  } | null>(null);
  const addressPreview = normalizeServerAddress(remoteUrl);

  async function start() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/setup/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteUrl }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<Enrollment> & { error?: string };
      if (!res.ok || !data.requestId || !data.deviceSecret || !data.verificationUrl) {
        setError(ERRORS[data.error ?? ""] ?? "ساخت درخواست اتصال ناموفق بود. دوباره تلاش کنید.");
        return;
      }
      setEnrollment({
        requestId: data.requestId,
        userCode: data.userCode ?? "",
        verificationUrl: data.verificationUrl,
        expiresAt: data.expiresAt ?? null,
        remoteUrl: data.remoteUrl ?? remoteUrl,
        deviceSecret: data.deviceSecret,
      });
      setPhase("waiting");
      // The desktop shell opens https links in the system browser.
      window.open(data.verificationUrl, "_blank", "noopener,noreferrer");
    } catch {
      setError(ERRORS.remote_unreachable);
    } finally {
      setBusy(false);
    }
  }

  const complete = useCallback(
    async (code: string) => {
      if (!enrollment) return;
      try {
        const res = await fetch("/api/setup/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ remoteUrl: enrollment.remoteUrl, code }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          signedIn?: boolean;
          identitySyncPending?: boolean;
          credentialSync?: CredentialSync | null;
          businessId?: string;
          businessSubdomain?: string;
          cloudOrigin?: string;
        };
        if (res.ok) {
          // #1572 — same hand-off as the pairing wizard: the shell names the
          // saved business now that enrollment has proven it. No-op in a browser.
          recordDesktopBusinessIdentity({
            businessId: data.businessId,
            businessSubdomain: data.businessSubdomain ?? null,
            cloudOrigin: data.cloudOrigin ?? null,
          });
          // Paired. The device-local owner PIN is optional from here: Cloud
          // identity material already travelled with the snapshot, and the
          // epic's contract is no compulsory second setup form on the till.
          //
          // What is not optional is saying whether that identity material
          // actually arrived. Pairing commits the snapshot, but the
          // login-credential plane can still be behind (cloud briefly
          // unreachable, or staff PINs still missing); jumping to the dashboard
          // would leave the owner to discover that at a failed staff login.
          if (data.signedIn === false) {
            setPhase("signin");
            return;
          }
          setPairResult({
            identitySyncPending: Boolean(data.identitySyncPending),
            credentialSync: data.credentialSync ?? null,
          });
          setPhase("paired");
          return;
        }
        if (data.error === "already_initialized") {
          router.replace("/login");
          return;
        }
        setError(PAIR_ERRORS[data.error ?? ""] ?? ERRORS.sync_failed);
        setPhase("error");
      } catch {
        setError(ERRORS.sync_failed);
        setPhase("error");
      }
    },
    [enrollment, router],
  );

  useEffect(() => {
    if (phase !== "waiting" || !enrollment) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = enrollment.expiresAt
      ? Date.parse(enrollment.expiresAt)
      : Date.now() + 10 * 60 * 1000;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setError(ERRORS.expired);
        setPhase("error");
        return;
      }
      let data: { status?: string; pairingCode?: string } = {};
      try {
        const res = await fetch("/api/setup/enroll/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            remoteUrl: enrollment.remoteUrl,
            requestId: enrollment.requestId,
            deviceSecret: enrollment.deviceSecret,
          }),
        });
        data = (await res.json().catch(() => ({}))) as { status?: string; pairingCode?: string };
      } catch {
        // A dropped poll is not a failed enrollment; try again next tick.
        if (!cancelled) timer = setTimeout(tick, ENROLLMENT_POLL_INTERVAL_MS);
        return;
      }
      if (cancelled) return;
      if (data.status === "approved" && typeof data.pairingCode === "string") {
        setPhase("applying");
        await complete(data.pairingCode);
        return;
      }
      if (data.status === "denied" || data.status === "expired" || data.status === "not_found") {
        setError(ERRORS[data.status] ?? ERRORS.not_found);
        setPhase("error");
        return;
      }
      timer = setTimeout(tick, ENROLLMENT_POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, ENROLLMENT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, enrollment, complete]);

  function restart() {
    setEnrollment(null);
    setPairResult(null);
    setError("");
    setPhase("address");
  }

  return (
    <div className={`mx-auto w-full max-w-lg ${cardClass} p-8`}>
      {phase !== "paired" && phase !== "signin" ? (
        <button
          type="button"
          onClick={phase === "address" ? onBack : restart}
          className="mb-4 inline-flex min-h-10 items-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          ← بازگشت
        </button>
      ) : null}

      {phase === "address" ? (
        <>
          <h1 className="mb-1 text-2xl font-bold">اتصال به کسب‌وکار موجود</h1>
          <p className="mb-6 text-sm leading-6 text-muted-foreground">
            آدرسی را که با آن وارد پنل ابری می‌شوید وارد کنید. سپس در مرورگر وارد حساب خود
            می‌شوید و همین دستگاه را تأیید می‌کنید؛ نیازی به کپی‌کردن کد اتصال نیست.
          </p>
          {error ? (
            <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <Field label="آدرس سرور ابری *" hint="همان آدرسی که با آن وارد پنل ابری می‌شوید.">
              <input
                className={inputClass}
                dir="ltr"
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                placeholder="mybusiness.example.com"
                autoComplete="off"
                required
              />
            </Field>
            {addressPreview.ok && addressPreview.url !== remoteUrl.trim() ? (
              <p className="text-xs text-muted-foreground" dir="ltr">
                {addressPreview.url}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={busy || !remoteUrl.trim()}>
              <CloudIcon className="size-4" aria-hidden="true" />
              {busy ? "در حال ساخت درخواست…" : "ورود با حساب ابری"}
            </Button>
          </form>
          <button
            type="button"
            onClick={onUsePairingCode}
            className="mt-4 w-full text-xs font-medium text-teal-700 underline-offset-4 hover:underline dark:text-teal-300"
          >
            کد اتصال دستی دارم
          </button>
        </>
      ) : null}

      {phase === "waiting" && enrollment ? (
        <>
          <h1 className="mb-1 text-2xl font-bold">تأیید در مرورگر</h1>
          <p className="mb-6 text-sm leading-6 text-muted-foreground">
            مرورگر باز شد. در حساب ابری خود وارد شوید و «تأیید و اتصال دستگاه» را بزنید. این
            پنجره را باز نگه دارید؛ پس از تأیید، تنظیمات خودکار دریافت می‌شوند.
          </p>
          <div className="rounded-xl border border-border bg-muted/40 p-4 text-center">
            <p className="text-xs text-muted-foreground">کد تأیید این دستگاه</p>
            <p className="mt-2 font-mono text-2xl tracking-[0.3em] text-foreground" dir="ltr">
              {formatUserCode(enrollment.userCode)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              این کد باید در مرورگر هم همین باشد.
            </p>
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            در انتظار تأیید در مرورگر…
          </p>
          <Button type="button" variant="outline" className="mt-4 w-full" onClick={restart}>
            لغو و شروع دوباره
          </Button>
        </>
      ) : null}

      {phase === "applying" ? (
        <>
          <h1 className="mb-1 text-2xl font-bold">در حال دریافت تنظیمات</h1>
          <p className="mb-6 text-sm leading-6 text-muted-foreground">
            دستگاه تأیید شد. داده‌های کسب‌وکار، کاربران و دسترسی‌های شعبه دریافت می‌شوند. این
            پنجره را نبندید.
          </p>
          <FormLoadingSkeleton rows={3} label="در حال دریافت تنظیمات از ابر" />
        </>
      ) : null}

      {phase === "signin" ? (
        <>
          <h1 className="mb-1 text-2xl font-bold">دستگاه متصل شد</h1>
          <div
            role="status"
            className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-foreground"
          >
            این دستگاه به حساب ابری متصل شد، اما ورود خودکار انجام نشد. با ایمیل و گذرواژهٔ مالک
            وارد شوید تا راه‌اندازی ادامه پیدا کند.
          </div>
          <Button type="button" className="w-full" onClick={() => router.replace("/login")}>
            رفتن به صفحهٔ ورود
          </Button>
        </>
      ) : null}

      {phase === "paired" ? (
        <>
          <h1 className="mb-1 text-2xl font-bold">دستگاه متصل شد</h1>
          <p className="mb-6 text-sm leading-6 text-muted-foreground">
            {pairResult?.identitySyncPending
              ? "تنظیمات کسب‌وکار، کاربران و دسترسی‌های شعبه دریافت شد."
              : "تنظیمات کسب‌وکار، کاربران، دسترسی‌های شعبه و اطلاعات ورود کارکنان دریافت شد."}
          </p>
          {pairResult?.identitySyncPending ? (
            <div
              role="status"
              className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-foreground"
            >
              <p className="font-medium">اطلاعات ورود کارکنان هنوز کامل دریافت نشده است.</p>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                {(pairResult.credentialSync?.pinMembersMissing ?? 0) > 0
                  ? `${toPersianDigits(pairResult.credentialSync?.pinMembersMissing ?? 0)} حساب از ${toPersianDigits(pairResult.credentialSync?.pinMembersExpected ?? 0)} حساب هنوز روی این دستگاه آماده نیست. `
                  : ""}
                دستگاه کار می‌کند، اما ممکن است کارکنان فعلاً نتوانند با پین وارد شوند. در «تنظیمات ← اتصال
                و همگام‌سازی» گزینهٔ «همگام‌سازی دوباره» را بزنید.
              </p>
            </div>
          ) : null}
          <Button type="button" className="w-full" onClick={() => router.replace("/dashboard")}>
            رفتن به داشبورد
          </Button>
        </>
      ) : null}

      {phase === "error" ? (
        <>
          <h1 className="mb-1 text-2xl font-bold">اتصال انجام نشد</h1>
          <div role="alert" className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
          <Button type="button" className="w-full" onClick={restart}>
            تلاش دوباره
          </Button>
          <button
            type="button"
            onClick={onUsePairingCode}
            className="mt-4 w-full text-xs font-medium text-teal-700 underline-offset-4 hover:underline dark:text-teal-300"
          >
            استفاده از کد اتصال دستی
          </button>
        </>
      ) : null}
    </div>
  );
}
