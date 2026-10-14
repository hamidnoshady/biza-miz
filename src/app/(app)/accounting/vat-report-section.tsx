"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useRef, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { cardClass } from "@/app/dashboard/page-chrome";

interface VatReport {
  periodFrom: string | null;
  periodTo: string | null;
  outputVat: number;
  inputVat: number;
  netPayable: number;
  vatPayableBalance: number;
  vatReceivableBalance: number;
}

/**
 * Output vs input VAT and the net payable position. Output VAT is
 * auto-posted (every order); input VAT is posted by a received purchase whose
 * supplier invoice carries VAT (audit F11), plus anything recorded by a manual
 * journal entry against "مالیات بر ارزش افزوده خرید" — this is a read-only
 * summary of both control accounts' movements, not a new place to enter
 * anything.
 */
export function VatReportSection({ refreshKey }: { refreshKey: number }) {
  const money = useMoney();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [report, setReport] = useState<VatReport | null>(null);
  const [error, setError] = useState("");
  // Two date picks in quick succession start overlapping fetches; the guard
  // keeps a slow earlier response from overwriting the newer period's numbers.
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    setError("");
    api<{ report: VatReport }>("/api/ledger/vat?" + params).then(({ ok, data }) => {
      if (seq !== requestSeq.current) return;
      if (ok) setReport(data.report);
      // Otherwise the skeleton outlives the request and reads as "still loading".
      else setError("بارگذاری گزارش مالیات بر ارزش افزوده ناموفق بود.");
    });
  }, [dateFrom, dateTo, refreshKey]);

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

        {error ? (
          <div className="mt-5">
            <ErrorBox>{error}</ErrorBox>
          </div>
        ) : !report ? (
          <LoadingSkeleton rows={3} className="mt-5" />
        ) : (
          <div className="mt-5 space-y-5">
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
