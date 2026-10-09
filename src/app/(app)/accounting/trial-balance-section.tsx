"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCwIcon, PrinterIcon } from "lucide-react";
import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { FilterChip } from "@/app/dashboard/filters";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useDimensionCatalog } from "./dimension-fields";
import { dimensionFilterOptionsFor, enabledDimensionKinds, enabledKindLabel } from "./dimension-catalog";
import { UNASSIGNED_DIMENSION, type DimensionKind } from "@/lib/accounting-dimensions";
import {
  CardEyebrow,
  cardClass,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { api, ErrorBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { ExportButtons } from "@/app/dashboard/reports/export-buttons";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, jalaliToIsoDate, todayJalali } from "@/lib/jalali";
// The whole contract comes from the pure module: a client component must not
// import the DB-touching service, not even for types.
import {
  filterTrialBalanceRows,
  type AccountType,
  type TrialBalanceAccountStatus,
  type TrialBalancePresentation,
  type TrialBalanceReport,
  type TrialBalanceRow,
  type TrialBalanceTotals,
} from "@/lib/trial-balance";
import { DrillDownPanel, type DrillDownTarget } from "@/app/dashboard/reports/drill-down-panel";
import printStyles from "./trial-balance-print.module.css";

interface FiscalYear {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  closedAt: string | null;
}

interface FiscalPeriod {
  id: string;
  fiscalYearId: string;
  label: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: "open" | "soft_closed" | "locked";
}

type DateScopeMode = "fiscal" | "custom";

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

const LEVEL_LABELS: Record<TrialBalanceRow["level"], string> = {
  group: "گروه",
  kol: "کل",
  moein: "معین",
  tafsili: "تفصیلی",
};

const PERIOD_STATUS_LABELS: Record<FiscalPeriod["status"], string> = {
  open: "دورهٔ باز",
  soft_closed: "بستهٔ موقت",
  locked: "قفل‌شده",
};

const LEVEL_INDENT: Record<TrialBalanceRow["level"], number> = {
  group: 0,
  kol: 1,
  moein: 2,
  tafsili: 3,
};

function initialCurrentMonthRange(): { from: string; to: string } {
  const today = todayJalali();
  return {
    from: jalaliToIsoDate(today.jy, today.jm, 1),
    to: jalaliToIsoDate(today.jy, today.jm, today.jd),
  };
}

function previousIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function formatRange(from: string | null, to: string): string {
  return from
    ? `از ${toPersianDigits(formatJalali(from))} تا ${toPersianDigits(formatJalali(to))}`
    : `تا ${toPersianDigits(formatJalali(to))}`;
}

function addTotals(rows: readonly TrialBalanceRow[]): TrialBalanceTotals {
  const totals: TrialBalanceTotals = {
    openingDebit: "0",
    openingCredit: "0",
    periodDebit: "0",
    periodCredit: "0",
    closingDebit: "0",
    closingCredit: "0",
    closingDifference: "0",
  };
  const keys = ["openingDebit", "openingCredit", "periodDebit", "periodCredit", "closingDebit", "closingCredit"] as const;
  for (const row of rows) {
    for (const key of keys) {
      totals[key] = (BigInt(totals[key]) + BigInt(row[key])).toString();
    }
  }
  totals.closingDifference = (BigInt(totals.closingDebit) - BigInt(totals.closingCredit)).toString();
  return totals;
}

type DrillableAmount = Exclude<keyof TrialBalanceTotals, "closingDifference">;

function amountLabel(field: DrillableAmount, presentation: TrialBalancePresentation): string {
  const labels: Record<keyof TrialBalanceTotals, string> = {
    openingDebit: "مانده افتتاحیه بدهکار",
    openingCredit: "مانده افتتاحیه بستانکار",
    periodDebit: "گردش بدهکار دوره",
    periodCredit: "گردش بستانکار دوره",
    closingDebit: presentation === "closing" ? "مانده بدهکار در تاریخ گزارش" : "مانده پایان بدهکار",
    closingCredit: presentation === "closing" ? "مانده بستانکار در تاریخ گزارش" : "مانده پایان بستانکار",
    closingDifference: "اختلاف مانده پایان",
  };
  return labels[field];
}

export function TrialBalanceSection({
  refreshKey,
  canExport = false,
}: {
  refreshKey: number;
  /** Export is hidden unless the member has the existing reports.export grant. */
  canExport?: boolean;
}) {
  const money = useMoney();
  const initialRange = useMemo(initialCurrentMonthRange, []);
  const [dateFrom, setDateFrom] = useState(initialRange.from);
  const [dateTo, setDateTo] = useState(initialRange.to);
  const [presentation, setPresentation] = useState<TrialBalancePresentation>("detailed");
  const [scopeMode, setScopeMode] = useState<DateScopeMode>("custom");
  const scopeModeRef = useRef<DateScopeMode>("custom");
  const scopeTouchedRef = useRef(false);
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);
  const [selectedYearId, setSelectedYearId] = useState("");
  const [fiscalPeriods, setFiscalPeriods] = useState<FiscalPeriod[] | null>(null);
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [fiscalLoadFailed, setFiscalLoadFailed] = useState(false);
  const [data, setData] = useState<TrialBalanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [search, setSearch] = useState("");
  const [accountType, setAccountType] = useState<AccountType | "all">("all");
  const [accountStatus, setAccountStatus] = useState<TrialBalanceAccountStatus>("all");
  const [includeZeroBalances, setIncludeZeroBalances] = useState(false);
  // Issue #868: the report can be read for one dimension value. Off until a kind
  // and a value are both chosen, and then every figure is that subset.
  const dimensionCatalog = useDimensionCatalog();
  const [dimensionKind, setDimensionKind] = useState<DimensionKind | "">("");
  const [dimensionValue, setDimensionValue] = useState("");
  const dimensionActive = dimensionKind !== "" && dimensionValue !== "";
  const dimensionScopeLabel = !dimensionActive
    ? ""
    : dimensionValue === UNASSIGNED_DIMENSION
      ? `${enabledKindLabel(dimensionCatalog.settings, dimensionKind)}: بدون بُعد`
      : (() => {
          const chosen = dimensionCatalog.values.find((v) => v.id === dimensionValue);
          return `${enabledKindLabel(dimensionCatalog.settings, dimensionKind)}: ${chosen ? `${toPersianDigits(chosen.code)} · ${chosen.name}` : "مقدار انتخاب‌شده"}`;
        })();
  const [drillTarget, setDrillTarget] = useState<DrillDownTarget | null>(null);
  // The print sheet is portalled onto <body>; there is no body to portal onto
  // during the server render, and on screen the sheet stays display:none.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => {
    setPortalReady(true);
  }, []);

  const selectedPeriod = fiscalPeriods?.find((period) => period.id === selectedPeriodId) ?? null;
  const selectedYear = fiscalYears.find((year) => year.id === selectedYearId) ?? null;

  // Fiscal data is independent from the account chart; a failed setup/list
  // request does not block the report, which still opens on the current Jalali
  // month-to-date custom range.
  useEffect(() => {
    let cancelled = false;
    void api<{ fiscalYears: FiscalYear[] }>("/api/ledger/fiscal-years")
      .then(({ ok, data: result }) => {
        if (cancelled) return;
        if (!ok) {
          setFiscalLoadFailed(true);
          return;
        }
        setFiscalLoadFailed(false);
        setFiscalYears(result.fiscalYears);
        if (!scopeTouchedRef.current && result.fiscalYears.length > 0) {
          const today = initialRange.to;
          const currentYear = result.fiscalYears.find((year) => year.startsOn <= today && year.endsOn >= today);
          setSelectedYearId((current) => current || currentYear?.id || result.fiscalYears[0].id);
        }
      })
      .catch(() => {
        if (!cancelled) setFiscalLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [initialRange.to]);

  // Load periods for the chosen fiscal year. The current period is the default;
  // closed/locked periods remain selectable for historical reporting.
  useEffect(() => {
    let cancelled = false;
    if (!selectedYearId) {
      setFiscalPeriods(null);
      setSelectedPeriodId("");
      return () => {
        cancelled = true;
      };
    }
    setFiscalPeriods(null);
    const yearId = selectedYearId;
    void api<{ periods: FiscalPeriod[] }>(`/api/ledger/fiscal-years/${yearId}/periods`)
      .then(({ ok, data: result }) => {
        if (cancelled) return;
        if (!ok) {
          setFiscalPeriods([]);
          setFiscalLoadFailed(true);
          return;
        }
        setFiscalLoadFailed(false);
        setFiscalPeriods(result.periods);
        if (result.periods.length === 0) return;
        const current = result.periods.find((period) => period.startsOn <= initialRange.to && period.endsOn >= initialRange.to);
        const preferred = result.periods.find((period) => period.id === selectedPeriodId);
        const period = preferred ?? current ?? result.periods[0];
        setSelectedPeriodId(period.id);
        if (scopeModeRef.current === "fiscal" || !scopeTouchedRef.current) {
          scopeModeRef.current = "fiscal";
          setScopeMode("fiscal");
          setDateFrom(period.startsOn);
          setDateTo(period.endsOn);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFiscalPeriods([]);
          setFiscalLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // selectedPeriodId is intentionally read as a preference but not a trigger:
    // changing a month selects from the already-loaded list without refetching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYearId, initialRange.to]);

  const loadReport = useCallback(async (signal: AbortSignal) => {
    if (!dateTo || (presentation === "detailed" && !dateFrom)) {
      setData(null);
      setLoading(false);
      setError("بازهٔ گزارش را کامل انتخاب کنید.");
      return;
    }
    if (presentation === "detailed" && dateFrom > dateTo) {
      setData(null);
      setLoading(false);
      setError("تاریخ شروع باید پیش از تاریخ پایان باشد.");
      return;
    }

    setLoading(true);
    setError("");
    setData(null);
    const params = new URLSearchParams();
    if (presentation === "closing") params.set("asOf", dateTo);
    else {
      params.set("dateFrom", dateFrom);
      params.set("dateTo", dateTo);
    }
    if (dimensionActive) {
      params.set("dimension", dimensionKind);
      params.set("value", dimensionValue);
    }
    try {
      const result = await api<TrialBalanceReport & { error?: string }>(
        `/api/ledger/trial-balance?${params}`,
        { signal },
      );
      // A superseded request must never overwrite the newer one — `api` reports
      // a cancellation as `aborted` rather than throwing, so both are checked.
      if (result.aborted || signal.aborted) return;
      if (result.ok) {
        setData(result.data);
        return;
      }
      setError(
        result.data.error === "network_error"
          ? "ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید."
          : result.data.error === "invalid_date_range"
            ? "بازهٔ تاریخ نامعتبر است؛ تاریخ شروع باید پیش از تاریخ پایان باشد."
            : result.data.error === "invalid_report_scope"
              ? "بازهٔ گزارش معتبر نیست؛ سال و دورهٔ مالی یا یک بازهٔ تاریخ انتخاب کنید."
              : "بارگذاری تراز آزمایشی ناموفق بود؛ دوباره تلاش کنید.",
      );
    } catch {
      if (!signal.aborted) setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [dateFrom, dateTo, presentation, dimensionActive, dimensionKind, dimensionValue]);

  useEffect(() => {
    const controller = new AbortController();
    void loadReport(controller.signal);
    return () => controller.abort();
  }, [loadReport, refreshKey, retryKey]);

  const displayFilters = useMemo(() => ({
    presentation,
    search,
    accountType,
    accountStatus,
    includeZeroBalances,
  }), [presentation, search, accountType, accountStatus, includeZeroBalances]);
  const rows = useMemo(
    () => data ? filterTrialBalanceRows(data.accounts, displayFilters) : [],
    [data, displayFilters],
  );
  const totals = useMemo(() => addTotals(rows), [rows]);
  const rangeLabel = !dateTo
    ? "تاریخی برای گزارش انتخاب نشده است"
    : presentation === "closing"
      ? `مانده در تاریخ ${toPersianDigits(formatJalali(dateTo))}`
      : dateFrom ? formatRange(dateFrom, dateTo) : "بازهٔ گزارش کامل نیست";
  const hasLedgerEntries = (data?.integrity.entryCount ?? 0) > 0;
  // No journal *lines* in scope — whether because nothing was posted or because
  // a header arrived without any. Both leave the columns at zero, and zero
  // equals zero is not a verdict.
  const noEntriesThroughDate = (data?.activity.lineCount ?? 0) === 0;
  const closingDifference = data?.totals.closingDifference ?? "0";
  const problems: string[] = [];
  if (data && data.integrity.unbalancedEntryCount > 0) {
    problems.push(`${toPersianDigits(data.integrity.unbalancedEntryCount)} سند نامتوازن`);
  }
  if (data && data.integrity.invalidEntryCount > 0) {
    problems.push(`${toPersianDigits(data.integrity.invalidEntryCount)} سند ناقص`);
  }
  const balanceStatus = !data || noEntriesThroughDate
    ? "بدون سند در این بازه"
    : dimensionActive
      ? "زیرمجموعهٔ بُعد"
      : data.trialBalanceBalanced ? "مانده‌ها برابر" : "مانده‌ها نامتوازن";
  const healthStatus = !data || !hasLedgerEntries
    ? "سلامت دفتر: بدون سند"
    : data.integrity.ledgerHealthy ? "دفتر سالم"
      : `نیازمند بازبینی${problems.length ? ` — ${problems.join("، ")}` : ""}`;

  function setCustomDate(which: "from" | "to", value: string) {
    scopeTouchedRef.current = true;
    scopeModeRef.current = "custom";
    setScopeMode("custom");
    setSelectedPeriodId("");
    if (which === "from") setDateFrom(value);
    else setDateTo(value);
  }

  function chooseScopeMode(next: DateScopeMode) {
    scopeTouchedRef.current = true;
    scopeModeRef.current = next;
    setScopeMode(next);
    if (next === "fiscal") {
      const period = selectedPeriod ?? fiscalPeriods?.[0];
      if (period) {
        setSelectedPeriodId(period.id);
        setDateFrom(period.startsOn);
        setDateTo(period.endsOn);
      }
    } else {
      setSelectedPeriodId("");
    }
  }

  function chooseFiscalYear(yearId: string) {
    scopeTouchedRef.current = true;
    scopeModeRef.current = "fiscal";
    setScopeMode("fiscal");
    setSelectedYearId(yearId);
    setSelectedPeriodId("");
  }

  function chooseFiscalPeriod(periodId: string) {
    const period = fiscalPeriods?.find((candidate) => candidate.id === periodId);
    if (!period) return;
    scopeTouchedRef.current = true;
    scopeModeRef.current = "fiscal";
    setScopeMode("fiscal");
    setSelectedPeriodId(period.id);
    setDateFrom(period.startsOn);
    setDateTo(period.endsOn);
  }

  function openDrillDown(account: TrialBalanceRow, field: DrillableAmount) {
    const expectedAmount = account[field];
    const target: DrillDownTarget = {
      accountCode: account.code,
      accountName: account.name,
      permissionScope: "ledger",
      expectedAmount,
      amountLabel: amountLabel(field, presentation),
    };
    if (field === "openingDebit" || field === "openingCredit") {
      target.dateTo = previousIsoDate(dateFrom);
      target.amountBasis = field === "openingDebit" ? "closingDebit" : "closingCredit";
    } else if (field === "periodDebit" || field === "periodCredit") {
      target.dateFrom = dateFrom;
      target.dateTo = dateTo;
      target.amountBasis = field === "periodDebit" ? "debit" : "credit";
    } else {
      target.dateTo = dateTo;
      target.amountBasis = field === "closingDebit" ? "closingDebit" : "closingCredit";
    }
    setDrillTarget(target);
  }

  /**
   * A cell amount. Every money column in the approved reference set names its
   * unit in each cell («۴۵۰۰٬۰۰ تومان»), so this keeps the default rather
   * than inventing a unit-less dialect for the wide view; the business's own
   * display preference still decides whether that word is تومان or ریال.
   */
  const amount = (rialText: string) => money.formatText(rialText);

  function renderAmountButton(account: TrialBalanceRow, field: DrillableAmount) {
    const value = account[field];
    return (
      <button
        type="button"
        onClick={() => openDrillDown(account, field)}
        title={`دیدن اسناد تشکیل‌دهندهٔ ${amountLabel(field, presentation)}`}
        aria-label={`${account.name}، ${amountLabel(field, presentation)}، ${money.formatText(value)}`}
        className="rounded-sm text-end underline decoration-dotted decoration-amber-600/50 underline-offset-4 hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50 dark:hover:text-amber-300"
      >
        {amount(value)}
      </button>
    );
  }

  const selectedExportOptions = {
    presentation,
    search,
    accountType,
    accountStatus,
    includeZeroBalances,
  } as const;

  return (
    <>
      <section aria-labelledby="trial-balance-heading" aria-busy={loading} className={cardClass}>
        <h2 id="trial-balance-heading" className="sr-only">تراز آزمایشی</h2>
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5 print:hidden">
          <div className="min-w-0">
            <CardEyebrow>دفتر تجمیعی همهٔ شعب</CardEyebrow>
            <p className="mt-1 text-sm font-semibold text-foreground">{rangeLabel}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {presentation === "closing"
                ? "ماندهٔ خالص هر حساب تا تاریخ انتخاب‌شده؛ ماندهٔ غیرعادی در ستون بدهکار یا بستانکار خودش دیده می‌شود."
                : "افتتاحیه شامل اسناد پیش از شروع دوره است؛ گردش فقط اسناد داخل بازه و ماندهٔ پایان تا تاریخ پایان را نشان می‌دهد."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {data ? (
              <>
                {dimensionActive ? null : (
                  <StatusBadge tone={noEntriesThroughDate ? "neutral" : data.trialBalanceBalanced ? "positive" : "danger"} dot>
                    {balanceStatus}
                  </StatusBadge>
                )}
                <StatusBadge tone={data.integrity.ledgerHealthy ? "positive" : "danger"}>
                  {healthStatus}
                </StatusBadge>
              </>
            ) : null}
            <SecondaryButton
              onClick={() => setRetryKey((key) => key + 1)}
              disabled={loading}
              className="min-h-9 px-2.5 text-xs"
            >
              <RefreshCwIcon aria-hidden="true" className="me-1.5 size-3.5" />
              {loading ? "در حال بروزرسانی…" : "بروزرسانی"}
            </SecondaryButton>
          </div>
        </header>

        <div className="space-y-4 border-b border-border/80 p-4 sm:p-5 print:hidden">
          <div className="grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 sm:grid-cols-2 xl:grid-cols-4 xl:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">دامنهٔ گزارش</span>
              <select
                aria-label="دامنهٔ گزارش تراز آزمایشی"
                className={inputClass}
                value={scopeMode}
                onChange={(event) => chooseScopeMode(event.target.value as DateScopeMode)}
              >
                <option value="fiscal" disabled={fiscalYears.length === 0}>سال و دورهٔ مالی</option>
                <option value="custom">بازهٔ سفارشی شمسی</option>
              </select>
            </label>
            {scopeMode === "fiscal" ? (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-xs text-muted-foreground">سال مالی</span>
                  <select
                    aria-label="سال مالی تراز آزمایشی"
                    className={inputClass}
                    value={selectedYearId}
                    onChange={(event) => chooseFiscalYear(event.target.value)}
                    disabled={fiscalYears.length === 0}
                  >
                    {fiscalYears.map((year) => (
                      <option key={year.id} value={year.id}>{toPersianDigits(year.label)}{year.closedAt ? " — بسته‌شده" : ""}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs text-muted-foreground">دورهٔ مالی</span>
                  <select
                    aria-label="دورهٔ مالی تراز آزمایشی"
                    className={inputClass}
                    value={selectedPeriodId}
                    onChange={(event) => chooseFiscalPeriod(event.target.value)}
                    disabled={!fiscalPeriods || fiscalPeriods.length === 0}
                  >
                    {(fiscalPeriods ?? []).map((period) => (
                      <option key={period.id} value={period.id}>
                        {toPersianDigits(period.name)} — {PERIOD_STATUS_LABELS[period.status]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="min-w-0 text-xs leading-5 text-muted-foreground">
                  {selectedPeriod
                    ? <><span className="font-medium text-foreground">{toPersianDigits(formatRange(selectedPeriod.startsOn, selectedPeriod.endsOn))}</span>{selectedYear?.closedAt ? " — سال مالی بسته‌شده" : ""}</>
                    : fiscalLoadFailed ? "دوره‌های مالی بارگذاری نشدند؛ بازهٔ سفارشی را انتخاب کنید." : "در حال بارگذاری دوره‌های مالی…"}
                </div>
              </>
            ) : presentation === "detailed" ? (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
                  <JalaliDatePicker value={dateFrom} onChange={(value) => setCustomDate("from", value)} ariaLabel="از تاریخ تراز آزمایشی" placeholder="از تاریخ" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
                  <JalaliDatePicker value={dateTo} onChange={(value) => setCustomDate("to", value)} ariaLabel="تا تاریخ تراز آزمایشی" placeholder="تا تاریخ" />
                </label>
              </>
            ) : (
              <div className="min-h-10 self-end text-xs leading-5 text-muted-foreground">
                گزارش فشرده ماندهٔ پایان دوره را در تاریخ انتخاب‌شده نشان می‌دهد.
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="شیوهٔ نمایش تراز آزمایشی">
            <FilterChip
              selected={presentation === "detailed"}
              onClick={() => setPresentation("detailed")}
            >
              افتتاحیه، گردش و ماندهٔ پایان
            </FilterChip>
            <FilterChip
              selected={presentation === "closing"}
              onClick={() => setPresentation("closing")}
            >
              مانده در تاریخ
            </FilterChip>
            {presentation === "closing" ? (
              <label className="ms-auto flex min-w-52 items-center gap-2 text-xs text-muted-foreground">
                تاریخ مانده
                <JalaliDatePicker value={dateTo} onChange={(value) => setCustomDate("to", value)} ariaLabel="تاریخ ماندهٔ تراز آزمایشی" placeholder="تاریخ مانده" />
              </label>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 xl:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">جست‌وجو در کد یا نام حساب</span>
              <input
                type="search"
                className={inputClass}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="کد یا نام حساب…"
                aria-label="جست‌وجوی حساب در تراز آزمایشی"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">نوع حساب</span>
              <select
                className={inputClass}
                value={accountType}
                onChange={(event) => setAccountType(event.target.value as AccountType | "all")}
                aria-label="فیلتر نوع حساب"
              >
                <option value="all">همهٔ انواع</option>
                {Object.entries(TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">وضعیت حساب</span>
              <select
                className={inputClass}
                value={accountStatus}
                onChange={(event) => setAccountStatus(event.target.value as TrialBalanceAccountStatus)}
                aria-label="فیلتر وضعیت حساب"
              >
                <option value="all">فعال و بایگانی‌شده</option>
                <option value="active">فقط فعال</option>
                <option value="archived">فقط بایگانی‌شده</option>
              </select>
            </label>
            {enabledDimensionKinds(dimensionCatalog.settings).length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs text-muted-foreground">بُعد</span>
                  <SearchableSelect
                    value={dimensionKind}
                    onChange={(next) => {
                      setDimensionKind(next as DimensionKind | "");
                      setDimensionValue(next ? UNASSIGNED_DIMENSION : "");
                    }}
                    ariaLabel="بُعد تراز آزمایشی"
                    options={[
                      { value: "", label: "همهٔ سندها" },
                      ...enabledDimensionKinds(dimensionCatalog.settings).map((k) => ({
                        value: k,
                        label: enabledKindLabel(dimensionCatalog.settings, k),
                      })),
                    ]}
                  />
                </label>
                {dimensionKind ? (
                  <label className="block min-w-0">
                    <span className="mb-1.5 block text-xs text-muted-foreground">
                      {enabledKindLabel(dimensionCatalog.settings, dimensionKind)}
                    </span>
                    <SearchableSelect
                      value={dimensionValue}
                      onChange={setDimensionValue}
                      ariaLabel={`${enabledKindLabel(dimensionCatalog.settings, dimensionKind)} تراز آزمایشی`}
                      options={[
                        { value: UNASSIGNED_DIMENSION, label: "بدون بُعد" },
                        ...dimensionFilterOptionsFor(dimensionCatalog.values, dimensionKind),
                      ]}
                    />
                  </label>
                ) : null}
              </div>
            ) : null}
            <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={includeZeroBalances}
                onChange={(event) => setIncludeZeroBalances(event.target.checked)}
                className="size-4 accent-amber-600"
              />
              نمایش حساب‌های بدون مانده و گردش
            </label>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            حساب‌های گروه و زیرحساب‌ها به ترتیب کد و با تورفتگی نمایش داده می‌شوند؛ جمع گروه دوباره به ماندهٔ دفتر افزوده نمی‌شود. حساب بایگانی‌شده‌ای که در تاریخ گزارش سابقه دارد حفظ می‌شود.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-5 print:hidden">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {data
              ? `${toPersianDigits(rows.length)} حساب از ${toPersianDigits(data.accounts.length)} حساب — ${rangeLabel}`
              : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {canExport && data && !dimensionActive ? (
              <ExportButtons
                request={{
                  kind: "trial_balance",
                  title: "تراز آزمایشی",
                  dateFrom: presentation === "detailed" ? dateFrom : undefined,
                  dateTo: presentation === "detailed" ? dateTo : undefined,
                  asOf: presentation === "closing" ? dateTo : undefined,
                  trialBalanceOptions: selectedExportOptions,
                }}
                disabled={loading}
              />
            ) : null}
            <SecondaryButton onClick={() => window.print()} disabled={!data || loading}>
              <PrinterIcon aria-hidden="true" className="me-1.5 size-4" />
              چاپ
            </SecondaryButton>
          </div>
        </div>

        <div className="p-4 sm:p-5">
          <ErrorBox>{error}</ErrorBox>
          {error && !data ? (
            <div className="mt-3 flex justify-center print:hidden">
              <SecondaryButton onClick={() => setRetryKey((key) => key + 1)}>تلاش دوباره</SecondaryButton>
            </div>
          ) : loading || !data ? (
            <SectionCardSkeleton rows={4} label="در حال بارگذاری تراز آزمایشی" />
          ) : (
            <>
              {dimensionActive ? (
                <p role="status" className="mb-4 rounded-xl border border-border bg-muted/60 px-3 py-2.5 text-sm leading-6 text-foreground">
                  این تراز فقط سندهایی را نشان می‌دهد که {dimensionScopeLabel} دارند. مانده‌های یک زیرمجموعه لزوماً متوازن نیستند؛ توازن کل دفتر در تراز بدون بُعد بررسی می‌شود.
                </p>
              ) : null}
              {(dimensionActive ? data.integrity.ledgerHealthy : data.integrity.ledgerHealthy && data.trialBalanceBalanced) ? null : (
                <p role="status" aria-live="polite" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-6 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  {noEntriesThroughDate
                    ? "تا تاریخ گزارش سندی وجود ندارد؛ دفتر خالی به‌عنوان تراز تأییدشده نمایش داده نمی‌شود."
                    : data.trialBalanceBalanced
                      ? `جمع مانده‌های پایان دوره برابر است، اما ${problems.join(" و ") || "سلامت دفتر نیازمند بررسی است"}.`
                      : `مانده‌های گزارش برابر نیستند؛ اختلاف بدهکار و بستانکار پایان دوره: ${money.formatText(BigInt(closingDifference) < 0n ? (-BigInt(closingDifference)).toString() : closingDifference)}.`}
                </p>
              )}
              {(search || accountType !== "all" || accountStatus !== "all") ? (
                <p className="mb-3 text-xs text-muted-foreground">
                  جمع پایین جدول فقط حساب‌های نمایش‌داده‌شده را در بر می‌گیرد؛ وضعیت تراز بالا مربوط به کل دفتر و همهٔ حساب‌هاست.
                </p>
              ) : null}

              <div className="hidden lg:block">
                <DataTable caption="تراز آزمایشی دوره‌ای، شامل مانده افتتاحیه، گردش و مانده پایان">
                  {presentation === "detailed" ? (
                    <thead className="bg-muted/60 text-muted-foreground">
                      <tr className="border-b border-border">
                        <Th rowSpan={2}>کد</Th>
                        <Th rowSpan={2}>حساب</Th>
                        <Th rowSpan={2}>نوع</Th>
                        <Th rowSpan={2}>سطح</Th>
                        <Th rowSpan={2}>وضعیت</Th>
                        <Th colSpan={2} numeric>ماندهٔ افتتاحیه</Th>
                        <Th colSpan={2} numeric>گردش دوره</Th>
                        <Th colSpan={2} numeric>ماندهٔ پایان دوره</Th>
                      </tr>
                      <tr className="border-b border-border">
                        <Th numeric>بدهکار</Th><Th numeric>بستانکار</Th>
                        <Th numeric>بدهکار</Th><Th numeric>بستانکار</Th>
                        <Th numeric>بدهکار</Th><Th numeric>بستانکار</Th>
                      </tr>
                    </thead>
                  ) : (
                    <DataTableHead>
                      <Th>کد</Th><Th>حساب</Th><Th>نوع</Th><Th>سطح</Th><Th>وضعیت</Th>
                      <Th numeric>مانده بدهکار</Th>
                      <Th numeric>مانده بستانکار</Th>
                    </DataTableHead>
                  )}
                  <DataTableBody>
                    {rows.map((account) => (
                      <DataTableRow key={account.id} className={account.hasChildren ? "bg-muted/30" : undefined}>
                        <Td muted nowrap className="font-medium">{toPersianDigits(account.code)}</Td>
                        <Td className={account.hasChildren ? "font-semibold" : "font-medium"}>
                          <span className="inline-flex items-center gap-1.5" style={{ paddingInlineStart: `${LEVEL_INDENT[account.level] * 0.75}rem` }}>
                            <span>{account.name}</span>
                            {account.hasChildren ? <span className="text-[10px] text-muted-foreground">گروه</span> : null}
                            {account.isAbnormalBalance ? <StatusBadge tone="danger">ماندهٔ غیرعادی</StatusBadge> : null}
                            {!account.isActive ? <StatusBadge>بایگانی‌شده</StatusBadge> : null}
                          </span>
                        </Td>
                        <Td muted>{TYPE_LABELS[account.type]}</Td>
                        <Td muted>{LEVEL_LABELS[account.level]}</Td>
                        <Td muted>{account.isActive ? "فعال" : "بایگانی"}</Td>
                        {presentation === "detailed" ? (
                          <>
                            <Td numeric nowrap>{renderAmountButton(account, "openingDebit")}</Td>
                            <Td numeric nowrap>{renderAmountButton(account, "openingCredit")}</Td>
                            <Td numeric nowrap>{renderAmountButton(account, "periodDebit")}</Td>
                            <Td numeric nowrap>{renderAmountButton(account, "periodCredit")}</Td>
                          </>
                        ) : null}
                        <Td numeric nowrap>{renderAmountButton(account, "closingDebit")}</Td>
                        <Td numeric nowrap>{renderAmountButton(account, "closingCredit")}</Td>
                      </DataTableRow>
                    ))}
                    {rows.length === 0 ? (
                      <tr><td colSpan={presentation === "detailed" ? 11 : 7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                        {data.accounts.length === 0 ? "در این دامنه حسابی با گردش یا مانده وجود ندارد." : "حسابی با این فیلترها یافت نشد."}
                      </td></tr>
                    ) : null}
                  </DataTableBody>
                  <DataTableFoot>
                    <tr>
                      <Th scope="row" colSpan={5}>جمع حساب‌های نمایش‌داده‌شده</Th>
                      {presentation === "detailed" ? (
                        <>
                          <Td numeric nowrap>{amount(totals.openingDebit)}</Td>
                          <Td numeric nowrap>{amount(totals.openingCredit)}</Td>
                          <Td numeric nowrap>{amount(totals.periodDebit)}</Td>
                          <Td numeric nowrap>{amount(totals.periodCredit)}</Td>
                        </>
                      ) : null}
                      <Td numeric nowrap>{amount(totals.closingDebit)}</Td>
                      <Td numeric nowrap>{amount(totals.closingCredit)}</Td>
                    </tr>
                  </DataTableFoot>
                </DataTable>
              </div>

              <div className="space-y-3 lg:hidden">
                {rows.map((account) => (
                  <article key={account.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-muted-foreground">{toPersianDigits(account.code)} · {TYPE_LABELS[account.type]}</p>
                        <h3 className={`mt-1 flex flex-wrap items-center gap-1.5 text-sm text-foreground ${account.hasChildren ? "font-bold" : "font-semibold"}`}>
                          <span style={{ paddingInlineStart: `${LEVEL_INDENT[account.level] * 0.75}rem` }}>{account.name}</span>
                          <span className="text-[10px] font-normal text-muted-foreground">{LEVEL_LABELS[account.level]}</span>
                          {account.isAbnormalBalance ? <StatusBadge tone="danger">ماندهٔ غیرعادی</StatusBadge> : null}
                          {!account.isActive ? <StatusBadge>بایگانی‌شده</StatusBadge> : null}
                        </h3>
                      </div>
                      {account.hasChildren ? <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">گروه</span> : null}
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3">
                      {(presentation === "detailed" ? [
                        ["مانده افتتاحیه بدهکار", "openingDebit"], ["مانده افتتاحیه بستانکار", "openingCredit"],
                        ["گردش بدهکار", "periodDebit"], ["گردش بستانکار", "periodCredit"],
                        ["مانده پایان بدهکار", "closingDebit"], ["مانده پایان بستانکار", "closingCredit"],
                      ] as const : [
                        ["مانده بدهکار", "closingDebit"], ["مانده بستانکار", "closingCredit"],
                      ] as const).map(([label, field]) => (
                        <div key={field} className="min-w-0 rounded-lg bg-muted/60 px-3 py-2.5">
                          <dt className="text-xs text-muted-foreground">{label}</dt>
                          <dd className="mt-1 overflow-x-auto text-end text-sm font-semibold text-foreground">
                            {renderAmountButton(account, field)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
                {rows.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    {data.accounts.length === 0 ? "در این دامنه حسابی با گردش یا مانده وجود ندارد." : "حسابی با این فیلترها یافت نشد."}
                  </p>
                ) : null}
                <dl className="grid grid-cols-2 gap-3 rounded-xl border border-border/80 bg-muted/60 p-4">
                  {(presentation === "detailed" ? [
                    ["جمع افتتاحیه بدهکار", totals.openingDebit], ["جمع افتتاحیه بستانکار", totals.openingCredit],
                    ["جمع گردش بدهکار", totals.periodDebit], ["جمع گردش بستانکار", totals.periodCredit],
                    ["جمع مانده پایان بدهکار", totals.closingDebit], ["جمع مانده پایان بستانکار", totals.closingCredit],
                  ] : [
                    ["جمع مانده بدهکار", totals.closingDebit], ["جمع مانده بستانکار", totals.closingCredit],
                  ]).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                      <dd className="mt-1 overflow-x-auto text-end text-sm font-bold text-foreground">{amount(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          )}
        </div>
      </section>

      {portalReady && data
        ? createPortal(
          <div id="print-sheet-root" className={printStyles.sheet} aria-hidden="true">
          <header>
            <p>{data.businessName}</p>
            <h1>تراز آزمایشی</h1>
            <p>{rangeLabel} — دفتر تجمیعی همهٔ شعب</p>
            <p>تاریخ تولید: {toPersianDigits(formatJalali(new Date(), { withMonthName: true }))}</p>
            <p>{balanceStatus} — {healthStatus}</p>
          </header>
          <table>
            <thead>
              <tr>
                <th>کد</th><th>حساب</th><th>نوع</th>
                {presentation === "detailed" ? <>
                  <th>افتتاحیه بدهکار</th><th>افتتاحیه بستانکار</th>
                  <th>گردش بدهکار</th><th>گردش بستانکار</th>
                </> : null}
                <th>مانده بدهکار</th><th>مانده بستانکار</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((account) => (
                <tr key={account.id}>
                  <td>{toPersianDigits(account.code)}</td>
                  <td>{account.name}{!account.isActive ? " (بایگانی‌شده)" : ""}</td>
                  <td>{TYPE_LABELS[account.type]} — {LEVEL_LABELS[account.level]}</td>
                  {presentation === "detailed" ? <>
                    <td>{amount(account.openingDebit)}</td><td>{amount(account.openingCredit)}</td>
                    <td>{amount(account.periodDebit)}</td><td>{amount(account.periodCredit)}</td>
                  </> : null}
                  <td>{amount(account.closingDebit)}</td><td>{amount(account.closingCredit)}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={presentation === "detailed" ? 3 : 3}>جمع حساب‌های نمایش‌داده‌شده</th>
                {presentation === "detailed" ? <>
                  <td>{amount(totals.openingDebit)}</td><td>{amount(totals.openingCredit)}</td>
                  <td>{amount(totals.periodDebit)}</td><td>{amount(totals.periodCredit)}</td>
                </> : null}
                <td>{amount(totals.closingDebit)}</td><td>{amount(totals.closingCredit)}</td>
              </tr>
            </tbody>
          </table>
          </div>,
          document.body,
        )
        : null}

      {drillTarget ? <DrillDownPanel target={drillTarget} onClose={() => setDrillTarget(null)} /> : null}
    </>
  );
}
