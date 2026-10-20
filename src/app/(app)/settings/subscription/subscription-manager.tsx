"use client";

/**
 * Subscription management — `/settings/subscription` (P1: not just a catalogue).
 *
 * Full tenant subscription dashboard:
 * - Current plan, status, period dates, trial/grace, next charge, renewal source & flags
 * - Feature matrix + operational limits, allowances, paid addons
 * - Current-plan badge; no chargeable CTA for owned plan; explicit trial/free/retired states
 * - Quote preview with breakdown before purchase; stale-quote rejection
 * - Tenant-owned actions: cancel at period end, auto-renew toggle, reactivate
 * - Respects billing.view vs billing.manage; permission-checked server side
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircleIcon, CheckCircle2Icon, ClockIcon, SparklesIcon, ShieldCheckIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PLATFORM_BILLING_HREF } from "@/lib/app-routes";
import { SectionCard, SectionCardSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, api, errorMessage } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";

interface Plan {
  key: string;
  name: string;
  description: string | null;
  monthlyPriceRial: number | null;
  status?: string;
  branchLimit?: number | null;
  memberLimit?: number | null;
  monthlyOrderLimit?: number | null;
}
interface SubscriptionData {
  subscription: {
    planKey: string;
    planName: string;
    status: string;
    statusLabel: string;
    periodStart: string | null;
    periodEnd: string | null;
    trialEnd: string | null;
    trialStartedAt: string | null;
    graceEnd: string | null;
    autoRenew: boolean;
    cancelAtPeriodEnd: boolean;
    cancelledAt: string | null;
    nextChargeAt: string | null;
    renewalSource: string;
    willRenew: boolean;
  } | null;
  currentPlan: Plan | null;
  plans: Plan[];
  planFeatures: { featureKey: string; featureName: string | null; pricingModel: string; priceRial: number; freeUntil: string | null }[];
  entitlements: { featureKey: string; source: string; expiresAt: string | null }[];
  operationalLimits: { branches: number | null; members: number | null; monthlyOrders: number | null } | null;
  wallet: { balanceRial: number };
  quote: { totalRial: number; baseRial: number; addonsRial: number; taxRial: number } | null;
  canManage: boolean;
}
interface QuoteBreakdown {
  quoteId: string;
  totalRial: number;
  subtotalRial: number;
  taxRial: number;
  discountRial: number;
  lines: { kind: string; description: string; amountRial: number }[];
}

function toman(rial: number): string {
  return toPersianDigits((rial / 10).toLocaleString("en-US").replace(/,/g, "٬"));
}
function statusColor(status: string): string {
  if (status === "active") return "text-emerald-600 dark:text-emerald-400";
  if (status === "trialing") return "text-sky-600 dark:text-sky-400";
  if (status === "past_due") return "text-amber-600 dark:text-amber-400";
  if (status === "cancelled" || status === "expired") return "text-destructive";
  return "text-muted-foreground";
}

export function SubscriptionManager() {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [quoteFor, setQuoteFor] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteBreakdown | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<SubscriptionData>("/api/billing/subscription");
    if (res.ok) {
      setData(res.data);
      setLoadError(null);
    } else {
      setLoadError(errorMessage((res.data as { error?: string })?.error) || "بارگذاری اشتراک ممکن نشد");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function fetchQuote(planKey: string) {
    setError("");
    setInfo("");
    setBusy(`quote-${planKey}`);
    const res = await api<{ quoteId: string; totalRial: number; subtotalRial: number; taxRial: number; discountRial: number; lines: QuoteBreakdown["lines"] }>(
      "/api/billing/quote",
      { method: "POST", body: JSON.stringify({ kind: "plan", planKey }) },
    );
    setBusy(null);
    if (!res.ok) {
      setError(errorMessage((res.data as { error?: string })?.error));
      return;
    }
    setQuote({ quoteId: res.data.quoteId, totalRial: res.data.totalRial, subtotalRial: res.data.subtotalRial, taxRial: res.data.taxRial, discountRial: res.data.discountRial ?? 0, lines: res.data.lines ?? [] });
    setQuoteFor(planKey);
  }

  async function confirmPurchase(planKey: string) {
    if (!quote || quoteFor !== planKey) return;
    setError("");
    setBusy(planKey);
    const idempotencyKey = `${planKey}:${quote.totalRial}:${Date.now()}`;
    const res = await api<{ redirectUrl?: string | null; gateway?: string; error?: string; message?: string }>(
      "/api/billing/payments",
      { method: "POST", body: JSON.stringify({ kind: "plan", planKey, expectedAmountRial: quote.totalRial, quoteId: quote.quoteId, idempotencyKey }) },
    );
    if (!res.ok) {
      if ((res.data as { error?: string })?.error === "stale_quote") {
        setError("قیمت تغییر کرده است. لطفاً پیش‌نمایش را دوباره ببینید.");
        setQuote(null);
        setQuoteFor(null);
      } else if ((res.data as { error?: string })?.error === "already_subscribed") {
        setError("شما همین پلن را دارید. برای تمدید از مدیریت اشتراک استفاده کنید.");
      } else {
        setError((res.data as { message?: string })?.message ?? errorMessage((res.data as { error?: string })?.error));
      }
      setBusy(null);
      return;
    }
    if (res.data.redirectUrl) {
      window.location.assign(res.data.redirectUrl);
      return;
    }
    // Manual gateway: pending approval
    setInfo("درخواست خرید ثبت شد و پس از تأیید مدیر سامانه فعال می‌شود.");
    setBusy(null);
    setQuote(null);
    setQuoteFor(null);
    void load();
  }

  async function doAction(action: string, payload: Record<string, unknown> = {}) {
    setError("");
    setInfo("");
    setBusy(action);
    const res = await api("/api/billing/subscription", { method: "POST", body: JSON.stringify({ action, ...payload }) });
    setBusy(null);
    if (!res.ok) {
      setError(errorMessage((res.data as { error?: string })?.error));
      return;
    }
    setInfo(action === "cancel" ? "لغو اشتراک برای پایان دوره ثبت شد." : action === "reactivate" ? "اشتراک دوباره فعال شد." : "تغییر ذخیره شد.");
    void load();
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox>{loadError}</ErrorBox>
        <Button variant="secondary" onClick={() => void load()}>تلاش دوباره</Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label="در حال بارگذاری">
        <SectionCardSkeleton label="اشتراک فعلی" rows={3} />
        <SectionCardSkeleton label="طرح‌های اشتراک" rows={3} />
      </div>
    );
  }

  const sub = data.subscription;
  const isCurrentPlan = (key: string) => sub?.planKey === key;

  return (
    <div className="space-y-4" dir="rtl">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {info ? <InfoBox>{info}</InfoBox> : null}

      {/* Current plan card */}
      <SectionCard
        title="اشتراک فعلی"
        description={sub ? `طرح ${sub.planName} — وضعیت: ${sub.statusLabel}` : "شما هنوز اشتراک فعالی ندارید."}
      >
        {sub ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-sm font-semibold">
                <ShieldCheckIcon className="size-4" /> {sub.planName}
                <span className={cn("text-xs", statusColor(sub.status))}>({sub.statusLabel})</span>
              </span>
              {sub.willRenew ? <span className="text-xs text-emerald-600">تمدید خودکار فعال</span> : <span className="text-xs text-muted-foreground">تمدید خودکار غیرفعال</span>}
              {sub.cancelAtPeriodEnd ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">لغو در پایان دوره</span> : null}
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-muted-foreground">دورهٔ فعلی</dt><dd>{sub.periodStart ? formatJalali(sub.periodStart, { withMonthName: true }) : "—"} تا {sub.periodEnd ? formatJalali(sub.periodEnd, { withMonthName: true }) : "—"}</dd></div>
              {sub.trialEnd ? <div><dt className="text-muted-foreground">پایان دورهٔ آزمایشی</dt><dd>{formatJalali(sub.trialEnd, { withMonthName: true })}</dd></div> : null}
              {sub.graceEnd ? <div><dt className="text-muted-foreground">مهلت پرداخت</dt><dd>{formatJalali(sub.graceEnd, { withMonthName: true })}</dd></div> : null}
              <div><dt className="text-muted-foreground">شارژ بعدی</dt><dd>{sub.nextChargeAt ? formatJalali(sub.nextChargeAt, { withMonthName: true }) : "—"} {sub.willRenew ? `· ${toman(data.quote?.totalRial ?? 0)} تومان از کیف پول` : ""}</dd></div>
              <div><dt className="text-muted-foreground">منبع تمدید</dt><dd>کیف پول (برداشت خودکار) — خرید اولیه از درگاه</dd></div>
            </dl>

            {/* Operational limits & entitlements */}
            <div className="rounded-xl border p-3">
              <p className="text-sm font-semibold">محدودیت‌های عملیاتی و قابلیت‌ها</p>
              <ul className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                <li>شعبه‌ها: {data.operationalLimits?.branches == null ? "نامحدود" : toPersianDigits(String(data.operationalLimits?.branches))}</li>
                <li>اعضا: {data.operationalLimits?.members == null ? "نامحدود" : toPersianDigits(String(data.operationalLimits?.members))}</li>
                <li>سفارش ماهانه: {data.operationalLimits?.monthlyOrders == null ? "نامحدود" : toPersianDigits(String(data.operationalLimits?.monthlyOrders))}</li>
              </ul>
              {data.planFeatures.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs">
                  {data.planFeatures.slice(0, 8).map((f) => (
                    <li key={f.featureKey} className="flex items-center justify-between">
                      <span>{f.featureName ?? f.featureKey}</span><span className="text-muted-foreground">{f.pricingModel === "included" ? "شامل" : f.pricingModel === "monthly" ? `${toman(f.priceRial)} تومان/ماه` : f.pricingModel}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {data.entitlements.filter((e) => e.source === "addon" || e.source === "manual").length > 0 ? (
                <p className="mt-2 text-xs">افزونه‌های خریداری‌شده: {data.entitlements.filter((e) => e.source === "addon" || e.source === "manual").map((e) => e.featureKey).join("، ")}</p>
              ) : null}
            </div>

            {/* Tenant-owned actions */}
            {data.canManage ? (
              <div className="flex flex-wrap gap-2">
                {!sub.cancelAtPeriodEnd && sub.status === "active" ? <Button variant="secondary" disabled={busy !== null} onClick={() => { if (confirm("آیا از لغو در پایان دوره اطمینان دارید؟")) void doAction("cancel", { atPeriodEnd: true }); }}>لغو در پایان دوره</Button> : null}
                {sub.cancelAtPeriodEnd ? <Button variant="secondary" disabled={busy !== null} onClick={() => void doAction("reactivate")}>فعال‌سازی دوباره</Button> : null}
                <Button variant="secondary" disabled={busy !== null} onClick={() => void doAction("set_auto_renew", { autoRenew: !sub.autoRenew })}>{sub.autoRenew ? "غیرفعال‌سازی تمدید خودکار" : "فعال‌سازی تمدید خودکار"}</Button>
                {busy ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><ClockIcon className="size-4 animate-pulse" /> در حال انجام…</span> : null}
              </div>
            ) : <p className="text-xs text-muted-foreground">برای تغییر تنظیمات مالی به دسترسی «مدیریت صورت‌حساب» نیاز دارید.</p>}
          </div>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">اشتراکی فعال نیست. یکی از طرح‌های زیر را انتخاب کنید.</p>
        )}
      </SectionCard>

      {/* Plan catalogue */}
      <SectionCard
        title="طرح‌های اشتراک"
        description="طرح این کسب‌وکار در سطح پلتفرم تعیین می‌شود و روی همهٔ برنامه‌ها اثر دارد. قیمت‌ها شامل مالیات و افزونه‌های ماهانه است."
      >
        {data.plans.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">در حال حاضر طرحی برای فروش تعریف نشده است.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.plans.map((plan) => {
              const isCurrent = isCurrentPlan(plan.key);
              const retired = plan.status === "retired";
              const isFree = plan.monthlyPriceRial == null || plan.monthlyPriceRial === 0;
              return (
                <div key={plan.key} className={cn("flex flex-col p-4", cardClass, isCurrent ? "ring-2 ring-primary" : "")}>
                  <p className="flex items-center gap-2 font-bold">
                    <SparklesIcon aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
                    {plan.name}
                    {isCurrent ? <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">فعلی</span> : null}
                    {retired ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">بازنشسته</span> : null}
                    {isCurrent && sub?.status === "trialing" ? <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800">آزمایشی</span> : null}
                  </p>
                  {plan.description ? <p className="mt-1 text-xs text-muted-foreground">{plan.description}</p> : null}
                  <p className="mt-3 text-lg font-extrabold tabular-nums">
                    {isFree ? "رایگان" : `${toman(plan.monthlyPriceRial!)} تومان / ماهانه`}
                  </p>
                  {!isFree ? <p className="text-xs text-muted-foreground">+ افزونه‌های ماهانه و مالیات در پیش‌نمایش</p> : null}

                  {/* Quote preview area */}
                  {quoteFor === plan.key && quote ? (
                    <div className="mt-3 rounded-xl border bg-muted/20 p-3 text-xs">
                      <p className="font-semibold">پیش‌نمایش دقیق پرداخت</p>
                      <div className="mt-2 space-y-1">
                        {quote.lines.map((l, i) => (
                          <div key={i} className="flex justify-between"><span>{l.description}</span><span>{toman(l.amountRial)} تومان</span></div>
                        ))}
                        <div className="flex justify-between border-t pt-1 font-bold"><span>مبلغ نهایی</span><span>{toman(quote.totalRial)} تومان</span></div>
                        {quote.taxRial > 0 ? <p className="text-muted-foreground">شامل {toman(quote.taxRial)} تومان مالیات</p> : null}
                        <p className="text-muted-foreground">دورهٔ بعدی همین مبلغ از کیف پول کسر می‌شود.</p>
                      </div>
                      <div className="mt-3 flex gap-2">
                        <Button size="sm" disabled={!data.canManage || busy !== null} onClick={() => void confirmPurchase(plan.key)}>تأیید و پرداخت</Button>
                        <Button size="sm" variant="secondary" onClick={() => { setQuote(null); setQuoteFor(null); }}>لغو</Button>
                      </div>
                    </div>
                  ) : null}

                  {/* CTA */}
                  <div className="mt-3">
                    {isCurrent ? (
                      <div className="flex flex-col gap-1">
                        <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2Icon className="size-4" /> همین پلن فعلی شما</span>
                        <Button variant="secondary" className="w-full" disabled={!data.canManage} onClick={() => void fetchQuote(plan.key)}>{busy === `quote-${plan.key}` ? "…در حال دریافت قیمت" : "تمدید / مشاهدهٔ جزئیات پرداخت"}</Button>
                      </div>
                    ) : retired ? (
                      <Button disabled className="w-full">غیر قابل خرید (بازنشسته)</Button>
                    ) : (
                      <Button
                        variant="secondary"
                        className="w-full"
                        disabled={!data.canManage || busy !== null}
                        onClick={() => void fetchQuote(plan.key)}
                      >
                        {busy === `quote-${plan.key}` ? "…در حال دریافت قیمت" : isFree ? "انتخاب پلن رایگان" : "مشاهدهٔ قیمت و خرید"}
                      </Button>
                    )}
                    {!data.canManage ? <p className="mt-1 text-xs text-muted-foreground">نیاز به مجوز مدیریت مالی</p> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard title="اعتبار و پرداخت‌ها">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm leading-6 text-muted-foreground">
            خرید اولیهٔ اشتراک از درگاه پرداخت انجام می‌شود؛ تمدیدهای بعدی به‌صورت خودکار از کیف پول کسر می‌گردد. شارژ اعتبار و تاریخچهٔ پرداخت‌ها در صفحهٔ صورت‌حساب است.
          </p>
          <Button variant="secondary" asChild><Link href={PLATFORM_BILLING_HREF}>صورت‌حساب پلتفرم</Link></Button>
        </div>
      </SectionCard>
    </div>
  );
}
