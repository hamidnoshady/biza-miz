"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ACCOUNTING_WORKSPACE_HREFS, accountingProductsHref } from "@/lib/app-routes";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { EmptyState, KpiCard, KpiRow, SectionCard, SectionCardSkeleton, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, InfoBox } from "@/app/dashboard/ui";
import type { AccountingSectionKey } from "./accounting-routes";
import type { FiscalReadiness } from "@/lib/fiscal-readiness";
import { FiscalReadinessBanner } from "./fiscal-readiness-banner";

/**
 * The Accounting app's dashboard (Phase «حسابداری» home) — its «داشبورد».
 *
 * Every number is the ledger's own: the endpoint reads `journal_lines` the
 * same way the trial balance does, so this screen reports the books rather
 * than a second source that could drift from them. The quick actions jump to
 * the screen that acts on each number, the way the Growth and CRM work desks
 * do.
 */

interface LedgerOverview {
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
  journalEntryCount: number;
  journalLineCount: number;
  unbalancedEntryCount: number;
  invalidEntryCount: number;
  balanceDifference: number;
  cashAndBank: number;
  liquidity: { cash: number; bank: number; pettyCash: number };
  paymentClearing: number;
  receivables: number;
  otherReceivables: number;
  vatReceivable: number;
  payables: number;
  revenue: number;
  expenses: number;
  netIncome: number;
  openReceivableCheques: number;
  openPayableCheques: number;
  costCoverage: { uncostedLines: number; uncostedOrders: number; uncostedNetRial: number; provisional: boolean };
  scope: { period: "lifetime"; branches: "all"; asOf: string };
  recentEntries: {
    id: string;
    date: string;
    memo: string | null;
    sourceType: string | null;
    total: number;
  }[];
}

function LedgerHealthNotice({ overview }: { overview: LedgerOverview }) {
  const money = useMoney();

  if (overview.journalEntryCount === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="neutral">
          دفتر هنوز سند ثبت‌شده‌ای ندارد.
        </StatusBadge>
        <p className="text-xs leading-5 text-muted-foreground">
          {formatPersianNumber(overview.journalEntryCount)} سند و{" "}
          {formatPersianNumber(overview.journalLineCount)} ردیف ثبت شده است؛ صفر
          بودن بدهکار و بستانکار در دفتر خالی، توازن حسابداری محسوب نمی‌شود.
        </p>
      </div>
    );
  }

  if (overview.balanced) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="positive">
          دفتر متوازن است — {formatPersianNumber(overview.journalEntryCount)}{" "}
          سند و {formatPersianNumber(overview.journalLineCount)} ردیف کنترل شد.
        </StatusBadge>
        <p className="text-xs leading-5 text-muted-foreground">
          جمع بدهکار: {money.format(overview.totalDebit)}، جمع بستانکار:{" "}
          {money.format(overview.totalCredit)}
        </p>
      </div>
    );
  }

  const problemParts: string[] = [];
  if (overview.unbalancedEntryCount > 0) {
    problemParts.push(
      `${formatPersianNumber(overview.unbalancedEntryCount)} سند نامتوازن`,
    );
  }
  if (overview.invalidEntryCount > 0) {
    problemParts.push(
      `${formatPersianNumber(overview.invalidEntryCount)} سند ناقص`,
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge tone="danger">
        دفتر نامتوازن است — اسناد ثبت‌شده را بازبینی کنید.
      </StatusBadge>
      <p className="text-xs leading-5 text-muted-foreground">
        {formatPersianNumber(overview.journalEntryCount)} سند و{" "}
        {formatPersianNumber(overview.journalLineCount)} ردیف؛{" "}
        {problemParts.length > 0 ? `${problemParts.join("، ")}؛ ` : ""}
        جمع بدهکار: {money.format(overview.totalDebit)}، جمع بستانکار:{" "}
        {money.format(overview.totalCredit)}، اختلاف:{" "}
        {money.format(Math.abs(overview.balanceDifference))}
      </p>
    </div>
  );
}

interface ShiftSales {
  since: string;
  lastShiftEndedAt: string | null;
  hasOpenShift: boolean;
  summary: {
    orderCount: number;
    grossTotal: number;
    cashTotal: number;
    cardTotal: number;
    onlineTotal: number;
    creditTotal: number;
  };
}

/**
 * The quick report box at the top of the Accounting home: the branch's total
 * sales for the shift now in progress, with the per-method breakdown the
 * cash-up will reconcile against.
 *
 * The till's counter, not the books': it reads orders/payments through
 * `/api/ledger/shift-sales` and goes back to zero at every shift close —
 * `branchShiftSales` starts the window at the branch's most recent cash-up
 * (bounded by the business day), so «بستن شیفت» is what resets this number.
 */
function ShiftSalesQuickReport({ refreshKey }: { refreshKey: number }) {
  const money = useMoney();
  const [sales, setSales] = useState<ShiftSales | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api<{ shiftSales: ShiftSales | null }>("/api/ledger/shift-sales").then(
      ({ ok, data }) => {
        if (!cancelled) setSales(ok ? data.shiftSales : null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // No branch (or the read failed): the box simply is not there — the rest of
  // the dashboard is the ledger's and stands on its own.
  if (sales === null) return null;

  if (sales === undefined) {
    return (
      <SectionCardSkeleton rows={2} label="در حال بارگذاری فروش شیفت جاری" />
    );
  }

  const { summary } = sales;
  // A branch that has never clocked anybody in (a website-only shop, a
  // branch that skips shifts) has no "current shift": the window is the
  // business day, and saying «شیفت جاری» there is what audit F18 flagged.
  const usesShifts = sales.hasOpenShift || sales.lastShiftEndedAt !== null;
  const ordersHref = `${ACCOUNTING_WORKSPACE_HREFS.reports}?tab=shift-orders&shift=${usesShifts ? "latest" : "all"}`;
  const methods = [
    { label: "نقدی", value: summary.cashTotal },
    { label: "کارت", value: summary.cardTotal },
    { label: "آنلاین", value: summary.onlineTotal },
    { label: "نسیه", value: summary.creditTotal },
  ];

  return (
    <div className={`p-4 sm:p-5 ${cardClass}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            گزارش سریع
          </p>
          <h2 className="mt-1 text-base font-semibold text-foreground">
            {usesShifts ? "فروش شیفت جاری" : "فروش روز کاری جاری"}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            از {formatJalali(sales.since, { withTime: true })} — این شعبه، همهٔ کانال‌ها (صندوق و وب‌سایت)؛{" "}
            {usesShifts ? "با هر بستن شیفت صفر می‌شود." : "این شعبه شیفت ثبت نمی‌کند، پس بازه همان روز کاری است."}
          </p>
        </div>
        <StatusBadge tone={sales.hasOpenShift ? "active" : "neutral"}>
          {sales.hasOpenShift ? "شیفت باز است" : usesShifts ? "شیفت بازی نیست" : "بدون شیفت"}
        </StatusBadge>
      </div>

      <p className="mt-3 truncate text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {money.format(summary.grossTotal)}
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {formatPersianNumber(summary.orderCount)} سفارش تکمیل‌شده {usesShifts ? "در این شیفت" : "در این روز کاری"} ·{" "}
        <Link href={ordersHref} className="font-semibold text-amber-800 underline-offset-4 hover:underline dark:text-amber-300">
          دیدن سفارش‌ها
        </Link>
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/80 pt-3 sm:grid-cols-4">
        {methods.map((method) => (
          <div key={method.label} className="min-w-0">
            <dt className="text-xs font-medium leading-5 text-muted-foreground">
              {method.label}
            </dt>
            <dd className="truncate text-sm font-bold text-foreground">
              {money.format(method.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function LedgerDashboardSection({
  onGoToTab,
  refreshKey,
}: {
  onGoToTab: (key: AccountingSectionKey) => void;
  refreshKey: number;
}) {
  const money = useMoney();
  const [overview, setOverview] = useState<LedgerOverview | null>(null);
  const [error, setError] = useState("");
  const [readiness, setReadiness] = useState<FiscalReadiness | null>(null);

  const load = useCallback(() => {
    setError("");
    // Advisory (audit F08): a failed read shows no warning, never "ready".
    api<{ readiness: FiscalReadiness }>("/api/ledger/fiscal-readiness").then(
      ({ ok, data }) => setReadiness(ok ? data.readiness : null),
      () => setReadiness(null),
    );
    api<{ overview: LedgerOverview }>("/api/ledger/overview").then(
      ({ ok, data }) => {
        if (ok) setOverview(data.overview);
        else setError("بارگذاری داشبورد حسابداری ناموفق بود.");
      },
    );
  }, []);
  useEffect(load, [load, refreshKey]);

  if (!overview) {
    // The skeleton must not outlive a request that failed — the error box did
    // render, but underneath a spinner-shaped placeholder that never resolved.
    return (
      <>
        <ErrorBox>{error}</ErrorBox>
        {error ? null : (
          <SectionCardSkeleton
            rows={4}
            label="در حال بارگذاری داشبورد حسابداری"
          />
        )}
      </>
    );
  }

  const hasActivity = overview.journalEntryCount > 0;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      {/* First thing on the home: the shift's running total (resets at each close). */}
      <ShiftSalesQuickReport refreshKey={refreshKey} />

      {!hasActivity ? (
        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                شروع سریع
              </p>
              <h2 className="mt-1 text-base font-semibold text-foreground sm:text-lg">
                دفتر شما هنوز خالی است
              </h2>
            </div>
          }
          description="اولین سند را ثبت کنید تا تراز، دریافتی‌ها و پرداختی‌ها اینجا شکل بگیرند."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Button
              variant="outline"
              className="min-h-11 justify-start"
              onClick={() => onGoToTab("manual")}
            >
              ۱. اولین سند دستی را ثبت کن
            </Button>
            <Button
              variant="outline"
              className="min-h-11 justify-start"
              onClick={() => onGoToTab("chart-of-accounts")}
            >
              ۲. سرفصل حساب‌ها را بازبینی کن
            </Button>
            <Button
              variant="outline"
              className="min-h-11 justify-start"
              onClick={() => onGoToTab("fiscal-periods")}
            >
              ۳. دورهٔ مالی را تعریف کن
            </Button>
          </div>
        </SectionCard>
      ) : null}

      <LedgerHealthNotice overview={overview} />

      {hasActivity ? (
        <FiscalReadinessBanner
          readiness={readiness}
          action={
            <Button variant="outline" size="sm" className="min-h-11" onClick={() => onGoToTab("fiscal-periods")}>
              تعریف سال مالی در «دوره‌های مالی»
            </Button>
          }
        />
      ) : null}

      {overview.costCoverage.provisional ? (
        <InfoBox>
          <p className="font-semibold">سود نمایش‌داده‌شده موقت است.</p>
          <p className="mt-1 text-xs leading-5">
            {formatPersianNumber(overview.costCoverage.uncostedOrders)} سفارش آنلاین (
            {formatPersianNumber(overview.costCoverage.uncostedLines)} ردیف، فروش خالص{" "}
            {money.format(overview.costCoverage.uncostedNetRial)}) بدون بهای تمام‌شدهٔ ثبت‌شده فروخته شده‌اند؛ درآمد
            آن‌ها کامل ثبت شده ولی بهای تمام‌شدهٔ کالای فروش‌رفته نه. برای کامل شدن سود، بهای خرید کالاها را ثبت کنید.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-2 min-h-11">
            <Link href={accountingProductsHref("prices")}>ثبت بهای خرید کالاها</Link>
          </Button>
        </InfoBox>
      ) : null}

      <p className="text-xs leading-5 text-muted-foreground">
        مانده‌ها از ابتدای دفتر و برای همهٔ شعب، به‌روز تا {formatJalali(overview.scope.asOf, { withTime: true })}؛ مبالغ به{" "}
        {money.unitLabel}.
      </p>

      <KpiRow className="xl:grid-cols-3">
        <KpiCard
          label="نقدینگی قابل استفاده"
          value={money.format(overview.cashAndBank)}
          hint={`صندوق ${money.format(overview.liquidity.cash)} · بانک ${money.format(overview.liquidity.bank)} · تنخواه ${money.format(overview.liquidity.pettyCash)}`}
        />
        <KpiCard
          label="وجوه در راه (تسویه‌نشده)"
          value={money.format(overview.paymentClearing)}
          hint="کارت‌خوان، درگاه و پلتفرم‌های فروش؛ تا واریز به بانک قابل خرج نیست"
        />
        <KpiCard
          label="دریافتنی از مشتریان"
          value={money.format(overview.receivables)}
          hint={`${formatPersianNumber(overview.openReceivableCheques)} چک دریافتی باز${
            overview.vatReceivable || overview.otherReceivables
              ? ` · مالیات قابل استرداد و سایر: ${money.format(overview.vatReceivable + overview.otherReceivables)}`
              : ""
          }`}
        />
        <KpiCard
          label="پرداختنی‌ها"
          value={money.format(overview.payables)}
          hint={`${formatPersianNumber(overview.openPayableCheques)} چک صادرشدهٔ باز`}
        />
        <KpiCard label="درآمد" value={money.format(overview.revenue)} />
        <KpiCard label="هزینه‌ها" value={money.format(overview.expenses)} />
        <KpiCard
          label={overview.costCoverage.provisional ? "سود (زیان) خالص — موقت" : "سود (زیان) خالص"}
          value={money.format(overview.netIncome)}
          hint={overview.costCoverage.provisional ? "بهای تمام‌شدهٔ بخشی از فروش‌ها ثبت نشده است" : undefined}
        />
      </KpiRow>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              دسترسی سریع
            </p>
            <h2 className="mt-1 text-base font-semibold text-foreground">
              کارهای رایج
            </h2>
          </div>
        }
        description="از اینجا مستقیم به بخشی بروید که باید در آن کار کنید."
      >
        {/*
          The whole workspace, not only the ledger: «اشخاص» و «گزارش‌های مالی»
          are top-level areas of this app now, and a home screen whose shortcuts
          all pointed into «فضای کار حسابداری» was exactly what made Accounting
          read as a ledger tool. The rest of the business (فروش، خرید، انبار،
          محصولات) is in the app's sidebar, gated once by the shell.
        */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => onGoToTab("directory")}
          >
            اشخاص
          </Button>
          <Button
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => onGoToTab("receivables")}
          >
            حساب‌های دریافتنی
          </Button>
          <Button
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => onGoToTab("payables")}
          >
            حساب‌های پرداختنی
          </Button>
          <Button
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => onGoToTab("manual")}
          >
            ثبت سند دستی
          </Button>
          <Button
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => onGoToTab("entries")}
          >
            دفتر روزنامه
          </Button>
          <Button
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => onGoToTab("cheques")}
          >
            چک‌ها
          </Button>
          <Button
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => onGoToTab("reconciliation")}
          >
            تطبیق بانکی
          </Button>
          <Button
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => onGoToTab("financial-reports")}
          >
            گزارش‌های مالی
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              آخرین رویدادها
            </p>
            <h2 className="mt-1 text-base font-semibold text-foreground">
              اسناد اخیر
            </h2>
          </div>
        }
        description="پنج سند آخر ثبت‌شده، از جدیدترین."
      >
        {overview.recentEntries.length === 0 ? (
          <EmptyState>هنوز سندی ثبت نشده است.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80">
            {overview.recentEntries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
                  {entry.memo?.trim() || "سند بدون شرح"}
                  {/* What posted it — a fact the endpoint already returned and this
                      list dropped, leaving five look-alike rows. */}
                  <span className="ms-2 text-xs text-muted-foreground">
                    {ledgerSourceLabel(entry.sourceType)}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatJalali(entry.date)}
                </span>
                <span className="w-28 shrink-0 text-end text-sm font-bold text-foreground">
                  {money.format(entry.total)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="بازکردن دفتر روزنامه"
                  onClick={() => onGoToTab("entries")}
                >
                  <ArrowLeftIcon className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
