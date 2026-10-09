"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { overlayPanelClass } from "@/app/dashboard/page-chrome";
import { OverlayDialog } from "./ledger-ui";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";

interface AccountStatementLine {
  entryId: string;
  date: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
  balance: number;
}

interface AccountStatement {
  accountCode: string;
  accountName: string;
  normalBalance: "debit" | "credit";
  openingBalance: number;
  lines: AccountStatementLine[];
  closingBalance: number;
}

/**
 * One account's دفتر معین/گردش حساب — opening balance, every movement in
 * the picked range with a running balance, closing balance. Reached from
 * the chart-of-accounts tab (Phase 22 Wave 5, issue #160 §7.3) — the
 * per-report drill-down panel shows a flat list for one figure; this is a
 * browsable statement for one account.
 */
export function AccountStatementPanel({
  accountId,
  accountCode,
  accountName,
  onClose,
}: {
  accountId: string;
  accountCode: string;
  accountName: string;
  onClose: () => void;
}) {
  const money = useMoney();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statement, setStatement] = useState<AccountStatement | null>(null);
  const [error, setError] = useState("");
  // Monotonic request token: increments for every effect run so a late response
  // from a superseded request cannot overwrite newer state even if AbortController
  // somehow fails to cancel the body stream (review item 3).
  const requestTokenRef = useRef(0);

  // Both pickers hand back ISO YYYY-MM-DD, so this comparison is chronological.
  const rangeInvalid = dateFrom !== "" && dateTo !== "" && dateFrom > dateTo;

  useEffect(() => {
    setStatement(null);
    // A reversed range used to round-trip to the server and come back as a
    // confusingly «empty» statement; name the mistake instead of fetching it.
    if (rangeInvalid) {
      setError("");
      return;
    }
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    setError("");

    // Stale-response guard (issue #824 §12 + review item 3):
    //
    //   * Monotonic request token guards against the A-then-B-then-A-out-of-order
    //     race even if abort somehow fails; the signal is the primary guard.
    //   * AbortController cancels the previous fetch when the effect re-runs or
    //     the panel unmounts.
    //   * The `api` helper now reports `aborted: true` if abort fires between
    //     headers and body or during JSON parsing (it previously swallowed that
    //     into {} and returned ok).
    //   * We also check `signal.aborted` directly right before every state write,
    //     so even a surprise path that forgot to propagate aborted cannot
    //     install stale data.
    const controller = new AbortController();
    const token = ++requestTokenRef.current;
    void api<AccountStatement>(`/api/ledger/accounts/${accountId}/statement?${params}`, {
      signal: controller.signal,
    }).then(({ ok, data, aborted }) => {
      if (controller.signal.aborted || aborted || token !== requestTokenRef.current) return;
      if (ok) setStatement(data);
      else setError("بارگذاری گردش این حساب ناموفق بود.");
    });
    return () => {
      controller.abort();
    };
  }, [accountId, dateFrom, dateTo, rangeInvalid]);

  return (
    <OverlayDialog
      headingId="account-statement-heading"
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[88vh] w-full max-w-3xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
    >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">گردش حساب (دفتر معین)</p>
            <h3 id="account-statement-heading" className="mt-1 text-lg font-bold">
              <span dir="ltr">{accountCode}</span> — {accountName}
            </h3>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            بستن
          </Button>
        </header>

        <div className="grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end sm:p-4">
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
            <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از ابتدا" />
          </label>
          <span aria-hidden="true" className="hidden pb-3 text-sm text-muted-foreground sm:block">تا</span>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
            <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا امروز" />
          </label>
        </div>

        {rangeInvalid ? (
          <p role="alert" className="mt-4 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            «از تاریخ» باید قبل از «تا تاریخ» باشد؛ بازه را اصلاح کنید.
          </p>
        ) : error ? (
          <p role="alert" className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : statement === null ? (
          <LoadingSkeleton rows={3} />
        ) : (
          <div className="mt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-muted/60 px-4 py-3 text-sm">
              <span className="text-muted-foreground">مانده افتتاحیه</span>
              <span className="font-semibold tabular-nums text-foreground">{money.format(statement.openingBalance)}</span>
            </div>

            {statement.lines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                در این بازه هیچ سندی به این حساب ثبت نشده است.
              </p>
            ) : (
              <>
                <DataTable
                  caption="گردش این حساب در بازه انتخاب‌شده"
                  className="hidden lg:block"
                  tableClassName="min-w-[700px]"
                >
                  <DataTableHead>
                    <Th>تاریخ</Th>
                    <Th>شرح</Th>
                    <Th numeric>بدهکار</Th>
                    <Th numeric>بستانکار</Th>
                    <Th numeric>مانده</Th>
                  </DataTableHead>
                  <DataTableBody>
                    {/* An entry can post two lines to the same account, so the
                        entry id alone is not a unique key. */}
                    {statement.lines.map((l, i) => (
                      <DataTableRow key={`${l.entryId}-${i}`}>
                        <Td muted nowrap>{toPersianDigits(formatJalali(l.date))}</Td>
                        <Td>
                          {l.memo ?? "—"}
                          {/* `sourceType` was fetched and then dropped; naming what
                              posted a line is most of what makes a معین readable. */}
                          <span className="ms-2 text-xs text-muted-foreground">{ledgerSourceLabel(l.sourceType)}</span>
                        </Td>
                        <Td numeric nowrap>{l.debit ? money.format(l.debit) : "—"}</Td>
                        <Td numeric nowrap>{l.credit ? money.format(l.credit) : "—"}</Td>
                        <Td numeric nowrap className="font-semibold">{money.format(l.balance)}</Td>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>

                <div className="space-y-3 lg:hidden">
                  {statement.lines.map((l, i) => (
                    <article key={`${l.entryId}-${i}`} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.date))}</p>
                      </div>
                      <h4 className="mt-1 font-semibold text-foreground">{l.memo ?? "—"}</h4>
                      <p className="mt-0.5 text-xs text-muted-foreground">{ledgerSourceLabel(l.sourceType)}</p>
                      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-sm">
                        <div>
                          <dt className="text-xs text-muted-foreground">بدهکار</dt>
                          <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums text-foreground">{l.debit ? money.format(l.debit) : "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">بستانکار</dt>
                          <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums text-foreground">{l.credit ? money.format(l.credit) : "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">مانده</dt>
                          <dd className="mt-1 whitespace-nowrap font-bold tabular-nums text-foreground">{money.format(l.balance)}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              </>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-muted/60 px-4 py-3 text-sm">
              <span className="text-muted-foreground">مانده اختتامیه</span>
              <span className="font-bold tabular-nums text-foreground">{money.format(statement.closingBalance)}</span>
            </div>
          </div>
        )}
      </OverlayDialog>
  );
}
