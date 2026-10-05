"use client";

/**
 * «گزارش‌های آماده» — the report library.
 *
 * Two things were wrong here before Phase 43, and they had the same root.
 *
 * The list was one flat column of every report the codebase knows, served
 * unfiltered: a jewellery shop scrolled past «چرخش میزها»، «عملکرد پیک‌ها» and
 * «گزارش ضایعات» — three reports over tables that trade never writes, so all
 * three were permanently empty — to reach a P&L, while the reports it actually
 * wanted lived on a different page entirely. The list is now grouped by
 * subject and filtered by trade on the server (`standardReportsFor`), and the
 * trades' own reports have moved in beside the shared ones.
 *
 * And the screen was hand-built: a bespoke two-pane grid, bespoke amber list
 * buttons, a bespoke `CONTROL_CLASS`, a raw `<input type="checkbox">`. Every
 * one of those is a primitive that already exists, so every one of them was a
 * place this page could drift from the rest of the dashboard — and had. It is
 * composed from `SectionCard`/`EmptyState`/`Field`/`Checkbox` now, and the
 * search/group chrome is the only markup it owns.
 */

import { useCallback, useDeferredValue, useEffect, useId, useMemo, useState } from "react";
import { SearchIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { normalizePosSearchText } from "@/lib/pos-selection";
import { cn } from "@/lib/utils";
import { EmptyState, LoadingSkeleton, SectionCard, SectionCardSkeleton, cardClass } from "../page-chrome";
import { JalaliDatePicker } from "../jalali-date-picker";
import { BusinessDayRangePresets } from "./business-day-range";
import { inputClass } from "../ui";
import { ChartPreview, DataTable } from "./chart-preview";
import { ExportButtons } from "./export-buttons";
import { PinToDashboardButton } from "./pin-button";
import { StructuredReportBody } from "./structured-report-body";

import { rowsToChartData, type ChartType, type ReportRow } from "./report-ui";
import {
  COMPARABLE_SHAPES,
  DOCUMENT_SHAPES,
  EXPORT_KIND_BY_SHAPE,
  SNAPSHOT_SHAPES,
  UNDATED_SHAPES,
  comparisonReady as canCompareRange,
  configWithRange,
  errorMessage,
  isInvalidRange,
  type ReportChartConfig,
  type ReportShape,
} from "./standard-report-config";

interface StandardReportDef {
  key: string;
  label: string;
  description: string | null;
  group: string;
  groupLabel: string;
  shape: ReportShape;
  chartType: ChartType | null;
  config: ReportChartConfig | null;
  /** The measure is Rial — render it through the business's money unit. */
  money?: boolean;
}

interface ViewMeta {
  key: string;
  hasDateColumn: boolean;
}

interface SavedReportRow {
  id: string;
  standard_key: string | null;
}

/**
 * Reports whose payload is a structured document rather than a row dump — the
 * ledger statements and every trade report. They are fetched from
 * `/api/reports/standard/[key]` (which computes them) rather than posted to
 * `/api/reports/query` (which only ever aggregates a view).
 */
type ReportPayload = Record<string, unknown>;

/**
 * Headline figures of a document-shaped report (a statement, not a row dump)
 * as one readable sentence — what the assistant gets asked to explain when
 * there are no rows to summarize. The comparison payload wraps the current
 * period under `current`, so unwrap it first. Statement amounts are Rial by
 * contract, so the caller passes the business's money formatter in; unknown
 * shapes contribute nothing rather than fabricated numbers.
 */
function documentFacts(
  document: ReportPayload | null,
  shape: ReportShape,
  formatFigure: (value: number) => string,
): string {
  if (typeof document !== "object" || document === null) return "";
  const root =
    "current" in document && typeof document.current === "object" && document.current !== null
      ? (document.current as ReportPayload)
      : document;
  const parts: string[] = [];
  const figure = (key: string, label: string) => {
    const value = root[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${label}: ${formatFigure(Math.round(value))}`);
    }
  };
  switch (shape) {
    case "profit_and_loss":
      figure("totalRevenue", "جمع درآمدها");
      figure("totalExpenses", "جمع هزینه‌ها");
      figure("costOfSales", "بهای تمام‌شده");
      figure("netIncome", "سود (زیان) خالص");
      break;
    case "balance_sheet":
      figure("totalAssets", "جمع دارایی‌ها");
      figure("totalLiabilities", "جمع بدهی‌ها");
      figure("totalEquity", "جمع حقوق صاحبان سرمایه");
      if (typeof root.balanced === "boolean") {
        parts.push(root.balanced ? "وضعیت تراز: متوازن" : "وضعیت تراز: نامتوازن");
      }
      break;
    case "cash_flow":
      figure("openingCash", "موجودی ابتدای دوره");
      figure("closingCash", "موجودی پایان دوره");
      figure("netChange", "تغییر خالص وجه نقد");
      break;
    case "food_cost_variance":
      figure("theoreticalCost", "بهای نظری");
      figure("actualCogs", "بهای تمام‌شده واقعی");
      figure("variance", "مابه‌التفاوت");
      break;
  }
  return parts.join("؛ ");
}

/**
 * Folds the spelling differences Persian typing produces, so the search box
 * matches what people actually type.
 *
 * The filter was `label.toLowerCase().includes(needle)`, and `toLowerCase` does
 * nothing to Persian: typing «کالای راکد» with the Arabic ك/ي that every Arabic
 * keyboard layout and half of the pasted text in the wild produce found
 * nothing, and «۲۱» never matched a label written with ASCII digits. This is
 * the same normalizer the POS search and every `SearchableSelect` already use,
 * so the report library now searches the way the rest of the product does.
 */
function normalizeSearch(value: string): string {
  return normalizePosSearchText(value);
}

export function StandardReportsSection({ canExplain }: { canExplain: boolean }) {
  const money = useMoney();
  const searchId = useId();
  const resultPanelId = `${useId()}-report-result`;
  const [reports, setReports] = useState<StandardReportDef[] | null>(null);
  const [views, setViews] = useState<ViewMeta[]>([]);
  const [savedIds, setSavedIds] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<StandardReportDef | null>(null);
  const [search, setSearch] = useState("");
  // Keep keystrokes urgent while React updates the filtered report list at a
  // lower priority. This matters on the lower-powered tablets used at the POS.
  const deferredSearch = useDeferredValue(search);
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [compare, setCompare] = useState(false);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [document, setDocument] = useState<ReportPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  // Starts true: the mount effect issues the first read immediately, so before
  // that finishes the honest state is "loading" — rendering the null-payload
  // fallback then would flash «نتیجه‌ای یافت نشد» for one frame.
  const [loading, setLoading] = useState(true);
  /**
   * The range the numbers on screen were actually read for.
   *
   * The export button and the assistant's "explain this" prompt both used the
   * *live* `dateFrom`/`dateTo`, which is a different range from the one the
   * result was computed for during the moment between changing a date and the
   * refetch landing — so an export could describe itself with a period the
   * figures in it never covered.
   */
  const [loadedRange, setLoadedRange] = useState({ dateFrom: "", dateTo: "" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/reports/standard")
      .then((response) => (response.ok ? response.json() : { reports: [] }))
      .then((data) => {
        if (!cancelled) setReports(data.reports ?? []);
      })
      .catch(() => {
        if (!cancelled) setReports([]);
      });
    fetch("/api/reports/views")
      .then((response) => (response.ok ? response.json() : { views: [] }))
      .then((data) => {
        if (!cancelled) setViews(data.views ?? []);
      })
      .catch(() => {
        if (!cancelled) setViews([]);
      });
    fetch("/api/reports/saved")
      .then((response) => (response.ok ? response.json() : { reports: [] }))
      .then((data) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const report of (data.reports ?? []) as SavedReportRow[]) {
          if (report.standard_key) map.set(report.standard_key, report.id);
        }
        setSavedIds(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const isDocument = selected ? DOCUMENT_SHAPES.has(selected.shape) : false;
  const hasDateColumn = selected?.config
    ? Boolean(views.find((view) => view.key === selected.config!.view)?.hasDateColumn)
    : false;
  const acceptsDateRange = selected
    ? (isDocument && !UNDATED_SHAPES.has(selected.shape)) || hasDateColumn
    : false;
  const canCompare = selected ? COMPARABLE_SHAPES.has(selected.shape) : false;
  /** A point-in-time statement: only an as-of date means anything to it. */
  const isSnapshot = selected ? SNAPSHOT_SHAPES.has(selected.shape) : false;
  // Each snapshot names its cutoff the way an owner would: a balance sheet
  // has a «تاریخ ترازنامه», the warranty register a plain «تا تاریخ».
  const snapshotDateLabel =
    selected?.shape === "balance_sheet" ? "تاریخ ترازنامه" : "تا تاریخ";
  const invalidRange = selected ? isInvalidRange(selected.shape, dateFrom, dateTo) : false;
  const comparisonReady = selected ? canCompareRange(selected.shape, dateFrom, dateTo) : false;

  // Keep the checkbox honest if the range that justified it is cleared.
  useEffect(() => {
    if (compare && !comparisonReady) setCompare(false);
  }, [compare, comparisonReady]);

  /**
   * How this report's measure is written. Money metrics are Rial in the
   * database and must be shown in the unit the business chose; a count of
   * orders or a table-turn time must not be.
   */
  const formatValue = useCallback(
    (value: number) =>
      selected?.money
        ? money.format(Math.round(value))
        : formatPersianNumber(Math.round(value)),
    [selected?.money, money],
  );

  /**
   * Reads the selected report.
   *
   * Every request carries an `AbortSignal` tied to the effect that started it,
   * because this refetches on each keystroke-sized change (a new report, a new
   * date, the compare toggle) and the responses do not have to come back in the
   * order they were sent. Without it a slow request for the report you just
   * navigated away from could land last and paint its rows under the *new*
   * report's title — the report library's worst possible failure, since both
   * screens look equally plausible.
   */
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!selected) return;
      // Don't spend a request on a range the user can see is wrong; the inline
      // message beside the pickers already says what to fix. Same predicate the
      // message uses, so the two can't disagree about what "wrong" means.
      if (isInvalidRange(selected.shape, dateFrom, dateTo)) {
        setLoading(false);
        setRows(null);
        setDocument(null);
        setLoadError("");
        return;
      }
      setLoading(true);
      setLoadError("");
      const requestedRange = { dateFrom, dateTo };
      try {
        if (DOCUMENT_SHAPES.has(selected.shape)) {
          const params = new URLSearchParams();
          if (dateFrom) params.set("dateFrom", dateFrom);
          if (dateTo) params.set("dateTo", dateTo);
          if (compare && COMPARABLE_SHAPES.has(selected.shape)) {
            params.set("compare", "1");
            // A snapshot has no period length to mirror, so
            // `getBalanceSheetComparison` needs the earlier as-of date spelled
            // out and returns `previous: null` without it — the checkbox
            // appeared to do nothing on the one statement where an owner most
            // expects a side-by-side. The extra picker beside it collects the
            // date into `dateFrom`.
            if (SNAPSHOT_SHAPES.has(selected.shape) && dateFrom) {
              params.set("previousAsOfDate", dateFrom);
            }
          }
          const query = params.toString();
          const response = await fetch(
            `/api/reports/standard/${encodeURIComponent(selected.key)}${query ? `?${query}` : ""}`,
            { signal },
          );
          const data = await response.json().catch(() => ({}));
          if (signal.aborted) return;
          if (!response.ok) {
            setLoadError(errorMessage(response.status));
            setDocument(null);
            setRows(null);
            return;
          }
          setDocument(data.report ?? data.comparison ?? null);
          setRows(null);
          setLoadedRange(requestedRange);
          return;
        }
        const response = await fetch("/api/reports/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(configWithRange(selected.config, dateFrom, dateTo)),
          signal,
        });
        const data = await response.json().catch(() => ({}));
        if (signal.aborted) return;
        if (!response.ok) {
          setLoadError(errorMessage(response.status));
          setRows(null);
          setDocument(null);
          return;
        }
        setRows(data.rows ?? []);
        setDocument(null);
        setLoadedRange(requestedRange);
      } catch (error) {
        // An abort is this component replacing its own request, not a failure.
        if (signal.aborted || (error as Error)?.name === "AbortError") return;
        setLoadError("خواندن این گزارش ممکن نشد. اتصال شبکه را بررسی کنید.");
        setRows(null);
        setDocument(null);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [selected, dateFrom, dateTo, compare],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * Grouped, and filtered by the search box. The search matches the label and
   * the description, because an owner looking for "چه چیزی می‌فروشد" types a
   * word from the sentence, not the report's name.
   *
   * Each report's searchable text is normalized once per list rather than once
   * per keystroke per report — the list is short, but this is the same shape
   * the rest of the codebase settled on for filtered lists and it keeps typing
   * smooth on the tablets this runs on.
   */
  const searchable = useMemo(
    () =>
      (reports ?? []).map((report) => ({
        report,
        haystack: normalizeSearch(`${report.label} ${report.description ?? ""}`),
      })),
    [reports],
  );

  const groups = useMemo(() => {
    const needle = normalizeSearch(deferredSearch);
    const matching = needle
      ? searchable.filter((entry) => entry.haystack.includes(needle)).map((entry) => entry.report)
      : searchable.map((entry) => entry.report);
    const byGroup = new Map<string, { label: string; reports: StandardReportDef[] }>();
    for (const report of matching) {
      const entry = byGroup.get(report.group) ?? { label: report.groupLabel, reports: [] };
      entry.reports.push(report);
      byGroup.set(report.group, entry);
    }
    return [...byGroup.entries()].map(([key, value]) => ({ key, ...value }));
  }, [searchable, deferredSearch]);

  const totalCount = reports?.length ?? 0;
  const matchCount = groups.reduce((sum, group) => sum + group.reports.length, 0);

  function select(report: StandardReportDef) {
    setSelected(report);
    setChartType(report.chartType ?? "bar");
    setDateFrom("");
    setDateTo("");
    setCompare(false);
    setRows(null);
    setDocument(null);
    setLoadError("");
    setLoadedRange({ dateFrom: "", dateTo: "" });
    // Below `lg` the library is a full-width column with the result *under* it,
    // so tapping a report on a phone changed a screenful of content the person
    // could not see and looked like it had done nothing at all. Take them to
    // the result, the same way the page-level section menu does when it opens
    // a section (see section-nav.tsx).
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      // After paint, so the panel being scrolled to exists.
      requestAnimationFrame(() => {
        window.document.getElementById(resultPanelId)?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    }
  }

  function explainSelectedReport() {
    if (!selected) return;
    // The figures as the screen shows them: money through the business's unit,
    // everything else as a grouped Persian number. Feeding the assistant a bare
    // Rial integer for a Toman business invited it to quote a number ten times
    // what the owner is looking at.
    // Document-shaped reports (the statements) have no rows — pull their
    // headline figures from the payload instead, so «توضیح این عدد» is never
    // sent to the assistant empty-handed over a screen full of numbers.
    const facts = rows
      ? rowsToChartData(rows)
          .slice(0, 8)
          .map(
            (row) =>
              `${row.label}: ${
                selected.money ? money.format(Math.round(row.value)) : formatPersianNumber(Math.round(row.value))
              }`,
          )
          .join("؛ ")
      : documentFacts(document, selected.shape, (value) => money.format(value));
    // Shamsi, like every other date a user sees (AGENTS.md "Shamsi-only dates").
    // This used to interpolate the raw ISO string straight into the prompt.
    const period =
      loadedRange.dateFrom || loadedRange.dateTo
        ? `بازهٔ انتخاب‌شده: ${
            loadedRange.dateFrom ? toPersianDigits(formatJalali(loadedRange.dateFrom)) : "ابتدای داده"
          } تا ${loadedRange.dateTo ? toPersianDigits(formatJalali(loadedRange.dateTo)) : "امروز"}.`
        : "";
    const prompt = [
      `گزارش «${selected.label}» را با اتکا به داده‌های واقعی بررسی و توضیح بده.`,
      period,
      facts ? `دادهٔ نمایشی فعلی: ${facts}.` : "",
      "اگر دادهٔ کافی برای نتیجه‌گیری وجود ندارد، صریح بگو چه گزارشی باید بررسی شود؛ عددی را حدس نزن.",
    ]
      .filter(Boolean)
      .join("\n");
    window.dispatchEvent(new CustomEvent("ai:prefill", { detail: { prompt } }));
  }

  if (!reports) {
    return <SectionCardSkeleton rows={5} label="در حال بارگذاری گزارش‌های آماده" />;
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(15rem,17rem)_minmax(0,1fr)] lg:items-start lg:gap-5">
      <aside className={cn("min-w-0 overflow-hidden lg:sticky lg:top-5", cardClass)}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کتابخانهٔ گزارش</p>
          <h2 className="mt-1 font-semibold text-foreground">گزارش‌های آماده</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            گزارش‌های مشترک، به‌همراه گزارش‌های ویژهٔ کسب‌وکار شما.
          </p>
          <div className="relative mt-3">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            />
            <input
              id={searchId}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="جستجوی گزارش"
              aria-label="جستجوی گزارش"
              aria-describedby={`${searchId}-count`}
              // A search field's own clear button (WebKit) sits at the input's
              // physical end, which in RTL is the *start* — right on top of the
              // magnifier. Padding both sides keeps the text clear of each.
              className={cn(inputClass, "ps-9 pe-9")}
            />
          </div>
          {/*
            Says how many reports the filter left. Without it a search that
            narrows 30 reports to 1 looks identical to a list that was always
            short, and there was nothing to announce the change to a screen
            reader either.
          */}
          <p id={`${searchId}-count`} aria-live="polite" className="mt-2 text-xs text-muted-foreground">
            {search.trim()
              ? `${formatPersianNumber(matchCount)} از ${formatPersianNumber(totalCount)} گزارش`
              : `${formatPersianNumber(totalCount)} گزارش`}
          </p>
        </div>

        {/*
          The list scrolls within the sticky card on a desktop. On a phone it is
          capped instead of running the full height of the document: an
          unbounded list of every report in the trade pushed the result — the
          thing the person came for — several screens down the page.
        */}
        <nav
          aria-label="فهرست گزارش‌های آماده"
          className="max-h-[22rem] overflow-y-auto p-2 lg:max-h-[calc(100dvh-21rem)]"
        >
          {groups.map((group) => (
            <div key={group.key} className="mb-3 last:mb-0">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.reports.map((report) => {
                  const isSelected = selected?.key === report.key;
                  return (
                    <button
                      key={report.key}
                      type="button"
                      aria-current={isSelected ? "page" : undefined}
                      // Points at the result region this button fills, so the
                      // relationship is not purely visual.
                      aria-controls={resultPanelId}
                      onClick={() => select(report)}
                      className={cn(
                        "flex min-h-11 w-full items-center rounded-xl px-3 py-2 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40",
                        isSelected
                          ? "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                          // `text-muted-foreground` on a long list of names is
                          // below AA on the card background; the names are the
                          // content here, not secondary detail.
                          : "text-foreground/80 hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {/* `break-words`: a long report name used to overflow the
                          17rem rail rather than wrap inside it. */}
                      <span className="min-w-0 flex-1 break-words">{report.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {matchCount === 0 ? (
            <div className="p-2">
              <EmptyState>
                {totalCount === 0
                  ? "گزارش آماده‌ای برای این کسب‌وکار تعریف نشده است."
                  : "گزارشی با این نام پیدا نشد."}
              </EmptyState>
            </div>
          ) : null}
        </nav>
      </aside>

      {/*
        A region, not a live region. `aria-live="polite"` on a container this
        large made every re-render — a whole statement, tables and all — queue
        itself to be read out; the polite announcement that belongs here is the
        short status line inside `ReportBody`, which owns one now.
      */}
      <div id={resultPanelId} role="region" aria-label="نتیجهٔ گزارش" className="min-w-0 scroll-mt-4">
        {!selected ? (
          <SectionCard title="پیش‌نمایش گزارش" description="برای دیدن نتیجه، یک گزارش را از فهرست انتخاب کنید.">
            <EmptyState>یک گزارش را از فهرست انتخاب کنید.</EmptyState>
          </SectionCard>
        ) : (
          <div className="min-w-0 space-y-4 sm:space-y-5">
            <SectionCard
              title={selected.label}
              description={selected.description ?? undefined}
              footer={`گروه: ${selected.groupLabel}`}
            >
              {acceptsDateRange || selected.chartType ? (
                <div className="grid gap-4">
                  {acceptsDateRange ? (
                    <>
                      {/*
                        A balance sheet is a snapshot, not a period: only the
                        as-of date moves it. Labelling its single meaningful
                        field «تا تاریخ» next to an «از تاریخ» that changes
                        nothing invited people to set a range and trust a figure
                        that ignored half of it — so the snapshot reports show
                        one clearly-named field, and the second date appears
                        only where it is really the start of a period.
                      */}
                      <div className={cn("grid gap-3", !isSnapshot && "sm:grid-cols-2")}>
                        {isSnapshot ? null : (
                          <label className="block">
                            <span className="mb-1.5 block text-sm font-medium text-foreground">از تاریخ</span>
                            <JalaliDatePicker
                              value={dateFrom}
                              onChange={setDateFrom}
                              placeholder="از تاریخ"
                              className={inputClass}
                            />
                          </label>
                        )}
                        <label className="block">
                          <span className="mb-1.5 block text-sm font-medium text-foreground">
                            {isSnapshot ? snapshotDateLabel : "تا تاریخ"}
                          </span>
                          <JalaliDatePicker
                            value={dateTo}
                            onChange={setDateTo}
                            placeholder={isSnapshot ? snapshotDateLabel : "تا تاریخ"}
                            className={inputClass}
                          />
                        </label>
                        {isSnapshot && compare ? (
                          <label className="block">
                            <span className="mb-1.5 block text-sm font-medium text-foreground">
                              مقایسه با تاریخ
                            </span>
                            <JalaliDatePicker
                              value={dateFrom}
                              onChange={setDateFrom}
                              placeholder="تاریخ دورهٔ قبل"
                              className={inputClass}
                            />
                          </label>
                        ) : null}
                      </div>
                      {/*
                        A snapshot has no period to preset — "this month" means
                        nothing to a balance sheet, and applying a range's start
                        to it would set the comparison date behind the user's
                        back.
                      */}
                      {isSnapshot ? null : (
                        <BusinessDayRangePresets
                          onSelect={(range) => {
                            setDateFrom(range.dateFrom);
                            setDateTo(range.dateTo);
                          }}
                          onClear={() => {
                            setDateFrom("");
                            setDateTo("");
                          }}
                        />
                      )}
                      {/*
                        An inverted range is a real mistake people make with two
                        separate pickers, and it used to fail in two different
                        silent ways: `/api/reports/query` rejected it with the
                        generic "could not read" message, while the document
                        reports accepted it and returned a confidently empty
                        statement. Neither said what was wrong; this does, and
                        `load` refuses to send the request at all.
                      */}
                      {invalidRange ? (
                        <p role="alert" className="text-sm font-medium text-destructive">
                          «از تاریخ» بعد از «تا تاریخ» است؛ ترتیب بازه را اصلاح کنید.
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  {selected.chartType ? (
                    <label className="block sm:max-w-xs">
                      <span className="mb-1.5 block text-sm font-medium text-foreground">نوع نمایش</span>
                      <SearchableSelect
                        className={inputClass}
                        value={chartType}
                        onChange={(value) => setChartType(value as ChartType)}
                        options={[
                          { value: "bar", label: "میله‌ای" },
                          { value: "line", label: "خطی" },
                          { value: "pie", label: "دایره‌ای" },
                          { value: "number", label: "عدد" },
                        ]}
                      />
                    </label>
                  ) : null}

                  {canCompare ? (
                    <div>
                      <label className="flex min-h-11 w-fit cursor-pointer items-center gap-3 rounded-xl border border-border/80 bg-muted px-3 text-sm text-foreground">
                        <Checkbox
                          checked={compare}
                          // Comparison needs a period to mirror (P&L/cash flow)
                          // or an earlier as-of date (balance sheet), and both
                          // come from the range. Ticking it with no range
                          // returned `previous: null` and drew nothing, so the
                          // control now says so instead of looking broken.
                          disabled={!comparisonReady}
                          onCheckedChange={(value) => setCompare(value === true)}
                        />
                        مقایسه با دورهٔ قبل
                      </label>
                      {!comparisonReady ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          برای مقایسه، هر دو سر بازهٔ تاریخ را انتخاب کنید.
                        </p>
                      ) : isSnapshot && compare && !dateFrom ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          تاریخ مقایسه را انتخاب کنید تا ترازنامهٔ آن تاریخ کنار ترازنامهٔ فعلی نمایش داده شود.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  این گزارش وضعیت لحظه‌ای را نشان می‌دهد و بازهٔ تاریخ نمی‌گیرد.
                </p>
              )}
            </SectionCard>

            <ReportBody
              report={selected}
              rows={rows}
              document={document}
              chartType={chartType}
              dateFrom={loadedRange.dateFrom}
              dateTo={loadedRange.dateTo}
              error={loadError}
              loading={loading}
              invalidRange={invalidRange}
              // Money metrics go through the business's unit; everything else
              // stays a plain grouped number.
              formatValue={formatValue}
            />

            <SectionCard title="خروجی و اشتراک‌گذاری">
              <div className="flex flex-wrap items-center gap-2">
                {/*
                  Exports describe the range the figures on screen were read
                  for (`loadedRange`), not whatever is currently in the pickers
                  — otherwise a file could be stamped «از … تا …» with a period
                  its own numbers never covered. `disabled` while a read is in
                  flight or failed, since there is nothing truthful to export.
                */}
                {selected.shape === "rows" || EXPORT_KIND_BY_SHAPE[selected.shape] ? (
                  <ExportButtons
                    disabled={loading || Boolean(loadError) || invalidRange || (rows === null && document === null)}
                    request={
                      EXPORT_KIND_BY_SHAPE[selected.shape]
                        ? {
                            title: selected.label,
                            kind: EXPORT_KIND_BY_SHAPE[selected.shape],
                            dateFrom: loadedRange.dateFrom,
                            dateTo: loadedRange.dateTo,
                          }
                        : {
                            title: selected.label,
                            kind: "chart",
                            // Same merge as the on-screen query, so the export
                            // is the same report — COGS stayed COGS.
                            config: configWithRange(
                              selected.config,
                              loadedRange.dateFrom,
                              loadedRange.dateTo,
                            ),
                          }
                    }
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    برای این گزارش هنوز خروجی فایل تعریف نشده است.
                  </p>
                )}
                {canExplain && (rows !== null || document !== null) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={explainSelectedReport}
                    className="min-h-11 gap-1.5 border-amber-200 bg-amber-50 px-3 font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/20"
                  >
                    <SparklesIcon className="size-4" aria-hidden="true" /> توضیح این عدد
                  </Button>
                ) : null}
                {selected.chartType && savedIds.has(selected.key) ? (
                  <PinToDashboardButton
                    savedReportId={savedIds.get(selected.key)!}
                    chartType={chartType}
                    title={selected.label}
                  />
                ) : null}
              </div>
            </SectionCard>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The result itself. Split out so the shape→view mapping is one readable
 * table rather than a nested ternary inside the page's layout.
 */
function ReportBody({
  report,
  rows,
  document,
  chartType,
  dateFrom,
  dateTo,
  error,
  loading,
  invalidRange,
  formatValue,
}: {
  report: StandardReportDef;
  rows: ReportRow[] | null;
  document: ReportPayload | null;
  chartType: ChartType;
  dateFrom: string;
  dateTo: string;
  error: string;
  loading: boolean;
  invalidRange: boolean;
  formatValue: (value: number) => string;
}) {
  if (invalidRange) {
    return (
      <SectionCard title="نتیجهٔ گزارش">
        <EmptyState>پس از اصلاح بازهٔ تاریخ، گزارش دوباره خوانده می‌شود.</EmptyState>
      </SectionCard>
    );
  }

  if (error) {
    return (
      <SectionCard title="نتیجهٔ گزارش">
        {/* `role="alert"`: a failed read is the one thing here worth
            interrupting a screen reader for. */}
        <div role="alert">
          <EmptyState>{error}</EmptyState>
        </div>
      </SectionCard>
    );
  }

  if (DOCUMENT_SHAPES.has(report.shape)) {
    if (document === null) {
      // A finished request with no payload surely isn't "loading" any more —
      // say so instead of leaving a skeleton spinning forever.
      return (
        <SectionCard title="نتیجهٔ گزارش">
          {loading ? (
            <LoadingSkeleton rows={4} label={`در حال خواندن ${report.label}`} />
          ) : (
            <EmptyState>نتیجه‌ای برای این گزارش یافت نشد.</EmptyState>
          )}
        </SectionCard>
      );
    }

    // The ledger statements keep their own padded card: they are documents with
    // internal sections, not a single table.
    return (
      <SectionCard title="نتیجهٔ گزارش">
        <StructuredReportBody shape={report.shape} payload={document} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />
      </SectionCard>
    );
  }

  if (rows === null) {
    return (
      <SectionCard title="نتیجهٔ گزارش">
        {loading ? (
          <LoadingSkeleton rows={4} label={`در حال خواندن ${report.label}`} />
        ) : (
          <EmptyState>نتیجه‌ای برای این گزارش یافت نشد.</EmptyState>
        )}
      </SectionCard>
    );
  }

  const data = rowsToChartData(rows);
  const rowLimit = typeof report.config?.limit === "number" ? report.config.limit : null;

  /*
    An empty result used to render a chart of nothing above a table of nothing —
    two blank cards that read like a broken screen rather than an answer. Say it
    once, and say which lever to pull.
  */
  if (data.length === 0) {
    return (
      <SectionCard title="نتیجهٔ گزارش">
        <EmptyState>
          {dateFrom || dateTo
            ? "برای این بازهٔ تاریخ داده‌ای ثبت نشده است. بازهٔ دیگری را امتحان کنید."
            : "هنوز داده‌ای برای این گزارش ثبت نشده است."}
        </EmptyState>
      </SectionCard>
    );
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5" aria-busy={loading || undefined}>
      {/*
        The one polite live region on the result side: a short sentence, so a
        screen reader hears "۱۲ ردیف" instead of the entire table being
        re-announced on every refetch.
      */}
      <p aria-live="polite" className="sr-only">
        {loading ? `در حال خواندن ${report.label}` : `${report.label}: ${formatPersianNumber(data.length)} ردیف`}
      </p>
      <SectionCard title="نمودار">
        <ChartPreview chartType={chartType} data={data} label={report.label} formatValue={formatValue} />
      </SectionCard>
      <SectionCard
        title="داده‌های گزارش"
        flush
        /*
          Several standard reports are top-N by definition — «پرفروش‌ترین
          کالاها» is `limit: 10` — and the table gave no sign of it, so ten rows
          of a two-hundred-item menu read as the whole menu and any total summed
          off it was wrong. Only shown when the limit actually bit.
        */
        footer={
          rowLimit && rows.length >= rowLimit
            ? `این گزارش ${formatPersianNumber(rowLimit)} مورد برتر را نشان می‌دهد، نه همهٔ ردیف‌ها.`
            : undefined
        }
      >
        <DataTable columns={["بُعد", "مقدار"]} data={data} formatValue={formatValue} />
      </SectionCard>
    </div>
  );
}
