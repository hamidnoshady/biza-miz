"use client";

/**
 * Phase 14 — consolidated numbers and cross-branch comparison for a business's own branches.
 *
 * This queries /api/reports/business-overview, which reads the same reporting views
 * (v_sales_by_day, v_ledger_by_account, v_waste_summary) every per-branch report reads,
 * so the numbers are guaranteed to reconcile with each branch's own reports.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Building2Icon,
  CoinsIcon,
  ReceiptTextIcon,
  SearchIcon,
  SparklesIcon,
  StoreIcon,
  TrendingUpIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { computeBranchOverviewMetrics, type BranchOverviewMetrics } from "@/lib/reports";
import {
  EmptyState,
  KpiRowSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  cardClass,
} from "@/app/dashboard/page-chrome";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { BarChart, PieChart } from "@/app/dashboard/charts";
import { ErrorBox, api, errorMessage, inputClass } from "../ui";
import { BusinessDayRangePresets } from "./business-day-range";
import { ExportButtons } from "./export-buttons";
import { ReportTable, type ReportTableColumn, type ReportTableFooterCell } from "./report-table";

interface BranchRow {
  locationId: string;
  locationName: string;
  isActive: boolean;
  orderCount: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  cogs: number;
  wasteCost: number;
}

interface Overview {
  from: string | null;
  to: string | null;
  branches: BranchRow[];
  consolidated: Omit<BranchRow, "locationId" | "locationName" | "isActive">;
}

interface BranchRowWithMetrics extends BranchRow {
  metrics: BranchOverviewMetrics;
  rank?: number;
}

type MetricKey = "total" | "gross_profit" | "order_count" | "avg_ticket" | "cogs" | "waste_cost";
type ChartKind = "bar" | "pie";
type SortKey = "total" | "gross_profit" | "order_count" | "avg_ticket" | "cogs" | "waste_cost" | "name";
type SortDir = "asc" | "desc";

const METRIC_OPTIONS: { value: MetricKey; label: string }[] = [
  { value: "total", label: "فروش خالص" },
  { value: "gross_profit", label: "سود ناخالص" },
  { value: "order_count", label: "تعداد سفارش" },
  { value: "avg_ticket", label: "میانگین فاکتور" },
  { value: "cogs", label: "بهای تمام‌شده" },
  { value: "waste_cost", label: "ضایعات" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "total", label: "بیشترین فروش خالص" },
  { value: "gross_profit", label: "بیشترین سود ناخالص" },
  { value: "order_count", label: "بیشترین تعداد سفارش" },
  { value: "avg_ticket", label: "بالاترین میانگین فاکتور" },
  { value: "cogs", label: "بهای تمام‌شده" },
  { value: "waste_cost", label: "بیشترین ضایعات" },
  { value: "name", label: "نام شعبه (الفبا)" },
];

export function BranchOverviewSection({
  canExplain = false,
  canExport = false,
}: {
  canExplain?: boolean;
  /**
   * `reports.export` (issue #819). The branch-comparison file is also gated by
   * `reports.business_wide` server-side — `canExport` only decides whether the
   * buttons are drawn, not whether the file is allowed.
   */
  canExport?: boolean;
}) {
  const money = useMoney();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [chartMetric, setChartMetric] = useState<MetricKey>("total");
  const [chartKind, setChartKind] = useState<ChartKind>("bar");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [sortBy, setSortBy] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);

    const qs = params.toString();
    const url = `/api/reports/business-overview${qs ? `?${qs}` : ""}`;
    const result = await api<Overview & { error?: string }>(url);

    if (result.ok) {
      setData(result.data);
    } else {
      setError(errorMessage(result.data.error));
    }
    setLoading(false);
  }, [dateFrom, dateTo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const dateSubtitle = useMemo(() => {
    if (dateFrom && dateTo) {
      return `بازهٔ ${toPersianDigits(formatJalali(dateFrom))} تا ${toPersianDigits(formatJalali(dateTo))}`;
    }
    if (dateFrom) return `از تاریخ ${toPersianDigits(formatJalali(dateFrom))}`;
    if (dateTo) return `تا تاریخ ${toPersianDigits(formatJalali(dateTo))}`;
    return "تمام دوره‌ها";
  }, [dateFrom, dateTo]);

  // Derived metrics for all branches + ranking by sales
  const branchesWithMetrics = useMemo(() => {
    if (!data) return [];
    const consolidatedTotal = data.consolidated.total;

    // Rank active branches by sales descending
    const sortedBySales = [...data.branches].sort((a, b) => b.total - a.total);
    const ranks = new Map<string, number>();
    sortedBySales.forEach((b, idx) => {
      ranks.set(b.locationId, idx + 1);
    });

    return data.branches.map((b): BranchRowWithMetrics => ({
      ...b,
      metrics: computeBranchOverviewMetrics(b, consolidatedTotal),
      rank: ranks.get(b.locationId),
    }));
  }, [data]);

  // Filtered and sorted branch list
  const displayBranches = useMemo(() => {
    let list = branchesWithMetrics;

    if (!showInactive) {
      list = list.filter((b) => b.isActive);
    }

    const needle = search.trim().toLowerCase();
    if (needle) {
      list = list.filter((b) => b.locationName.toLowerCase().includes(needle));
    }

    return [...list].sort((a, b) => {
      let diff = 0;
      switch (sortBy) {
        case "name":
          diff = a.locationName.localeCompare(b.locationName, "fa");
          break;
        case "gross_profit":
          diff = a.metrics.grossProfit - b.metrics.grossProfit;
          break;
        case "order_count":
          diff = a.orderCount - b.orderCount;
          break;
        case "avg_ticket":
          diff = a.metrics.avgTicket - b.metrics.avgTicket;
          break;
        case "cogs":
          diff = a.cogs - b.cogs;
          break;
        case "waste_cost":
          diff = a.wasteCost - b.wasteCost;
          break;
        case "total":
        default:
          diff = a.total - b.total;
          break;
      }
      return sortDir === "asc" ? diff : -diff;
    });
  }, [branchesWithMetrics, showInactive, search, sortBy, sortDir]);

  // Consolidated derived metrics
  const consolidatedMetrics = useMemo(() => {
    if (!data) return { grossProfit: 0, margin: 0, avgTicket: 0 };
    const c = data.consolidated;
    const grossProfit = c.total - c.cogs;
    const margin = c.total > 0 ? (grossProfit / c.total) * 100 : 0;
    const avgTicket = c.orderCount > 0 ? Math.round(c.total / c.orderCount) : 0;
    return { grossProfit, margin, avgTicket };
  }, [data]);

  // Top performing branch by revenue
  const topBranch = useMemo(() => {
    if (!data || data.branches.length === 0) return null;
    const activeWithSales = data.branches.filter((b) => b.isActive && b.total > 0);
    const pool = activeWithSales.length > 0 ? activeWithSales : data.branches;
    const sorted = [...pool].sort((a, b) => b.total - a.total);
    const top = sorted[0];
    if (!top || top.total <= 0) return null;
    const share = data.consolidated.total > 0 ? (top.total / data.consolidated.total) * 100 : 0;
    return { ...top, share };
  }, [data]);

  // Chart data preparation
  const chartData = useMemo(() => {
    const isMoneyMetric = chartMetric !== "order_count";
    const toChartVal = (rial: number) =>
      isMoneyMetric ? (money.unit === "toman" ? Math.trunc(rial / 10) : rial) : rial;

    return displayBranches.map((b) => {
      let rawVal = 0;
      switch (chartMetric) {
        case "gross_profit":
          rawVal = b.metrics.grossProfit;
          break;
        case "order_count":
          rawVal = b.orderCount;
          break;
        case "avg_ticket":
          rawVal = b.metrics.avgTicket;
          break;
        case "cogs":
          rawVal = b.cogs;
          break;
        case "waste_cost":
          rawVal = b.wasteCost;
          break;
        case "total":
        default:
          rawVal = b.total;
          break;
      }
      return {
        label: b.locationName,
        value: toChartVal(rawVal),
      };
    });
  }, [displayBranches, chartMetric, money.unit]);

  function explainBranchesWithAI() {
    if (!data) return;
    const periodText =
      dateFrom || dateTo
        ? `بازهٔ زمانی انتخاب‌شده: ${dateFrom ? `از ${toPersianDigits(formatJalali(dateFrom))}` : "ابتدای داده‌ها"} تا ${dateTo ? `تا ${toPersianDigits(formatJalali(dateTo))}` : "امروز"}.`
        : "بازهٔ زمانی: کل تاریخچه.";

    const branchLines = branchesWithMetrics
      .map((b) => {
        return `• شعبه «${b.locationName}» (${b.isActive ? "فعال" : "غیرفعال"}): فروش خالص ${money.format(b.total)}، تعداد سفارش ${toPersianDigits(String(b.orderCount))}، میانگین فاکتور ${money.format(b.metrics.avgTicket)}، بهای تمام‌شده ${money.format(b.cogs)}، ضایعات ${money.format(b.wasteCost)}، سود ناخالص ${money.format(b.metrics.grossProfit)} (حاشیه سود ${toPersianDigits(b.metrics.grossMarginPct.toFixed(1))}٪)، سهم از کل فروش ${toPersianDigits(b.metrics.revenueSharePct.toFixed(1))}٪`;
      })
      .join("\n");

    const prompt = [
      "گزارش مقایسهٔ عملکرد شعب کسب‌وکار را بر پایهٔ داده‌های واقعی زیر به دقت تحلیل و ارزیابی کن:",
      periodText,
      `جمع کل فروش کسب‌وکار: ${money.format(data.consolidated.total)} (${toPersianDigits(String(data.consolidated.orderCount))} سفارش)، سود ناخالص کل: ${money.format(consolidatedMetrics.grossProfit)} (حاشیه ${toPersianDigits(consolidatedMetrics.margin.toFixed(1))}٪)، میانگین هر فاکتور: ${money.format(consolidatedMetrics.avgTicket)}.`,
      "عملکرد شعب به تفکیک:",
      branchLines,
      "لطفاً تفاوت‌های عملکردی، دلایل احتمالی شکاف فروش یا حاشیه سود بین شعب، و ۳ پیشنهاد راهبردی برای بهبود درآمد شعب ضعیف‌تر و تثبیت شعب پیشتاز ارائه کن.",
    ].join("\n");

    window.dispatchEvent(new CustomEvent("ai:prefill", { detail: { prompt } }));
  }

  if (loading && !data) {
    return (
      <div className="space-y-4 sm:space-y-5">
        <KpiRowSkeleton count={4} label="در حال بارگذاری شاخص‌های مقایسه شعب" />
        <SectionCardSkeleton rows={5} label="در حال بارگذاری مقایسه شعب" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <Button variant="outline" onClick={loadData}>
          تلاش مجدد
        </Button>
      </div>
    );
  }

  if (!data) return null;

  if (data.branches.length <= 1) {
    return (
      <SectionCard
        title="مقایسهٔ شعب"
        description="گزارش تجمیعی و مقایسه عملکرد شعب مختلف کسب‌وکار."
      >
        <EmptyState>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              این کسب‌وکار بیش از یک شعبه ندارد؛ مقایسهٔ عملکرد وقتی شعبهٔ دوم اضافه شود در دسترس خواهد بود.
            </p>
            <div className="pt-1">
              <Button asChild variant="outline" size="sm">
                <Link href="/settings?tab=branches">مدیریت و افزودن شعبه در تنظیمات</Link>
              </Button>
            </div>
          </div>
        </EmptyState>
      </SectionCard>
    );
  }

  const tableColumns: ReportTableColumn<BranchRowWithMetrics>[] = [
    {
      key: "branch",
      header: "شعبه",
      cell: (branch) => (
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">{branch.locationName}</span>
          {branch.rank ? (
            <span className="inline-flex items-center rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">
              رتبه {toPersianDigits(String(branch.rank))}
            </span>
          ) : null}
          {!branch.isActive ? <StatusBadge tone="neutral">غیرفعال</StatusBadge> : null}
        </div>
      ),
    },
    {
      key: "share",
      header: "سهم از کل",
      align: "end",
      numeric: true,
      cell: (branch) => (
        <div className="flex items-center justify-end gap-2">
          <div className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-muted sm:block">
            <div
              className="h-full rounded-full bg-amber-500 dark:bg-amber-400"
              style={{ width: `${Math.min(100, Math.max(0, branch.metrics.revenueSharePct))}%` }}
            />
          </div>
          <span className="text-xs font-semibold tabular-nums text-foreground">
            {toPersianDigits(branch.metrics.revenueSharePct.toFixed(1))}٪
          </span>
        </div>
      ),
    },
    {
      key: "orders",
      header: "تعداد سفارش",
      align: "end",
      numeric: true,
      cell: (branch) => toPersianDigits(String(branch.orderCount)),
    },
    {
      key: "avgTicket",
      header: "میانگین فاکتور",
      align: "end",
      numeric: true,
      cell: (branch) => money.format(branch.metrics.avgTicket),
    },
    {
      key: "subtotal",
      header: "فروش ناخالص",
      align: "end",
      numeric: true,
      desktopOnly: true,
      cell: (branch) => money.format(branch.subtotal),
    },
    {
      key: "discount",
      header: "تخفیف",
      align: "end",
      numeric: true,
      desktopOnly: true,
      muted: true,
      cell: (branch) => (branch.discount > 0 ? money.format(branch.discount) : "—"),
    },
    {
      key: "cogs",
      header: "بهای تمام‌شده",
      align: "end",
      numeric: true,
      cell: (branch) => money.format(branch.cogs),
    },
    {
      key: "waste",
      header: "ضایعات",
      align: "end",
      numeric: true,
      muted: true,
      cell: (branch) => (branch.wasteCost > 0 ? money.format(branch.wasteCost) : "—"),
    },
    {
      key: "total",
      header: "فروش خالص",
      align: "end",
      numeric: true,
      cell: (branch) => <span className="font-bold text-foreground">{money.format(branch.total)}</span>,
    },
    {
      key: "grossProfit",
      header: "سود ناخالص",
      align: "end",
      numeric: true,
      cell: (branch) => (
        <div className="flex flex-col items-end gap-0.5">
          <span className="font-semibold text-foreground">
            {money.format(branch.metrics.grossProfit)}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            حاشیه {toPersianDigits(branch.metrics.grossMarginPct.toFixed(1))}٪
          </span>
        </div>
      ),
    },
  ];

  const tableFooter: ReportTableFooterCell[] = [
    { key: "branch", content: "مجموع کسب‌وکار" },
    {
      key: "share",
      label: "سهم از کل",
      content: "۱۰۰٪",
      align: "end",
      numeric: true,
    },
    {
      key: "orders",
      label: "تعداد سفارش کل",
      content: toPersianDigits(String(data.consolidated.orderCount)),
      align: "end",
      numeric: true,
    },
    {
      key: "avgTicket",
      label: "میانگین فاکتور کل",
      content: money.format(consolidatedMetrics.avgTicket),
      align: "end",
      numeric: true,
    },
    {
      key: "subtotal",
      label: "فروش ناخالص کل",
      content: money.format(data.consolidated.subtotal),
      align: "end",
      numeric: true,
    },
    {
      key: "discount",
      label: "تخفیف کل",
      content: data.consolidated.discount > 0 ? money.format(data.consolidated.discount) : "—",
      align: "end",
      numeric: true,
    },
    {
      key: "cogs",
      label: "بهای تمام‌شده کل",
      content: money.format(data.consolidated.cogs),
      align: "end",
      numeric: true,
    },
    {
      key: "waste",
      label: "ضایعات کل",
      content: data.consolidated.wasteCost > 0 ? money.format(data.consolidated.wasteCost) : "—",
      align: "end",
      numeric: true,
    },
    {
      key: "total",
      label: "فروش خالص کل",
      content: money.format(data.consolidated.total),
      align: "end",
      numeric: true,
    },
    {
      key: "grossProfit",
      label: "سود ناخالص کل",
      content: (
        <div className="flex flex-col items-end gap-0.5">
          <span>{money.format(consolidatedMetrics.grossProfit)}</span>
          <span className="text-[11px] font-normal text-muted-foreground tabular-nums">
            حاشیه {toPersianDigits(consolidatedMetrics.margin.toFixed(1))}٪
          </span>
        </div>
      ),
      align: "end",
      numeric: true,
    },
  ];

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      {/* Date Filter & Control Card */}
      <SectionCard
        title="فیلتر و تنظیمات بازهٔ زمانی"
        description={`مقایسه بر اساس دفاتر و گزارش‌های ثبتی هر شعبه در ${dateSubtitle}.`}
      >
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">از تاریخ</span>
              <JalaliDatePicker
                value={dateFrom}
                onChange={setDateFrom}
                placeholder="از تاریخ"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">تا تاریخ</span>
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
        </div>
      </SectionCard>

      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {/* Executive KPI Summary Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* Card 1: Total Net Sales */}
        <div className={`${cardClass} flex flex-col justify-between p-4 sm:p-5`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">فروش خالص کل</span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <CoinsIcon className="size-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3">
            <p className="text-xl font-bold tracking-tight text-foreground sm:text-2xl tabular-nums">
              {money.format(data.consolidated.total)}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              فروش ناخالص: {money.format(data.consolidated.subtotal)}
            </p>
          </div>
        </div>

        {/* Card 2: Total Gross Profit */}
        <div className={`${cardClass} flex flex-col justify-between p-4 sm:p-5`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">سود ناخالص کل</span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
              <TrendingUpIcon className="size-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3">
            <p className="text-xl font-bold tracking-tight text-foreground sm:text-2xl tabular-nums">
              {money.format(consolidatedMetrics.grossProfit)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              حاشیه سود ناخالص: {toPersianDigits(consolidatedMetrics.margin.toFixed(1))}٪
            </p>
          </div>
        </div>

        {/* Card 3: Total Orders */}
        <div className={`${cardClass} flex flex-col justify-between p-4 sm:p-5`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">تعداد کل سفارش‌ها</span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300">
              <ReceiptTextIcon className="size-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3">
            <p className="text-xl font-bold tracking-tight text-foreground sm:text-2xl tabular-nums">
              {toPersianDigits(String(data.consolidated.orderCount))}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              میانگین هر سفارش: {money.format(consolidatedMetrics.avgTicket)}
            </p>
          </div>
        </div>

        {/* Card 4: Top Performing Branch */}
        <div className={`${cardClass} flex flex-col justify-between p-4 sm:p-5`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">شعبهٔ پیشتاز</span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <Building2Icon className="size-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3">
            <p className="truncate text-lg font-bold text-foreground sm:text-xl">
              {topBranch ? topBranch.locationName : "—"}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground tabular-nums">
              {topBranch
                ? `${toPersianDigits(topBranch.share.toFixed(1))}٪ از کل فروش (${money.format(topBranch.total)})`
                : "سفارشی ثبت نشده است"}
            </p>
          </div>
        </div>
      </div>

      {/* Visual Chart Card */}
      <SectionCard
        title="نمودار مقایسه عملکرد شعب"
        description={`مقایسهٔ شعب بر اساس ${METRIC_OPTIONS.find((m) => m.value === chartMetric)?.label ?? "فروش"} (${money.unitLabel}).`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-36 sm:w-44">
              <SearchableSelect
                className={inputClass}
                value={chartMetric}
                onChange={(val) => setChartMetric(val as MetricKey)}
                options={METRIC_OPTIONS}
              />
            </div>
            <div className="w-32">
              <SearchableSelect
                className={inputClass}
                value={chartKind}
                onChange={(val) => setChartKind(val as ChartKind)}
                options={[
                  { value: "bar", label: "میله‌ای" },
                  { value: "pie", label: "دایره‌ای" },
                ]}
              />
            </div>
          </div>
        }
      >
        <div className="min-h-[240px] pt-2">
          {chartKind === "pie" ? (
            <PieChart data={chartData} height={260} />
          ) : (
            <BarChart data={chartData} height={260} />
          )}
        </div>
      </SectionCard>

      {/* Comparison Table Section */}
      <SectionCard
        title="جدول جامع مقایسه شعب"
        description="جزئیات فروش، بهای تمام‌شده، سود و نسبت‌های مالی هر شعبه."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-40 sm:w-48">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="جستجوی شعبه…"
                aria-label="جستجوی شعبه"
                className={`${inputClass} ps-9`}
              />
            </div>
            <div className="w-44">
              <SearchableSelect
                className={inputClass}
                value={sortBy}
                onChange={(val) => setSortBy(val as SortKey)}
                options={SORT_OPTIONS}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")}
              className="h-10 px-2.5 text-xs font-medium"
              title={sortDir === "asc" ? "صعودی به نزولی" : "نزولی به صعودی"}
            >
              {sortDir === "desc" ? "نزولی ↓" : "صعودی ↑"}
            </Button>
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border/80 bg-muted px-2.5 text-xs text-foreground">
              <Checkbox
                checked={showInactive}
                onCheckedChange={(val) => setShowInactive(val === true)}
              />
              نمایش غیرفعال
            </label>
          </div>
        }
        flush
      >
        <ReportTable
          caption="جدول مقایسه عملکرد شعب"
          rows={displayBranches}
          rowKey={(branch) => branch.locationId}
          empty={
            <div className="py-6 text-center text-sm text-muted-foreground">
              {search
                ? "شعبه‌ای با این نام یافت نشد."
                : "داده‌ای برای مقایسه در این بازهٔ زمانی وجود ندارد."}
            </div>
          }
          cardTitle={(branch) => (
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-semibold">
                <StoreIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                {branch.locationName}
                {branch.rank ? (
                  <span className="inline-flex items-center rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">
                    رتبه {toPersianDigits(String(branch.rank))}
                  </span>
                ) : null}
              </span>
              {!branch.isActive ? <StatusBadge tone="neutral">غیرفعال</StatusBadge> : null}
            </div>
          )}
          columns={tableColumns}
          footer={tableFooter}
        />
      </SectionCard>

      {/* Export & AI Actions */}
      <SectionCard title="خروجی و تحلیل هوشمند">
        <div className="flex flex-wrap items-center gap-2">
          {canExport ? (
            <ExportButtons
              request={{
                title: "گزارش مقایسه عملکرد شعب",
                kind: "business_overview",
                dateFrom,
                dateTo,
              }}
            />
          ) : null}

          {canExplain ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={explainBranchesWithAI}
              className="min-h-11 gap-1.5 border-amber-200 bg-amber-50 px-3 font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/20"
            >
              <SparklesIcon className="size-4" aria-hidden="true" /> تحلیل هوشمند مقایسه شعب
            </Button>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}
