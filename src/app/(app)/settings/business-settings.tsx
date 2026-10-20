"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { SectionCard, cardClass } from "@/app/dashboard/page-chrome";
import { radioMoveForKey, radioTargetIndex } from "@/lib/radio-keys";
import { LogoPanel } from "./printing/logo-panel";
import { usePrintIdentity } from "./printing/use-printing";

interface BusinessState {
  business: { name: string } | null;
  location: { name: string; address: string | null; phone: string | null } | null;
  prefs: { currencyDisplay?: "toman" | "rial" } | null;
  profile: {
    legalName?: string;
    taxId?: string;
    email?: string;
    website?: string;
    receiptFooter?: string;
  } | null;
  error?: string;
}

interface FormState {
  businessName: string;
  locationName: string;
  address: string;
  phone: string;
  currencyDisplay: "toman" | "rial";
  legalName: string;
  taxId: string;
  email: string;
  website: string;
  receiptFooter: string;
}

const EMPTY: FormState = {
  businessName: "",
  locationName: "",
  address: "",
  phone: "",
  currencyDisplay: "toman",
  legalName: "",
  taxId: "",
  email: "",
  website: "",
  receiptFooter: "",
};

function fromState(data: BusinessState): FormState {
  return {
    businessName: data.business?.name ?? "",
    locationName: data.location?.name ?? "",
    address: data.location?.address ?? "",
    phone: data.location?.phone ?? "",
    currencyDisplay: data.prefs?.currencyDisplay === "rial" ? "rial" : "toman",
    legalName: data.profile?.legalName ?? "",
    taxId: data.profile?.taxId ?? "",
    email: data.profile?.email ?? "",
    website: data.profile?.website ?? "",
    receiptFooter: data.profile?.receiptFooter ?? "",
  };
}

/**
 * Two options are a pair of buttons, not a dropdown — the choice is visible
 * without opening anything, and «تومان»/«ریال» is the setting most often
 * checked at a glance rather than changed.
 */
function CurrencyChoice({
  value,
  onChange,
}: {
  value: FormState["currencyDisplay"];
  onChange: (next: FormState["currencyDisplay"]) => void;
}) {
  const options = [
    { key: "toman", label: "تومان", hint: "۲۵,۰۰۰" },
    { key: "rial", label: "ریال", hint: "۲۵۰,۰۰۰" },
  ] as const;
  // Roving focus: the checked option is the one Tab stop, and the arrows move
  // (and check) — see radio-keys.ts. Without it `role="radio"` is a lie told
  // to every screen reader.
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  return (
    <div role="radiogroup" aria-label="واحد نمایش مبلغ" className="grid grid-cols-2 gap-2">
      {options.map((option, index) => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.key)}
            onKeyDown={(event) => {
              const move = radioMoveForKey(event.key, true);
              const target = move && radioTargetIndex(move, index, options.length);
              if (target === null) return;
              event.preventDefault();
              onChange(options[target].key);
              buttonsRef.current[target]?.focus();
            }}
            className={`flex min-h-11 flex-col items-center justify-center rounded-xl border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${
              active
                ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
                : "border-border/80 bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <span>{option.label}</span>
            <span className={`text-[11px] font-normal ${active ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground"}`}>
              {option.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Business and active-branch profile, available after the initial wizard as well. */
export function BusinessSettings() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  /** Nothing to save until something is edited — the save bar says so. */
  const [dirty, setDirty] = useState(false);
  const identity = usePrintIdentity();

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<BusinessState>("/api/settings/business");
    if (ok) {
      setForm(fromState(data));
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function change<K extends keyof FormState>(key: K, value: FormState[K]) {
    setSaved(false);
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>("/api/settings/business", {
      method: "PUT",
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setSaved(true);
    setDirty(false);
  }

  if (loading) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" aria-label="در حال بارگذاری تنظیمات" className="space-y-4">
        {[0, 1, 2].map((row) => (
          <div key={row} aria-hidden="true" className="ops-skeleton h-40 rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>اطلاعات کسب‌وکار ذخیره شد.</InfoBox> : null}

      <SectionCard title="هویت کسب‌وکار" description="نام، مشخصات حقوقی و لوگوی کسب‌وکار که روی رسید، فاکتور و گزارش‌ها چاپ می‌شود.">
        {!identity.loading ? (
          <div className="mb-6">
            <LogoPanel logo={identity.logo} onChanged={identity.reload} />
          </div>
        ) : null}

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام کسب‌وکار">
            <input
              className={inputClass}
              maxLength={200}
              value={form.businessName}
              onChange={(e) => change("businessName", e.target.value)}
              required
            />
          </Field>
          <Field label="نام حقوقی / صاحب امتیاز" hint="روی فاکتور رسمی چاپ می‌شود.">
            <input
              className={inputClass}
              maxLength={200}
              value={form.legalName}
              onChange={(e) => change("legalName", e.target.value)}
              placeholder="اختیاری"
            />
          </Field>
          <Field label="شناسه / شماره مالیاتی">
            <input
              className={inputClass}
              dir="ltr"
              maxLength={50}
              value={form.taxId}
              onChange={(e) => change("taxId", e.target.value)}
              placeholder="اختیاری"
            />
          </Field>
          <Field label="ایمیل پشتیبانی">
            <input
              className={inputClass}
              dir="ltr"
              type="email"
              value={form.email}
              onChange={(e) => change("email", e.target.value)}
              placeholder="info@example.com"
            />
          </Field>
          <Field label="وب‌سایت">
            <input
              className={inputClass}
              dir="ltr"
              maxLength={300}
              value={form.website}
              onChange={(e) => change("website", e.target.value)}
              placeholder="https://example.com"
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="واحد نمایش مبلغ" description="فقط شکل نمایش عوض می‌شود؛ مبلغ‌های ثبت‌شده دست‌نخورده می‌مانند.">
        <CurrencyChoice value={form.currencyDisplay} onChange={(next) => change("currencyDisplay", next)} />
      </SectionCard>

      <SectionCard title="شعبهٔ فعال" description="این اطلاعات برای شعبه‌ای که اکنون انتخاب شده است استفاده می‌شود.">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام شعبه">
            <input
              className={inputClass}
              // The same 80-character ceiling /api/branches enforces on a
              // branch name (MAX_BRANCH_NAME): this field edits the same
              // locations.name column the branch screen does, so a name only
              // this form would accept is a name the branch editor then
              // refuses to save.
              maxLength={80}
              value={form.locationName}
              onChange={(e) => change("locationName", e.target.value)}
              required
            />
          </Field>
          <Field label="شماره تماس">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="tel"
              maxLength={32}
              value={form.phone}
              onChange={(e) => change("phone", e.target.value)}
            />
          </Field>
        </div>
        <Field label="نشانی">
          <textarea
            className={`${inputClass} h-auto min-h-24 py-2`}
            maxLength={500}
            value={form.address}
            onChange={(e) => change("address", e.target.value)}
          />
        </Field>
      </SectionCard>

      <SectionCard title="متن پایین رسید" description="مثلاً پیام تشکر، شرایط مرجوعی یا راه ارتباطی.">
        <textarea
          className={`${inputClass} h-auto min-h-24 py-2`}
          maxLength={500}
          value={form.receiptFooter}
          onChange={(e) => change("receiptFooter", e.target.value)}
          placeholder="از خرید شما متشکریم"
        />
      </SectionCard>

      {/*
        The button leads and the status follows it, rather than the other way
        round: the assistant's floating button occupies the inline-end corner
        of every screen, and whatever sits there gets covered. A line of text
        can afford that; the form's only submit cannot.
      */}
      <div className={`flex flex-wrap items-center justify-between gap-3 ${cardClass} px-4 py-3`}>
        <Button type="submit" size="lg" disabled={saving || !dirty} className="px-6 font-semibold">
          {saving ? "در حال ذخیره…" : "ذخیرهٔ اطلاعات"}
        </Button>
        <p className="min-w-0 text-xs leading-5 text-muted-foreground">
          {dirty ? "تغییرات ذخیره نشده است." : "همه‌چیز ذخیره شده است."}
        </p>
      </div>
    </form>
  );
}
