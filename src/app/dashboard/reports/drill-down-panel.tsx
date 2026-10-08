"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { XIcon } from "lucide-react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { overlayPanelClass } from "../page-chrome";
import { useOverlayEscape } from "@/app/(app)/accounting/use-overlay-escape";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

interface DrillDownLine {
  lineId: string;
  entryId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  debit: string;
  credit: string;
}

interface DrillDownResult {
  lines: DrillDownLine[];
  totals: { debit: string; credit: string; signedBalance: string };
  totalLines: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface DrillDownTarget {
  accountCode: string;
  accountName: string;
  dateFrom?: string;
  dateTo?: string;
  /** `ledger.view` for the trial-balance page; otherwise the existing reports.view gate. */
  permissionScope?: "ledger" | "reports";
  /** The exact report cell this posting list should reconcile to. */
  amountBasis?: "debit" | "credit" | "closingDebit" | "closingCredit";
  expectedAmount?: string;
  amountLabel?: string;
}

/**
 * Shared report drill-down. Exact debit/credit totals are computed for the
 * entire result while journal lines are paged, so large histories still
 * reconcile without loading every line into the browser at once.
 */
export function DrillDownPanel({ target, onClose }: { target: DrillDownTarget; onClose: () => void }) {
  const money = useMoney();
  const [result, setResult] = useState<DrillDownResult | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState("");
  useOverlayEscape(onClose);

  const requestPage = useCallback(async (offset: number, signal?: AbortSignal) => {
    const params = new URLSearchParams({ accountCode: target.accountCode });
    if (target.dateFrom) params.set("dateFrom", target.dateFrom);
    if (target.dateTo) params.set("dateTo", target.dateTo);
    if (target.permissionScope === "ledger") params.set("permissionScope", "ledger");
    if (offset > 0) params.set("offset", String(offset));
    return api<DrillDownResult>(`/api/reports/drill-down?${params}`, { signal });
  }, [target.accountCode, target.dateFrom, target.dateTo, target.permissionScope]);

  useEffect(() => {
    setResult(null);
    setError("");
    setPageError("");
    const controller = new AbortController();
    void requestPage(0, controller.signal)
      .then(({ ok, data }) => {
        if (controller.signal.aborted) return;
        if (ok) setResult(data);
        else setError("خواندن اسناد این حساب ممکن نشد.");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("خواندن اسناد این حساب ممکن نشد.");
      });
    return () => controller.abort();
  }, [requestPage]);

  async function loadMore() {
    if (!result?.hasMore || result.nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    setPageError("");
    try {
      const { ok, data } = await requestPage(result.nextOffset);
      if (!ok) {
        setPageError("بارگذاری ادامهٔ اسناد ناموفق بود.");
        return;
      }
      setResult((current) => current ? {
        ...data,
        lines: [...current.lines, ...data.lines],
      } : data);
    } catch {
      setPageError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      setLoadingMore(false);
    }
  }

  const reconciles = result && target.expectedAmount !== undefined && target.amountBasis
    ? (() => {
        const signed = BigInt(result.totals.signedBalance);
        const actual = target.amountBasis === "debit"
          ? result.totals.debit
          : target.amountBasis === "credit"
            ? result.totals.credit
            : target.amountBasis === "closingDebit"
              ? (signed > 0n ? signed.toString() : "0")
              : (signed < 0n ? (-signed).toString() : "0");
        return BigInt(actual) === BigInt(target.expectedAmount);
      })()
    : null;

  const expectedLabel = target.amountLabel ?? "مبلغ گزارش";
  const expectedText = target.expectedAmount !== undefined
    ? money.formatText(target.expectedAmount)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="drill-down-title"
        className={`${overlayPanelClass} max-h-[88vh] w-full max-w-5xl overflow-y-auto p-5`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="drill-down-title" className="font-semibold text-foreground">{target.accountName}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              اسناد تشکیل‌دهندهٔ {target.amountLabel ?? "ماندهٔ حساب"} — کد حساب {toPersianDigits(target.accountCode)}
              {expectedText ? ` — ${expectedLabel}: ${expectedText}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن"
            className="-me-1 -mt-1 shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>

        {error ? (
          <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
        ) : result === null ? (
          <LoadingSkeleton rows={3} />
        ) : result.totalLines === 0 ? (
          <p className="text-sm text-muted-foreground">سندی برای این حساب در این بازه یافت نشد.</p>
        ) : (
          <>
            {reconciles !== null ? (
              <p
                role="status"
                className={`mb-3 rounded-xl border px-3 py-2 text-sm ${
                  reconciles
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                    : "border-destructive/30 bg-destructive/10 text-destructive"
                }`}
              >
                {reconciles
                  ? `جمع ردیف‌های دفتر با ${expectedLabel} گزارش برابر است.`
                  : `جمع ردیف‌های دفتر با ${expectedLabel} گزارش برابر نیست؛ اختلاف را بررسی کنید.`}
              </p>
            ) : null}
            <DataTable caption={`اسناد حساب ${target.accountName}`}>
              <DataTableHead>
                <Th>تاریخ</Th>
                <Th>شماره سند / شرح</Th>
                <Th>منبع</Th>
                <Th numeric>بدهکار</Th>
                <Th numeric>بستانکار</Th>
              </DataTableHead>
              <DataTableBody>
                {result.lines.map((line) => (
                  <DataTableRow key={line.lineId}>
                    <Td muted nowrap>{toPersianDigits(formatJalali(line.entryDate))}</Td>
                    <Td>
                      <div className="min-w-40">
                        <p>{line.memo ?? "بدون شرح"}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <span title={line.entryId}>سند {toPersianDigits(line.entryId.slice(0, 8))}</span>
                          {target.permissionScope === "ledger" ? (
                            <Link
                              href={`/accounting/entries?entryId=${encodeURIComponent(line.entryId)}`}
                              className="font-medium text-amber-800 underline decoration-amber-500/50 underline-offset-2 hover:text-amber-950 dark:text-amber-300 dark:hover:text-amber-200"
                              aria-label={`بازکردن سند ${toPersianDigits(line.entryId.slice(0, 8))}`}
                            >
                              بازکردن سند
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </Td>
                    <Td muted>{ledgerSourceLabel(line.sourceType)}</Td>
                    <Td numeric nowrap>{line.debit !== "0" ? money.formatText(line.debit) : "—"}</Td>
                    <Td numeric nowrap>{line.credit !== "0" ? money.formatText(line.credit) : "—"}</Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
              <DataTableFoot>
                <tr>
                  <Th scope="row" colSpan={3}>جمع همهٔ {toPersianDigits(result.totalLines)} ردیف</Th>
                  <Td numeric nowrap>{money.formatText(result.totals.debit)}</Td>
                  <Td numeric nowrap>{money.formatText(result.totals.credit)}</Td>
                </tr>
                <tr>
                  <Th scope="row" colSpan={3}>ماندهٔ خالص (بدهکار − بستانکار)</Th>
                  <Td numeric nowrap colSpan={2}>{money.formatText(result.totals.signedBalance)}</Td>
                </tr>
              </DataTableFoot>
            </DataTable>
            {pageError ? <p role="alert" className="mt-3 text-sm text-destructive">{pageError}</p> : null}
            {result.hasMore ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {toPersianDigits(result.lines.length)} از {toPersianDigits(result.totalLines)} ردیف بارگذاری شده است؛ جمع بالا همهٔ ردیف‌ها را در بر می‌گیرد.
                </p>
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="min-h-10 rounded-lg border border-border/80 bg-card px-3.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {loadingMore ? "در حال بارگذاری…" : "نمایش ردیف‌های بیشتر"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
