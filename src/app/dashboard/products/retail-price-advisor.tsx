"use client";

/**
 * «پیشنهاد قیمت فروش» on the New Product pricing tab.
 *
 * The overhead, profit target, rounding and tax basis are the business's
 * decisions and live in «تنظیمات ← قیمت‌گذاری» (`retail-pricing-policy.ts`);
 * this panel only reads them. What it lets one product do is override the
 * overhead or the profit for itself, and then it shows the suggested price with
 * one action: apply it.
 *
 * Preview only. Nothing is written until the product is saved, and the
 * calculation behind an applied price travels with the product so the audit row
 * can say how the price was derived (issue #924, review item 3).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import type { ParsedPriceRecommendation } from "@/lib/product-input";
import {
  profitPercentLimit,
  suggestRetailPrice,
  type ProfitMode,
  type RetailPricingPolicy,
} from "@/lib/retail-pricing-policy";
import { api, errorMessage, Field, inputClass } from "../ui";
import { PercentInput, PriceInput } from "../number-fields";
import { LoadingSkeleton, SectionCard } from "../page-chrome";

interface PolicyResponse {
  policy: RetailPricingPolicy;
  defaultTaxPercent: number | null;
  error?: string;
}

const PRICING_SETTINGS_HREF = "/settings/pricing";

function percentText(value: number): string {
  return `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 }).format(value)}٪`;
}

function parsePercent(raw: string): number | null {
  const trimmed = toLatinDigits(raw).trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function RetailPriceAdvisor({
  purchasePrice,
  sellPrice,
  taxSalePercent,
  onApply,
}: {
  /** The form's purchase price, as typed (business display unit). */
  purchasePrice: string;
  /** The form's current sale price, to tell whether the suggestion is already in it. */
  sellPrice: string;
  /** The product's own sale-tax percent, as typed; empty falls back to the business rate. */
  taxSalePercent: string;
  onApply: (value: string, recommendation: ParsedPriceRecommendation) => void;
}) {
  const money = useMoney();
  const [policyState, setPolicyState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; policy: RetailPricingPolicy; defaultTaxPercent: number | null }
  >({ status: "loading" });
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [fixedOverhead, setFixedOverhead] = useState("");
  const [percentOverhead, setPercentOverhead] = useState("");
  const [profitMode, setProfitMode] = useState<ProfitMode>("markup");
  const [profitPercent, setProfitPercent] = useState("");

  const loadPolicy = useCallback(async () => {
    setPolicyState({ status: "loading" });
    try {
      const { ok, data } = await api<PolicyResponse>("/api/settings/retail-pricing");
      if (!ok) {
        setPolicyState({ status: "error", message: errorMessage(data.error) });
        return;
      }
      setPolicyState({ status: "ready", policy: data.policy, defaultTaxPercent: data.defaultTaxPercent ?? null });
    } catch {
      setPolicyState({ status: "error", message: "ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی و دوباره تلاش کنید." });
    }
  }, []);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const policy = policyState.status === "ready" ? policyState.policy : null;
  const defaultTaxPercent = policyState.status === "ready" ? policyState.defaultTaxPercent : null;

  const overrides = useMemo(() => {
    const fixed = fixedOverhead.trim() === "" ? null : money.tryParse(fixedOverhead);
    return {
      fixedOverheadRial: fixed && fixed.ok ? fixed.rial : null,
      percentOverhead: parsePercent(percentOverhead),
      profitMode,
      profitPercent: parsePercent(profitPercent),
    };
  }, [fixedOverhead, percentOverhead, profitMode, profitPercent, money]);

  const hasOverrides =
    overrides.fixedOverheadRial != null || overrides.percentOverhead != null || overrides.profitPercent != null;

  const profitOutOfRange =
    overrides.profitPercent != null &&
    (() => {
      const limit = profitPercentLimit(profitMode);
      return limit.maxInclusive ? overrides.profitPercent > limit.max : overrides.profitPercent >= limit.max;
    })();

  const outcome = useMemo(() => {
    if (!policy) return null;
    const cost = purchasePrice.trim() === "" ? null : money.tryParse(purchasePrice);
    // The product's own tax percent wins; a blank one means the business rate.
    const productTax = parsePercent(taxSalePercent);
    return suggestRetailPrice({
      policy,
      overrides: profitOutOfRange ? { ...overrides, profitPercent: null } : overrides,
      referenceCostRial: cost && cost.ok ? cost.rial : null,
      taxPercent: productTax ?? defaultTaxPercent,
      minUnitRial: money.parse("1"),
    });
  }, [policy, overrides, profitOutOfRange, purchasePrice, taxSalePercent, defaultTaxPercent, money]);

  const clearOverrides = () => {
    setFixedOverhead("");
    setPercentOverhead("");
    setProfitPercent("");
  };

  // `money.format` already carries the unit.
  const formatAmount = (rial: number) => toPersianDigits(money.format(rial));

  const suggestedText = outcome?.ok ? String(money.toInput(outcome.recommendation.suggestedPriceRial)) : "";
  const alreadyApplied = outcome?.ok === true && sellPrice.trim() !== "" && toLatinDigits(sellPrice).replace(/[٬,\s]/g, "") === suggestedText;

  function renderResult() {
    if (policyState.status === "loading") return <LoadingSkeleton rows={2} label="در حال بارگذاری تنظیمات قیمت‌گذاری" />;
    if (policyState.status === "error") {
      return (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-destructive">{policyState.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadPolicy()}>
            تلاش دوباره
          </Button>
        </div>
      );
    }
    if (!outcome) return null;
    if (!outcome.ok) {
      const message =
        outcome.reason === "no_cost"
          ? "قیمت خرید را وارد کنید تا قیمت فروش پیشنهادی محاسبه شود."
          : outcome.reason === "no_profit"
            ? "سود هدف هنوز تعیین نشده است. آن را در تنظیمات قیمت‌گذاری وارد کنید، یا برای همین محصول سود اختصاصی بگذارید."
            : "با مقدارهای فعلی قیمتی قابل محاسبه نیست؛ مقدارها را بررسی کنید.";
      return (
        <p className="text-sm leading-6 text-muted-foreground" aria-live="polite">
          {message}
          {outcome.reason === "no_profit" ? (
            <>
              {" "}
              <Link href={PRICING_SETTINGS_HREF} className="font-medium text-primary underline-offset-4 hover:underline">
                باز کردن تنظیمات قیمت‌گذاری
              </Link>
            </>
          ) : null}
        </p>
      );
    }

    const { breakdown } = outcome.preview;
    const overheadRial = breakdown.costRial - Number(outcome.recommendation.inputs.referenceCostRial);
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0" aria-live="polite">
          <p className="text-xs font-medium text-muted-foreground">قیمت فروش پیشنهادی</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {formatAmount(outcome.recommendation.suggestedPriceRial)}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            بهای تمام‌شده {formatAmount(breakdown.costRial)}
            {overheadRial > 0 ? ` (سربار ${formatAmount(overheadRial)})` : ""} · سود {formatAmount(breakdown.grossProfitRial)}
            {outcome.preview.taxPreview && outcome.recommendation.inputs.taxMode === "exclusive"
              ? ` · مالیات جدا: ${formatAmount(outcome.preview.taxPreview.taxRial)}`
              : ""}
          </p>
        </div>
        <Button
          type="button"
          disabled={alreadyApplied}
          onClick={() => onApply(suggestedText, outcome.recommendation)}
          className="w-full sm:w-auto"
        >
          {alreadyApplied ? (
            <>
              <CheckIcon aria-hidden="true" className="size-4" />
              قیمت پیشنهادی اعمال شده
            </>
          ) : (
            "اعمال قیمت پیشنهادی"
          )}
        </Button>
      </div>
    );
  }

  const policySummary = policy
    ? [
        policy.fixedOverheadRial || policy.percentOverhead
          ? `سربار ${[
              policy.percentOverhead ? percentText(policy.percentOverhead) : null,
              policy.fixedOverheadRial ? formatAmount(policy.fixedOverheadRial) : null,
            ]
              .filter(Boolean)
              .join(" + ")}`
          : "بدون سربار",
        policy.profitPercent == null
          ? "سود هدف تعیین نشده"
          : `${policy.profitMode === "margin" ? "حاشیهٔ سود" : "نشانه‌گذاری"} ${percentText(policy.profitPercent)}`,
        policy.rounding === "none" ? "بدون گردکردن" : `گرد به ${formatAmount(policy.roundStepRial)}`,
        policy.taxMode === "inclusive" ? "قیمت با مالیات" : "قیمت بدون مالیات",
      ]
    : [];

  return (
    <SectionCard
      title="پیشنهاد قیمت فروش"
      description="بر پایهٔ قیمت خرید و تنظیمات قیمت‌گذاری کسب‌وکار محاسبه می‌شود. تا وقتی محصول را ذخیره نکنید چیزی ثبت نمی‌شود."
      actions={
        <Link href={PRICING_SETTINGS_HREF} className="text-xs font-medium text-primary underline-offset-4 hover:underline">
          تنظیمات قیمت‌گذاری
        </Link>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-border/80 bg-muted/40 p-4">{renderResult()}</div>

        {policy ? (
          <ul aria-label="تنظیمات قیمت‌گذاری کسب‌وکار" className="flex flex-wrap gap-2">
            {policySummary.map((item) => (
              <li key={item} className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                {item}
              </li>
            ))}
          </ul>
        ) : null}

        {policy ? (
          <div className="rounded-xl border border-border/80">
            <button
              type="button"
              aria-expanded={overridesOpen}
              aria-controls="retail-price-advisor-overrides"
              onClick={() => setOverridesOpen((open) => !open)}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-4 py-2 text-start text-sm font-medium text-foreground hover:bg-muted/60"
            >
              <span className="flex items-center gap-2">
                <SlidersHorizontalIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                سربار یا سود اختصاصی برای این محصول
                {hasOverrides ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">فعال</span>
                ) : null}
              </span>
              <ChevronDownIcon
                aria-hidden="true"
                className={`size-4 shrink-0 text-muted-foreground transition-transform ${overridesOpen ? "rotate-180" : ""}`}
              />
            </button>
            {overridesOpen ? (
              <div id="retail-price-advisor-overrides" className="space-y-3 border-t border-border/80 p-4">
                <p className="text-xs leading-5 text-muted-foreground">
                  فقط برای کالاهایی که با بقیه فرق دارند. فیلد خالی یعنی مقدار تنظیمات قیمت‌گذاری.
                </p>
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
                  <Field label="سربار ثابت اختصاصی">
                    <PriceInput
                      id="retail-advisor-fixed-overhead"
                      value={fixedOverhead}
                      onChange={(event) => setFixedOverhead(event.target.value)}
                      placeholder={policy.fixedOverheadRial ? toPersianDigits(money.toInput(policy.fixedOverheadRial)) : "از تنظیمات"}
                    />
                  </Field>
                  <Field label="سربار درصدی اختصاصی">
                    <PercentInput
                      id="retail-advisor-percent-overhead"
                      value={percentOverhead}
                      onChange={(event) => setPercentOverhead(event.target.value)}
                      placeholder={policy.percentOverhead ? toPersianDigits(policy.percentOverhead) : "از تنظیمات"}
                    />
                  </Field>
                  <Field label="روش سود اختصاصی">
                    <select
                      id="retail-advisor-profit-mode"
                      className={inputClass}
                      value={profitMode}
                      onChange={(event) => setProfitMode(event.target.value as ProfitMode)}
                    >
                      <option value="markup">نشانه‌گذاری روی بها</option>
                      <option value="margin">حاشیهٔ سود از قیمت فروش</option>
                    </select>
                  </Field>
                  <Field
                    label={profitMode === "margin" ? "حاشیهٔ سود اختصاصی" : "نشانه‌گذاری اختصاصی"}
                    hint={profitOutOfRange ? undefined : "اگر وارد کنید، جای سود هدف تنظیمات می‌نشیند."}
                  >
                    <PercentInput
                      id="retail-advisor-profit-percent"
                      value={profitPercent}
                      onChange={(event) => setProfitPercent(event.target.value)}
                      aria-invalid={profitOutOfRange || undefined}
                      placeholder={policy.profitPercent == null ? "از تنظیمات" : toPersianDigits(policy.profitPercent)}
                    />
                    {profitOutOfRange ? (
                      <p className="mt-1 text-xs text-destructive">
                        {profitMode === "margin"
                          ? "حاشیهٔ سود باید از ۰ تا کمتر از ۱۰۰ باشد."
                          : "نشانه‌گذاری باید از ۰ تا ۱۰٬۰۰۰ باشد."}
                      </p>
                    ) : null}
                  </Field>
                </div>
                {hasOverrides ? (
                  <Button type="button" variant="outline" size="sm" onClick={clearOverrides}>
                    پاک‌کردن مقدارهای اختصاصی
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
