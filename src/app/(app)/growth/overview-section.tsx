"use client";

/**
 * The Growth app's management dashboard (Phase 36b) — its «داشبورد».
 *
 * Every number here is read from the same tables the section screens write
 * to, and every balance is the ledger's own (the bridge card reconstructs
 * them from journal lines, exactly like the trial balance). The dashboard's
 * one job is to make the state of marketing legible at a glance and to be one
 * tap away from the screen that acts on it — hence quick actions that jump
 * between sections.
 *
 * The bridge card *shows* the four accounts the app posts to and deliberately
 * does not link into حسابداری: the Growth app owns no accounting navigation
 * (`growth-app-nav.tsx` lists only its own sections, and
 * `growth-accounting-view.tsx` is accounting's read of this same data). It is
 * here so the owner can tie the marketing numbers to the books, not so the
 * app grows a second door into the ledger.
 *
 * Three failure modes this screen is written against, all of them bugs it
 * used to have:
 *
 *  - **A failed load must not be an eternal skeleton.** The error banner lived
 *    inside the loaded branch, so a 500 or a dropped connection left the
 *    skeleton pulsing forever with nothing said and nothing to press. A failed
 *    read now renders its own message and a «تلاش دوباره».
 *  - **A refresh must say it is working, and must clear the last error.** The
 *    icon button fired a fetch with no busy state and no way to recover the
 *    banner once it had appeared.
 *  - **A number nobody can act on must not be printed as fact.** «آمادهٔ خرید
 *    مجدد» is a per-branch prediction; with no branch in context the answer is
 *    «شعبه‌ای انتخاب نشده», not a confident «۰».
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { WELL_KNOWN_CODES } from "@/lib/coa-template";
import type { GrowthOverview } from "@/lib/growth-overview";
import { growthRecommendations, type RecommendationTone } from "@/lib/growth-recommendations";
import { discountBudgetUsage } from "@/lib/growth-settings";
// The campaign life-cycle vocabulary (states, their Persian labels and their
// badge tones) is `growth-shared.ts`'s, not this screen's. The private copies
// that used to live here disagreed with the campaigns list about which tone a
// running campaign wears, so one campaign changed colour between two screens.
import {
  CAMPAIGN_STATES,
  CAMPAIGN_STATE_LABELS,
  CAMPAIGN_STATE_TONES,
} from "@/lib/growth-shared";
import {
  CardTitle,
  EmptyState,
  KpiCard,
  KpiRow,
  KpiRowSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api } from "@/app/dashboard/ui";
import type { GrowthSectionKey } from "./growth-routes";

const ACTIVITY_KIND_LABELS: Record<string, string> = {
  campaign: "کمپین",
  points: "وفاداری",
  gift_card: "کارت هدیه",
  commission: "پورسانت",
};

/** What each bridge account *is*, in the app's own words — a code alone means nothing to an owner. */
const BRIDGE_HINTS: Record<string, string> = {
  [WELL_KNOWN_CODES.salariesPayable]: "پورسانت تعهدشده به فروشندگان، تا زمان پرداخت حقوق",
  [WELL_KNOWN_CODES.storeCreditPayable]: "اعتباری که مشتریان از بازخرید امتیاز در اختیار دارند",
  [WELL_KNOWN_CODES.giftCardPayable]: "مانده کارت‌های هدیهٔ فروخته‌شده و خرج‌نشده",
  [WELL_KNOWN_CODES.commissionExpense]: "هزینهٔ پورسانت ثبت‌شده در دفاتر",
};

/**
 * «تلاش دوباره» for a failed read — the shape ar-/ap-section established. A
 * failed request is not an empty dashboard: printing zeros would claim
 * knowledge nobody has, and a banner alone leaves the retry to a page refresh.
 */
function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-6 text-center">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      <div className="mt-3 flex justify-center">
        <Button type="button" variant="outline" className="px-4" onClick={onRetry}>
          تلاش دوباره
        </Button>
      </div>
    </div>
  );
}

const RECOMMENDATION_TONES: Record<RecommendationTone, "danger" | "active" | "neutral"> = {
  warning: "danger",
  opportunity: "active",
  setup: "neutral",
};
const RECOMMENDATION_LABELS: Record<RecommendationTone, string> = {
  warning: "هشدار",
  opportunity: "فرصت",
  setup: "راه‌اندازی",
};

export function OverviewSection({
  onGoToSection,
  canOpenSection,
}: {
  onGoToSection: (key: GrowthSectionKey) => void;
  /** The member's own section gate, so a suggestion never leads to a redirect. */
  canOpenSection: (key: GrowthSectionKey) => boolean;
}) {
  const money = useMoney();
  const [overview, setOverview] = useState<GrowthOverview | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // One in-flight read at a time: a second «بازخوانی» must cancel the first,
  // or a slow response can land after a fast one and show older numbers.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshing(true);
    const { ok, data, aborted } = await api<{ overview: GrowthOverview }>("/api/growth/overview", {
      signal: controller.signal,
    });
    // A superseded request must not touch state — neither the spinner it no
    // longer owns nor an error it was never asked about.
    if (aborted) return;
    if (ok) {
      setOverview(data.overview);
      // A successful read clears the previous failure; leaving the banner up
      // over fresh numbers is how a screen ends up contradicting itself.
      setError("");
    } else {
      setError("بارگذاری میز کار رشد ناموفق بود.");
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
    return () => inFlight.current?.abort();
  }, [load]);

  if (!overview) {
    // Before the first successful read there is nothing to refresh over, so a
    // failure is the whole screen — not a banner above a skeleton that will
    // never resolve.
    if (error) return <LoadFailed message={error} onRetry={() => void load()} />;
    return (
      <div className="space-y-4 sm:space-y-5">
        {/*
          The skeleton must reserve the grid the loaded page actually uses —
          `KpiRowSkeleton`'s default is a four-column row, so six tiles landing
          in a three-column grid made the whole page jump on first paint.
        */}
        <KpiRowSkeleton
          count={6}
          className="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3"
          label="در حال بارگذاری نشانگرهای رشد"
        />
        <SectionCardSkeleton rows={4} label="در حال بارگذاری میز کار رشد" />
      </div>
    );
  }

  const commission = overview.commission;
  const storeCredit =
    overview.bridge.find((row) => row.code === WELL_KNOWN_CODES.storeCreditPayable)?.balance ?? 0;
  const firstRun = overview.campaigns.list.length === 0 && overview.loyalty.programs === 0;
  const budget = discountBudgetUsage(overview.campaigns.discountRial, overview.campaigns.discountBudgetRial);
  // «قدم بعدی» (issue #764): plain rules over the figures above, filtered to
  // what this member may open. The first-run card already covers set-up.
  const recommendations = firstRun
    ? []
    : growthRecommendations(
        {
          hasLocation: overview.hasLocation,
          liveCampaigns: overview.campaigns.counts.live,
          scheduledCampaigns: overview.campaigns.counts.scheduled,
          loyaltyPrograms: overview.loyalty.programs,
          repurchaseDue: overview.repurchase.due,
          customersTotal: overview.loyalty.customersTotal,
          customersWithPoints: overview.loyalty.customersWithPoints,
          discountRial: overview.campaigns.discountRial,
          discountBudgetRial: overview.campaigns.discountBudgetRial,
        },
        canOpenSection,
      );
  const windowLabel = `${toPersianDigits(formatJalali(overview.window.from))} تا ${toPersianDigits(
    formatJalali(overview.window.to),
  )}`;

  return (
    <div className="space-y-4 sm:space-y-5">
      {/*
        One toolbar for the whole dashboard. «بازخوانی» used to sit on the
        activity card alone, which read as though it refreshed that list only —
        it always reloaded every number on the page.
      */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs leading-5 text-muted-foreground">
          بازهٔ گزارش: <span className="font-medium text-foreground">{windowLabel}</span> (۳۰ روز
          گذشته)
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          <RefreshCwIcon aria-hidden="true" className="size-4" />
          {refreshing ? "در حال بازخوانی…" : "بازخوانی"}
        </Button>
      </div>

      {/*
        A refresh that failed keeps the last good numbers on screen — they are
        still the truth as of the last read — and says so above them, with the
        retry the toolbar button already provides.
      */}
      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          {error} اعداد زیر مربوط به آخرین بازخوانی موفق است.
        </p>
      ) : null}

      {recommendations.length > 0 ? (
        <SectionCard
          title={<CardTitle eyebrow="قدم بعدی" title="پیشنهادهای امروز" />}
          description="از روی همین اعداد؛ هر پیشنهاد به بخشی می‌رود که کارش را انجام می‌دهد."
        >
          <ul className="divide-y divide-border/80">
            {recommendations.map((recommendation) => (
              <li key={recommendation.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium leading-6 text-foreground">
                    <StatusBadge tone={RECOMMENDATION_TONES[recommendation.tone]}>
                      {RECOMMENDATION_LABELS[recommendation.tone]}
                    </StatusBadge>
                    <span className="min-w-0 break-words">{recommendation.title}</span>
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{recommendation.detail}</p>
                </div>
                <Button
                  variant="outline"
                  className="min-h-11 w-full shrink-0 sm:w-auto"
                  onClick={() => onGoToSection(recommendation.section)}
                >
                  {recommendation.action}
                  <ArrowLeftIcon aria-hidden="true" className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {firstRun ? (
        <SectionCard
          title={<CardTitle eyebrow="شروع سریع" title="شروع برنامهٔ رشد" />}
          description="سه قدم کوچک برای شروع برنامهٔ رشد و بازاریابی."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("campaigns")}>
              ۱. اولین کمپین تخفیف را بساز
            </Button>
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("loyalty")}>
              ۲. برنامهٔ وفاداری را تعریف کن
            </Button>
            {overview.commission ? (
              <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("commission")}>
                ۳. پورسانت فروشندگان را فعال کن
              </Button>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {/*
        Six tiles: two columns from `sm`, three from `lg`. The old
        `xl:grid-cols-3` left a 1024–1279px laptop — the most common desktop
        width in the field — showing a two-column column of six, twice as tall
        as it needed to be.
      */}
      <KpiRow className="lg:grid-cols-3 xl:grid-cols-3">
        <KpiCard
          label="تخفیف کمپین‌ها · ۳۰ روز گذشته"
          value={money.format(overview.campaigns.discountRial)}
          hint={`${formatPersianNumber(overview.campaigns.applications)} بار اعمال روی فروش · ${formatPersianNumber(overview.campaigns.counts.live)} کمپین در حال اجرا${
            budget
              ? ` · ${formatPersianNumber(budget.percent)}٪ سقف ${money.format(overview.campaigns.discountBudgetRial ?? 0)}${budget.exceeded ? " (عبور از سقف)" : ""}`
              : ""
          }`}
        />
        <KpiCard
          label={`بدهی کارت هدیه (${toPersianDigits(WELL_KNOWN_CODES.giftCardPayable)})`}
          value={money.format(overview.giftCards.outstandingRial)}
          hint={`${formatPersianNumber(overview.giftCards.issued30d)} کارت به ارزش ${money.format(overview.giftCards.issuedValue30d)} در ۳۰ روز گذشته صادر شد`}
        />
        <KpiCard
          label={`اعتبار فروشگاهی مشتریان (${toPersianDigits(WELL_KNOWN_CODES.storeCreditPayable)})`}
          value={money.format(storeCredit)}
          hint={`${formatPersianNumber(overview.loyalty.customersWithPoints)} مشتری از ${formatPersianNumber(overview.loyalty.customersTotal)} امتیاز مصرف‌نشده دارد`}
        />
        {/* Compensation: present only when the server sent it (commission.view). */}
        {overview.commission ? (
          <KpiCard
            label="پورسانت فروشندگان · ۳۰ روز گذشته"
            value={money.format(overview.commission.accrued30d)}
            hint={`هزینه ${toPersianDigits(WELL_KNOWN_CODES.commissionExpense)}، بدهی حقوق ${toPersianDigits(WELL_KNOWN_CODES.salariesPayable)}`}
          />
        ) : null}
        <KpiCard
          label="امتیاز در گردش"
          value={formatPersianNumber(overview.loyalty.pointsOutstanding)}
          hint={`ارزش تخمینی بازخرید ${money.format(overview.loyalty.pointsValueEstimate)} · ${formatPersianNumber(overview.loyalty.earned30d)} کسب و ${formatPersianNumber(overview.loyalty.redeemed30d)} خرج‌شده در ۳۰ روز`}
        />
        <KpiCard
          label="آمادهٔ خرید مجدد (این شعبه)"
          // Without a branch in context this figure was never computed; «۰» would
          // be a claim, not an answer.
          value={overview.hasLocation ? formatPersianNumber(overview.repurchase.due) : "—"}
          hint={
            overview.hasLocation
              ? "مشتریانی که موعد خرید دوباره‌شان گذشته است"
              : "شعبه‌ای در دسترس نیست؛ این پیش‌بینی برای هر شعبه جداگانه محاسبه می‌شود."
          }
        />
      </KpiRow>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={<CardTitle eyebrow="کمپین‌های تخفیف" title="برترین کمپین‌ها" />}
          description="بیشترین تخفیف مصرف‌شده در ۳۰ روز گذشته"
          actions={
            <Button variant="ghost" size="xs" onClick={() => onGoToSection("campaigns")}>
              همهٔ کمپین‌ها
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          {overview.campaigns.top.length === 0 ? (
            <EmptyState>هنوز کمپینی روی فروشی اعمال نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {overview.campaigns.top.map((row) => (
                <li key={row.promotionId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    {/*
                      `block` + `truncate`: an inline span cannot truncate, so a
                      long campaign name used to push the amount off the card on
                      a narrow screen instead of being cut.
                    */}
                    <span className="block truncate font-medium text-foreground">{row.promotionName}</span>
                    {/* Logical margin: `mr-2` is a *right* margin, which is the leading edge in RTL. */}
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {formatPersianNumber(row.applications)} بار اعمال
                    </span>
                  </div>
                  <span className="shrink-0 font-semibold text-amber-700 dark:text-amber-300">
                    {money.format(row.discountRial)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {commission ? (
          <SectionCard
            title={<CardTitle eyebrow="پورسانت فروش" title="برترین فروشندگان" />}
            description="پورسانت انباشته در ۳۰ روز گذشته"
            actions={
              <Button variant="ghost" size="xs" onClick={() => onGoToSection("commission")}>
                رتبه‌بندی کامل
                <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
              </Button>
            }
          >
            {commission.top.length === 0 ? (
              <EmptyState>هنوز پورسانتی ثبت نشده است.</EmptyState>
            ) : (
              <ul className="divide-y divide-border/80 text-sm">
                {commission.top.map((row) => (
                  <li key={row.employeeId} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0 truncate font-medium text-foreground">{row.employeeName}</span>
                    <span className="shrink-0 font-semibold text-emerald-700 dark:text-emerald-300">
                      {money.format(row.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/*
          The campaign list was read from the API and thrown away, and the four
          state labels were declared and never rendered — so «۲ کمپین در حال
          اجرا» in the KPI hint was the only thing the dashboard ever said about
          what is actually running.
        */}
        <SectionCard
          title={<CardTitle eyebrow="چرخهٔ عمر کمپین" title="وضعیت کمپین‌ها" />}
          description="در حال اجرا، زمان‌بندی‌شده، متوقف و پایان‌یافته"
          actions={
            <Button variant="ghost" size="xs" onClick={() => onGoToSection("campaigns")}>
              مدیریت کمپین‌ها
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          {overview.campaigns.list.length === 0 ? (
            <EmptyState>هنوز کمپینی تعریف نشده است.</EmptyState>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {/* The shared ordered list, not a fifth copy of the four keys. */}
                {CAMPAIGN_STATES.map((state) => (
                  <span key={state} className="text-xs text-muted-foreground">
                    <StatusBadge tone={CAMPAIGN_STATE_TONES[state]}>
                      {CAMPAIGN_STATE_LABELS[state]} {formatPersianNumber(overview.campaigns.counts[state])}
                    </StatusBadge>
                  </span>
                ))}
              </div>
              <ul className="divide-y divide-border/80 text-sm">
                {overview.campaigns.list.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{row.name}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {row.activeFrom || row.activeTo
                          ? `${row.activeFrom ? toPersianDigits(formatJalali(row.activeFrom)) : "بدون شروع"} — ${
                              row.activeTo ? toPersianDigits(formatJalali(row.activeTo)) : "بدون پایان"
                            }`
                          : "بدون بازهٔ زمانی"}
                      </span>
                    </div>
                    {/*
                      `row.state` is a `CampaignState`, so both lookups are
                      total — the `?? "neutral"` / `?? row.state` fallbacks that
                      used to sit here were unreachable, and the second one
                      would have printed a raw English token if it ever ran.
                    */}
                    <StatusBadge tone={CAMPAIGN_STATE_TONES[row.state]}>
                      {CAMPAIGN_STATE_LABELS[row.state]}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </>
          )}
        </SectionCard>

        <SectionCard
          title={<CardTitle eyebrow="رویدادهای سیستم" title="آخرین رویدادهای رشد" />}
          description="جریان یکپارچهٔ چهار موتور: کمپین، امتیاز، کارت هدیه و پورسانت"
        >
          {overview.activity.length === 0 ? (
            <EmptyState>هنوز رویدادی ثبت نشده است؛ اولین فروش با کمپین یا امتیاز، اینجا ظاهر می‌شود.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {overview.activity.map((row, index) => (
                // `justify-between` over a single child did nothing; the row is
                // one block of text and reads as one.
                <li key={`${row.at}-${index}`} className="min-w-0 py-2.5">
                  <p className="leading-6 text-foreground">{activityText(row, money.format)}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <StatusBadge tone="neutral">{ACTIVITY_KIND_LABELS[row.kind] ?? row.kind}</StatusBadge>
                    <span>{toPersianDigits(formatJalali(row.at, { withTime: true }))}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/*
          The customers the branch predicts are due back. The API already
          returned this sample and nothing rendered it, so the KPI's count had
          no screen behind it.
        */}
        <SectionCard
          title={<CardTitle eyebrow="نگه‌داشت مشتری" title="آمادهٔ خرید مجدد" />}
          description="پیش‌بینی بر پایهٔ فاصلهٔ خریدهای گذشتهٔ همین شعبه"
          actions={
            <Button variant="ghost" size="xs" onClick={() => onGoToSection("loyalty")}>
              وفاداری و اعتبار
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          {!overview.hasLocation ? (
            <EmptyState>
              شعبه‌ای در دسترس نیست؛ این پیش‌بینی برای هر شعبه جداگانه محاسبه می‌شود.
            </EmptyState>
          ) : overview.repurchase.sample.length === 0 ? (
            <EmptyState>فعلاً مشتری‌ای موعد خرید دوباره‌اش نرسیده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {overview.repurchase.sample.map((row) => (
                <li
                  key={`${row.customerId}-${row.productId}`}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{row.customerName}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {row.productName} · هر {formatPersianNumber(Math.round(row.avgIntervalDays))} روز
                    </span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {toPersianDigits(formatJalali(row.predictedDate))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/*
          The bridge: the four ledger accounts this app posts to, with the
          balances reconstructed from journal lines. Read-only and unlinked on
          purpose — Growth owns no accounting navigation (see the file header).
        */}
        <SectionCard
          title={<CardTitle eyebrow="اتصال به حسابداری" title="مانده حساب‌های مرتبط" />}
          description="مانده‌ها از دفتر روزنامه بازسازی می‌شود — همان روشی که تراز آزمایشی به کار می‌برد."
        >
          {overview.bridge.length === 0 ? (
            <EmptyState>
              هنوز حساب‌های مرتبط با رشد در سرفصل‌ها ساخته نشده‌اند.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {overview.bridge.map((row) => (
                <li key={row.code} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {toPersianDigits(row.code)} · {row.name}
                    </span>
                    {BRIDGE_HINTS[row.code] ? (
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        {BRIDGE_HINTS[row.code]}
                      </span>
                    ) : null}
                  </div>
                  {/*
                    A negative balance is a real answer (an over-redeemed
                    liability), and it must not read like a healthy one.
                  */}
                  <span
                    className={`shrink-0 font-semibold ${
                      row.balance < 0 ? "text-destructive" : "text-foreground"
                    }`}
                  >
                    {money.format(row.balance)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/** One activity row, as one Persian sentence — the feed reads like a log, not a table. */
function activityText(
  row: GrowthOverview["activity"][number],
  formatMoney: (value: number) => string,
): string {
  switch (row.kind) {
    case "campaign":
      return `کمپین «${row.subject}» ${formatMoney(row.amount)} تخفیف داد.`;
    case "gift_card":
      return `کارت هدیه ${toPersianDigits(row.subject)} به ارزش ${formatMoney(row.amount)} صادر شد.`;
    case "commission":
      // A return reverses an accrual with a negative amount; «ثبت شد» over a
      // negative figure reads as a payment that was made.
      return row.amount < 0
        ? `پورسانت ${formatMoney(Math.abs(row.amount))} برای ${row.subject} برگشت خورد.`
        : `پورسانت ${formatMoney(row.amount)} برای ${row.subject} ثبت شد.`;
    case "points":
      return row.amount < 0
        ? `${row.subject} ${formatPersianNumber(Math.abs(row.amount))} امتیاز به اعتبار فروشگاهی تبدیل کرد.`
        : `${row.subject} ${formatPersianNumber(row.amount)} امتیاز گرفت.`;
    default:
      return row.subject;
  }
}
