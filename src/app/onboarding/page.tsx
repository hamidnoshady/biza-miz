"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2Icon, CheckIcon, ImagePlusIcon, Trash2Icon } from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { toPersianDigits } from "@/lib/digits";

/**
 * ESH-202 / #1387 — short, resumable business onboarding.
 *
 * Four steps, all optional except the industry and the business name: industry
 * (the canonical enabled registry, never a second list), business basics, a logo
 * that may be skipped, and an optional profile. Progress is saved server-side on
 * every Continue, so a refresh, another device or an interrupted connection
 * resumes at the same step. The business is created only by the final submit,
 * which then hands off to the existing `/setup` wizard (#1239).
 *
 * Nothing here sells an app, opens a wallet or asks for a password.
 */
interface OnboardingLogo {
  dataUrl: string;
  mimeType: string;
  byteLength: number;
}

interface OnboardingState {
  industry: string | null;
  businessName: string | null;
  locationName: string | null;
  address: string | null;
  phoneE164: string | null;
  logo: OnboardingLogo | null;
  step: "industry" | "business" | "logo" | "profile";
  status: "in_progress" | "provisioned";
  provisionedBusinessId: string | null;
}

interface IndustryOption {
  key: string;
  label: string;
}

const STEPS = ["industry", "business", "logo", "profile"] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLES: Record<Step, string> = {
  industry: "صنف کسب‌وکار",
  business: "اطلاعات کسب‌وکار",
  logo: "نشان تجاری",
  profile: "اطلاعات تکمیلی",
};

const ERRORS: Record<string, string> = {
  invalid_industry: "صنف انتخاب‌شده در دسترس نیست.",
  invalid_name: "نام کسب‌وکار را وارد کنید.",
  invalid_phone: "شمارهٔ تماس معتبر نیست.",
  invalid_logo: "فایل نشان باید PNG، JPEG، WebP یا SVG و کمتر از ۲۵۶ کیلوبایت باشد.",
  invalid_email: "ایمیل معتبر نیست.",
  email_taken: "این ایمیل قبلاً برای حساب دیگری ثبت شده است.",
  invalid_national_id: "کد ملی معتبر نیست.",
  national_id_taken: "این کد ملی قبلاً ثبت شده است.",
  onboarding_incomplete: "برای ساخت کسب‌وکار، صنف و نام کسب‌وکار لازم است.",
  field_too_long: "یکی از فیلدها بیش از حد بلند است.",
  identity_missing: "حساب شما در دسترس نیست. دوباره وارد شوید.",
  unauthorized: "نشست شما منقضی شده است. دوباره وارد شوید.",
};

function messageFor(error: string | undefined): string {
  return ERRORS[error ?? ""] ?? "انجام نشد. لطفاً دوباره تلاش کنید.";
}

function OnboardingSkeleton() {
  return (
    <div className={`w-full max-w-xl ${cardClass} p-6 sm:p-8`}>
      <FormLoadingSkeleton rows={5} label="در حال بارگذاری اطلاعات کسب‌وکار" />
    </div>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [industries, setIndustries] = useState<IndustryOption[]>([]);
  const [step, setStep] = useState<Step>("industry");
  const [state, setState] = useState<OnboardingState | null>(null);

  const [industry, setIndustry] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [locationName, setLocationName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [logo, setLogo] = useState<OnboardingLogo | null>(null);
  const [email, setEmail] = useState("");
  const [nationalId, setNationalId] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/onboarding", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login");
          return null;
        }
        return (await res.json()) as {
          ok?: boolean;
          state?: OnboardingState | null;
          industries?: IndustryOption[];
        };
      })
      .then((data) => {
        if (cancelled || !data?.ok) return;
        if (data.state?.status === "provisioned") {
          router.replace("/setup");
          return;
        }
        setIndustries(data.industries ?? []);
        const current = data.state ?? null;
        setState(current);
        if (current) {
          setIndustry(current.industry);
          setBusinessName(current.businessName ?? "");
          setLocationName(current.locationName ?? "");
          setAddress(current.address ?? "");
          setPhone(current.phoneE164 ?? "");
          setLogo(current.logo);
          setStep(current.step);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError(messageFor(undefined));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function save(patch: Record<string, unknown>, next: Step | "submit") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next === "submit" ? patch : { ...patch, step: next }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; state?: OnboardingState };
      if (!res.ok || !data.ok) {
        setError(messageFor(data.error));
        return;
      }
      if (next !== "submit") {
        setStep(next);
        setState(data.state ?? state);
        return;
      }

      const submit = await fetch("/api/onboarding/submit", { method: "POST" });
      const result = (await submit.json()) as { ok?: boolean; next?: string; error?: string };
      if (!submit.ok || !result.ok) {
        setError(messageFor(result.error));
        return;
      }
      router.push(result.next ?? "/setup");
    } catch {
      setError(messageFor(undefined));
    } finally {
      setBusy(false);
    }
  }

  async function readLogo(file: File) {
    setError(null);
    if (file.size > 262_144) {
      setError(ERRORS.invalid_logo);
      return;
    }
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!dataUrl) {
      setError(ERRORS.invalid_logo);
      return;
    }
    setLogo({
      dataUrl,
      mimeType: file.type,
      byteLength: file.size,
    });
  }

  const stepIndex = STEPS.indexOf(step);
  const canContinueBusiness = businessName.trim().length > 0 && industry !== null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 sm:px-6">
      {loading ? (
        <OnboardingSkeleton />
      ) : (
        <div className={`w-full max-w-xl ${cardClass} p-6 sm:p-8`}>
          <div className="mb-6 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              گام {toPersianDigits(stepIndex + 1)} از {toPersianDigits(STEPS.length)}
            </p>
            <h1 className="text-xl font-bold text-foreground">{STEP_TITLES[step]}</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              فقط اطلاعات لازم برای ساخت کسب‌وکار را وارد کنید. هر گام ذخیره می‌شود و می‌توانید
              بعداً از همین‌جا ادامه دهید.
            </p>
          </div>

          {error ? (
            <div className="mb-4">
              <ErrorBox>{error}</ErrorBox>
            </div>
          ) : null}

          {step === "industry" ? (
            <div className="space-y-4">
              <div role="radiogroup" aria-label="صنف کسب‌وکار" className="grid gap-2 sm:grid-cols-2">
                {industries.map((option) => {
                  const selected = industry === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setIndustry(option.key)}
                      className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-start text-sm outline-none transition-colors focus-visible:ring focus-visible:ring-ring/50 ${
                        selected
                          ? "border-primary bg-primary/5 font-medium text-foreground"
                          : "border-border text-foreground hover:bg-muted"
                      }`}
                    >
                      <span>{option.label}</span>
                      {selected ? <CheckIcon className="size-4 text-primary" aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
              <Button
                type="button"
                className="w-full"
                disabled={busy || !industry}
                onClick={() => industry && save({ industry }, "business")}
              >
                {busy ? "در حال ذخیره…" : "ادامه"}
              </Button>
            </div>
          ) : null}

          {step === "business" ? (
            <form
              className="space-y-1"
              onSubmit={(event) => {
                event.preventDefault();
                save(
                  {
                    industry,
                    businessName,
                    locationName,
                    address,
                    phone,
                  },
                  "logo",
                );
              }}
            >
              <Field label="نام کسب‌وکار" hint="همان نامی که مشتری می‌شناسد.">
                <input
                  className={inputClass}
                  value={businessName}
                  onChange={(event) => setBusinessName(event.target.value)}
                  autoComplete="organization"
                  required
                />
              </Field>
              <Field label="نام شعبه (اختیاری)">
                <input
                  className={inputClass}
                  value={locationName}
                  onChange={(event) => setLocationName(event.target.value)}
                />
              </Field>
              <Field label="نشانی (اختیاری)">
                <input
                  className={inputClass}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  autoComplete="street-address"
                />
              </Field>
              <Field label="شمارهٔ تماس کسب‌وکار (اختیاری)">
                <input
                  className={inputClass}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  inputMode="tel"
                  dir="ltr"
                  autoComplete="tel"
                />
              </Field>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setStep("industry")}>
                  بازگشت
                </Button>
                <Button type="submit" className="flex-1" disabled={busy || !canContinueBusiness}>
                  {busy ? "در حال ذخیره…" : "ادامه"}
                </Button>
              </div>
            </form>
          ) : null}

          {step === "logo" ? (
            <div className="space-y-4">
              <div className="flex items-center gap-4 rounded-xl border border-border p-4">
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {logo ? (
                    <img src={logo.dataUrl} alt="پیش‌نمایش نشان تجاری" className="size-full object-contain" />
                  ) : (
                    <Building2Icon className="size-6 text-muted-foreground" aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium text-foreground">نشان تجاری</p>
                  <p className="text-xs text-muted-foreground">
                    PNG، JPEG، WebP یا SVG، حداکثر ۲۵۶ کیلوبایت. می‌توانید این گام را رد کنید.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">
                  <ImagePlusIcon className="size-4" aria-hidden="true" />
                  {logo ? "جایگزینی فایل" : "انتخاب فایل"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void readLogo(file);
                    }}
                  />
                </label>
                {logo ? (
                  <button
                    type="button"
                    onClick={() => setLogo(null)}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                  >
                    <Trash2Icon className="size-4" aria-hidden="true" />
                    حذف
                  </button>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setStep("business")}>
                  بازگشت
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => save({ logoDataUrl: logo?.dataUrl ?? null }, "profile")}
                >
                  {busy ? "در حال ذخیره…" : logo ? "ادامه با این نشان" : "رد کردن نشان"}
                </Button>
              </div>
            </div>
          ) : null}

          {step === "profile" ? (
            <form
              className="space-y-1"
              onSubmit={(event) => {
                event.preventDefault();
                save({ email, nationalId }, "submit");
              }}
            >
              <Field
                label="ایمیل (اختیاری)"
                hint="برای اعلان‌های حساس فقط بعد از تأیید ایمیل استفاده می‌شود."
              >
                <input
                  className={inputClass}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  dir="ltr"
                  autoComplete="email"
                />
              </Field>
              <Field label="کد ملی (اختیاری)" hint="رمزنگاری‌شده ذخیره می‌شود و در فهرست‌ها نمایش داده نمی‌شود.">
                <input
                  className={inputClass}
                  value={nationalId}
                  onChange={(event) => setNationalId(event.target.value)}
                  inputMode="numeric"
                  dir="ltr"
                />
              </Field>

              <div className="rounded-xl border border-border p-4 text-sm">
                <p className="mb-2 font-medium text-foreground">خلاصه</p>
                <dl className="space-y-1 text-muted-foreground">
                  <div className="flex justify-between gap-3">
                    <dt>صنف</dt>
                    <dd className="text-foreground">
                      {industries.find((option) => option.key === industry)?.label ?? "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>نام کسب‌وکار</dt>
                    <dd className="text-foreground">{businessName || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>نشان تجاری</dt>
                    <dd className="text-foreground">{logo ? "انتخاب شده" : "رد شده"}</dd>
                  </div>
                </dl>
              </div>

              <div className="flex gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setStep("logo")}>
                  بازگشت
                </Button>
                <Button type="submit" className="flex-1" disabled={busy || !canContinueBusiness}>
                  {busy ? "در حال ساخت کسب‌وکار…" : "ساخت کسب‌وکار و ادامه"}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      )}
    </main>
  );
}
