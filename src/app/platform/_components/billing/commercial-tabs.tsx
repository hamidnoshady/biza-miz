"use client";

/**
 * Meters, spend limits, commercial rules and read-only quote preview calculator.
 */
import { useEffect, useState } from "react";
import { usePlatformQuery } from "../../_lib/use-platform-data";
import { Button, Card, EmptyState, ErrorBox, Field, InfoBox, inputClass, SkeletonRows } from "../../ui";
import {
  formatRial,
  parseOptionalSafeIntInput,
  parseSafeIntInput,
  parseThresholdsInput,
  tomanLabel,
} from "@/lib/platform-money";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { platformFetch } from "@/lib/platform-client";

interface MeterRow {
  key: string;
  name: string;
  unit: string;
  aggregation: string;
  source: string;
  customerVisible: boolean;
  critical: boolean;
  price: { version: number; unitAmountRial: number; unitSize?: number; unit: string; effectiveFrom?: string } | null;
}

export function BillingMetersTab() {
  const query = usePlatformQuery<{ meters: MeterRow[] }>("/api/platform/billing/meters");
  if (query.loading) return <SkeletonRows rows={6} />;
  if (query.errorText) return <ErrorBox>{query.errorText}</ErrorBox>;
  const meters = query.data?.meters ?? [];
  if (meters.length === 0) return <EmptyState title="کنتوری ثبت نشده است" />;
  return (
    <Card title="کنتورها و نسخهٔ قیمت فعال">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-2 text-right font-medium">نام</th>
              <th className="py-2 text-right font-medium">کلید</th>
              <th className="py-2 text-right font-medium">واحد</th>
              <th className="py-2 text-right font-medium">تجمیع</th>
              <th className="py-2 text-right font-medium">نسخهٔ قیمت</th>
              <th className="py-2 text-left font-medium">قیمت باز</th>
            </tr>
          </thead>
          <tbody>
            {meters.map((meter) => (
              <tr key={meter.key} className="border-t border-border">
                <td className="py-2 text-foreground">{meter.name}</td>
                <td className="py-2 font-mono text-xs text-muted-foreground" dir="ltr">
                  {meter.key}
                </td>
                <td className="py-2 text-muted-foreground" dir="ltr">
                  {meter.unit}
                </td>
                <td className="py-2 text-muted-foreground">{meter.aggregation}</td>
                <td className="py-2 text-xs text-muted-foreground">
                  {meter.price ? `نسخهٔ ${toPersianDigits(meter.price.version)}` : "—"}
                </td>
                <td className="py-2 text-left tabular-nums text-foreground">
                  {meter.price
                    ? `${formatRial(meter.price.unitAmountRial)}${
                        (meter.price.unitSize ?? 1) > 1
                          ? ` / ${toPersianDigits(meter.price.unitSize ?? 1)} ${meter.price.unit}`
                          : ""
                      }`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

interface QuotePreviewResult {
  kind: string;
  subtotalRial: number;
  taxRateBps: number;
  taxRial: number;
  totalRial: number;
  rounding: "ceil" | "floor";
  minimumTopUpRial: number;
  belowMinimumTopUp: boolean;
  creditGrantedRial?: number;
  lines: Array<{
    lineType: string;
    description: string;
    quantity: number;
    unitAmountRial: number;
    amountRial: number;
    priceVersionId: string | null;
  }>;
}

export function BillingRulesTab() {
  const query = usePlatformQuery<{ settings: Record<string, unknown> }>("/api/platform/billing/settings");
  const [invoicePrefix, setInvoicePrefix] = useState("");
  const [dueDays, setDueDays] = useState("");
  const [graceDays, setGraceDays] = useState("");
  const [rounding, setRounding] = useState<"ceil" | "floor">("ceil");
  const [minTopUp, setMinTopUp] = useState("");
  const [overagePolicy, setOveragePolicy] = useState<"charge" | "block">("charge");
  const [defaultSpendAction, setDefaultSpendAction] = useState("warn_only");
  const [taxRateBps, setTaxRateBps] = useState("");
  const [footer, setFooter] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const settings = query.data?.settings;
  useEffect(() => {
    if (!settings) return;
    setInvoicePrefix(String(settings.invoice_prefix ?? "INV"));
    setDueDays(String(settings.default_due_days ?? 7));
    setGraceDays(String(settings.default_grace_days ?? 3));
    setRounding(settings.rounding === "floor" ? "floor" : "ceil");
    setMinTopUp(String(settings.minimum_top_up_rial ?? 100000));
    setOveragePolicy(settings.overage_policy === "block" ? "block" : "charge");
    setDefaultSpendAction(String(settings.default_spend_action ?? "warn_only"));
    setTaxRateBps(String(settings.tax_rate_bps ?? 0));
    setFooter(String(settings.invoice_footer ?? ""));
  }, [settings]);

  if (query.loading) return <SkeletonRows rows={4} />;
  if (query.errorText) return <ErrorBox>{query.errorText}</ErrorBox>;

  return (
    <div className="space-y-4">
      <Card title="قواعد تجاری و صورت‌حساب">
        <ErrorBox>{error}</ErrorBox>
        {message && <InfoBox>{message}</InfoBox>}
        <form
          className="mt-2 space-y-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            setMessage("");
            const parsedDue = parseSafeIntInput(dueDays, { min: 0, max: 365 });
            const parsedGrace = parseSafeIntInput(graceDays, { min: 0, max: 365 });
            const parsedMinTopUp = parseSafeIntInput(minTopUp, { min: 0 });
            const parsedTax = parseSafeIntInput(taxRateBps, { min: 0, max: 10000 });
            if (
              parsedDue === null ||
              parsedGrace === null ||
              parsedMinTopUp === null ||
              parsedTax === null
            ) {
              setError("مقادیر عددی قواعد تجاری معتبر نیستند.");
              return;
            }
            void platformFetch("/api/platform/billing/settings", {
              method: "PUT",
              body: {
                invoicePrefix: invoicePrefix.trim() || "INV",
                defaultDueDays: parsedDue,
                defaultGraceDays: parsedGrace,
                rounding,
                minimumTopUpRial: parsedMinTopUp,
                overagePolicy,
                defaultSpendAction,
                taxRateBps: parsedTax,
                invoiceFooter: footer,
              },
            }).then((result) => {
              if (result.ok) {
                setMessage("قواعد تجاری ذخیره شد.");
                query.refetch();
              } else {
                setError("ذخیرهٔ قواعد تجاری انجام نشد.");
              }
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="پیشوند فاکتور">
              <input
                className={inputClass}
                dir="ltr"
                value={invoicePrefix}
                onChange={(e) => setInvoicePrefix(e.target.value)}
              />
            </Field>
            <Field label="مهلت پرداخت (روز)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={dueDays}
                onChange={(e) => setDueDays(e.target.value)}
              />
            </Field>
            <Field label="مهلت ارفاق (روز)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={graceDays}
                onChange={(e) => setGraceDays(e.target.value)}
              />
            </Field>
            <Field label="گرد کردن مبالغ">
              <select
                className={inputClass}
                value={rounding}
                onChange={(e) => setRounding(e.target.value === "floor" ? "floor" : "ceil")}
              >
                <option value="ceil">رو به بالا (ceil)</option>
                <option value="floor">رو به پایین (floor)</option>
              </select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="حداقل شارژ دلخواه (ریال)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={minTopUp}
                onChange={(e) => setMinTopUp(e.target.value)}
              />
            </Field>
            <Field label="مالیات (ده‌هزارم — مثلاً ۹۰۰ = ۹٪)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={taxRateBps}
                onChange={(e) => setTaxRateBps(e.target.value)}
              />
            </Field>
            <Field label="سیاست اضافه‌مصرف">
              <select
                className={inputClass}
                value={overagePolicy}
                onChange={(e) => setOveragePolicy(e.target.value === "block" ? "block" : "charge")}
              >
                <option value="charge">کسر هزینه (charge)</option>
                <option value="block">توقف (block)</option>
              </select>
            </Field>
            <Field label="عمل پیش‌فرض سقف هزینه">
              <select
                className={inputClass}
                value={defaultSpendAction}
                onChange={(e) => setDefaultSpendAction(e.target.value)}
              >
                <option value="continue">ادامه</option>
                <option value="warn_only">فقط هشدار</option>
                <option value="block_noncritical">توقف کارهای غیرحیاتی</option>
                <option value="throttle_noncritical">کند کردن کارهای غیرحیاتی</option>
              </select>
            </Field>
          </div>

          <Field label="متن پایین فاکتور">
            <textarea
              className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-sm text-foreground"
              rows={2}
              value={footer}
              onChange={(event) => setFooter(event.target.value)}
            />
          </Field>

          <Button type="submit">ذخیرهٔ قواعد تجاری</Button>
        </form>
      </Card>

      <CommercialQuotePreviewCard />
    </div>
  );
}

function CommercialQuotePreviewCard() {
  const [kind, setKind] = useState<"custom_top_up" | "plan_subscription" | "meter_usage">("custom_top_up");
  const [amountRial, setAmountRial] = useState("500000");
  const [planKey, setPlanKey] = useState("pro");
  const [meterKey, setMeterKey] = useState("messaging.sms_segment");
  const [quantity, setQuantity] = useState("100");
  const [quote, setQuote] = useState<QuotePreviewResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function runPreview() {
    setError("");
    const body: Record<string, unknown> = { kind };
    if (kind === "custom_top_up") {
      const parsed = parseSafeIntInput(amountRial, { min: 0 });
      if (parsed === null) {
        setError("مبلغ شارژ باید یک عدد صحیح معتبر باشد.");
        return;
      }
      body.amountRial = parsed;
    } else if (kind === "plan_subscription") {
      body.planKey = planKey.trim();
    } else if (kind === "meter_usage") {
      const parsedQty = parseSafeIntInput(quantity, { min: 0 });
      if (parsedQty === null) {
        setError("مقدار مصرف باید یک عدد صحیح معتبر باشد.");
        return;
      }
      body.meterKey = meterKey.trim();
      body.quantity = parsedQty;
    }

    setLoading(true);
    const res = await platformFetch<{ quote?: QuotePreviewResult; error?: string }>(
      "/api/platform/billing/settings",
      {
        method: "POST",
        body,
      },
    );
    setLoading(false);
    if (res.ok && res.data?.quote) {
      setQuote(res.data.quote);
    } else {
      setError("محاسبهٔ پیش‌نمایش انجام نشد.");
    }
  }

  return (
    <Card title="محاسبه‌گر پیش‌نمایش قیمت و مالیات (بدون تغییر داده)">
      <p className="mb-3 text-xs text-muted-foreground">
        این ابزار دقیقاً از موتور قیمت‌گذاری و قواعد تجاریِ تولید (مالیات، گرد کردن، حداقل شارژ و نسخهٔ قیمت باز) برای شبیه‌سازی مبلغ نهایی استفاده می‌کند.
      </p>
      <ErrorBox>{error}</ErrorBox>
      <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <Field label="نوع تراکنش">
          <select
            className={inputClass}
            value={kind}
            onChange={(e) =>
              setKind(e.target.value as "custom_top_up" | "plan_subscription" | "meter_usage")
            }
          >
            <option value="custom_top_up">شارژ دلخواه کیف پول</option>
            <option value="plan_subscription">اشتراک ماهانهٔ پلن</option>
            <option value="meter_usage">مصرف کنتور</option>
          </select>
        </Field>

        {kind === "custom_top_up" && (
          <Field label="مبلغ پایهٔ شارژ (ریال)">
            <PersianNumberInput
              className={inputClass}
              inputMode="numeric"
              value={amountRial}
              onChange={(e) => setAmountRial(e.target.value)}
            />
          </Field>
        )}

        {kind === "plan_subscription" && (
          <Field label="کلید پلن (مثلاً pro)">
            <input
              className={inputClass}
              dir="ltr"
              value={planKey}
              onChange={(e) => setPlanKey(e.target.value)}
            />
          </Field>
        )}

        {kind === "meter_usage" && (
          <>
            <Field label="کلید کنتور">
              <input
                className={inputClass}
                dir="ltr"
                value={meterKey}
                onChange={(e) => setMeterKey(e.target.value)}
              />
            </Field>
            <Field label="مقدار مصرف">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Field>
          </>
        )}

        <Button type="button" onClick={() => void runPreview()} disabled={loading}>
          {loading ? "در حال محاسبه…" : "محاسبهٔ پیش‌نمایش"}
        </Button>
      </div>

      {quote && (
        <div className="mt-4 space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
          {quote.belowMinimumTopUp && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              مبلغ واردشده کمتر از حداقل شارژ مجاز ({tomanLabel(quote.minimumTopUpRial)}) است و در درگاه رد خواهد شد.
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-4">
            <Setting label="جمع پایه" value={tomanLabel(quote.subtotalRial)} />
            <Setting
              label={`مالیات (${toPersianDigits(quote.taxRateBps)} ده‌هزارم)`}
              value={tomanLabel(quote.taxRial)}
            />
            <Setting label="گرد کردن" value={quote.rounding === "floor" ? "floor" : "ceil"} />
            <Setting label="مبلغ قابل پرداخت" value={tomanLabel(quote.totalRial)} />
          </div>
        </div>
      )}
    </Card>
  );
}

interface SpendListPayload {
  policies?: Array<{
    businessId: string;
    businessName?: string;
    monthlyBudgetRial: number | null;
    thresholds: number[];
    actionAtLimit: string;
    lastWarningThreshold: number | null;
    lastWarningAt: string | null;
    throttledAt: string | null;
    spentRial: number;
    evaluation: {
      percent: number | null;
      crossedThresholds: number[];
      warned: boolean;
      blocked: boolean;
      throttled: boolean;
    };
  }>;
  businesses?: Array<{ id: string; name: string; planKey: string }>;
}

interface SingleSpendPayload {
  policy: {
    businessId: string;
    monthlyBudgetRial: number | null;
    thresholds: number[];
    actionAtLimit: string;
  } | null;
  spend?: {
    breakdown: {
      periodMonth: string;
      walletUsageDebitsRial: number;
      spendRefundsRial: number;
      allowanceUsedRial: number;
      aiDebtIncurredRial: number;
      totalSpendRial: number;
    };
    evaluation: {
      percent: number | null;
      crossedThresholds: number[];
      warned: boolean;
      blocked: boolean;
      throttled: boolean;
    };
  };
}

export function BillingSpendTab() {
  const listQuery = usePlatformQuery<SpendListPayload>("/api/platform/billing/spend");
  const [businessId, setBusinessId] = useState("");
  const [budget, setBudget] = useState("");
  const [thresholds, setThresholds] = useState("50, 75, 90, 100");
  const [action, setAction] = useState("warn_only");
  const [currentSpend, setCurrentSpend] = useState<SingleSpendPayload["spend"] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!businessId.trim()) {
      setCurrentSpend(null);
      return;
    }
    void platformFetch<SingleSpendPayload>(
      `/api/platform/billing/spend?businessId=${encodeURIComponent(businessId.trim())}`,
    ).then((res) => {
      if (res.ok && res.data) {
        if (res.data.policy) {
          setBudget(
            res.data.policy.monthlyBudgetRial == null
              ? ""
              : String(res.data.policy.monthlyBudgetRial),
          );
          setAction(res.data.policy.actionAtLimit);
          setThresholds((res.data.policy.thresholds ?? [50, 75, 90, 100]).join(", "));
        } else {
          setBudget("");
          setAction("warn_only");
          setThresholds("50, 75, 90, 100");
        }
        setCurrentSpend(res.data.spend ?? null);
      }
    });
  }, [businessId]);

  const businesses = listQuery.data?.businesses ?? [];
  const policies = listQuery.data?.policies ?? [];

  return (
    <div className="space-y-4">
      <Card title="سقف هزینهٔ ماهانهٔ کسب‌وکار">
        <ErrorBox>{error}</ErrorBox>
        {message && <InfoBox>{message}</InfoBox>}
        <form
          className="space-y-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            setMessage("");
            if (!businessId.trim()) {
              setError("لطفاً یک کسب‌وکار را انتخاب یا شناسهٔ آن را وارد کنید.");
              return;
            }
            const parsedBudget = parseOptionalSafeIntInput(budget, { min: 0 });
            if (!parsedBudget.ok) {
              setError("بودجهٔ ماهانه باید یک عدد صحیح صفر یا بزرگ‌تر باشد.");
              return;
            }
            const parsedThresholds = parseThresholdsInput(thresholds);
            if (parsedThresholds === null) {
              setError("آستانه‌های هشدار باید اعداد بین ۱ تا ۱۰۰ (جداشده با ویرگول) باشند.");
              return;
            }
            void platformFetch<SingleSpendPayload>("/api/platform/billing/spend", {
              method: "PUT",
              body: {
                businessId: businessId.trim(),
                monthlyBudgetRial: parsedBudget.value,
                thresholds: parsedThresholds,
                actionAtLimit: action,
              },
            }).then((result) => {
              if (result.ok) {
                setMessage("سیاست سقف هزینه ذخیره شد.");
                if (result.data?.spend) setCurrentSpend(result.data.spend);
                listQuery.refetch();
              } else {
                setError("ذخیرهٔ سیاست سقف هزینه انجام نشد.");
              }
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="انتخاب کسب‌وکار">
              <select
                className={inputClass}
                value={businessId}
                onChange={(e) => setBusinessId(e.target.value)}
              >
                <option value="">— انتخاب از فهرست کسب‌وکارها —</option>
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.planKey})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="شناسهٔ کسب‌وکار (UUID)">
              <input
                className={`${inputClass} font-mono text-xs`}
                dir="ltr"
                value={businessId}
                onChange={(event) => setBusinessId(event.target.value)}
                required
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="بودجهٔ ماهانه (ریال — خالی = بدون سقف)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                placeholder="مثلاً ۱۰٬۰۰۰٬۰۰۰"
              />
            </Field>
            <Field label="آستانه‌های هشدار (٪)">
              <input
                className={inputClass}
                dir="ltr"
                value={thresholds}
                onChange={(e) => setThresholds(e.target.value)}
                placeholder="50, 75, 90, 100"
              />
            </Field>
            <Field label="عمل در رسیدن به سقف">
              <select
                className={inputClass}
                value={action}
                onChange={(event) => setAction(event.target.value)}
              >
                <option value="continue">ادامه</option>
                <option value="warn_only">فقط هشدار</option>
                <option value="block_noncritical">توقف کارهای غیرحیاتی</option>
                <option value="throttle_noncritical">کند کردن کارهای غیرحیاتی</option>
              </select>
            </Field>
          </div>

          {currentSpend && (
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <div className="mb-2 font-medium text-foreground">
                مصرف خالص ماه جاری (مرز ماه تهران): {tomanLabel(currentSpend.breakdown.totalSpendRial)}
                {currentSpend.evaluation.percent != null && (
                  <span className="mr-2 text-muted-foreground">
                    ({toPersianDigits(currentSpend.evaluation.percent)}٪ از بودجه)
                  </span>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <Setting
                  label="کسر از کیف پول"
                  value={tomanLabel(currentSpend.breakdown.walletUsageDebitsRial)}
                />
                <Setting
                  label="برگشت وجه پیام"
                  value={tomanLabel(currentSpend.breakdown.spendRefundsRial)}
                />
                <Setting
                  label="سهمیهٔ پلن مصرف‌شده"
                  value={tomanLabel(currentSpend.breakdown.allowanceUsedRial)}
                />
                <Setting
                  label="بدهی هوش مصنوعی ماه"
                  value={tomanLabel(currentSpend.breakdown.aiDebtIncurredRial)}
                />
              </div>
            </div>
          )}

          <Button type="submit">ذخیرهٔ سیاست سقف هزینه</Button>
        </form>
      </Card>

      {policies.length > 0 && (
        <Card title="سیاست‌های سقف هزینهٔ ثبت‌شده">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-2 text-right font-medium">کسب‌وکار</th>
                  <th className="py-2 text-right font-medium">بودجهٔ ماهانه</th>
                  <th className="py-2 text-right font-medium">مصرف ماه جاری</th>
                  <th className="py-2 text-right font-medium">عمل در سقف</th>
                  <th className="py-2 text-right font-medium">آخرین هشدار</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr
                    key={p.businessId}
                    className="cursor-pointer border-t border-border hover:bg-muted/40"
                    onClick={() => setBusinessId(p.businessId)}
                  >
                    <td className="py-2 font-medium text-foreground">
                      {p.businessName ?? p.businessId}
                    </td>
                    <td className="py-2 tabular-nums text-foreground">
                      {p.monthlyBudgetRial == null ? "بدون سقف" : tomanLabel(p.monthlyBudgetRial)}
                    </td>
                    <td className="py-2 tabular-nums text-foreground">
                      {tomanLabel(p.spentRial)}
                      {p.evaluation.percent != null && (
                        <span className="mr-1 text-xs text-muted-foreground">
                          ({toPersianDigits(p.evaluation.percent)}٪)
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{p.actionAtLimit}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {p.lastWarningThreshold != null
                        ? `${toPersianDigits(p.lastWarningThreshold)}٪ (${
                            p.lastWarningAt
                              ? formatJalali(p.lastWarningAt, { withMonthName: true, withTime: true })
                              : "—"
                          })`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground" dir="ltr">
        {value || "—"}
      </dd>
    </div>
  );
}
