"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BusinessLogo } from "@/lib/business-logo";
import {
  LOGO_MAX_BYTES,
  LOGO_MIME_TYPES,
  isLogoMimeType,
} from "@/lib/business-logo-rules";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton, SetupDataSkeleton, StepShell } from "../ui";
import { nextPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";

interface StateResponse {
  business?: { name: string; industry?: Industry } | null;
  location?: { name: string; address: string | null; phone: string | null } | null;
  prefs?: { currencyDisplay: "toman" | "rial" } | null;
  profile?: {
    legalName?: string;
    taxId?: string;
    email?: string;
    website?: string;
  } | null;
  logo?: BusinessLogo | null;
  error?: string;
}

/**
 * Step 1 of the owner-approved flow (issue #1239 / ESH-90): complete the
 * business profile — name, immutable industry, first branch, contact details
 * and the receipt/invoice logo. The logo may be deliberately deferred; it is
 * persisted through its canonical upload API, never a second storage.
 */
export default function BusinessStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  // The AEC industry walks an extra «پروفایل کسب‌وکار» step right after this
  // one (issue #799), then app selection; every other industry goes straight to
  // the gallery. Passing the filtered sequence is what makes `nextPath` return
  // the right destination for both.
  const steps = useMemo(() => stepsFor(industry), [industry]);
  const [businessName, setBusinessName] = useState("");
  const [locationName, setLocationName] = useState("شعبه مرکزی");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [currencyDisplay, setCurrencyDisplay] = useState<"toman" | "rial">("toman");
  const [logo, setLogo] = useState<BusinessLogo | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<StateResponse>("/api/setup/state")
      .then(({ ok, data }) => {
        if (!ok) {
          setError("بارگذاری اطلاعات کسب‌وکار ممکن نشد.");
          return;
        }
        if (data.business?.name) setBusinessName(data.business.name);
        if (data.location) {
          setLocationName(data.location.name);
          setAddress(data.location.address ?? "");
          setPhone(data.location.phone ?? "");
        }
        if (data.prefs?.currencyDisplay) setCurrencyDisplay(data.prefs.currencyDisplay);
        if (data.profile) {
          setLegalName(data.profile.legalName ?? "");
          setTaxId(data.profile.taxId ?? "");
          setEmail(data.profile.email ?? "");
          setWebsite(data.profile.website ?? "");
        }
        setLogo(data.logo ?? null);
      })
      .catch(() => setError("بارگذاری اطلاعات کسب‌وکار ممکن نشد."))
      .finally(() => setLoaded(true));
  }, []);

  async function uploadLogo(file: File) {
    setLogoError("");
    if (!isLogoMimeType(file.type)) {
      setLogoError("فقط تصویر PNG، JPEG، WebP یا SVG قابل استفاده است.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError("حجم لوگو باید کمتر از ۲۵۶ کیلوبایت باشد.");
      return;
    }
    setLogoBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const { ok, data, status } = await api<{ logo?: BusinessLogo; error?: string }>(
        "/api/settings/business/logo",
        { method: "POST", body: form },
      );
      if (!ok || !data.logo) {
        setLogoError(errorMessage(data.error, undefined, status));
        return;
      }
      setLogo(data.logo);
    } finally {
      setLogoBusy(false);
    }
  }

  async function removeLogo() {
    setLogoError("");
    setLogoBusy(true);
    try {
      const { ok, data, status } = await api<{ error?: string }>(
        "/api/settings/business/logo",
        { method: "DELETE" },
      );
      if (!ok) {
        setLogoError(errorMessage(data.error, undefined, status));
        return;
      }
      setLogo(null);
      if (fileInput.current) fileInput.current.value = "";
    } finally {
      setLogoBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { ok, data, status } = await api<{ error?: string }>("/api/setup/business", {
        method: "POST",
        body: JSON.stringify({
          businessName,
          locationName,
          address,
          phone,
          legalName,
          taxId,
          email,
          website,
          currencyDisplay,
        }),
      });
      if (!ok) {
        setError(errorMessage(data.error, undefined, status));
        return;
      }
      // The industry's own sequence, not the full one: `aec_profile` follows
      // this step for an AEC business (issue #799 §2), then every business
      // meets the app gallery.
      router.push(nextPath("business", steps));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <SetupDataSkeleton rows={8} />;

  return (
    <StepShell
      step="business"
      description="نام کسب‌وکار، شعبهٔ اول، اطلاعات تماس و لوگوی چاپ را ثبت کنید. زبان فارسی، تقویم جلالی و نمایش مبالغ به تومان پیش‌فرض است."
    >
      <form onSubmit={submit} className="max-w-xl">
        <ErrorBox>{error}</ErrorBox>

        <Field label="نام کسب‌وکار *">
          <input
            className={inputClass}
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="مثلاً فروشگاه بهار"
            required
          />
        </Field>

        <Field label="نوع کسب‌وکار" hint="نوع کسب‌وکار پس از ثبت تغییر نمی‌کند.">
          <input
            className={inputClass}
            value={INDUSTRY_LABELS[industry]}
            disabled
            readOnly
          />
        </Field>

        <Field label="نام شعبهٔ اول *" hint="شعبه‌های بعدی را بعداً می‌توانید اضافه کنید.">
          <input
            className={inputClass}
            value={locationName}
            onChange={(e) => setLocationName(e.target.value)}
            required
          />
        </Field>

        <Field label="نشانی" hint="نشانی اصلی برای چاپ روی اسناد و مسیریابی شعبه.">
          <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>

        <Field label="تلفن">
          <input
            className={inputClass}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            dir="ltr"
          />
        </Field>

        <div className="my-7 border-t border-border pt-6">
          <p className="mb-4 text-sm font-semibold text-foreground">اطلاعات تکمیلی (اختیاری)</p>
          <Field label="نام حقوقی" hint="اگر با نام نمایشی کسب‌وکار تفاوت دارد.">
            <input className={inputClass} value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </Field>
          <Field label="شناسهٔ مالیاتی">
            <input className={inputClass} value={taxId} onChange={(e) => setTaxId(e.target.value)} dir="ltr" />
          </Field>
          <Field label="ایمیل">
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              dir="ltr"
            />
          </Field>
          <Field label="وب‌سایت">
            <input
              className={inputClass}
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="example.ir"
              dir="ltr"
            />
          </Field>
        </div>

        <div className="mb-4">
          <span className="mb-1 block text-sm font-medium text-foreground">
            لوگوی کسب‌وکار
          </span>
          <div className="flex flex-wrap items-center gap-3">
            {logo ? (
              <img
                src={logo.dataUrl}
                alt="پیش‌نمایش لوگوی کسب‌وکار"
                className="h-16 w-auto max-w-40 rounded-lg border border-border bg-card p-1"
              />
            ) : (
              <div className="flex h-16 w-28 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                بدون لوگو
              </div>
            )}
            <input
              ref={fileInput}
              id="business-logo"
              type="file"
              accept={LOGO_MIME_TYPES.join(",")}
              disabled={logoBusy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadLogo(file);
              }}
              className="text-sm text-muted-foreground file:me-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:text-foreground"
            />
            {logo ? (
              <SecondaryButton onClick={() => void removeLogo()} disabled={logoBusy}>
                حذف لوگو
              </SecondaryButton>
            ) : null}
          </div>
          <span className="mt-1 block text-xs text-muted-foreground">
            PNG، JPEG، WebP یا SVG — حداکثر {Math.floor(LOGO_MAX_BYTES / 1024)} کیلوبایت.
            اگر آماده نیست، فعلاً رد شوید.
          </span>
        </div>
        {logoError ? <ErrorBox>{logoError}</ErrorBox> : null}

        <Field label="نمایش مبالغ">
          <div className="flex gap-4">
            {(
              [
                ["toman", "تومان (پیش‌فرض)"],
                ["rial", "ریال"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="currency"
                  checked={currencyDisplay === value}
                  onChange={() => setCurrencyDisplay(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </Field>

        <div className="mt-6">
          <PrimaryButton disabled={busy || logoBusy}>ذخیره و ادامه</PrimaryButton>
        </div>
      </form>
    </StepShell>
  );
}
