"use client";

import { SetupDataSkeleton } from "../ui";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass, PrimaryButton, StepShell } from "../ui";
import { nextPath } from "../steps";
import { useSetupIndustry } from "../industry-context";

interface Category {
  id: string;
  name: string;
  tax_rate: string | number;
}

interface TaxResponse {
  tax: { defaultRate: number } | null;
  categories: Category[];
  error?: string;
}

export default function TaxStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const [defaultRate, setDefaultRate] = useState("10");
  const [categories, setCategories] = useState<{ id: string; name: string; rate: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<TaxResponse>("/api/setup/tax").then(({ data }) => {
      if (data.tax) setDefaultRate(String(data.tax.defaultRate));
      if (data.categories) {
        setCategories(
          data.categories.map((c) => ({ id: c.id, name: c.name, rate: String(Number(c.tax_rate)) })),
        );
      }
    }).finally(() => setLoaded(true));
  }, []);

  function parseRate(s: string): number {
    return Number(toLatinDigits(s).replace(/[٫]/g, "."));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { ok, data, status } = await api<{ error?: string }>("/api/setup/tax", {
        method: "POST",
        body: JSON.stringify({
          defaultRate: parseRate(defaultRate),
          categories: categories.map((c) => ({ id: c.id, taxRate: parseRate(c.rate) })),
        }),
      });
      if (!ok) {
        setError(errorMessage(data.error, undefined, status));
        return;
      }
      router.push(nextPath("tax"));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <SetupDataSkeleton rows={4} />;

  return (
    <StepShell
      step="tax"
      description="نرخ پیش‌فرض مالیات بر ارزش افزوده را تعیین کنید. دسته‌های منو با همین نرخ ساخته می‌شوند و بعد از ساخت منو می‌توانید برای هر دسته نرخ جدا (یا صفر برای معاف) بگذارید."
    >
      <form onSubmit={submit} className="max-w-lg">
        <ErrorBox>{error}</ErrorBox>
        <Field label="نرخ پیش‌فرض مالیات (٪)" hint="نرخ رایج ارزش افزوده ۱۰٪ است؛ اگر مشمول نیستید ۰ بگذارید.">
          <PersianNumberInput
            className={`${inputClass} w-28`}
            dir="ltr"
            inputMode="decimal"
            value={defaultRate}
            onChange={(e) => setDefaultRate(e.target.value)}
            required
          />
        </Field>

        {categories.length > 0 ? (
          <div className="mt-6">
            <p className="mb-2 text-sm font-medium text-foreground">نرخ هر دسته از منو</p>
            <div className="space-y-2">
              {categories.map((c, i) => (
                <div key={c.id} className="flex items-center gap-3">
                  <span className="w-40 truncate text-sm">{c.name}</span>
                  <PersianNumberInput
                    className={`${inputClass} w-24`}
                    dir="ltr"
                    inputMode="decimal"
                    value={c.rate}
                    onChange={(e) =>
                      setCategories((cs) =>
                        cs.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)),
                      )
                    }
                  />
                  <span className="text-sm text-muted-foreground">٪</span>
                </div>
              ))}
            </div>
          </div>
        ) : industry === "food_service" ? (
          <InfoBox>
            هنوز دسته‌ای در منو ندارید — بعد از مرحلهٔ {toPersianDigits(6)} (ورود منو) می‌توانید به
            این‌جا برگردید و نرخ هر دسته را جدا تنظیم کنید.
          </InfoBox>
        ) : null}

        <div className="mt-6">
          <PrimaryButton disabled={busy}>ذخیره و ادامه</PrimaryButton>
        </div>
      </form>
    </StepShell>
  );
}
