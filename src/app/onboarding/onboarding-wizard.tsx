"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { Button } from "@/components/ui/button";
import { BRAND_NAME_FA } from "@/lib/brand";
import { toPersianDigits } from "@/lib/digits";
import type { Industry } from "@/lib/industries";
import {
  LOGO_MAX_BYTES,
  LOGO_MIME_TYPES,
  isLogoMimeType,
} from "@/lib/business-logo-rules";
import type { BusinessLogo } from "@/lib/business-logo";
import type { OnboardingDraft, OnboardingState } from "@/lib/onboarding";

type StepId = "industry" | "basics" | "logo" | "profile" | "review";

const STEP_TITLES: Record<StepId, string> = {
  industry: "نوع کسب‌وکار",
  basics: "اطلاعات کسب‌وکار",
  logo: "لوگوی کسب‌وکار",
  profile: "پروفایل شخصی",
  review: "بازبینی و ثبت",
};

const STEP_ORDER: StepId[] = ["industry", "basics", "logo", "profile", "review"];

/**
 * Industry-aware examples are copy, never a second industry registry: the keys
 * are typed by `Industry`, so a missing trade is a type error and a new trade
 * must add one line here.
 */
const BUSINESS_NAME_EXAMPLES: Record<Industry, string> = {
  food_service: "مثلاً کافه رستوران بهار",
  jewelry: "مثلاً گالری طلای پارسیان",
  watch: "مثلاً ساعت‌فروشی زمان",
  accessories: "مثلاً فروشگاه بدلیجات نگین",
  cosmetics: "مثلاً فروشگاه آرایشی بهداشتی گل",
  wholesale: "مثلاً پخش عمدهٔ کالای ایرانی",
  tools_fittings: "مثلاً ابزار و یراق‌آلات صنعت",
  haberdashery: "مثلاً خرازی رنگین‌کمان",
  service_saas: "مثلاً خدمات نرم‌افزاری ابری",
  architecture_construction: "مثلاً دفتر مهندسی و پیمانکاری سازه",
  automotive: "مثلاً نمایشگاه خودرو امید",
  advertising_agency: "مثلاً آژانس تبلیغاتی ایده",
};

const ERRORS: Record<string, string> = {
  bad_request: "درخواست کامل نیست. دوباره تلاش کنید.",
  continuation_invalid: "مهلت ادامهٔ راه‌اندازی تمام شده است. دوباره وارد شوید.",
  memberships_exist: "این شماره از قبل به یک کسب‌وکار متصل است. برای ورود به صفحهٔ ورود می‌روید.",
  industry_required: "ابتدا نوع کسب‌وکار را انتخاب کنید.",
  invalid_industry: "نوع کسب‌وکار انتخاب‌شده معتبر نیست.",
  invalid_business_name: "نام کسب‌وکار الزامی است.",
  invalid_location_name: "نام شعبه معتبر نیست.",
  field_too_long: "طول یکی از فیلدها بیش از حد مجاز است.",
  invalid_email: "ایمیل واردشده معتبر نیست.",
  email_taken: "این ایمیل قبلاً برای حساب دیگری ثبت شده است.",
  invalid_national_id: "کد ملی واردشده معتبر نیست.",
  national_id_taken: "این کد ملی قبلاً برای حساب دیگری ثبت شده است.",
  encryption_unavailable: "ذخیرهٔ امن کد ملی در این نصب ممکن نیست؛ می‌توانید این مرحله را رد کنید.",
  invalid_logo: "فایل لوگو معتبر نیست. PNG، JPEG، WebP یا SVG با حجم حداکثر ۲۵۶ کیلوبایت انتخاب کنید.",
  missing_file: "فایلی انتخاب نشده است.",
  not_started: "اطلاعات این مرحله کامل نیست. از ابتدا دوباره تلاش کنید.",
  missing_business_name: "نام کسب‌وکار الزامی است.",
  identity_missing: "حساب شما در دسترس نیست. دوباره وارد شوید.",
  submit_failed: "ثبت کسب‌وکار انجام نشد. اطلاعات شما حفظ شده است؛ دوباره تلاش کنید.",
};

function messageFor(error: string | undefined): string {
  return ERRORS[error ?? ""] ?? "انجام نشد. لطفاً دوباره تلاش کنید.";
}

function firstStep(draft: OnboardingDraft): number {
  const done = new Set(draft.completedSteps);
  for (let index = 0; index < STEP_ORDER.length - 1; index++) {
    if (!done.has(STEP_ORDER[index] as Exclude<StepId, "review">)) return index;
  }
  return STEP_ORDER.length - 1;
}

function digits(value: string): string {
  return toPersianDigits(value);
}

/**
 * The entry realm reserves its shape while the server state is unavailable;
 * the page normally supplies it, so this is the fallback rather than a flash.
 */
export function OnboardingWizard({ initialState }: { initialState?: OnboardingState }) {
  if (!initialState) return <FormLoadingSkeleton />;
  return <OnboardingWizardLoaded initialState={initialState} />;
}

function OnboardingWizardLoaded({ initialState }: { initialState: OnboardingState }) {
  const router = useRouter();
  const [draft, setDraft] = useState<OnboardingDraft>(initialState.draft);
  const [stepIndex, setStepIndex] = useState(() => firstStep(initialState.draft));
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  const [industry, setIndustry] = useState<Industry | "">(initialState.draft.industry ?? "");
  const [businessName, setBusinessName] = useState(initialState.draft.businessName);
  const [locationName, setLocationName] = useState(initialState.draft.locationName);
  const [address, setAddress] = useState(initialState.draft.address);
  const [phone, setPhone] = useState(initialState.draft.phone);
  const [logo, setLogo] = useState<BusinessLogo | null>(initialState.draft.logo);
  const [email, setEmail] = useState(initialState.identity.email ?? "");
  const [nationalId, setNationalId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [emailNotice, setEmailNotice] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);

  const step = STEP_ORDER[stepIndex];
  const stepTitle = STEP_TITLES[step];

  useEffect(() => {
    if (initialState.provisioned || draft.provisionedBusinessId) {
      router.replace("/setup/business");
    }
  }, [draft.provisionedBusinessId, initialState.provisioned, router]);

  const completion = useMemo(() => {
    const done = new Set(draft.completedSteps);
    return STEP_ORDER.slice(0, -1).filter((id) => done.has(id as Exclude<StepId, "review">)).length;
  }, [draft.completedSteps]);

  const emailChanged =
    email.trim().toLowerCase() !== (initialState.identity.email ?? "").toLowerCase();
  const emailVerified = initialState.identity.emailVerified && !emailChanged;

  async function callJson<T>(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
    const response = await fetch(url, init);
    const data = (await response.json().catch(() => ({}))) as T;
    return { ok: response.ok, status: response.status, data };
  }

  function goLogin() {
    router.replace("/login");
  }

  async function saveStep(payload: Record<string, unknown>): Promise<boolean> {
    setSaveState("saving");
    setError("");
    try {
      const { ok, status, data } = await callJson<{
        ok?: boolean;
        draft?: OnboardingDraft;
        emailVerification?: "sent" | "unavailable" | "failed";
        error?: string;
        next?: string;
      }>("/api/onboarding/step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (status === 401) {
        goLogin();
        return false;
      }
      if (!ok || !data.ok || !data.draft) {
        setError(messageFor(data.error));
        setSaveState("error");
        return false;
      }
      setDraft(data.draft);
      if (data.emailVerification === "sent") {
        setEmailNotice("پیوند تأیید به ایمیل شما ارسال شد.");
      } else if (data.emailVerification === "unavailable") {
        setEmailNotice(
          "ایمیل ثبت شد؛ اما ارسال ایمیل تأیید در این نصب پیکربندی نشده است. برای استفادهٔ حساس، تأیید لازم است.",
        );
      } else if (data.emailVerification === "failed") {
        setEmailNotice(
          "ایمیل ثبت شد؛ اما ارسال پیام تأیید ناموفق بود. می‌توانید دوباره ذخیره کنید یا بعداً از بخش امنیت حساب تلاش کنید.",
        );
      }
      setSaveState("saved");
      return true;
    } catch {
      setError(messageFor(undefined));
      setSaveState("error");
      return false;
    }
  }

  async function continueStep() {
    setError("");
    if (step === "industry") {
      if (!industry) {
        setError("نوع کسب‌وکار را انتخاب کنید.");
        return;
      }
      if (await saveStep({ step: "industry", industry })) setStepIndex(1);
      return;
    }
    if (step === "basics") {
      if (!businessName.trim()) {
        setError("نام کسب‌وکار را وارد کنید.");
        return;
      }
      if (
        await saveStep({
          step: "basics",
          businessName,
          locationName,
          address,
          phone,
        })
      ) {
        setStepIndex(2);
      }
      return;
    }
    if (step === "logo") {
      if (await saveStep({ step: "logo" })) setStepIndex(3);
      return;
    }
    if (step === "profile") {
      if (
        await saveStep({
          step: "profile",
          // An emptied field on an address that was present is an explicit
          // removal; a field that was never filled stays "not provided".
          ...(email.trim()
            ? { email: email.trim() }
            : initialState.identity.email
              ? { email: null }
              : {}),
          ...(nationalId.trim() ? { nationalId: nationalId.trim() } : {}),
        })
      ) {
        setStepIndex(4);
      }
      return;
    }
    await submit();
  }

  async function uploadLogo(file: File) {
    setError("");
    if (!isLogoMimeType(file.type)) {
      setError("فقط تصویر PNG، JPEG، WebP یا SVG قابل استفاده است.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError("حجم لوگو باید کمتر از ۲۵۶ کیلوبایت باشد.");
      return;
    }

    setBusy(true);
    setSaveState("saving");
    try {
      const form = new FormData();
      form.append("file", file);
      const { ok, status, data } = await callJson<{
        ok?: boolean;
        logo?: BusinessLogo;
        draft?: OnboardingDraft;
        error?: string;
      }>("/api/onboarding/logo", { method: "POST", body: form });
      if (status === 401) {
        goLogin();
        return;
      }
      if (!ok || !data.ok || !data.logo) {
        setError(messageFor(data.error));
        setSaveState("error");
        return;
      }
      if (data.draft) setDraft(data.draft);
      if (data.logo) setLogo(data.logo);
      setSaveState("saved");
    } catch {
      setError(messageFor(undefined));
      setSaveState("error");
    } finally {
      setBusy(false);
    }
  }

  async function removeLogo() {
    setBusy(true);
    setError("");
    setSaveState("saving");
    try {
      const { ok, status, data } = await callJson<{
        ok?: boolean;
        draft?: OnboardingDraft;
        error?: string;
      }>("/api/onboarding/logo", { method: "DELETE" });
      if (status === 401) {
        goLogin();
        return;
      }
      if (!ok || !data.ok) {
        setError(messageFor(data.error));
        setSaveState("error");
        return;
      }
      setLogo(null);
      if (data.draft) setDraft(data.draft);
      if (fileInput.current) fileInput.current.value = "";
      setSaveState("saved");
    } catch {
      setError(messageFor(undefined));
      setSaveState("error");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!confirmed) {
      setError("برای ثبت، خلاصهٔ اطلاعات را تأیید کنید.");
      return;
    }
    setBusy(true);
    setError("");
    setSaveState("saving");
    try {
      const { ok, status, data } = await callJson<{
        ok?: boolean;
        signedIn?: boolean;
        next?: string;
        error?: string;
      }>("/api/onboarding/submit", { method: "POST" });
      if (status === 401) {
        goLogin();
        return;
      }
      if (!ok || !data.ok) {
        if (data.error === "memberships_exist") {
          goLogin();
          return;
        }
        setError(messageFor(data.error ?? "submit_failed"));
        setSaveState("error");
        return;
      }
      router.replace(data.next ?? "/setup/business");
    } catch {
      setError(messageFor("submit_failed"));
      setSaveState("error");
    } finally {
      setBusy(false);
    }
  }

  function skipLogo() {
    void (async () => {
      if (await saveStep({ step: "logo" })) setStepIndex(3);
    })();
  }

  return (
    <main className="min-h-screen bg-background px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-primary">{BRAND_NAME_FA}</p>
            <h1 className="mt-1 text-xl font-bold text-foreground sm:text-2xl">
              راه‌اندازی کوتاه کسب‌وکار
            </h1>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {initialState.identity.fullName}
              {initialState.identity.maskedPhone
                ? ` — ${toPersianDigits(initialState.identity.maskedPhone)}`
                : ""}
            </p>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            مرحلهٔ {digits(String(stepIndex + 1))} از {digits(String(STEP_ORDER.length))}
          </span>
        </header>

        <div
          className="mb-4 h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={STEP_ORDER.length}
          aria-valuenow={stepIndex + 1}
          aria-label="پیشرفت راه‌اندازی"
        >
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${((stepIndex + 1) / STEP_ORDER.length) * 100}%` }}
          />
        </div>

        <div className={`${cardClass} p-5 sm:p-7`}>
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-foreground">{stepTitle}</h2>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {saveState === "saving"
                ? "در حال ذخیره…"
                : saveState === "saved"
                  ? "ذخیره شد"
                  : saveState === "error"
                    ? "ذخیره نشد"
                    : completion > 0
                      ? `${digits(String(completion))} مرحله ذخیره شده`
                      : ""}
            </p>
          </div>

          <ErrorBox>{error}</ErrorBox>

          {step === "industry" ? (
            <fieldset>
              <legend className="mb-1 block text-sm font-medium text-foreground">
                نوع کسب‌وکار <span aria-hidden="true">*</span>
              </legend>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                این انتخاب پس از ثبت کسب‌وکار تغییر نمی‌کند و مراحل بعدی راه‌اندازی بر اساس آن تنظیم می‌شود.
              </p>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="نوع کسب‌وکار">
                {initialState.industries.map((item) => {
                  const selected = industry === item.key;
                  return (
                    <label
                      key={item.key}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-colors ${
                        selected
                          ? "border-amber-400 bg-amber-50 text-foreground dark:bg-amber-500/10"
                          : "border-border bg-card hover:bg-muted/60"
                      }`}
                    >
                      <input
                        type="radio"
                        name="industry"
                        value={item.key}
                        checked={selected}
                        onChange={() => setIndustry(item.key)}
                        className="size-4 accent-amber-600"
                      />
                      <span>{item.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          {step === "basics" ? (
            <div>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                فقط اطلاعات ضروری کسب‌وکار را وارد کنید. نام و شمارهٔ موبایل شما قبلاً ثبت شده و دوباره پرسیده نمی‌شود.
              </p>
              <Field label="نام کسب‌وکار *">
                <input
                  className={inputClass}
                  value={businessName}
                  onChange={(event) => setBusinessName(event.target.value)}
                  placeholder={industry ? BUSINESS_NAME_EXAMPLES[industry] : "مثلاً فروشگاه بهار"}
                  autoComplete="organization"
                  required
                />
              </Field>
              <Field
                label="نام شعبهٔ اول"
                hint="اختیاری؛ اگر خالی بماند «شعبه مرکزی» ثبت می‌شود."
              >
                <input
                  className={inputClass}
                  value={locationName}
                  onChange={(event) => setLocationName(event.target.value)}
                  placeholder="شعبه مرکزی"
                  autoComplete="off"
                />
              </Field>
              <Field label="نشانی کسب‌وکار" hint="اختیاری؛ روی اسناد و مسیریابی شعبه استفاده می‌شود.">
                <input
                  className={inputClass}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  autoComplete="street-address"
                />
              </Field>
              <Field label="تلفن کسب‌وکار" hint="اختیاری؛ شمارهٔ شخصی شما دوباره پرسیده نمی‌شود.">
                <input
                  className={inputClass}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  dir="ltr"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </Field>
            </div>
          ) : null}

          {step === "logo" ? (
            <div>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                لوگو روی فاکتور و اسناد چاپ می‌شود. اگر آماده نیست، می‌توانید این مرحله را رد کنید و بعداً از تنظیمات اضافه کنید.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {logo ? (
                  <img
                    src={logo.dataUrl}
                    alt="پیش‌نمایش لوگوی کسب‌وکار"
                    className="h-20 w-auto max-w-48 rounded-xl border border-border bg-card p-1"
                  />
                ) : (
                  <div className="flex h-20 w-36 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
                    بدون لوگو
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <input
                    ref={fileInput}
                    id="onboarding-logo"
                    type="file"
                    accept={LOGO_MIME_TYPES.join(",")}
                    aria-label="انتخاب فایل لوگوی کسب‌وکار"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadLogo(file);
                    }}
                    className="text-sm text-muted-foreground file:me-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:text-foreground"
                  />
                  <span className="text-xs text-muted-foreground">
                    PNG، JPEG، WebP یا SVG — حداکثر {digits(String(Math.floor(LOGO_MAX_BYTES / 1024)))} کیلوبایت.
                  </span>
                </div>
              </div>
              {logo ? (
                <div className="mt-4">
                  <Button type="button" variant="outline" onClick={() => void removeLogo()} disabled={busy}>
                    حذف لوگو
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === "profile" ? (
            <div>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                هر دو مورد اختیاری است و رد کردن آن‌ها مانع ادامه نمی‌شود. رمز عبور را می‌توانید بعداً از بخش امنیت حساب تنظیم کنید.
              </p>
              <Field
                label="ایمیل"
                hint={
                  emailVerified
                    ? "ایمیل فعلی تأیید شده است."
                    : "برای اطلاع‌رسانی حساس و بازیابی حساب، تأیید ایمیل لازم است."
                }
              >
                <input
                  className={inputClass}
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setEmailNotice("");
                  }}
                  dir="ltr"
                  autoComplete="email"
                  placeholder="name@example.com"
                />
              </Field>
              {emailNotice ? (
                <p className="mb-4 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground" role="status">
                  {emailNotice}
                </p>
              ) : null}
              <Field
                label="کد ملی"
                hint={
                  initialState.identity.hasNationalId
                    ? "کد ملی قبلاً به‌صورت رمزنگاری‌شده ثبت شده است. برای جایگزینی، مقدار تازه را وارد کنید."
                    : "به‌صورت رمزنگاری‌شده ذخیره می‌شود و در فهرست‌های معمولی نمایش داده نمی‌شود."
                }
              >
                <input
                  className={inputClass}
                  value={nationalId}
                  onChange={(event) => setNationalId(event.target.value)}
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={12}
                  placeholder="۱۰ رقم"
                />
              </Field>
            </div>
          ) : null}

          {step === "review" ? (
            <div>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                این اطلاعات همین حالا ثبت می‌شود و سپس وارد راه‌اندازی کامل کسب‌وکار می‌شوید. هیچ برنامه‌ای فعال نمی‌شود و هیچ مبلغی کسر یا از کیف پول درخواست نمی‌شود.
              </p>
              <dl className="divide-y divide-border rounded-xl border border-border">
                <SummaryRow label="نوع کسب‌وکار" value={industry ? industryLabel(initialState, industry) : "—"} />
                <SummaryRow label="نام کسب‌وکار" value={businessName || "—"} />
                <SummaryRow label="شعبهٔ اول" value={locationName || "شعبه مرکزی"} />
                <SummaryRow label="نشانی" value={address || "—"} />
                <SummaryRow label="تلفن کسب‌وکار" value={phone || "—"} />
                <SummaryRow label="ایمیل" value={email ? `${email}${emailVerified ? " (تأییدشده)" : " (تأییدنشده)"}` : "ثبت نشده"} />
                <SummaryRow
                  label="کد ملی"
                  value={nationalId.trim() || initialState.identity.hasNationalId ? "ثبت می‌شود (رمزنگاری‌شده)" : "ثبت نشده"}
                />
                <SummaryRow label="لوگو" value={logo ? "انتخاب شده" : "بدون لوگو"} />
              </dl>
              {logo ? (
                <div className="mt-3">
                  <img
                    src={logo.dataUrl}
                    alt="پیش‌نمایش لوگوی کسب‌وکار"
                    className="h-16 w-auto max-w-40 rounded-lg border border-border bg-card p-1"
                  />
                </div>
              ) : null}
              <label className="mt-5 flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-0.5 size-4 accent-emerald-600"
                />
                <span>
                  اطلاعات بالا را بررسی کردم و تأیید می‌کنم که کسب‌وکار با همین مشخصات ساخته شود.
                </span>
              </label>
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
              disabled={stepIndex === 0 || busy || saveState === "saving"}
            >
              بازگشت
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {step === "logo" && !logo ? (
                <Button type="button" variant="outline" onClick={skipLogo} disabled={busy || saveState === "saving"}>
                  رد کردن لوگو
                </Button>
              ) : null}
              <Button
                type="button"
                onClick={() => void continueStep()}
                disabled={busy || saveState === "saving" || (step === "review" && !confirmed)}
              >
                {step === "review" ? "ثبت کسب‌وکار و ادامه" : "ذخیره و ادامه"}
              </Button>
            </div>
          </div>
        </div>

        <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
          نام و شمارهٔ موبایل شما در ثبت‌نام گرفته شده و دوباره پرسیده نمی‌شود. انتخاب برنامه‌ها، قیمت‌ها و کیف پول فقط در مرحلهٔ بعد از راه‌اندازی کامل نمایش داده می‌شود.
        </p>
      </div>
    </main>
  );
}

function industryLabel(state: OnboardingState, industry: Industry): string {
  return state.industries.find((item) => item.key === industry)?.label ?? industry;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 p-3 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-end font-medium text-foreground">{value}</dd>
    </div>
  );
}
