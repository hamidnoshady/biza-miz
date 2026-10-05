"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SetupDataSkeleton, StepShell } from "../ui";
import { nextPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";

interface StateResponse {
  business?: { name: string } | null;
  location?: { name: string; address: string | null; phone: string | null } | null;
  prefs?: { currencyDisplay: "toman" | "rial" } | null;
  error?: string;
}

export default function BusinessStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  // The AEC industry walks an extra «پروفایل کسب‌وکار» step right after this
  // one (issue #799); every other industry goes straight to the chart of
  // accounts. Passing the filtered sequence is what makes `nextPath` return the
  // right destination for both.
  const steps = useMemo(() => stepsFor(industry), [industry]);
  const [businessName, setBusinessName] = useState("");
  const [locationName, setLocationName] = useState("شعبه مرکزی");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [currencyDisplay, setCurrencyDisplay] = useState<"toman" | "rial">("toman");
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
      })
      .catch(() => setError("بارگذاری اطلاعات کسب‌وکار ممکن نشد."))
      .finally(() => setLoaded(true));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { ok, data, status } = await api<{ error?: string }>("/api/setup/business", {
        method: "POST",
        body: JSON.stringify({ businessName, locationName, address, phone, currencyDisplay }),
      });
      if (!ok) {
        setError(errorMessage(data.error, undefined, status));
        return;
      }
      // The industry's own sequence, not the full one: `aec_profile` follows
      // this step for an AEC business (issue #799 §2) and for nobody else.
      router.push(nextPath("business", steps));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <SetupDataSkeleton rows={5} />;

  return (
    <StepShell
      step="business"
      description="نام کسب‌وکار و شعبهٔ اول را ثبت کنید. زبان فارسی، تقویم جلالی و نمایش مبالغ به تومان پیش‌فرض است."
    >
      <form onSubmit={submit} className="max-w-lg">
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
        <Field label="نام شعبه *" hint="شعبه‌های بعدی را بعداً می‌توانید اضافه کنید.">
          <input
            className={inputClass}
            value={locationName}
            onChange={(e) => setLocationName(e.target.value)}
            required
          />
        </Field>
        <Field label="نشانی">
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
          <PrimaryButton disabled={busy}>ذخیره و ادامه</PrimaryButton>
        </div>
      </form>
    </StepShell>
  );
}
