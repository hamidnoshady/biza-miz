"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useMoney } from "@/components/money/money-context";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import {
  DEFAULT_RETAIL_PRICING_POLICY,
  MAX_RETAIL_OVERHEAD_PERCENT,
  profitPercentLimit,
  suggestRetailPrice,
  NO_RETAIL_PRICING_OVERRIDES,
  type ProfitMode,
  type RetailPricingPolicy,
  type RetailRoundingPolicy,
} from "@/lib/retail-pricing-policy";
import type { OverheadBase, TaxMode } from "@/lib/retail-price-recommendation";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { PercentInput, PriceInput } from "@/app/dashboard/number-fields";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";

interface RetailPricingResponse {
  policy: RetailPricingPolicy;
  defaultTaxPercent: number | null;
  error?: string;
}

/** What the inputs hold while the owner is typing — display unit and raw text. */
interface RetailPricingForm {
  fixedOverhead: string;
  percentOverhead: string;
  overheadBase: OverheadBase;
  profitMode: ProfitMode;
  profitPercent: string;
  rounding: RetailRoundingPolicy;
  roundStep: string;
  taxMode: TaxMode;
}

type FormField = keyof RetailPricingForm;

const SAMPLE_COST_DISPLAY = "100000";

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 }).format(value)}٪`;
}

function CardTitle({ eyebrow, children }: { eyebrow: string; children: string }) {
  return (
    <span className="block">
      <span className="block text-xs font-semibold text-amber-700 dark:text-amber-300">{eyebrow}</span>
      <span className="mt-1 block text-base font-semibold text-foreground sm:text-lg">{children}</span>
    </span>
  );
}

function ChoiceCards<T extends string>({
  name,
  value,
  onChange,
  options,
  disabled,
  label,
}: {
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; title: string; description: string }[];
  disabled: boolean;
  label: string;
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as T)}
      disabled={disabled}
      // Radix defaults the group to LTR, which would flip the cards and their text.
      dir="rtl"
      className="grid gap-2 sm:grid-cols-2"
      aria-label={label}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className={`flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
              active
                ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                : "border-border/80 bg-card hover:bg-muted"
            }`}
          >
            <RadioGroupItem id={`${name}-${option.value}`} value={option.value} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{option.title}</span>
              <span
                className={`mt-1 block text-xs leading-5 ${
                  active ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground"
                }`}
              >
                {option.description}
              </span>
            </span>
          </label>
        );
      })}
    </RadioGroup>
  );
}

/**
 * Business-wide policy behind the New Product «پیشنهاد قیمت فروش». A single
 * product can override the overhead or the profit for itself on the product
 * form; everything else is decided here, once.
 */
export function RetailPricingSettings() {
  const money = useMoney();
  const [form, setForm] = useState<RetailPricingForm | null>(null);
  const [savedForm, setSavedForm] = useState<RetailPricingForm | null>(null);
  const [defaultTaxPercent, setDefaultTaxPercent] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [invalidFields, setInvalidFields] = useState<Set<FormField>>(new Set());

  const toForm = useCallback(
    (policy: RetailPricingPolicy): RetailPricingForm => ({
      fixedOverhead: policy.fixedOverheadRial == null ? "" : String(money.toInput(policy.fixedOverheadRial)),
      percentOverhead: policy.percentOverhead == null ? "" : String(policy.percentOverhead),
      overheadBase: policy.overheadBase,
      profitMode: policy.profitMode,
      profitPercent: policy.profitPercent == null ? "" : String(policy.profitPercent),
      rounding: policy.rounding,
      roundStep: String(money.toInput(policy.roundStepRial)),
      taxMode: policy.taxMode,
    }),
    [money],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setError("");
    setSaved(false);
    try {
      const { ok, data } = await api<RetailPricingResponse>("/api/settings/retail-pricing");
      if (!ok) {
        setLoadError(errorMessage(data.error));
        return;
      }
      const next = toForm(data.policy);
      setForm(next);
      setSavedForm(next);
      setDefaultTaxPercent(data.defaultTaxPercent ?? null);
      setInvalidFields(new Set());
    } catch {
      setLoadError("ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, [toForm]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = form != null && savedForm != null && JSON.stringify(form) !== JSON.stringify(savedForm);

  function change<K extends FormField>(key: K, value: RetailPricingForm[K]) {
    setSaved(false);
    setError("");
    setInvalidFields((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  /** Empty → null; otherwise the amount in Rial, or `false` when it is not one. */
  function parseOptionalMoney(raw: string): number | null | false {
    if (raw.trim() === "") return null;
    const parsed = money.tryParse(raw);
    return parsed.ok ? parsed.rial : false;
  }

  function parseOptionalPercent(raw: string, limit: { max: number; maxInclusive: boolean }): number | null | false {
    const trimmed = toLatinDigits(raw).trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) return false;
    return (limit.maxInclusive ? value > limit.max : value >= limit.max) ? false : value;
  }

  /** The policy the form currently describes, or the fields that stop it from being one. */
  function toPolicy(current: RetailPricingForm):
    | { ok: true; policy: RetailPricingPolicy }
    | { ok: false; invalid: Set<FormField>; message: string } {
    const invalid = new Set<FormField>();
    const fixed = parseOptionalMoney(current.fixedOverhead);
    const percent = parseOptionalPercent(current.percentOverhead, { max: MAX_RETAIL_OVERHEAD_PERCENT, maxInclusive: true });
    const profit = parseOptionalPercent(current.profitPercent, profitPercentLimit(current.profitMode));
    const step =
      current.rounding === "none" ? DEFAULT_RETAIL_PRICING_POLICY.roundStepRial : parseOptionalMoney(current.roundStep);
    if (fixed === false) invalid.add("fixedOverhead");
    if (percent === false) invalid.add("percentOverhead");
    if (profit === false) invalid.add("profitPercent");
    // The step is a multiple: empty or zero would divide by nothing.
    if (!step) invalid.add("roundStep");
    if (fixed === false || percent === false || profit === false || !step) {
      const message = invalid.has("profitPercent")
        ? current.profitMode === "margin"
          ? "حاشیهٔ سود باید از ۰ تا کمتر از ۱۰۰ باشد."
          : "درصد نشانه‌گذاری باید از ۰ تا ۱۰٬۰۰۰ باشد."
        : invalid.has("percentOverhead")
          ? "درصد سربار باید از ۰ تا ۱۰۰۰ باشد."
          : invalid.has("fixedOverhead")
            ? "سربار ثابت باید مبلغی صفر یا بیشتر باشد."
            : "مبلغ گردکردن باید عددی بزرگ‌تر از صفر باشد.";
      return { ok: false, invalid, message };
    }
    return {
      ok: true,
      policy: {
        fixedOverheadRial: fixed,
        percentOverhead: percent,
        overheadBase: current.overheadBase,
        profitMode: current.profitMode,
        profitPercent: profit,
        rounding: current.rounding,
        roundStepRial: step,
        taxMode: current.taxMode,
      },
    };
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    const result = toPolicy(form);
    if (!result.ok) {
      setInvalidFields(result.invalid);
      setError(result.message);
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const { ok, data } = await api<RetailPricingResponse>("/api/settings/retail-pricing", {
        method: "PUT",
        body: JSON.stringify(result.policy),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      const next = toForm(data.policy);
      setForm(next);
      setSavedForm(next);
      setDefaultTaxPercent(data.defaultTaxPercent ?? null);
      setInvalidFields(new Set());
      setSaved(true);
    } catch {
      setError("ذخیره انجام نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!savedForm) return;
    setForm(savedForm);
    setError("");
    setSaved(false);
    setInvalidFields(new Set());
  }

  // A worked example beside the inputs: a percentage on its own never tells
  // the owner what a product will cost, a price does.
  const example = useMemo(() => {
    if (!form) return null;
    const current = toPolicy(form);
    if (!current.ok) return null;
    const sample = money.tryParse(SAMPLE_COST_DISPLAY);
    if (!sample.ok) return null;
    return {
      costRial: sample.rial,
      outcome: suggestRetailPrice({
        policy: current.policy,
        overrides: NO_RETAIL_PRICING_OVERRIDES,
        referenceCostRial: sample.rial,
        taxPercent: defaultTaxPercent,
        minUnitRial: money.parse("1"),
      }),
    };
    // toPolicy closes over `money`, which is stable per unit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, defaultTaxPercent, money]);

  if (loading) return <LoadingSkeleton rows={5} label="در حال بارگذاری تنظیمات قیمت‌گذاری" />;

  if (loadError || !form || !savedForm) {
    return (
      <div className="space-y-4">
        <ErrorBox>{loadError || "بارگذاری تنظیمات قیمت‌گذاری ممکن نشد."}</ErrorBox>
        <SectionCard
          title="بارگذاری دوباره"
          description="تا تنظیمات فعلی دریافت نشود، فرم نمایش داده نمی‌شود تا داده‌ای ناخواسته بازنویسی نشود."
        >
          <Button type="button" onClick={() => void load()}>
            تلاش دوباره
          </Button>
        </SectionCard>
      </div>
    );
  }

  const profitLabel = form.profitMode === "margin" ? "حاشیهٔ سود هدف" : "درصد نشانه‌گذاری هدف";
  const profitHint =
    form.profitMode === "margin"
      ? "از ۰ تا کمتر از ۱۰۰؛ برای نمونه ۲۰ یعنی ۲۰٪ از قیمت فروش سود شما باشد."
      : "برای نمونه ۲۵ یعنی قیمت فروش ۲۵٪ بیشتر از بهای تمام‌شده باشد.";

  return (
    <form onSubmit={save} className="space-y-6" noValidate>
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>تنظیمات قیمت‌گذاری با موفقیت ذخیره شد.</InfoBox> : null}

      <SectionCard
        title={<CardTitle eyebrow="سربار">سربار پیش‌فرض هر کالا</CardTitle>}
        description="هزینه‌هایی مثل حمل، بسته‌بندی و اجاره که به بهای خرید هر کالا اضافه می‌شود. برای کالایی که سربار متفاوتی دارد، همان‌جا در فرم محصول مقدار اختصاصی وارد کنید."
      >
        <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
          <Field label="سربار ثابت" hint="مبلغی که به هر واحد اضافه می‌شود.">
            <PriceInput
              id="retail-pricing-fixed-overhead"
              value={form.fixedOverhead}
              disabled={saving}
              aria-invalid={invalidFields.has("fixedOverhead") || undefined}
              onChange={(event) => change("fixedOverhead", event.target.value)}
            />
          </Field>
          <Field label="سربار درصدی" hint="درصدی از بهای خرید که به هر واحد اضافه می‌شود.">
            <PercentInput
              id="retail-pricing-percent-overhead"
              value={form.percentOverhead}
              disabled={saving}
              aria-invalid={invalidFields.has("percentOverhead") || undefined}
              onChange={(event) => change("percentOverhead", event.target.value)}
            />
          </Field>
        </div>
        <fieldset disabled={saving} className="mt-1">
          <legend className="mb-2 text-sm font-medium text-foreground">سربار درصدی از چه مبنایی حساب شود؟</legend>
          <ChoiceCards
            name="retail-pricing-overhead-base"
            label="مبنای سربار درصدی"
            value={form.overheadBase}
            disabled={saving}
            onChange={(value) => change("overheadBase", value)}
            options={[
              { value: "reference", title: "فقط بهای خرید", description: "درصد از بهای خرید کالا گرفته می‌شود." },
              {
                value: "with_fixed",
                title: "بهای خرید + سربار ثابت",
                description: "درصد از مجموع بهای خرید و سربار ثابت گرفته می‌شود.",
              },
            ]}
          />
        </fieldset>
      </SectionCard>

      <SectionCard
        title={<CardTitle eyebrow="سود">سود هدف</CardTitle>}
        description="قیمت پیشنهادی بر پایهٔ بهای خرید به‌علاوهٔ سربار و این سود ساخته می‌شود. تا سود هدف تعیین نشود، قیمتی پیشنهاد نمی‌شود مگر آن‌که در فرم محصول برای همان کالا سود وارد شود."
      >
        <fieldset disabled={saving} className="space-y-4">
          <legend className="mb-2 text-sm font-medium text-foreground">سود نسبت به چه چیزی سنجیده شود؟</legend>
          <ChoiceCards
            name="retail-pricing-profit-mode"
            label="روش سود هدف"
            value={form.profitMode}
            disabled={saving}
            onChange={(value) => change("profitMode", value)}
            options={[
              {
                value: "markup",
                title: "نشانه‌گذاری روی بها",
                description: "سود درصدی از بهای تمام‌شده است؛ ۲۵٪ یعنی بها × ۱٫۲۵.",
              },
              {
                value: "margin",
                title: "حاشیهٔ سود از قیمت فروش",
                description: "سود درصدی از قیمت فروش است؛ ۲۵٪ یعنی یک‌چهارم قیمت فروش سود باشد.",
              },
            ]}
          />
          <Field label={profitLabel} hint={profitHint}>
            <div className="max-w-sm">
              <PercentInput
                id="retail-pricing-profit-percent"
                value={form.profitPercent}
                placeholder="مثلاً ۲۵"
                disabled={saving}
                aria-invalid={invalidFields.has("profitPercent") || undefined}
                onChange={(event) => change("profitPercent", event.target.value)}
              />
            </div>
          </Field>
        </fieldset>
      </SectionCard>

      <SectionCard
        title={<CardTitle eyebrow="قیمت نهایی">گردکردن و مبنای مالیات</CardTitle>}
        description="قیمت پیشنهادی پیش از نمایش گرد می‌شود، و مالیات به یکی از دو روش به آن مربوط می‌شود."
      >
        <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
          <Field label="گردکردن قیمت">
            <select
              id="retail-pricing-rounding"
              className={inputClass}
              value={form.rounding}
              disabled={saving}
              onChange={(event) => change("rounding", event.target.value as RetailRoundingPolicy)}
            >
              <option value="none">بدون گردکردن اضافه</option>
              <option value="nearest">به نزدیک‌ترین</option>
              <option value="up">به بالا</option>
              <option value="down">به پایین</option>
            </select>
          </Field>
          {form.rounding !== "none" ? (
            <Field label="گرد به مضرب" hint="مثلاً ۱٬۰۰۰ یعنی قیمت‌ها به هزار نزدیک می‌شوند.">
              <PriceInput
                id="retail-pricing-round-step"
                value={form.roundStep}
                disabled={saving}
                aria-invalid={invalidFields.has("roundStep") || undefined}
                onChange={(event) => change("roundStep", event.target.value)}
              />
            </Field>
          ) : null}
        </div>
        <fieldset disabled={saving} className="mt-1">
          <legend className="mb-2 text-sm font-medium text-foreground">قیمت فروش محصول با مالیات یا بدون آن ثبت شود؟</legend>
          <ChoiceCards
            name="retail-pricing-tax-mode"
            label="مبنای مالیات"
            value={form.taxMode}
            disabled={saving}
            onChange={(value) => change("taxMode", value)}
            options={[
              {
                value: "exclusive",
                title: "قیمت بدون مالیات",
                description: "مالیات جداگانه روی فاکتور اضافه می‌شود و در قیمت پیشنهادی نمی‌آید.",
              },
              {
                value: "inclusive",
                title: "قیمت شامل مالیات",
                description: "قیمت پیشنهادی مالیات را هم در خود دارد.",
              },
            ]}
          />
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {defaultTaxPercent == null
              ? "نرخ مالیات از تنظیمات «مالیات» خوانده می‌شود؛ هنوز نرخی تعیین نشده است."
              : `نرخ مالیات از تنظیمات «مالیات» خوانده می‌شود (نرخ فعلی ${formatPercent(defaultTaxPercent)}) و در فرم محصول برای هر کالا قابل تغییر است.`}
          </p>
        </fieldset>
      </SectionCard>

      <SectionCard
        title="نمونه"
        description="با تنظیمات بالا (و پیش از ذخیره)، کالایی با این بهای خرید چنین قیمتی پیشنهاد می‌گیرد."
      >
        {example && example.outcome.ok ? (
          <p className="text-sm leading-7 text-foreground" aria-live="polite">
            بهای خرید {toPersianDigits(money.format(example.costRial))} ←{" "}
            <strong className="font-semibold">
              {toPersianDigits(money.format(example.outcome.recommendation.suggestedPriceRial))}
            </strong>{" "}
            قیمت پیشنهادی
          </p>
        ) : (
          <p className="text-sm leading-6 text-muted-foreground" aria-live="polite">
            {example && !example.outcome.ok && example.outcome.reason === "no_profit"
              ? "سود هدف را وارد کنید تا نمونه نمایش داده شود."
              : "با مقدارهای فعلی نمونه‌ای قابل محاسبه نیست؛ فیلدهای قرمز را اصلاح کنید."}
          </p>
        )}
      </SectionCard>

      <SectionCard bodyClassName="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div aria-live="polite" className="text-sm">
          <p className="font-medium text-foreground">
            {dirty ? "تغییرات ذخیره‌نشده دارید." : "همهٔ تغییرات ذخیره شده‌اند."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            ذخیره فقط پیشنهادهای بعدی را تغییر می‌دهد و قیمت کالاهای فعلی را عوض نمی‌کند.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <div className="w-full sm:w-48">
            <PrimaryButton disabled={saving || !dirty}>{saving ? "در حال ذخیره…" : "ذخیرهٔ قیمت‌گذاری"}</PrimaryButton>
          </div>
          <Button type="button" variant="outline" disabled={saving || !dirty} onClick={reset} className="w-full sm:w-auto">
            بازگردانی تغییرات
          </Button>
        </div>
      </SectionCard>
    </form>
  );
}
