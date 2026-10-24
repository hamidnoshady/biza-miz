"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { cardClass } from "@/app/dashboard/page-chrome";
import { ModeChoice } from "./mode-choice";
import { PairForm } from "./pair-form";
import { UploadRestorePanel } from "@/app/dashboard/backup/backup-manager";
import {
  ENABLED_INDUSTRIES,
  INDUSTRIES,
  INDUSTRY_LABELS,
  type Industry,
} from "@/lib/industries";
import { classifyLocalEnrollmentCode } from "@/lib/connection-code";

type Stage = "choosing" | "local" | "connecting" | "restoring";

/**
 * First-run page. On a completely empty database it asks how this install
 * should be set up — a brand-new local-only business, or an existing online
 * business claimed with a pairing code — then runs the chosen path. If the
 * install already has users, it redirects to the normal login.
 */
export default function WelcomePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [stage, setStage] = useState<Stage>("choosing");
  const [canRestore, setCanRestore] = useState(false);

  useEffect(() => {
    // Only an empty *desktop* install may restore here; the server decides.
    fetch("/api/setup/restore")
      .then((r) => r.json())
      .then((s: { available?: boolean }) => setCanRestore(Boolean(s.available)))
      .catch(() => setCanRestore(false));
  }, []);

  useEffect(() => {
    fetch("/api/setup/state")
      .then((r) => r.json())
      .then((s: { needsBootstrap?: boolean }) => {
        if (!s.needsBootstrap) {
          router.replace("/login");
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));
  }, [router]);

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className={`w-full max-w-md ${cardClass} p-6`}>
          <FormLoadingSkeleton rows={3} label="در حال بررسی وضعیت راه‌اندازی" />
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 sm:px-6">
      <div className="w-full">
        {stage !== "choosing" ? (
          <div
            className="mx-auto mb-4 flex w-full max-w-md items-center justify-center gap-2 text-xs text-muted-foreground"
            aria-label="پیشرفت راه‌اندازی"
          >
            <span className="size-2 rounded-full bg-emerald-600 dark:bg-emerald-400" />
            <span>انتخاب روش</span>
            <span className="h-px w-8 bg-border" />
            <span className="size-2 rounded-full bg-amber-500 dark:bg-amber-400" />
            <span>
              {stage === "local"
                ? "ساخت فضای کار"
                : stage === "restoring"
                  ? "بازگردانی پشتیبان"
                  : "اتصال دستگاه"}
            </span>
          </div>
        ) : null}
        {stage === "choosing" ? (
          <ModeChoice
            canRestore={canRestore}
            onChoose={(mode) =>
              setStage(
                mode === "local" ? "local" : mode === "restore" ? "restoring" : "connecting",
              )
            }
          />
        ) : null}
        {stage === "local" ? (
          <LocalBootstrapForm onBack={() => setStage("choosing")} />
        ) : null}
        {stage === "connecting" ? (
          <PairForm onBack={() => setStage("choosing")} />
        ) : null}
        {stage === "restoring" ? (
          <RestoreFromFileForm onBack={() => setStage("choosing")} />
        ) : null}
      </div>
    </main>
  );
}

/**
 * The reinstall path: upload the backup the previous install wrote, verify it,
 * then replace this empty database with it. Afterwards the owner signs in with
 * their old account; cloud sync is re-attached from the desktop panel's
 * «ترمیم / اتصال دوباره», which keeps the restored data and queued events.
 */
function RestoreFromFileForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [applied, setApplied] = useState(false);
  return (
    <div className={`mx-auto w-full max-w-2xl ${cardClass} p-8`}>
      {!applied ? (
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex min-h-10 items-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          ← بازگشت
        </button>
      ) : null}
      <h1 className="mb-1 text-2xl font-bold">بازگردانی از فایل پشتیبان</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        فایل ابتدا در یک پایگاه‌دادهٔ موقت بررسی می‌شود و تا شما تأیید نکنید چیزی تغییر نمی‌کند.
      </p>
      <UploadRestorePanel
        endpoint="/api/setup/restore/upload"
        onApplied={() => setApplied(true)}
        onRun={async ({ uploadId, fileName, passphrase, apply }) => {
          const res = await fetch("/api/setup/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadId, fileName, passphrase, apply }),
          });
          return res.json().catch(() => ({ error: "" }));
        }}
      />
      {applied ? (
        <button
          type="button"
          onClick={() => router.replace("/login")}
          className="mt-6 inline-flex min-h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          رفتن به صفحهٔ ورود
        </button>
      ) : null}
    </div>
  );
}

const LOCAL_BOOTSTRAP_ERRORS: Record<string, string> = {
  missing_fields: "همهٔ فیلدهای الزامی را پر کنید.",
  cloud_activation_required:
    "برای راه‌اندازی تمام‌آفلاین، وارد کردن آدرس سرور ابری و توکن فعال‌سازی آفلاین الزامی است.",
  missing_cloud_url: "آدرس سرور ابری را وارد کنید.",
  invalid_cloud_url: "آدرس سرور ابری معتبر نیست.",
  https_required: "آدرس سرور ابری باید با ارتباط امن HTTPS باشد.",
  private_or_loopback_address_forbidden:
    "آدرس شبکهٔ داخلی یا محلی برای فعال‌سازی ابری مجاز نیست؛ آدرس عمومی پنل ابری را وارد کنید.",
  dns_error: "نام دامنهٔ سرور ابری پیدا نشد. آدرس واردشده و اتصال اینترنت را بررسی کنید.",
  tls_error: "گواهی امنیتی (TLS/SSL) سرور ابری معتبر نیست.",
  timeout: "پاسخ‌گویی سرور ابری بیش از حد طول کشید. اینترنت را بررسی و تلاش مجدد کنید.",
  network_error: "ارتباط با سرور ابری برقرار نشد. اتصال اینترنت و آدرس سرور را بررسی کنید.",
  cloud_5xx: "سرور ابری موقتاً در دسترس نیست. چند لحظه بعد تلاش مجدد کنید.",
  cloud_invalid_response: "پاسخ دریافتی از این آدرس متعلق به سرور ابری سازگار نیست.",
  invalid_token: "توکن فعال‌سازی آفلاین معتبر نیست.",
  token_expired: "مهلت این توکن فعال‌سازی تمام شده است. در پنل ابری توکن جدید بسازید.",
  token_revoked: "این توکن فعال‌سازی لغو شده است. در پنل ابری توکن جدید بسازید.",
  token_already_used:
    "این توکن قبلاً روی دستگاه دیگری مصرف شده است. برای این دستگاه توکن جدید صادر کنید.",
  business_disabled: "وضعیت کسب‌وکار در پنل ابری غیرفعال یا معلق است.",
  deployment_profile_not_allowed: "مجوز حالت تمام‌آفلاین برای این کسب‌وکار فعال نیست.",
  business_mismatch: "توکن واردشده به کسب‌وکار دیگری تعلق دارد.",
  token_pairing_code:
    "این مقدار «کد اتصال هیبرید» است، نه توکن فعال‌سازی آفلاین (OFL1-…). از بخش «اتصال‌ها ← برنامه دسکتاپ» توکن تمام‌آفلاین بسازید.",
  token_sync_token:
    "این مقدار «توکن همگام‌سازی سرور» (POS1-…) است، نه توکن فعال‌سازی آفلاین (OFL1-…).",
  token_bad_format: "فرمت توکن فعال‌سازی باید به شکل OFL1-XXXX-XXXX-XXXX باشد.",
  token_empty: "توکن فعال‌سازی آفلاین را وارد کنید.",
  rate_limited: "تعداد تلاش‌ها بیش از حد مجاز است. یک دقیقه صبر کنید و دوباره امتحان کنید.",
  invalid_email: "ایمیل معتبر نیست.",
  weak_password: "گذرواژه باید حداقل ۸ کاراکتر باشد.",
  email_password_mismatch:
    "این ایمیل قبلاً ثبت شده و گذرواژه با آن هم‌خوانی ندارد.",
  invalid_industry: "نوع کسب‌وکار نامعتبر است.",
  industry_not_available: "این نوع کسب‌وکار هنوز در دسترس نیست.",
};

interface VerifiedCloudInfo {
  cloudOrigin: string;
  businessName: string;
  locationName: string;
  plan: string;
}

/** Full Offline first-run setup with mandatory live Cloud activation (#974). */
function LocalBootstrapForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [cloudUrl, setCloudUrl] = useState("");
  const [cloudToken, setCloudToken] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifiedInfo, setVerifiedInfo] = useState<VerifiedCloudInfo | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [businessName, setBusinessName] = useState("");
  const [locationName, setLocationName] = useState("شعبه مرکزی");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [industry, setIndustry] = useState<Industry>("food_service");
  const [error, setError] = useState("");
  const [canRetryVerify, setCanRetryVerify] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The one-time TOTP/recovery-code handover, shown between bootstrap and the wizard. */
  const [mfa, setMfa] = useState<MfaHandover | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const continueTo = signedIn ? "/setup/business" : `/login?next=${encodeURIComponent("/setup/business")}`;

  const tokenKind = cloudToken.trim() ? classifyLocalEnrollmentCode(cloudToken) : "empty";
  const tokenHint =
    tokenKind === "pairing_code"
      ? LOCAL_BOOTSTRAP_ERRORS.token_pairing_code
      : tokenKind === "sync_token"
        ? LOCAL_BOOTSTRAP_ERRORS.token_sync_token
        : tokenKind === "bad_length" || tokenKind === "bad_charset" || tokenKind === "api_key" || tokenKind === "local_installation_token"
          ? LOCAL_BOOTSTRAP_ERRORS.token_bad_format
          : "";

  async function verifyCloudActivation() {
    if (!cloudUrl.trim() || !cloudToken.trim()) {
      setError(LOCAL_BOOTSTRAP_ERRORS.cloud_activation_required);
      setCanRetryVerify(false);
      return;
    }
    if (tokenKind !== "local_enrollment_code") {
      setError(tokenHint || LOCAL_BOOTSTRAP_ERRORS.token_bad_format);
      setCanRetryVerify(false);
      return;
    }

    setVerifying(true);
    setError("");
    setCanRetryVerify(false);
    try {
      const res = await fetch("/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verifyOnly: true,
          cloudUrl: cloudUrl.trim(),
          cloudToken: cloudToken.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        cloudOrigin?: string;
        businessName?: string;
        locationName?: string;
        industry?: string;
        plan?: string;
      };
      if (!res.ok || !data.ok) {
        setVerifiedInfo(null);
        setError(
          LOCAL_BOOTSTRAP_ERRORS[data.error ?? ""] ??
            "تأیید فعال‌سازی ابری ناموفق بود. آدرس و توکن را بررسی کنید.",
        );
        setCanRetryVerify(true);
        return;
      }

      setVerifiedInfo({
        cloudOrigin: data.cloudOrigin ?? cloudUrl.trim(),
        businessName: data.businessName ?? "",
        locationName: data.locationName ?? "شعبه مرکزی",
        plan: data.plan ?? "",
      });
      if (data.businessName) setBusinessName(data.businessName);
      if (data.locationName) setLocationName(data.locationName);
      if (data.industry && ENABLED_INDUSTRIES.includes(data.industry as Industry)) {
        setIndustry(data.industry as Industry);
      }
    } catch {
      setVerifiedInfo(null);
      setError(LOCAL_BOOTSTRAP_ERRORS.network_error);
      setCanRetryVerify(true);
    } finally {
      setVerifying(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!cloudUrl.trim() || !cloudToken.trim()) {
      setError(LOCAL_BOOTSTRAP_ERRORS.cloud_activation_required);
      return;
    }
    if (tokenKind !== "local_enrollment_code") {
      setError(tokenHint || LOCAL_BOOTSTRAP_ERRORS.token_bad_format);
      return;
    }
    setBusy(true);
    setError("");
    setCanRetryVerify(false);
    let res: Response;
    try {
      res = await fetch("/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cloudUrl: cloudUrl.trim(),
          cloudToken: cloudToken.trim(),
          businessName,
          locationName,
          ownerName,
          email,
          password,
          industry,
          deploymentMode: "local",
        }),
      });
    } catch {
      setBusy(false);
      setError(LOCAL_BOOTSTRAP_ERRORS.network_error);
      setCanRetryVerify(true);
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setBusy(false);
      if (data.error === "already_initialized") {
        router.replace("/login");
        return;
      }
      setError(
        LOCAL_BOOTSTRAP_ERRORS[data.error] ??
          "خطا در راه‌اندازی اولیه. آدرس ابری و توکن را بررسی و دوباره تلاش کنید.",
      );
      setCanRetryVerify(res.status >= 500 || data.error === "network_error" || data.error === "timeout");
      return;
    }

    const data: { mfa?: MfaHandover; signedIn?: boolean } = await res.json().catch(() => ({}));
    setBusy(false);
    const sessionOpened = data.signedIn !== false;
    setSignedIn(sessionOpened);
    if (
      data.mfa &&
      (data.mfa.totpSecret || data.mfa.recoveryCodes.length > 0)
    ) {
      setMfa(data.mfa);
      return;
    }
    router.replace(
      sessionOpened ? "/setup/business" : `/login?next=${encodeURIComponent("/setup/business")}`,
    );
  }

  if (mfa) {
    return (
      <MfaHandoverCard
        mfa={mfa}
        signedIn={signedIn}
        onDone={() => router.replace(continueTo)}
      />
    );
  }

  return (
    <div className={`mx-auto w-full max-w-lg ${cardClass} p-8`}>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex min-h-10 items-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        ← بازگشت
      </button>
      <h1 className="mb-1 text-2xl font-bold">راه‌اندازی تمام‌آفلاین (محلی)</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        ابتدا آدرس سرور ابری و توکن فعال‌سازی را وارد و تأیید کنید. پس از فعال‌سازی، عملیات فروش و حسابداری کاملاً آفلاین روی همین دستگاه انجام می‌شود و تراکنش‌ها همگام‌سازی نخواهند شد.
      </p>

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          <p>{error}</p>
          {canRetryVerify ? (
            <button
              type="button"
              disabled={verifying || busy}
              onClick={verifyCloudActivation}
              className="mt-2 inline-flex min-h-8 items-center rounded-md border border-destructive/40 px-3 text-xs font-semibold hover:bg-destructive/10"
            >
              تلاش مجدد
            </button>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-3 rounded-xl border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/50">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-amber-800 dark:text-amber-300">
              گام ۱: فعال‌سازی امن با سرور ابری
            </span>
            <button
              type="button"
              onClick={() => setShowHelp((prev) => !prev)}
              className="text-xs font-medium text-teal-700 underline-offset-4 hover:underline dark:text-teal-300"
            >
              راهنمای دریافت توکن
            </button>
          </div>

          {showHelp ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-xs leading-6 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              در پنل ابری کسب‌وکار به بخش «تنظیمات ← اتصال‌ها ← برنامه دسکتاپ» بروید، حالت «تمام‌آفلاین (محلی)» را انتخاب کنید و یک توکن یک‌بارمصرف با پیشوند <span dir="ltr" className="font-mono">OFL1-</span> بسازید. در صورت نداشتن دسترسی به پنل، از مدیر سامانه توکن دریافت کنید.
            </div>
          ) : null}

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">
              آدرس سرور ابری *
            </span>
            <input
              dir="ltr"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30"
              value={cloudUrl}
              onChange={(e) => {
                setCloudUrl(e.target.value);
                setVerifiedInfo(null);
              }}
              placeholder="https://mybusiness.example.com"
              required
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">
              توکن فعال‌سازی آفلاین *
            </span>
            <input
              dir="ltr"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30"
              value={cloudToken}
              onChange={(e) => {
                setCloudToken(e.target.value);
                setVerifiedInfo(null);
              }}
              placeholder="OFL1-XXXX-XXXX-XXXX"
              autoComplete="off"
              required
            />
          </label>

          {tokenHint ? (
            <p className="text-xs text-amber-800 dark:text-amber-300">{tokenHint}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={verifying || busy}
              onClick={verifyCloudActivation}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-stone-300 bg-background px-4 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50 dark:border-stone-700"
            >
              {verifying ? "در حال بررسی با ابر…" : "بررسی و تأیید"}
            </button>
            {verifiedInfo ? (
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                تأیید شد: «{verifiedInfo.businessName}» ({verifiedInfo.locationName})
              </span>
            ) : null}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            نام کسب‌وکار *
          </span>
          <input
            className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="مثلاً فروشگاه بهار"
            required
          />
        </label>
        <div className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            نوع کسب‌وکار *
          </span>
          <div className="grid grid-cols-2 gap-2">
            {INDUSTRIES.map((option) => {
              const enabled = ENABLED_INDUSTRIES.includes(option);
              const selected = industry === option;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={!enabled}
                  onClick={() => enabled && setIndustry(option)}
                  className={`relative rounded-lg border px-3 py-2 text-sm transition-colors outline-none focus-visible:ring focus-visible:ring-ring/50 ${
                    selected
                      ? "border-amber-300 dark:border-amber-500/40 bg-amber-100 dark:bg-amber-500 dark:bg-amber-400/20 font-medium text-amber-950 dark:text-amber-200"
                      : "border-input text-foreground"
                  } ${enabled ? "hover:border-amber-400 dark:hover:border-amber-500/50" : "cursor-not-allowed opacity-50"}`}
                >
                  {INDUSTRY_LABELS[option]}
                  {!enabled ? (
                    <span className="absolute -top-2 -right-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      به‌زودی
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            نام شعبهٔ اول *
          </span>
          <input
            className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30"
            value={locationName}
            onChange={(e) => setLocationName(e.target.value)}
            required
          />
        </label>
        <hr className="border-border" />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            نام مالک *
          </span>
          <input
            className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            ایمیل مالک *
          </span>
          <input
            className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30"
            dir="ltr"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            گذرواژه *
          </span>
          <input
            className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30"
            dir="ltr"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="حداقل ۸ کاراکتر"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-transparent bg-primary px-5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/80 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50"
        >
          {busy ? "در حال ساخت…" : "ساخت و شروع راه‌اندازی"}
        </button>
      </form>
    </div>
  );
}

/** What `/api/setup/bootstrap` hands back once, and never again. */
interface MfaHandover {
  method: "totp" | "sms_otp";
  totpSecret: string | null;
  totpUrl: string | null;
  totpQr: string | null;
  recoveryCodes: string[];
}

/**
 * Phase 24 Wave 2 — the first-run second-factor handover.
 *
 * `provisionBusiness` has enrolled the Owner in TOTP (a local install has no
 * internet, so an SMS second factor would lock them out of their own till the
 * first time the connection dropped) and minted ten recovery codes. Both exist
 * in plaintext for exactly the length of this screen: the secret is stored
 * encrypted and the codes only as bcrypt hashes, so a reload here really does
 * lose them.
 *
 * Hence the deliberate friction — an explicit checkbox rather than a "next"
 * button. The alternative, which is what shipped before this screen existed, is
 * an Owner who discovers at their second login that they are enrolled in a
 * factor nobody ever showed them.
 */
function MfaHandoverCard({
  mfa,
  signedIn = true,
  onDone,
}: {
  mfa: MfaHandover;
  /** False when bootstrap created the business but could not sign the Owner in. */
  signedIn?: boolean;
  onDone: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className={`w-full max-w-md ${cardClass} p-8`}>
      <h1 className="mb-1 text-2xl font-bold">ورود دومرحله‌ای مالک</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        روی نصب محلی، ورود مالک با «برنامهٔ رمزساز» محافظت می‌شود؛ چون بدون
        اینترنت پیامکی ارسال نمی‌شود. این صفحه فقط همین یک بار نمایش داده
        می‌شود.
      </p>

      {mfa.totpQr ? (
        <div className="mb-4 flex justify-center">
          { }
          <img
            src={mfa.totpQr}
            alt="کد QR ورود دومرحله‌ای"
            className="size-52 rounded-lg bg-white p-2 ring-1 ring-border/80"
          />
        </div>
      ) : null}

      {mfa.totpSecret ? (
        <div className="mb-4">
          <p className="mb-1 text-sm text-muted-foreground">
            کد QR را با Google Authenticator (یا هر برنامهٔ مشابه) اسکن کنید، یا
            این کد را دستی وارد کنید:
          </p>
          <p
            dir="ltr"
            className="rounded-lg border border-input bg-muted/50 px-3 py-2 font-mono text-sm tracking-wider"
          >
            {mfa.totpSecret}
          </p>
        </div>
      ) : null}

      {mfa.recoveryCodes.length > 0 ? (
        <div className="mb-4">
          <p className="mb-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            این ۱۰ کد بازیابی را چاپ کنید یا جای امنی بنویسید. اگر گوشی‌تان را
            از دست بدهید، تنها راه ورود همین‌هاست.
          </p>
          <div
            dir="ltr"
            className="grid grid-cols-2 gap-1 rounded-lg border border-input bg-muted/50 px-3 py-2 font-mono text-sm tracking-wider"
          >
            {mfa.recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 w-full rounded-lg border border-input py-2 text-sm font-semibold transition hover:bg-primary/10"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  mfa.recoveryCodes.join("\n"),
                );
                setCopied(true);
              } catch {
                // Clipboard access can be refused; the codes are on screen anyway.
                setCopied(false);
              }
            }}
          >
            {copied ? "کپی شد" : "کپی کدها"}
          </button>
        </div>
      ) : null}

      {!signedIn ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-foreground"
        >
          کسب‌وکار و حساب مالک ساخته شد، اما ورود خودکار انجام نشد. پس از ذخیرهٔ این کدها،
          با ایمیل و گذرواژهٔ مالک وارد شوید تا راه‌اندازی ادامه پیدا کند.
        </p>
      ) : null}

      <label className="mb-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 size-4"
        />
        <span>
          کد QR را اسکن کردم و کدهای بازیابی را در جای امنی ذخیره کردم.
        </span>
      </label>

      <button
        type="button"
        disabled={!confirmed}
        onClick={onDone}
        className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-transparent bg-primary px-5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/80 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50"
      >
        {signedIn ? "ادامه به راه‌اندازی" : "رفتن به صفحهٔ ورود"}
      </button>
    </div>
  );
}
