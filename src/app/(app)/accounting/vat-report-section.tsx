"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useMemo, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, SecondaryButton } from "@/app/dashboard/ui";
import { cardClass } from "@/app/dashboard/page-chrome";
import { formatJalali } from "@/lib/jalali";
import { useResourceState } from "@/app/dashboard/resource-state";

interface VatReport {
  periodFrom: string | null;
  periodTo: string | null;
  outputVat: number;
  inputVat: number;
  netPayable: number;
  vatPayableBalance: number;
  vatReceivableBalance: number;
}

function periodLabel(report: VatReport): string {
  const from = report.periodFrom ? formatJalali(report.periodFrom) : "ابتدا";
  const to = report.periodTo ? formatJalali(report.periodTo) : "امروز";
  return `از ${from} تا ${to}`;
}

/**
 * Output vs input VAT and the net payable position. Output VAT is
 * auto-posted (every order); input VAT is posted by a received purchase whose
 * supplier invoice carries VAT (audit F11), plus anything recorded by a manual
 * journal entry against "مالیات بر ارزش افزوده خرید" — this is a read-only
 * summary of both control accounts' movements, not a new place to enter
 * anything.
 *
 * Issue #909 §13/§3 — the period shown under the headline is the *server's*
 * `periodFrom`/`periodTo` echoed back on the report that is actually on
 * screen, never the date pickers' own live value. Those two can briefly
 * disagree — the user picks a new date, the request is still in flight — and
 * only the server's figure is the one the numbers below it actually describe
 * (the "committed scope"). This also gives the period a visible label at
 * all, which it previously had none despite the field existing in the API
 * response.
 */
export function VatReportSection({ refreshKey }: { refreshKey: number }) {
  const money = useMoney();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const scopeKey = useMemo(() => JSON.stringify({ dateFrom, dateTo }), [dateFrom, dateTo]);

  const { status, data: report, error, slow, retry } = useResourceState<VatReport>(
    scopeKey,
    async (signal, markSlow) => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const { ok, data, aborted } = await api<{ report: VatReport }>("/api/ledger/vat?" + params, {
        signal,
        onSlow: markSlow,
      });
      return { ok, data: data.report, aborted };
    },
    // `refreshKey` (bumped after posting a document elsewhere) forces a
    // same-scope reload — it must never register as a scope change, or the
    // figures on screen would blank out for a refresh that has nothing to
    // do with the selected dates.
    { describeError: () => "بارگذاری گزارش مالیات بر ارزش افزوده ناموفق بود.", refreshSignal: refreshKey },
  );

  const refreshing = status === "refreshing";
  const failedWithData = status === "refresh-failed";
  const failedWithoutData = status === "failed";

  return (
    <section aria-labelledby="vat-report-heading" className={cardClass}>
      <header className="border-b border-border/80 px-4 py-4 sm:px-5">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">گزارش مالی</p>
        <h2 id="vat-report-heading" className="mt-1 text-base font-semibold text-foreground">گزارش مالیات بر ارزش افزوده</h2>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
          مالیات ستاندهٔ فروش در برابر مالیات پرداختیِ ثبت‌شده برای بازه انتخاب‌شده.
        </p>
      </header>

      <div className="p-4 sm:p-5">
        <div className="grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end sm:p-4">
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
            <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از تاریخ" />
          </label>
          <span aria-hidden="true" className="hidden pb-3 text-sm text-muted-foreground sm:block">تا</span>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
            <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا تاریخ" />
          </label>
        </div>

        {failedWithoutData ? (
          <div className="mt-5 space-y-3">
            <ErrorBox>{error}</ErrorBox>
            <SecondaryButton onClick={retry}>تلاش دوباره</SecondaryButton>
          </div>
        ) : !report ? (
          <LoadingSkeleton
            rows={3}
            className="mt-5"
            label={slow ? "بارگذاری گزارش مالیات بر ارزش افزوده کمی طول کشیده…" : "در حال بارگذاری گزارش مالیات بر ارزش افزوده"}
          />
        ) : (
          <div className="mt-5 space-y-5" aria-busy={refreshing}>
            {failedWithData ? (
              <div className="space-y-2">
                <ErrorBox>{error}</ErrorBox>
                <SecondaryButton onClick={retry}>تلاش دوباره</SecondaryButton>
              </div>
            ) : refreshing ? (
              <p role="status" aria-live="polite" className="rounded-xl border border-border bg-muted/60 px-3 py-2.5 text-sm leading-6 text-muted-foreground">
                {slow ? "در حال به‌روزرسانی گزارش مالیات بر ارزش افزوده برای همین بازه (کمی طول کشیده)…" : "در حال به‌روزرسانی گزارش مالیات بر ارزش افزوده برای همین بازه…"}
              </p>
            ) : null}

            <p className="text-xs text-muted-foreground">دوره گزارش: {periodLabel(report)}</p>

            <div className="grid gap-3 sm:grid-cols-3">
              <article className="rounded-xl border border-border/80 bg-muted/60 p-4">
                <p className="text-sm text-muted-foreground">مالیات ستانده (فروش)</p>
                <p className="mt-2 text-xl font-bold tabular-nums text-foreground">{money.format(report.outputVat)}</p>
              </article>
              <article className="rounded-xl border border-border/80 bg-muted/60 p-4">
                <p className="text-sm text-muted-foreground">مالیات پرداختی (خرید)</p>
                <p className="mt-2 text-xl font-bold tabular-nums text-foreground">{money.format(report.inputVat)}</p>
              </article>
              <article className="rounded-xl border border-border/80 bg-muted/60 p-4">
                <p className="text-sm text-muted-foreground">
                  {report.netPayable >= 0 ? "خالص قابل پرداخت" : "خالص قابل استرداد"}
                </p>
                <p className={"mt-2 text-xl font-bold tabular-nums " + (report.netPayable >= 0 ? "text-foreground" : "text-emerald-700 dark:text-emerald-300")}>
                  {money.format(Math.abs(report.netPayable))}
                </p>
              </article>
            </div>

            <section aria-labelledby="vat-balance-heading" className="border-t border-border pt-5">
              <h3 id="vat-balance-heading" className="text-sm font-semibold text-foreground">مانده تجمعی حساب‌ها</h3>
              <p className="mt-1 text-xs text-muted-foreground">تا پایان بازه انتخاب‌شده</p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-border/80 bg-muted/60 p-4">
                  <dt className="text-sm text-muted-foreground">مالیات بر ارزش افزوده پرداختنی</dt>
                  <dd className="mt-2 text-lg font-bold tabular-nums text-foreground">{money.format(report.vatPayableBalance)}</dd>
                </div>
                <div className="rounded-xl border border-border/80 bg-muted/60 p-4">
                  <dt className="text-sm text-muted-foreground">مالیات بر ارزش افزوده خرید (قابل استرداد)</dt>
                  <dd className="mt-2 text-lg font-bold tabular-nums text-foreground">{money.format(report.vatReceivableBalance)}</dd>
                </div>
              </dl>
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
