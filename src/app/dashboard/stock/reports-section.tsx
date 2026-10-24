"use client";

/**
 * Phase 42b — the «گزارش» tab: low-stock and dead-stock reports.
 * Hardened for #917: warehouse-aware, paginated, exact valuation, retry-safe.
 * Exports cover full filtered result via shared codecs; full/page labeling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircleIcon, DownloadIcon, PrinterIcon, RefreshCwIcon, SearchIcon, FileSpreadsheetIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber, formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th, DataTableFoot } from "@/app/dashboard/data-table";
import type { Warehouse } from "./warehouses-section";
import { toCsv, sheetsToXlsxBuffer } from "@/lib/data-transfer/codecs";
import { cellValue, type ReportColumn } from "@/lib/report-export";

interface ReportRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  reorderPoint?: string;
  level?: "out" | "low";
  lastSoldAt?: string | null;
  firstStockedAt?: string | null;
  valueRial?: number;
  valueRialText?: string;
  hasMissingCost?: boolean;
  unitCost?: string | null;
  unit?: string | null;
  category?: string | null;
  ageDays?: number | null;
  tracking?: string | null;
}

interface PaginatedReport {
  rows: ReportRow[];
  total: number;
  pagination: { page: number; pageSize: number; total: number; pages: number } | null;
  summary: {
    totalValueRialText?: string;
    totalValueRial?: number;
    missingCostCount?: number;
    outCount?: number;
    lowCount?: number;
    valuedCount?: number;
  };
}

interface ReportsResponse {
  low: PaginatedReport;
  dead: PaginatedReport;
  applied: {
    locationId: string | null;
    days: number;
    daysApplied: number;
    todayIso: string;
    cutoff: string | null;
    search?: string | null;
    includeInactive?: boolean;
    severity?: string;
    sortBy?: string;
    sortDir?: string;
    category?: string | null;
    valuation?: string | null;
    tracking?: string | null;
  };
}

const DAYS_OPTIONS = [30, 60, 90, 180] as const;

function persianErrorMessage(code?: string, fallback?: string): string {
  const map: Record<string, string> = {
    unauthorized: "وارد نشده‌اید؛ دوباره وارد شوید.",
    forbidden: "دسترسی به گزارش‌ها مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    invalid_days: "بازه زمانی باید عدد صحیح باشد.",
    days_out_of_range: "بازه زمانی باید بین ۱ تا ۳۶۵۰ روز باشد.",
    not_found: "انبار یافت نشد.",
    invalid_today: "تاریخ نامعتبر است.",
    offline: "اتصال اینترنت برقرار نیست؛ اتصال را بررسی کنید.",
  };
  if (code && map[code]) return map[code];
  return fallback || "خطا در دریافت گزارش؛ دوباره تلاش کنید.";
}

function buildExportTable(rows: ReportRow[], type: "low" | "dead"): { columns: ReportColumn[]; rows: Record<string, unknown>[] } {
  const columns: ReportColumn[] = type === "low"
    ? [
        { key: "itemName", label: "کالا" },
        { key: "sku", label: "کد کالا" },
        { key: "category", label: "دسته" },
        { key: "quantity", label: "موجودی" },
        { key: "reorderPoint", label: "نقطه سفارش" },
        { key: "level", label: "وضعیت" },
        { key: "unit", label: "واحد" },
        { key: "unitCost", label: "بهای واحد (ریال)" },
        { key: "valueRialText", label: "ارزش (ریال) — exact" },
        { key: "hasMissingCost", label: "وضعیت بها" },
      ]
    : [
        { key: "itemName", label: "کالا" },
        { key: "sku", label: "کد کالا" },
        { key: "category", label: "دسته" },
        { key: "quantity", label: "موجودی" },
        { key: "lastSoldAt", label: "آخرین فروش معتبر" },
        { key: "firstStockedAt", label: "اولین موجودی" },
        { key: "ageDays", label: "قدمت (روز)" },
        { key: "unit", label: "واحد" },
        { key: "unitCost", label: "بهای واحد (ریال)" },
        { key: "valueRialText", label: "ارزش (ریال) — exact" },
        { key: "hasMissingCost", label: "وضعیت بها" },
      ];
  const exportRows: Record<string, unknown>[] = rows.map((r) => ({
    itemName: r.itemName,
    sku: r.sku ?? "",
    category: r.category ?? "",
    quantity: r.quantity,
    reorderPoint: r.reorderPoint ?? "",
    level: r.level ?? "",
    unit: r.unit ?? "",
    unitCost: r.unitCost ?? "",
    valueRialText: r.valueRialText ?? String(r.valueRial ?? ""),
    hasMissingCost: r.hasMissingCost ? "بها نامشخص" : "ارزش‌دار",
    lastSoldAt: r.lastSoldAt ? formatJalali(r.lastSoldAt) : "بدون فروش",
    firstStockedAt: r.firstStockedAt ? formatJalali(r.firstStockedAt) : "",
    ageDays: r.ageDays != null ? String(r.ageDays) : "",
  }));
  return { columns, rows: exportRows };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsSection() {
  const money = useMoney();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [locationId, setLocationId] = useState<string>("");
  const [days, setDays] = useState<number>(90);
  const [customDays, setCustomDays] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [severity, setSeverity] = useState<"all" | "out" | "low">("all");
  const [sortBy, setSortBy] = useState<string>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [category, setCategory] = useState<string>("");
  const [valuation, setValuation] = useState<"all" | "valued" | "missing">("all");

  const [low, setLow] = useState<PaginatedReport | null>(null);
  const [dead, setDead] = useState<PaginatedReport | null>(null);
  const [applied, setApplied] = useState<ReportsResponse["applied"] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [lowPage, setLowPage] = useState(1);
  const [deadPage, setDeadPage] = useState(1);
  const [warehousesLoading, setWarehousesLoading] = useState(true);
  const [exporting, setExporting] = useState<"low-csv" | "low-xlsx" | "dead-csv" | "dead-xlsx" | null>(null);

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadWarehouses = useCallback(() => {
    setWarehousesLoading(true);
    api<{ warehouses: Warehouse[] }>("/api/stock/warehouses")
      .then(({ ok, data }) => {
        if (ok && Array.isArray(data.warehouses)) {
          setWarehouses(data.warehouses);
          if (!locationId && data.warehouses.length > 0) {
            const active = data.warehouses.find((w) => w.is_active) ?? data.warehouses[0];
            if (active) setLocationId(active.id);
          }
        }
      })
      .catch(() => {})
      .finally(() => setWarehousesLoading(false));
  }, [locationId]);

  useEffect(() => {
    loadWarehouses();
  }, [loadWarehouses]);

  const buildParams = useCallback((overrides?: { lowPg?: number; deadPg?: number }) => {
    const curLowPage = overrides?.lowPg ?? lowPage;
    const curDeadPage = overrides?.deadPg ?? deadPage;
    const params = new URLSearchParams();
    if (locationId) params.set("locationId", locationId);
    params.set("days", String(days));
    if (search.trim()) params.set("search", search.trim());
    if (includeInactive) params.set("includeInactive", "true");
    if (severity !== "all") params.set("severity", severity);
    if (category.trim()) params.set("category", category.trim());
    if (valuation !== "all") params.set("valuation", valuation);
    params.set("sortBy", sortBy);
    params.set("sortDir", sortDir);
    params.set("lowPage", String(curLowPage));
    params.set("deadPage", String(curDeadPage));
    return params;
  }, [locationId, days, search, includeInactive, severity, sortBy, sortDir, lowPage, deadPage, category, valuation]);

  const fetchReports = useCallback(
    (opts?: { lowPg?: number; deadPg?: number }) => {
      const curLowPage = opts?.lowPg ?? lowPage;
      const curDeadPage = opts?.deadPg ?? deadPage;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const reqId = ++requestIdRef.current;

      setLoading(true);
      setError("");
      setErrorCode(undefined);

      const params = buildParams({ lowPg: curLowPage, deadPg: curDeadPage });

      api<ReportsResponse>(`/api/stock/reports?${params.toString()}`)
        .then(({ ok, data }) => {
          if (reqId !== requestIdRef.current) return;
          if (controller.signal.aborted) return;
          if (ok) {
            setLow(data.low);
            setDead(data.dead);
            setApplied(data.applied ?? null);
            setError("");
            setErrorCode(undefined);
          } else {
            const code = (data as { error?: string })?.error;
            setErrorCode(code);
            setError(persianErrorMessage(code, (data as { message?: string })?.message));
          }
        })
        .catch((err: unknown) => {
          if (reqId !== requestIdRef.current) return;
          if (controller.signal.aborted) return;
          const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
          setErrorCode(isOffline ? "offline" : undefined);
          setError(isOffline ? persianErrorMessage("offline") : "ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
        })
        .finally(() => {
          if (reqId === requestIdRef.current && !controller.signal.aborted) setLoading(false);
        });
    },
    [buildParams, lowPage, deadPage],
  );

  useEffect(() => {
    if (warehousesLoading && warehouses.length === 0) return;
    fetchReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, days, search, includeInactive, severity, sortBy, sortDir, category, valuation]);

  const goLowPage = useCallback(
    (p: number) => {
      setLowPage(p);
      fetchReports({ lowPg: p, deadPg: deadPage });
    },
    [fetchReports, deadPage],
  );
  const goDeadPage = useCallback(
    (p: number) => {
      setDeadPage(p);
      fetchReports({ lowPg: lowPage, deadPg: p });
    },
    [fetchReports, lowPage],
  );

  const selectedWarehouse = useMemo(
    () => warehouses.find((w) => w.id === locationId) ?? null,
    [warehouses, locationId],
  );

  const lowTotal = low?.total ?? low?.rows.length ?? 0;
  const deadTotal = dead?.total ?? dead?.rows.length ?? 0;
  const lowMissingCost = low?.summary.missingCostCount ?? 0;
  const deadMissingCost = dead?.summary.missingCostCount ?? 0;
  const deadValuedText = dead?.summary.totalValueRialText ?? dead?.rows.reduce((s, r) => s + BigInt(r.valueRialText ?? String(r.valueRial ?? 0)), 0n).toString() ?? "0";
  const lowTotalValueText = low?.summary.totalValueRialText ?? "0";

  const handleDaysSelect = (d: number) => {
    setDays(d);
    setCustomDays("");
    setLowPage(1);
    setDeadPage(1);
  };
  const handleCustomDays = () => {
    const n = Number(customDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      setError(persianErrorMessage("days_out_of_range"));
      return;
    }
    setDays(n);
    setLowPage(1);
    setDeadPage(1);
  };

  const handleRetry = () => fetchReports();
  const handlePrint = useCallback(() => window.print(), []);

  // --- Full filtered export (not just current page) ---
  const fetchFullRows = useCallback(async (type: "low" | "dead"): Promise<ReportRow[]> => {
    const baseParams = buildParams({ lowPg: 1, deadPg: 1 });
    baseParams.set("lowPage", "1");
    baseParams.set("deadPage", "1");
    // Fetch type only to avoid double work; loop pages until total covered
    const first = await api<ReportsResponse>(`/api/stock/reports?${baseParams.toString()}&type=${type}`).then(r => r.data as ReportsResponse);
    const firstReport = type === "low" ? first.low : first.dead;
    let rows = [...(firstReport?.rows ?? [])];
    const total = firstReport?.total ?? rows.length;
    const totalPages = firstReport?.pagination?.pages ?? 1;
    // If more than 1 page, fetch remaining pages sequentially (SQL-bounded, max 10k SKUs)
    for (let p = 2; p <= totalPages; p++) {
      const params = new URLSearchParams(baseParams.toString());
      if (type === "low") params.set("lowPage", String(p));
      else params.set("deadPage", String(p));
      params.set("type", type);
      const res = await api<ReportsResponse>(`/api/stock/reports?${params.toString()}`).then(r => r.data as ReportsResponse);
      const report = type === "low" ? res.low : res.dead;
      if (report?.rows) rows = rows.concat(report.rows);
      if (rows.length >= total) break;
    }
    return rows;
  }, [buildParams]);

  const exportCsv = useCallback(async (type: "low" | "dead") => {
    setExporting(type === "low" ? "low-csv" : "dead-csv");
    try {
      const rows = await fetchFullRows(type);
      const table = buildExportTable(rows, type);
      // Use shared codec: exact valueRialText via cellValue with Jalali handling
      const csv = toCsv(
        table.columns.map(c => c.label),
        table.rows.map(r => table.columns.map(c => cellValue(r[c.key]))),
      );
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const filename = type === "low" ? `low-stock-full-${toPersianDigits(String(rows.length))}.csv` : `dead-stock-full-${toPersianDigits(String(rows.length))}.csv`;
      downloadBlob(blob, filename);
    } catch {
      setError("خروجی CSV ناموفق بود.");
    } finally {
      setExporting(null);
    }
  }, [fetchFullRows]);

  const exportXlsx = useCallback(async (type: "low" | "dead") => {
    setExporting(type === "low" ? "low-xlsx" : "dead-xlsx");
    try {
      const rows = await fetchFullRows(type);
      const table = buildExportTable(rows, type);
      const buf = await sheetsToXlsxBuffer([{
        name: type === "low" ? "کمبود موجودی — کل فیلتر" : "کالای راکد — کل فیلتر",
        columns: table.columns,
        rows: table.rows,
      }]);
      const blob = new Blob([new Uint8Array(buf)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const filename = type === "low" ? "low-stock-full.xlsx" : "dead-stock-full.xlsx";
      downloadBlob(blob, filename);
    } catch {
      setError("خروجی اکسل ناموفق بود.");
    } finally {
      setExporting(null);
    }
  }, [fetchFullRows]);

  if (loading && !low && !dead) {
    return (
      <div className="space-y-4" dir="rtl">
        <SectionCard title="در حال بارگذاری گزارش‌ها…">
          <LoadingSkeleton rows={3} />
        </SectionCard>
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="کمبود موجودی">
            <LoadingSkeleton rows={4} />
          </SectionCard>
          <SectionCard title="کالای راکد">
            <LoadingSkeleton rows={4} />
          </SectionCard>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4" dir="rtl">
      <SectionCard
        title="تنظیمات گزارش"
        description={
          applied
            ? `انبار: ${selectedWarehouse?.name ?? "—"} · بازهٔ راکد: ${toPersianDigits(String(applied.daysApplied ?? days))} روز · cutoff: ${applied.cutoff ? toPersianDigits(formatJalali(applied.cutoff)) : "—"} · تاریخ گزارش: ${toPersianDigits(formatJalali(applied.todayIso))}`
            : undefined
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">انبار</label>
            <SearchableSelect
              value={locationId}
              onChange={(v) => {
                setLocationId(v);
                setLowPage(1);
                setDeadPage(1);
              }}
              options={warehouses.map((w) => ({ value: w.id, label: `${w.name}${!w.is_active ? " (غیرفعال)" : ""}` }))}
              placeholder={warehousesLoading ? "در حال بارگذاری…" : "انتخاب انبار"}
              ariaLabel="انتخاب انبار"
            />
            {selectedWarehouse ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedWarehouse.name} {selectedWarehouse.address ? `· ${selectedWarehouse.address}` : ""}
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">بازهٔ کالای راکد</label>
            <div className="flex flex-wrap gap-1.5">
              {DAYS_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => handleDaysSelect(d)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${days === d ? "border-amber-300 bg-amber-100 font-semibold text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-100" : "border-border bg-card hover:bg-muted"}`}
                  aria-pressed={days === d}
                >
                  {toPersianDigits(String(d))} روز
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <PersianNumberInput
                value={customDays}
                onChange={(e) => setCustomDays(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="سفارشی"
                className="w-24 rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
                aria-label="بازه سفارشی"
                grouping={false}
              />
              <Button type="button" variant="outline" size="sm" onClick={handleCustomDays} disabled={!customDays}>
                اعمال
              </Button>
              {applied && applied.daysApplied !== 90 ? (
                <span className="text-xs text-muted-foreground">اعمال‌شده: {toPersianDigits(String(applied.daysApplied))} روز · cutoff {applied.cutoff ? toPersianDigits(formatJalali(applied.cutoff)) : "—"}</span>
              ) : applied?.cutoff ? (
                <span className="text-xs text-muted-foreground">cutoff: {toPersianDigits(formatJalali(applied.cutoff))}</span>
              ) : null}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">جستجو (نام/ SKU)</label>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setLowPage(1);
                  setDeadPage(1);
                }}
                placeholder="جستجوی کالا…"
                className="w-full rounded-lg border border-border bg-card py-1.5 pe-3 ps-8 text-sm"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              { (["all", "out", "low"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${severity === s ? "border-amber-300 bg-amber-100 font-semibold text-amber-900 dark:bg-amber-500/20 dark:text-amber-100" : "border-border bg-card"}`}
                >
                  {s === "all" ? "همه" : s === "out" ? "تمام‌شده" : "کم‌موجودی"}
                </button>
              ))}
            </div>
            <div className="mt-2 space-y-1">
              {/* category maps to COALESCE(i.collection, i.season) on server */}
              <label className="block text-xs font-medium text-muted-foreground">دسته (collection)</label>
              <input
                value={category}
                onChange={(e) => { setCategory(e.target.value); setLowPage(1); setDeadPage(1); }}
                placeholder="فیلتر دسته…"
                className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              نمایش کالاهای غیرفعال
            </label>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">ارزش‌گذاری (valuation):</label>
              <select value={valuation} onChange={(e) => setValuation(e.target.value as "all" | "valued" | "missing")} className="rounded-lg border border-border bg-card px-2 py-1 text-xs">
                <option value="all">همه (valuation completeness — همه)</option>
                <option value="valued">ارزش‌دار (has cost)</option>
                <option value="missing">بدون بها (missing_cost)</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">مرتب‌سازی:</label>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="rounded-lg border border-border bg-card px-2 py-1 text-xs">
                <option value="name">نام</option>
                <option value="shortage">کمبود</option>
                <option value="quantity">موجودی</option>
                <option value="value">ارزش</option>
                <option value="age">قدمت</option>
              </select>
              <select value={sortDir} onChange={(e) => setSortDir(e.target.value as "asc" | "desc")} className="rounded-lg border border-border bg-card px-2 py-1 text-xs">
                <option value="asc">صعودی</option>
                <option value="desc">نزولی</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={handleRetry} aria-label="بارگذاری مجدد">
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                به‌روزرسانی
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={handlePrint}>
                <PrinterIcon className="size-4" aria-hidden="true" />
                چاپ / PDF — کل فیلتر
              </Button>
            </div>
          </div>
        </div>

        {error ? (
          <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span className="inline-flex items-center gap-2">
              <AlertCircleIcon className="size-4" aria-hidden="true" />
              {error}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={handleRetry}>
              تلاش دوباره
            </Button>
          </div>
        ) : null}

        {loading ? <p className="mt-2 text-xs text-muted-foreground">در حال به‌روزرسانی…</p> : null}
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SectionCard title="خلاصه کمبود" bodyClassName="text-center">
          <p className="text-2xl font-bold tabular-nums">{toPersianDigits(String(lowTotal))}</p>
          <p className="text-xs text-muted-foreground">قلم {low?.summary.outCount ? `· ${toPersianDigits(String(low?.summary.outCount))} تمام‌شده` : ""} {low?.summary.lowCount ? `· ${toPersianDigits(String(low?.summary.lowCount))} زیر نقطه` : ""}</p>
          {lowMissingCost > 0 ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{toPersianDigits(String(lowMissingCost))} ردیف بدون بهای تمام‌شده</p> : null}
        </SectionCard>
        <SectionCard title="خلاصه راکد" bodyClassName="text-center">
          <p className="text-2xl font-bold tabular-nums">{toPersianDigits(String(deadTotal))}</p>
          <p className="text-xs text-muted-foreground">قلم راکد در {toPersianDigits(String(days))} روز · cutoff {applied?.cutoff ? toPersianDigits(formatJalali(applied.cutoff)) : "—"}</p>
          {deadMissingCost > 0 ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{toPersianDigits(String(deadMissingCost))} ردیف بدون بهای تمام‌شده</p> : null}
        </SectionCard>
        <SectionCard title="ارزش خوابیده (راکد)" bodyClassName="text-center">
          <p className="text-lg font-semibold tabular-nums">{money.formatText(deadValuedText ?? "0")}</p>
          <p className="text-xs text-muted-foreground">جمع ارزش راکد (ریال → {money.unitLabel}) · exact valueRialText</p>
        </SectionCard>
        <SectionCard title="اقدامات — خروجی کل فیلتر" bodyClassName="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => exportCsv("low")} disabled={exporting !== null || !low?.rows.length} aria-label="CSV کمبود — کل فیلتر">
              <DownloadIcon className="size-4" aria-hidden="true" />
              {exporting === "low-csv" ? "…" : "CSV کمبود (کل)"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => exportXlsx("low")} disabled={exporting !== null} aria-label="XLSX کمبود — کل فیلتر">
              <FileSpreadsheetIcon className="size-4" aria-hidden="true" />
              {exporting === "low-xlsx" ? "…" : "اکسل کمبود (کل)"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => exportCsv("dead")} disabled={exporting !== null || !dead?.rows.length} aria-label="CSV راکد — کل فیلتر">
              <DownloadIcon className="size-4" aria-hidden="true" />
              {exporting === "dead-csv" ? "…" : "CSV راکد (کل)"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => exportXlsx("dead")} disabled={exporting !== null} aria-label="XLSX راکد — کل فیلتر">
              <FileSpreadsheetIcon className="size-4" aria-hidden="true" />
              {exporting === "dead-xlsx" ? "…" : "اکسل راکد (کل)"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">خروجی‌ها تمام نتیجهٔ فیلترشده (نه فقط صفحهٔ جاری) را با valueRialText دقیق صادر می‌کنند؛ برچسب «کل فیلتر» vs «صفحه جاری» در نام فایل.</p>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={`کمبود موجودی${severity !== "all" ? ` (${severity === "out" ? "تمام‌شده" : "کم‌موجودی"})` : ""}`}
          description={selectedWarehouse ? `انبار: ${selectedWarehouse.name}` : undefined}
          bodyClassName="space-y-3"
        >
          {error && !low ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center text-sm text-destructive">
              <p>{error}</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={handleRetry}>
                تلاش دوباره
              </Button>
            </div>
          ) : !low || low.rows.length === 0 ? (
            <EmptyState>چیزی زیر نقطهٔ سفارش نیست.</EmptyState>
          ) : (
            <div className="space-y-3">
              <DataTable caption="کمبود موجودی" tableClassName="min-w-[720px]">
                <DataTableHead>
                  <Th>کالا</Th>
                  <Th>کد</Th>
                  <Th>دسته</Th>
                  <Th>واحد</Th>
                  <Th>موجودی / نقطه</Th>
                  <Th>وضعیت</Th>
                  <Th>ارزش — exact</Th>
                  <Th>پیوندها</Th>
                </DataTableHead>
                <DataTableBody>
                  {low.rows.map((r) => (
                    <DataTableRow key={r.itemId}>
                      <Td>
                        <Link href={`/dashboard/inventory?focus=${r.itemId}`} className="font-medium text-foreground hover:underline">
                          {r.itemName}
                        </Link>
                        {r.category ? <span className="ms-1 text-xs text-muted-foreground">· {r.category}</span> : null}
                      </Td>
                      <Td muted>{r.sku ? <span dir="ltr">{r.sku}</span> : "—"}</Td>
                      <Td muted className="text-xs">{r.category ?? "—"}</Td>
                      <Td muted>{r.unit ?? "—"}</Td>
                      <Td className="tabular-nums">
                        <span className="font-medium">{formatQuantity(r.quantity)}</span>
                        <span className="text-xs text-muted-foreground"> از {formatPersianNumber(Number(r.reorderPoint ?? "0"))}</span>
                      </Td>
                      <Td>
                        <StatusBadge tone={r.level === "out" ? "danger" : "active"}>{r.level === "out" ? "تمام شده" : "کم‌موجودی"}</StatusBadge>
                        {r.hasMissingCost ? <span className="ms-1 text-xs text-amber-700 dark:text-amber-300">بها نامشخص</span> : null}
                      </Td>
                      <Td className="tabular-nums">{r.hasMissingCost ? <span className="text-amber-700 dark:text-amber-300">نامشخص</span> : money.formatText(String(r.valueRialText ?? r.valueRial ?? 0))}</Td>
                      <Td className="text-xs">
                        <div className="flex flex-col gap-1">
                          <Link href={`/accounting/inventory?tab=stock-levels&warehouse=${locationId ?? ""}`} className="underline">موجودی انبار</Link>
                          <Link href={`/accounting/inventory?tab=documents&search=${encodeURIComponent(r.sku ?? r.itemName)}`} className="underline">اسناد مرتبط</Link>
                          <Link href={`/dashboard/stock/stock-levels-section?item=${r.itemId}`} className="underline">گزارش حرکت</Link>
                        </div>
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
                {low.summary ? (
                  <DataTableFoot>
                    <tr>
                      <Td colSpan={5} className="font-semibold">
                        جمع {toPersianDigits(String(low.total ?? low.rows.length))} قلم — کل فیلتر {toPersianDigits(String(lowTotal))} · صفحه جاری {toPersianDigits(String(low.rows.length))}
                        {lowMissingCost ? ` · ${toPersianDigits(String(lowMissingCost))} بدون بها` : ""}
                      </Td>
                      <Td colSpan={3} className="font-semibold tabular-nums">{money.formatText(String(lowTotalValueText ?? "0"))} (exact)</Td>
                    </tr>
                  </DataTableFoot>
                ) : null}
              </DataTable>
              {low.pagination && low.pagination.pages > 1 ? (
                <div className="flex items-center justify-between pt-2">
                  <Button variant="outline" size="sm" disabled={(low.pagination?.page ?? 1) <= 1} onClick={() => goLowPage((low.pagination?.page ?? 1) - 1)}>
                    قبلی
                  </Button>
                  <span className="text-xs tabular-nums">
                    صفحه {toPersianDigits(String(low.pagination!.page))} از {toPersianDigits(String(low.pagination!.pages))} · {toPersianDigits(String(low.pagination!.total))} ردیف — کل {toPersianDigits(String(lowTotal))} ردیف فیلترشده
                  </span>
                  <Button variant="outline" size="sm" disabled={(low.pagination?.page ?? 1) >= (low.pagination?.pages ?? 1)} onClick={() => goLowPage((low.pagination?.page ?? 1) + 1)}>
                    بعدی
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title={`کالای راکد (${toPersianDigits(String(days))} روز بدون فروش)`}
          description={selectedWarehouse ? `انبار: ${selectedWarehouse.name} · cutoff ${applied?.cutoff ? formatJalali(applied.cutoff) : "—"}` : undefined}
          bodyClassName="space-y-3"
        >
          {error && !dead ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center text-sm text-destructive">
              <p>{error}</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={handleRetry}>
                تلاش دوباره
              </Button>
            </div>
          ) : !dead || dead.rows.length === 0 ? (
            <EmptyState>کالای راکدی نیست.</EmptyState>
          ) : (
            <div className="space-y-3">
              <DataTable caption="کالای راکد" tableClassName="min-w-[780px]">
                <DataTableHead>
                  <Th>کالا</Th>
                  <Th>کد</Th>
                  <Th>دسته</Th>
                  <Th>موجودی</Th>
                  <Th>آخرین فروش معتبر</Th>
                  <Th>قدمت موجودی</Th>
                  <Th>ارزش — exact</Th>
                  <Th>پیوندها</Th>
                </DataTableHead>
                <DataTableBody>
                  {dead.rows.map((r) => (
                    <DataTableRow key={r.itemId}>
                      <Td>
                        <Link href={`/dashboard/inventory?focus=${r.itemId}`} className="font-medium text-foreground hover:underline">
                          {r.itemName}
                        </Link>
                        {r.category ? <span className="ms-1 text-xs text-muted-foreground">· {r.category}</span> : null}
                      </Td>
                      <Td muted>{r.sku ? <span dir="ltr">{r.sku}</span> : "—"}</Td>
                      <Td muted className="text-xs">{r.category ?? "—"}</Td>
                      <Td className="tabular-nums">{formatQuantity(r.quantity)}</Td>
                      <Td className="text-xs">
                        {r.lastSoldAt ? toPersianDigits(formatJalali(r.lastSoldAt)) : <span className="text-muted-foreground">بدون فروش {r.firstStockedAt ? `· موجود از ${toPersianDigits(formatJalali(r.firstStockedAt))}` : ""}</span>}
                      </Td>
                      <Td className="tabular-nums text-xs">{r.ageDays != null ? `${toPersianDigits(String(r.ageDays))} روز` : "—"} {r.firstStockedAt ? <span className="text-muted-foreground">· از {toPersianDigits(formatJalali(r.firstStockedAt))}</span> : null}</Td>
                      <Td className="tabular-nums">
                        {r.hasMissingCost ? <span className="text-amber-700 dark:text-amber-300">بها نامشخص</span> : <span className="font-semibold">{money.formatText(String(r.valueRialText ?? r.valueRial ?? 0))}</span>}
                      </Td>
                      <Td className="text-xs">
                        <div className="flex flex-col gap-1">
                          <Link href={`/accounting/inventory?tab=stock-levels&warehouse=${locationId ?? ""}`} className="underline">موجودی انبار</Link>
                          <Link href={`/accounting/inventory?tab=documents&search=${encodeURIComponent(r.sku ?? r.itemName)}`} className="underline">اسناد مرتبط</Link>
                          <Link href={`/dashboard/stock/documents-section?item=${r.itemId}`} className="underline">حرکت انبار</Link>
                        </div>
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
                {dead.summary ? (
                  <DataTableFoot>
                    <tr>
                      <Td colSpan={6} className="font-semibold">
                        {toPersianDigits(String(dead.total ?? dead.rows.length))} قلم راکد — کل فیلتر {toPersianDigits(String(deadTotal))} · صفحه جاری {toPersianDigits(String(dead.rows.length))} {deadMissingCost ? `· ${toPersianDigits(String(deadMissingCost))} بدون بها` : ""}
                      </Td>
                      <Td colSpan={2} className="font-semibold tabular-nums">{money.formatText(String(deadValuedText ?? "0"))} (exact)</Td>
                    </tr>
                  </DataTableFoot>
                ) : null}
              </DataTable>
              {dead.pagination && dead.pagination.pages > 1 ? (
                <div className="flex items-center justify-between pt-2">
                  <Button variant="outline" size="sm" disabled={(dead.pagination?.page ?? 1) <= 1} onClick={() => goDeadPage((dead.pagination?.page ?? 1) - 1)}>
                    قبلی
                  </Button>
                  <span className="text-xs tabular-nums">
                    صفحه {toPersianDigits(String(dead.pagination!.page))} از {toPersianDigits(String(dead.pagination!.pages))} · {toPersianDigits(String(dead.pagination!.total))} ردیف — کل {toPersianDigits(String(deadTotal))} ردیف فیلترشده
                  </span>
                  <Button variant="outline" size="sm" disabled={(dead.pagination?.page ?? 1) >= (dead.pagination?.pages ?? 1)} onClick={() => goDeadPage((dead.pagination?.page ?? 1) + 1)}>
                    بعدی
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="راهنمای گزارش و پیوندها" bodyClassName="space-y-2 text-xs leading-6 text-muted-foreground">
        <p>
          <strong className="text-foreground">کمبود:</strong> شامل کالاهای فعالِ قابل فروش (جز والد تنوع) با موجودی صفر (فاقد ردیف item_stock → ۰) یا کمتر/مساوی نقطهٔ سفارش مثبت. کالاهای وزنی/سریالی و اقلام غیرفعال نیز در شمارش/ارزش لحاظ یا در سطل مجزای برچسب‌دار گزارش می‌شوند — حذف خاموش ندارند.
        </p>
        <p>
          <strong className="text-foreground">راکد:</strong> موجودی مثبت که {toPersianDigits(String(days))} روز فروش معتبر نداشته؛ برای «هرگز فروخته‌نشده» سنِّ موجودی (first_stocked_at/created_at) مبناست، نه صرفاً نبود فروش. کالای تازه‌رسیده تا گذر زمان به عنوان راکد طبقه‌بندی نمی‌شود. آخرین فروش پس از ابطال/برگشت، با بازمحاسبه از فروش‌های غیرباطل تعیین می‌شود. cutoff: {applied?.cutoff ? toPersianDigits(formatJalali(applied.cutoff)) : "—"}.
        </p>
        <p>
          <strong className="text-foreground">ارزش‌گذاری:</strong> ارزش = مقدار × بهای تمام‌شدهٔ میانگین وزنی (ریال) با دقت exact numeric؛ خروجی CSV/XLSX از valueRialText دقیق استفاده می‌کند؛ نمایش در واحد پول انتخابی کسب‌وکار (ریال/تومان). ردیف‌های بدون بهای تمام‌شده با «بها نامشخص» و missingCostCount مشخص و در جمعِ ارزشِ قابل اعتماد لحاظ نمی‌شوند.
        </p>
        <p className="flex flex-wrap gap-2">
          <Link href="/accounting/reports?tab=inventory" className="underline">
            گزارش‌های مرکزی حسابداری
          </Link>
          <span>·</span>
          <Link href={`/accounting/inventory?tab=stock-levels&warehouse=${locationId ?? ""}`} className="underline">
            موجودی انبار
          </Link>
          <span>·</span>
          <Link href={`/accounting/inventory?tab=documents`} className="underline">
            اسناد انبار
          </Link>
          <span>·</span>
          <Link href={`/accounting/inventory?tab=stock-counts`} className="underline">گزارش حرکت انبار</Link>
          <span>·</span>
          <span>چاپ با Ctrl+P؛ خروجی CSV/XLSX کل فیلتر (نه فقط صفحهٔ جاری) را با برچسب «کل فیلتر» صادر می‌کند.</span>
        </p>
        {applied ? (
          <p className="rounded-lg bg-muted/50 px-2 py-1">
            اعمال‌شده: انبار <span className="font-medium text-foreground">{selectedWarehouse?.name ?? applied.locationId ?? "—"}</span> · بازهٔ راکد {toPersianDigits(String(applied.daysApplied))} روز · cutoff {applied.cutoff ? toPersianDigits(formatJalali(applied.cutoff)) : "—"} · تاریخ مرجع {toPersianDigits(formatJalali(applied.todayIso))} · دسته: {applied.category ?? "—"} · ارزش‌گذاری: {applied.valuation ?? "همه"} · جستجو: {applied.search ?? "—"} · شامل غیرفعال: {applied.includeInactive ? "بله" : "خیر"}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="صنایع غذایی (F&B)" bodyClassName="text-xs text-muted-foreground">
        <p>
          گزارش‌های انبار غذایی (ارزش موجودی، ضایعات، تولید، خرید به تفکیک تأمین‌کننده) در{" "}
          <Link href="/accounting/reports" className="font-medium text-foreground underline">
            گزارش‌های حسابداری
          </Link>{" "}
          موجود است؛ این بخش گزارش خرده‌فروشی مبتنی بر <code dir="ltr">items/item_stock</code> را نمایش می‌دهد و موتور گزارش جداگانه‌ای ایجاد نمی‌کند.
        </p>
      </SectionCard>
    </div>
  );
}
