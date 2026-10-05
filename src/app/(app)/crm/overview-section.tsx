"use client";

import { KpiRow, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The CRM app's management dashboard (Phase 36) — its «میز کار».
 *
 * Every number here comes from `/api/crm/overview`, which reads the same tables
 * the section screens write to and borrows the store-credit figure from the
 * ledger's own 2410 balance rather than recomputing it. The dashboard's job is
 * to make the state of the customer base legible at a glance and to be one tap
 * from the screen that acts on it.
 *
 * Two things it deliberately shows that a CRM usually hides:
 *
 * - **consent coverage**, next to the customer count. A base of 900 with 120
 *   reachable by SMS is the single most important fact about what marketing can
 *   actually do, and it is invisible until someone puts the two numbers side by
 *   side.
 * - **the accounting bridge**, naming account 2410 and the ledger's balance for
 *   it. The Growth app set that precedent: an app that touches money says which
 *   account it lands in, so the owner can check it against the books instead of
 *   trusting a marketing screen's arithmetic.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { LIFECYCLE_STAGES, type LifecycleStage } from "@/lib/crm-scoring";
import { DEAL_STAGE_META } from "@/lib/crm-shared";
import type { CrmOverview } from "@/lib/crm-overview";
import { EmptyState, KpiCard, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { crmCustomerHref, type CrmSectionKey } from "./crm-routes";
import { CrmCardHeading } from "./crm-card-heading";
import { CrmTodayQueues } from "./today-queues";

/** A labelled proportion bar — lifecycle mix and consent coverage both read better as a shape. */
function ShareBar({ parts }: { parts: { key: string; label: string; count: number; tone: string }[] }) {
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  if (total === 0) return null;
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
      {parts.map((part) => (
        <span
          key={part.key}
          className={part.tone}
          style={{ width: `${(part.count / total) * 100}%` }}
          title={`${part.label}: ${formatPersianNumber(part.count)}`}
        />
      ))}
    </div>
  );
}

const STAGE_TONES: Record<string, string> = {
  champion: "bg-emerald-500 dark:bg-emerald-500",
  loyal: "bg-emerald-400 dark:bg-emerald-600",
  potential_loyalist: "bg-teal-400 dark:bg-teal-600",
  new: "bg-sky-400 dark:bg-sky-600",
  promising: "bg-sky-300 dark:bg-sky-700",
  needs_attention: "bg-amber-400 dark:bg-amber-400",
  about_to_sleep: "bg-amber-300 dark:bg-amber-500/35",
  at_risk: "bg-orange-400 dark:bg-orange-500",
  cant_lose: "bg-rose-500 dark:bg-rose-500",
  hibernating: "bg-muted-foreground/30",
  lost: "bg-input",
  never_purchased: "bg-muted",
};

export function CrmOverviewSection({
  onGoToSection,
  canRecompute = false,
}: {
  onGoToSection: (key: CrmSectionKey) => void;
  /**
   * Whether this member may run the RFM job (`overview.write` in the section
   * table, `crm.manage` on the route). The button used to be drawn for everyone
   * who could open the page, so a member holding `crm.export` but not
   * `crm.manage` saw a control whose request answered 403 — see
   * `crm-permissions.ts`.
   */
  canRecompute?: boolean;
}) {
  const money = useMoney();
  const [overview, setOverview] = useState<CrmOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scoring, setScoring] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshing(true);
    setError("");
    const result = await api<{ overview?: CrmOverview }>("/api/crm/overview", {
      signal: controller.signal,
    });
    if (result.aborted) return;
    if (result.ok && result.data.overview) {
      setOverview(result.data.overview);
    } else {
      setError("بارگذاری میز کار ارتباط با مشتری ناموفق بود.");
    }
    setLoading(false);
    setRefreshing(false);
  }, []);
  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  /** Recomputing RFM is a whole-population job, so it is a button, not a page load. */
  const recompute = async () => {
    if (scoring) return;
    setScoring(true);
    setError("");
    const { ok } = await api("/api/crm/rfm", { method: "POST" });
    setScoring(false);
    if (ok) void load();
    else setError("محاسبهٔ امتیاز مشتریان ناموفق بود.");
  };

  if (loading && !overview) {
    return <SectionCardSkeleton rows={4} />;
  }

  if (!overview) {
    return (
      <div className="space-y-4">
        <ErrorBox>{error || "بارگذاری میز کار ارتباط با مشتری ناموفق بود."}</ErrorBox>
        <SectionCard
          title="بارگذاری میز کار"
          description="اطلاعات میز کار دریافت نشد. اتصال را بررسی کنید و دوباره تلاش کنید."
        >
          <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => void load()} disabled={refreshing}>
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            {refreshing ? "در حال تلاش…" : "تلاش دوباره"}
          </Button>
        </SectionCard>
      </div>
    );
  }

  const { customers, consent, value, pipeline, cases, tasks, retention, segments } = overview;
  const firstRun = customers.total === 0;
  const newTrend = customers.new30d - customers.newPrevious30d;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      {firstRun ? (
        <SectionCard
          title={
            <CrmCardHeading kicker="شروع سریع" title="شروع کار با پروندهٔ مشتریان" />
          }
          description="هنوز مشتری‌ای ثبت نشده است. سه قدم اول برنامهٔ ارتباط با مشتری:"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Button type="button" variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("directory")}>
              ۱. اولین مشتری را ثبت کن
            </Button>
            <Button type="button" variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("segments")}>
              ۲. یک بخش‌بندی بساز
            </Button>
            <Button type="button" variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("activities")}>
              ۳. اولین پیگیری را یادداشت کن
            </Button>
          </div>
        </SectionCard>
      ) : null}

      {/* The attention feed leads the page — see today-queues.tsx. Totals sit
          below it, because «چه کسی به توجه نیاز دارد» is the question somebody
          opens the CRM with. */}
      <CrmTodayQueues />

      <KpiRow className="xl:grid-cols-3">
        <KpiCard
          label="مشتریان فعال"
          value={formatPersianNumber(customers.total)}
          hint={`${formatPersianNumber(customers.neverPurchased)} هنوز خرید نکرده‌اند`}
        />
        <KpiCard
          label="مشتری تازه · ۳۰ روز گذشته"
          value={formatPersianNumber(customers.new30d)}
          hint={
            newTrend === 0
              ? "بدون تغییر نسبت به دورهٔ قبل"
              : newTrend > 0
                ? `${formatPersianNumber(newTrend)} بیشتر از دورهٔ قبل`
                : `${formatPersianNumber(Math.abs(newTrend))} کمتر از دورهٔ قبل`
          }
        />
        <KpiCard
          label="قابل ارسال پیامک"
          value={formatPersianNumber(consent.smsReachable)}
          hint={`${toPersianDigits(String(consent.smsCoveragePercent))}٪ از مشتریان · ${formatPersianNumber(consent.smsGranted)} رضایت داده‌اند`}
        />
        <KpiCard
          label="ارزش تحقق‌یافتهٔ مشتریان"
          value={money.formatText(value.totalHistoricRial)}
          hint={`میانگین هر مشتری ${money.formatText(value.averageCustomerRial)}`}
        />
        <KpiCard
          label="نگه‌داشت مشتری · دوره به دوره"
          value={retention.priorCount === 0 ? "—" : `${toPersianDigits(String(retention.retentionRate))}٪`}
          hint={
            retention.priorCount === 0
              ? "برای مقایسه هنوز مشتری‌ای در دورهٔ قبل ثبت نشده است"
              : `${formatPersianNumber(retention.retainedCount)} از ${formatPersianNumber(retention.priorCount)} مشتری دورهٔ قبل برگشتند`
          }
        />
        <KpiCard
          label="کارهای عقب‌افتاده"
          value={formatPersianNumber(tasks.overdue)}
          hint={`${formatPersianNumber(tasks.dueToday)} کار امروز · ${formatPersianNumber(tasks.open)} کار باز`}
        />
        <KpiCard
          label="بخش‌بندی‌های فعال"
          value={formatPersianNumber(segments.total)}
          hint={segments.total > 0 ? segments.names.slice(0, 2).join(" · ") : "برای هدف‌گیری مشتریان یک بخش بسازید"}
        />
      </KpiRow>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={
            <CrmCardHeading kicker="تحلیل رفتار (RFM)" title="چرخهٔ عمر مشتریان" />
          }
          description="بر پایهٔ تازگی، تکرار و مبلغ خرید (RFM)"
          actions={
            canRecompute ? (
              <Button type="button" variant="ghost" onClick={recompute} disabled={scoring} aria-busy={scoring} className="min-h-11">
                <RefreshCwIcon aria-hidden="true" className="size-3.5" />
                {scoring ? "در حال محاسبه…" : "محاسبهٔ دوباره"}
              </Button>
            ) : null
          }
        >
          {overview.lifecycle.length === 0 ? (
            <EmptyState>
              {canRecompute
                ? "هنوز امتیازی محاسبه نشده است. «محاسبهٔ دوباره» را بزنید تا مشتریان بر اساس رفتار خریدشان دسته‌بندی شوند."
                : "هنوز امتیاز چرخهٔ عمر محاسبه نشده است. از مالک یا مدیر بخواهید آن را محاسبه کند."}
            </EmptyState>
          ) : (
            <div className="space-y-3">
              <ShareBar
                parts={overview.lifecycle.map((row) => ({
                  key: row.stage,
                  label: LIFECYCLE_STAGES[row.stage as LifecycleStage]?.label ?? row.stage,
                  count: row.count,
                  tone: STAGE_TONES[row.stage] ?? "bg-input",
                }))}
              />
              <ul className="divide-y divide-border/80 text-sm">
                {overview.lifecycle.map((row) => {
                  const meta = LIFECYCLE_STAGES[row.stage as LifecycleStage];
                  return (
                    <li key={row.stage} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <span className="font-medium text-foreground">{meta?.label ?? row.stage}</span>
                        {meta?.action ? (
                          <span className="mr-2 text-xs text-muted-foreground">{meta.action}</span>
                        ) : null}
                      </div>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatPersianNumber(row.count)} نفر · {money.format(row.valueRial)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {overview.lastScoredAt ? (
                <p className="text-xs text-muted-foreground">
                  آخرین محاسبه: {toPersianDigits(formatJalali(overview.lastScoredAt))}
                </p>
              ) : null}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title={
            <CrmCardHeading kicker="معامله و فروش" title="قیف فروش" />
          }
          description="معامله‌های باز و ارزش وزنی آن‌ها"
          actions={
            <Button type="button" variant="ghost" onClick={() => onGoToSection("deals")} className="min-h-11">
              قیف کامل
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          {pipeline.openCount === 0 ? (
            <EmptyState>معاملهٔ بازی ثبت نشده است.</EmptyState>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">ارزش خام</p>
                  <p className="mt-1 font-semibold text-foreground">{money.formatText(pipeline.openValueRial)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">ارزش وزنی (بر پایهٔ احتمال)</p>
                  <p className="mt-1 font-semibold text-teal-700 dark:text-teal-300">{money.formatText(pipeline.weightedValueRial)}</p>
                </div>
              </div>
              <ul className="divide-y divide-border/80 text-sm">
                {pipeline.byStage.map((row) => (
                  <li key={row.stage} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0 font-medium text-foreground">
                      {DEAL_STAGE_META[row.stage]?.label ?? row.stage}
                    </span>
                    <span className="min-w-0 text-end tabular-nums text-muted-foreground">
                      {formatPersianNumber(row.count)} معامله · {money.formatText(row.valueRial)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            نرخ موفقیت {toPersianDigits(String(pipeline.winRatePercent))}٪ از معامله‌های تعیین‌تکلیف‌شده.
            درآمد از مسیر فاکتور ثبت می‌شود، نه از قیف فروش.
          </p>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={
            <CrmCardHeading kicker="عملکرد فروش" title="بهترین مشتریان" />
          }
          description="بیشترین خرید تحقق‌یافته"
          actions={
            <Button type="button" variant="ghost" size="icon-lg" onClick={() => void load()} aria-label="بازخوانی" disabled={refreshing} aria-busy={refreshing}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
          }
        >
          {overview.topCustomers.length === 0 ? (
            <EmptyState>هنوز خریدی به مشتری خاصی نسبت داده نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {overview.topCustomers.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <Link href={crmCustomerHref(row.id)} className="block truncate font-medium text-foreground hover:underline">
                      {row.name}
                    </Link>
                    <span className="mr-2 text-xs text-muted-foreground">
                      {formatPersianNumber(row.orderCount)} خرید
                    </span>
                  </div>
                  <span className="shrink-0 font-semibold text-emerald-700 dark:text-emerald-300">{money.formatText(row.totalSpentRial)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title={
            <CrmCardHeading kicker="میز خدمت" title="خدمات و رسیدگی" />
          }
          description="تیکت‌های باز و زمان رسیدگی"
          actions={
            <Button type="button" variant="ghost" onClick={() => onGoToSection("cases")} className="min-h-11">
              همهٔ تیکت‌ها
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">تیکت باز</p>
              <p className="mt-1 font-semibold text-foreground">{formatPersianNumber(cases.open)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">فوری</p>
              <p className="mt-1 font-semibold text-rose-700 dark:text-rose-300">{formatPersianNumber(cases.urgent)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">حل‌شده · ۳۰ روز</p>
              <p className="mt-1 font-semibold text-emerald-700 dark:text-emerald-300">{formatPersianNumber(cases.resolved30d)}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {cases.medianResolutionHours === null
              ? "در این دوره تیکتی حل نشده است."
              : `میانهٔ زمان رسیدگی: ${toPersianDigits(String(cases.medianResolutionHours))} ساعت.`}
          </p>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={
            <CrmCardHeading kicker="حریم و رضایت" title="رضایت ارتباط" />
          }
          description="چه سهمی از مشتریان واقعاً قابل پیام دادن‌اند"
          actions={
            <Button type="button" variant="ghost" onClick={() => onGoToSection("consent")} className="min-h-11">
              سابقهٔ رضایت
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          <ul className="divide-y divide-border/80 text-sm">
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-foreground">پیامک</span>
              <span className="min-w-0 text-end tabular-nums text-muted-foreground">
                {formatPersianNumber(consent.smsReachable)} قابل ارسال از {formatPersianNumber(consent.smsGranted)} رضایت
              </span>
            </li>
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-foreground">ایمیل</span>
              <span className="min-w-0 text-end tabular-nums text-muted-foreground">
                {formatPersianNumber(consent.emailReachable)} قابل ارسال از {formatPersianNumber(consent.emailGranted)} رضایت
              </span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            «رضایت» یعنی اجازه داده‌اند؛ «قابل ارسال» یعنی اجازه داده‌اند و شماره یا ایمیلشان هم ثبت است.
            بخش‌بندی همیشه عدد دوم را ملاک ارسال می‌گیرد.
          </p>
        </SectionCard>

        <SectionCard
          title={
            <CrmCardHeading kicker="دفاتر مالی" title="پل حسابداری" />
          }
          description="اعدادی که این برنامه با دفتر حساب‌ها مشترک دارد"
          actions={
            <Button type="button" variant="ghost" asChild className="min-h-11">
              <Link href="/accounting/overview">
                مشاهدهٔ دفتر
                <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
              </Link>
            </Button>
          }
        >
          <ul className="divide-y divide-border/80 text-sm">
            <li className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <span className="font-medium text-foreground">اعتبار فروشگاهی مشتریان</span>
                <span className="mr-2 text-xs text-muted-foreground">حساب ۲۴۱۰</span>
              </div>
              <span className="shrink-0 font-semibold text-foreground">{money.formatText(value.storeCreditRial)}</span>
            </li>
          </ul>
          <p className="mt-3 text-xs leading-6 text-muted-foreground">
            این عدد از دفتر روزنامه خوانده می‌شود، نه از این برنامه. مدیریت ارتباط با مشتری هیچ سند
            حسابداری ثبت نمی‌کند: ادغام دو مشتری، برنده‌شدن یک معامله و بستن یک تیکت هیچ‌کدام روی
            تراز آزمایشی اثر ندارند.
          </p>
        </SectionCard>
      </div>

      {overview.duplicates > 0 ? (
        <SectionCard
          title={
            <CrmCardHeading kicker="یکپارچه‌سازی" title="مشتریان تکراری" />
          }
          description="پرونده‌هایی که احتمالاً یک نفرند"
          actions={
            <Button type="button" variant="ghost" onClick={() => onGoToSection("duplicates")} className="min-h-11">
              بررسی و ادغام
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          <p className="text-sm leading-6 text-foreground/80">
            <StatusBadge tone="neutral">{formatPersianNumber(overview.duplicates)} مورد</StatusBadge>{" "}
            جفت پروندهٔ احتمالاً تکراری پیدا شد. ادغام برگشت‌ناپذیر است و فقط با تأیید شما انجام می‌شود.
          </p>
        </SectionCard>
      ) : null}
    </div>
  );
}
