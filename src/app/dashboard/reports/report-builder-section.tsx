"use client";

import { EmptyState, LoadingSkeleton, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { JalaliDatePicker } from "../jalali-date-picker";
import { BusinessDayRangePresets } from "./business-day-range";
import { ErrorBox, Field, inputClass } from "../ui";
import { ChartPreview, DataTable } from "./chart-preview";
import { ExportButtons } from "./export-buttons";
import { PinToDashboardButton } from "./pin-button";
import {
  rowsToChartData,
  type Aggregation,
  type ChartType,
  type ReportRow,
} from "./report-ui";
import type { ReportCapabilities } from "@/lib/report-permissions";
import type { ReportConfig } from "@/lib/reports";
import {
  builderConfigFromState,
  builderStateFromConfig,
  previewIsStale,
  type SortBy,
  type SortDir,
} from "./report-builder-config";

/**
 * What `/api/reports/views` publishes about one source. Every picker and every
 * filter below is built from this — the engine's own catalogue — rather than
 * from a hand-written list that can drift away from the SQL whitelist (issue
 * #819: a filter the engine supports but the builder never offered is a
 * capability hidden behind a UI omission).
 */
interface ViewMeta {
  key: string;
  label: string;
  hasDateColumn: boolean;
  dimensions: { key: string; label: string }[];
  metrics: { key: string; label: string; money: boolean; aggregations: Aggregation[] }[];
  /** Equality filters this source accepts, straight from the engine whitelist. */
  filters: { key: string; label: string }[];
}

export type { SortBy, SortDir } from "./report-builder-config";

interface SavedReportRow {
  id: string;
  name: string;
  /** Optional free text saying what the report is for (issue #819, Step 8). */
  description: string | null;
  /** Bumped by every edit, so the list can say whether a shared report changed. */
  version: number;
  /** The stored config; `ReportConfig` is the one shape both sides agree on. */
  config: ReportConfig;
  is_standard: boolean;
}

const AGG_LABELS: Record<Aggregation, string> = {
  sum: "جمع",
  avg: "میانگین",
  count: "تعداد",
  count_distinct: "تعداد یکتا",
};

/**
 * The Report Builder.
 *
 * `capabilities` comes from the server page (issue #819), so the actions the
 * member cannot perform are not drawn: saving, renaming and deleting a saved
 * report need `reports.manage`, and the export buttons need `reports.export`.
 * The routes enforce the same keys — this only keeps the screen from offering
 * a control whose request could only answer 403.
 */
export function ReportBuilderSection({ capabilities }: { capabilities: ReportCapabilities }) {
  const money = useMoney();
  const [views, setViews] = useState<ViewMeta[] | null>(null);
  const [saved, setSaved] = useState<SavedReportRow[] | null>(null);

  const [view, setView] = useState("");
  const [metric, setMetric] = useState("");
  const [aggregation, setAggregation] = useState<Aggregation>("sum");
  const [dimension, setDimension] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Engine-supported equality filters (view.filters), keyed by filter key.
  const [equals, setEquals] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState<"" | SortBy>("");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [limit, setLimit] = useState("");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const [rows, setRows] = useState<ReportRow[] | null>(null);
  /**
   * The config that produced `rows`. Export, pin and the stale notice all read
   * this rather than the live draft: what is downloaded must be what is on
   * screen (issue #819 — the file used to be built from controls the reader had
   * changed but never previewed).
   */
  const [loadedConfig, setLoadedConfig] = useState<ReportConfig | null>(null);
  const [error, setError] = useState("");
  /** Success/confirmation feedback for the saved-report list, announced politely. */
  const [notice, setNotice] = useState("");
  /** Which mutation is running, so one entry is busy without freezing the list. */
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** The entry awaiting delete confirmation — deleting cascades to dashboard widgets. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);
  // Monotonic request id + the in-flight request: a slow first preview must
  // never overwrite a newer one, and a preview superseded by a filter change
  // is aborted rather than left to land late.
  const previewSeq = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  async function loadSaved() {
    try {
      const response = await fetch("/api/reports/saved");
      if (!response.ok) throw new Error("saved_reports_failed");
      const data = await response.json();
      setSaved(data.reports ?? []);
    } catch {
      setSaved([]);
      setError("بارگذاری گزارش‌های ذخیره‌شده ناموفق بود. دوباره تلاش کنید.");
    }
  }

  useEffect(() => {
    fetch("/api/reports/views")
      .then(async (response) => {
        if (!response.ok) throw new Error("views_failed");
        return response.json();
      })
      .then((data) => {
        const list: ViewMeta[] = data.views ?? [];
        setViews(list);
        if (list.length > 0) {
          setView(list[0].key);
          const firstMetric = list[0].metrics[0];
          setMetric(firstMetric?.key ?? "");
          if (firstMetric?.aggregations[0]) setAggregation(firstMetric.aggregations[0]);
          setDimension(list[0].dimensions[0]?.key ?? "");
        }
      })
      .catch(() => setError("بارگذاری منابع گزارش ناموفق بود. صفحه را دوباره بارگذاری کنید."));
    void loadSaved();
  }, []);

  const currentView = useMemo(
    () => views?.find((item) => item.key === view) ?? null,
    [views, view],
  );
  const currentMetric = useMemo(
    () => currentView?.metrics.find((item) => item.key === metric) ?? null,
    [currentView, metric],
  );
  const customReports = (saved ?? []).filter((report) => !report.is_standard);

  /**
   * Metrics don't all support the same aggregations (a distinct-count metric
   * supports only count_distinct), so the picked aggregation is clamped to the
   * new metric's list instead of being left as-is — otherwise the config the
   * form submits is one the server rejects.
   */
  function selectMetric(key: string, from: ViewMeta | null = currentView) {
    setMetric(key);
    const aggregations = from?.metrics.find((item) => item.key === key)?.aggregations ?? [];
    if (aggregations.length > 0 && !aggregations.includes(aggregation)) {
      setAggregation(aggregations[0]);
    }
  }

  function selectView(key: string) {
    setView(key);
    const nextView = views?.find((item) => item.key === key) ?? null;
    selectMetric(nextView?.metrics[0]?.key ?? "", nextView);
    setDimension(nextView?.dimensions[0]?.key ?? "");
    // Date filters belong to the selected source. Keeping them when switching
    // to a source without a date column makes an otherwise valid form fail on
    // the server with a confusing "not date filterable" error.
    if (!nextView?.hasDateColumn) {
      setDateFrom("");
      setDateTo("");
    }
    // Equality filters are per-source keys; carrying them across sources makes
    // the next preview fail validation with a confusing message.
    setEquals({});
    setRows(null);
    setError("");
  }

  /**
   * The loaded form as a report config. The same object feeds the preview, the
   * save/update body, the export and the pin, so what is exported is what was
   * on screen — not a second, separately-assembled config (issue #819).
   */
  function currentConfig(): ReportConfig {
    return builderConfigFromState(
      {
        view,
        metric,
        aggregation,
        dimension,
        dateFrom,
        dateTo,
        equals,
        sortBy,
        sortDir,
        limit,
        chartType,
      },
      (currentView?.filters ?? []).map((filter) => filter.key),
    );
  }

  async function preview() {
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setError("تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.");
      return;
    }
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const seq = ++previewSeq.current;
    // The exact object that goes on the wire is remembered with the rows, so
    // "what produced this result" is a fact rather than a reconstruction.
    const config = currentConfig();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reports/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (seq !== previewSeq.current) return; // a newer preview is on its way
      if (!response.ok) {
        setError(data.details?.join(" ") ?? "پیکربندی گزارش نامعتبر است.");
        return;
      }
      setRows(data.rows ?? []);
      setLoadedConfig(config);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (seq !== previewSeq.current) return;
      setError("دریافت پیش‌نمایش ناموفق بود. اتصال شبکه را بررسی کنید.");
    } finally {
      if (seq === previewSeq.current) setBusy(false);
    }
  }

  async function save() {
    if (!name.trim()) {
      setError("برای ذخیرهٔ گزارش، نامی وارد کنید.");
      return;
    }
    setBusy(true);
    setError("");
    const url = editingId
      ? "/api/reports/saved/" + editingId
      : "/api/reports/saved";
    try {
      const response = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, config: currentConfig() }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.details?.join(" ") ?? "ذخیرهٔ گزارش ناموفق بود.");
        return;
      }
      setEditingId(null);
      setName("");
      setDescription("");
      setNotice(editingId ? "گزارش به‌روزرسانی شد." : "گزارش ذخیره شد.");
      void loadSaved();
    } catch {
      setError("ذخیرهٔ گزارش ناموفق بود. اتصال شبکه را بررسی کنید.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Loads every stored field back into the form. Anything dropped here is lost
   * on the next save: the old version restored only view/metric/aggregation/
   * dimension/dates, so editing a saved report silently reset its filters,
   * sort, Top-N and chosen chart (issue #819).
   */
  function loadIntoBuilder(report: SavedReportRow) {
    const state = builderStateFromConfig(report.config);
    setView(state.view);
    setMetric(state.metric);
    setAggregation(state.aggregation);
    setDimension(state.dimension);
    setDateFrom(state.dateFrom);
    setDateTo(state.dateTo);
    setEquals(state.equals);
    setSortBy(state.sortBy);
    setSortDir(state.sortDir);
    setLimit(state.limit);
    setChartType(state.chartType);
    setName(report.name);
    setDescription(report.description ?? "");
    setEditingId(report.id);
    setRows(null);
    setError("");
  }

  /**
   * Deletes a saved report, with the failure handling the old one-liner did not
   * have (issue #819): it ignored `response.ok`, so a 403 or 404 looked exactly
   * like success and the row simply stayed. Deleting a report also removes every
   * dashboard widget pinned to it — `dashboard_widgets.saved_report_id` is
   * `ON DELETE CASCADE` (migration 0008) — so the confirmation says so.
   */
  async function remove(id: string) {
    setPendingId(id);
    setListError("");
    setNotice("");
    try {
      const response = await fetch("/api/reports/saved/" + id, {
        method: "DELETE",
      });
      if (!response.ok) {
        setListError("حذف گزارش انجام نشد. دسترسی یا اتصال را بررسی کنید.");
        return;
      }
      setConfirmingDelete(null);
      setNotice("گزارش حذف شد؛ ویجت‌های سنجاق‌شدهٔ آن هم از داشبورد برداشته شدند.");
      if (editingId === id) {
        setEditingId(null);
        setName("");
      }
      void loadSaved();
    } catch {
      setListError("حذف گزارش انجام نشد. اتصال شبکه را بررسی کنید.");
    } finally {
      setPendingId(null);
    }
  }

  /** A copy of a saved report under a new name — the same config, a new row. */
  async function duplicate(report: SavedReportRow) {
    setPendingId(report.id);
    setListError("");
    setNotice("");
    try {
      const response = await fetch("/api/reports/saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${report.name} (کپی)`, config: report.config }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setListError(data.details?.join(" ") ?? "ساخت نسخهٔ کپی انجام نشد.");
        return;
      }
      setNotice("نسخهٔ کپی ساخته شد.");
      void loadSaved();
    } catch {
      setListError("ساخت نسخهٔ کپی انجام نشد. اتصال شبکه را بررسی کنید.");
    } finally {
      setPendingId(null);
    }
  }

  if (!views) {
    return (
      <SectionCardSkeleton rows={4} label="در حال بارگذاری گزارش‌ساز" />
    );
  }

  // The engine marks money metrics (Rial amounts) in `/api/reports/views`; the
  // preview must render them through the business's display unit, or a business
  // showing «تومان» reads its own sales ten times too high (issue #819).
  const formatValue = currentMetric?.money ? money.format : undefined;

  /**
   * True when the controls no longer describe the result on screen (issue
   * #819). Compared as JSON over the config the form would submit — the same
   * object the preview sent — so "dirty" means exactly "the next Preview
   * would send something different".
   */
  const isDirty = previewIsStale(currentConfig(), loadedConfig);

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="گزارش‌ساز"
        description="منبع، معیار و نحوهٔ نمایش گزارش را با داده‌های موجود تنظیم کنید."
      >
        <div aria-busy={busy}>
          <ErrorBox>{error}</ErrorBox>

          <div className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="منبع داده">
              <SearchableSelect
                className={inputClass}
                value={view}
                onChange={selectView}
                options={views.map((item) => ({ value: item.key, label: item.label }))}
              />
            </Field>

            <Field label="معیار">
              <SearchableSelect
                className={inputClass}
                value={metric}
                onChange={(value) => selectMetric(value)}
                options={(currentView?.metrics ?? []).map((item) => ({
                  value: item.key,
                  label: item.label,
                }))}
              />
            </Field>

            <Field label="نوع تجمیع">
              <SearchableSelect
                className={inputClass}
                value={aggregation}
                onChange={(value) => setAggregation(value as Aggregation)}
                options={(currentMetric?.aggregations ?? ["sum"]).map((item) => ({
                  value: item,
                  label: AGG_LABELS[item],
                }))}
              />
            </Field>

            <Field label="بُعد">
              <SearchableSelect
                className={inputClass}
                value={dimension}
                onChange={setDimension}
                options={(currentView?.dimensions ?? []).map((item) => ({
                  value: item.key,
                  label: item.label,
                }))}
              />
            </Field>
          </div>

          {currentView?.hasDateColumn ? (
            <fieldset className="mt-1 rounded-xl border border-border/80 bg-muted p-3 sm:p-4">
              <legend className="px-1 text-sm font-semibold text-foreground">
                بازهٔ تاریخ
              </legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    از تاریخ
                  </span>
                  <JalaliDatePicker
                    value={dateFrom}
                    onChange={setDateFrom}
                    placeholder="از تاریخ"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    تا تاریخ
                  </span>
                  <JalaliDatePicker
                    value={dateTo}
                    onChange={setDateTo}
                    placeholder="تا تاریخ"
                    className={inputClass}
                  />
                </label>
              </div>
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
            </fieldset>
          ) : null}

          {(currentView?.filters.length ?? 0) > 0 ? (
            <fieldset className="mt-3 rounded-xl border border-border/80 bg-muted p-3 sm:p-4">
              <legend className="px-1 text-sm font-semibold text-foreground">
                فیلترها
              </legend>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                فیلترهای پشتیبانی‌شدهٔ همین منبع داده. مقدار خالی یعنی فیلتر اعمال نشود.
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {currentView?.filters.map((filter) => (
                  <label key={filter.key} className="block">
                    <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {filter.label}
                    </span>
                    <input
                      className={inputClass}
                      value={equals[filter.key] ?? ""}
                      placeholder={filter.label}
                      onChange={(event) =>
                        setEquals((current) => ({ ...current, [filter.key]: event.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <div className="mt-3 grid gap-3 rounded-xl border border-border/80 bg-muted p-3 sm:grid-cols-3 sm:p-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                ترتیب
              </span>
              <SearchableSelect
                className={inputClass}
                value={sortBy}
                onChange={(value) => setSortBy(value as "" | SortBy)}
                options={[
                  { value: "", label: "پیش‌فرض منبع" },
                  { value: "dimension", label: "بر اساس بُعد" },
                  { value: "metric", label: "بر اساس مقدار" },
                ]}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                جهت ترتیب
              </span>
              <SearchableSelect
                className={inputClass}
                value={sortDir}
                onChange={(value) => setSortDir(value as SortDir)}
                options={[
                  { value: "desc", label: "نزولی" },
                  { value: "asc", label: "صعودی" },
                ]}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                حداکثر ردیف (Top-N)
              </span>
              <input
                className={inputClass}
                inputMode="numeric"
                placeholder="بدون محدودیت"
                value={limit}
                onChange={(event) => setLimit(event.target.value.replace(/[^\d]/g, ""))}
              />
            </label>
          </div>

          <div className="mt-5 grid gap-3 border-t border-border pt-5 lg:grid-cols-[auto_minmax(11rem,1fr)_minmax(12rem,1fr)_auto] lg:items-end">
            <Button type="button" size="lg" onClick={preview} disabled={busy} className="px-5 font-semibold">
              پیش‌نمایش
            </Button>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                نوع نمایش
              </span>
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

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                نام گزارش
              </span>
              <input
                className={inputClass}
                placeholder="نام گزارش برای ذخیره"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                توضیح (اختیاری)
              </span>
              <input
                className={inputClass}
                placeholder="این گزارش برای چه پرسشی است؟"
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>

            {capabilities.canManageSavedReports ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={save}
                  disabled={busy}
                  className="font-semibold"
                >
                  {editingId ? "به‌روزرسانی گزارش" : "ذخیرهٔ گزارش"}
                </Button>
                {editingId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    onClick={() => {
                      setEditingId(null);
                      setName("");
                      setDescription("");
                    }}
                    className="text-muted-foreground"
                  >
                    انصراف از ویرایش
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {rows !== null && isDirty ? (
            <p
              role="status"
              className="mt-4 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100"
            >
              تنظیمات تغییر کرده‌اند — برای به‌روزرسانی نتیجه، پیش‌نمایش را اجرا کنید.
            </p>
          ) : null}

          {rows !== null ? (
            <section
              aria-label="خروجی پیش‌نمایش گزارش"
              className="mt-6 space-y-5 border-t border-border pt-5"
            >
              <ChartPreview
                chartType={chartType}
                data={rowsToChartData(rows)}
                label={name || currentView?.label || ""}
                formatValue={formatValue}
              />
              <DataTable
                columns={["بُعد", "مقدار"]}
                data={rowsToChartData(rows)}
                formatValue={formatValue}
              />
              {capabilities.canExportReports ? (
                <div className="border-t border-border pt-4">
                  {/*
                    The file is built from `loadedConfig` — the config that
                    produced the rows above — never from the live draft, so it
                    cannot disagree with what the reader is looking at. While the
                    draft is dirty the buttons are disabled anyway; that is the
                    "optionally disable export until Preview runs again" half of
                    the issue's fix, and belt-and-braces with the config above.
                  */}
                  <ExportButtons
                    disabled={isDirty}
                    request={{
                      title: name || currentView?.label || "گزارش",
                      kind: "chart",
                      config: loadedConfig ?? undefined,
                    }}
                  />
                  {isDirty ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      خروجی از نتیجهٔ فعلی ساخته می‌شود؛ ابتدا پیش‌نمایش را اجرا کنید.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="گزارش‌های سفارشی ذخیره‌شده"
        description="گزارش‌هایی که خودتان ساخته‌اید — قابل ویرایش، سنجاق به داشبورد یا حذف."
        flush
      >
        {/* Feedback for the list's mutations: announced, and never a message
            about one report drawn on another one. */}
        <div className="px-4 pt-3 sm:px-5">
          {listError ? (
            <p role="alert" className="text-xs text-destructive">
              {listError}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </div>
        <ul className="divide-y divide-border px-4 sm:px-5">
          {saved === null ? (
            <li className="py-3">
              <LoadingSkeleton rows={3} compact />
            </li>
          ) : null}

          {customReports.map((report) => {
            const pending = pendingId === report.id;
            const confirming = confirmingDelete === report.id;
            return (
              <li
                key={report.id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block break-words font-semibold text-foreground">
                    {report.name}
                  </span>
                  {report.description ? (
                    <span className="mt-0.5 block break-words text-xs leading-5 text-muted-foreground">
                      {report.description}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    نسخهٔ {toPersianDigits(report.version)}
                  </span>
                </span>
                {confirming ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-xs leading-5 text-muted-foreground">
                      این گزارش و ویجت‌های سنجاق‌شدهٔ آن حذف می‌شوند. مطمئنید؟
                    </span>
                    <Button
                      type="button"
                      variant="destructive"
                      size="lg"
                      disabled={pending}
                      onClick={() => remove(report.id)}
                    >
                      {pending ? "در حال حذف…" : "تأیید حذف"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      disabled={pending}
                      onClick={() => setConfirmingDelete(null)}
                    >
                      انصراف
                    </Button>
                  </div>
                ) : (
                  <div className="grid shrink-0 gap-2 sm:flex sm:flex-wrap">
                    {capabilities.canManageSavedReports ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        disabled={pending}
                        onClick={() => loadIntoBuilder(report)}
                      >
                        ویرایش / تغییر نام
                      </Button>
                    ) : null}
                    <PinToDashboardButton
                      savedReportId={report.id}
                      chartType={report.config.visualization ?? "bar"}
                      title={report.name}
                    />
                    {capabilities.canManageSavedReports ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="lg"
                          disabled={pending}
                          onClick={() => duplicate(report)}
                        >
                          {pending ? "در حال کپی…" : "کپی"}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="lg"
                          disabled={pending}
                          onClick={() => {
                            setListError("");
                            setNotice("");
                            setConfirmingDelete(report.id);
                          }}
                        >
                          حذف
                        </Button>
                      </>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}

          {saved !== null && customReports.length === 0 ? (
            <li className="py-4">
              <EmptyState>
                هنوز گزارش سفارشی‌ای ذخیره نشده است. بالا یک منبع و معیار انتخاب کنید و آن را ذخیره کنید.
              </EmptyState>
            </li>
          ) : null}
        </ul>
      </SectionCard>
    </div>
  );
}
