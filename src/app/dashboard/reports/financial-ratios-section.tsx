"use client";

/**
 * «تحلیل مالی» — the financial-ratios report.
 *
 * The screen is a view over `financial-ratios-service.ts`: it never computes a
 * ratio itself. Every figure, status, reason, formula and input arrives from the
 * server, which reads the same journal lines as the P&L and balance sheet. That
 * is deliberate — a client-side second implementation would be a second source
 * of truth, and the export would disagree with the screen the first time either
 * changed.
 *
 * The filters follow the reporting contract: a Jalali date range (or a
 * business-day preset), the member's authorized branch or the explicitly
 * gated consolidated scope, and — for members who may read the ledger — one
 * accounting dimension. Every filter that changes the numbers is sent to the
 * one endpoint that computes them, and the export sends the same values.
 *
 * Unavailable ratios are shown as unavailable, with the reason and the missing
 * inputs, never as a zero. Each ratio expands to its inputs, its source
 * statement and per-account drill-down into the journal lines behind the
 * figure.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ListFilterIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, toGregorian, todayIsoDate, todayJalali } from "@/lib/jalali";
import { formatRatioValue, type RatioKey, type RatioStatus, type RatioUnit } from "@/lib/financial-ratios";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  KpiRowSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "../page-chrome";
import { ErrorBox, Field, InfoBox, api } from "../ui";
import { JalaliDatePicker } from "../jalali-date-picker";
import { FilterChip, FilterChipRow } from "../filters";
import { LineChart } from "../charts";
import { BusinessDayRangePresets } from "./business-day-range";
import { ExportButtons } from "./export-buttons";
import { DrillDownPanel, type DrillDownTarget } from "./drill-down-panel";

// The wire shapes of the server response. Deliberately local: importing the
// service into a client bundle would pull in the database layer, and a type
// import from it would still blur that boundary.
interface RatioInputLine {
  key: string;
  label: string;
  value: number | null;
}

interface RatioResult {
  key: RatioKey;
  label: string;
  group: string;
  unit: RatioUnit;
  explanation: string;
  formula: string;
  numerator: string;
  denominator: string;
  periodConvention: "movement" | "point_in_time" | "average_balance";
  source: "profit_and_loss" | "balance_sheet" | "ledger";
  status: RatioStatus;
  value: number | null;
  display: string | null;
  reason: string | null;
  reasonText: string | null;
  missingInputs: string[];
  inputs: RatioInputLine[];
  previous: RatioResult | null;
  change: number | null;
  changePct: number | null;
  direction: "up" | "down" | "flat" | null;
}

interface RatioGroup {
  key: string;
  label: string;
  description: string;
  ratios: RatioResult[];
}

interface InputDetail {
  key: string;
  label: string;
  unit: "money" | "days";
  value: number | null;
  accounts: { code: string; name: string; amount: number }[];
}

interface TrendPoint {
  dateFrom: string;
  dateTo: string;
  label: string;
  values: Partial<Record<RatioKey, number | null>>;
}

interface RatioReport {
  catalogueVersion: string;
  generatedAt: string;
  scope: "branch" | "business-wide";
  period: { dateFrom: string; dateTo: string; days: number | null };
  comparisonPeriod: { dateFrom: string; dateTo: string } | null;
  dimension: { kind: string; valueId: string } | null;
  groups: RatioGroup[];
  inputs: InputDetail[];
  checks: {
    hasLedgerActivity: boolean;
    balanceSheetBalanced: boolean | null;
    totalAssets: number;
    totalLiabilitiesAndEquity: number;
    openingComparativesAvailable: boolean;
  };
  warnings: string[];
  mapping: { interestExpenseAccountCodes: string[] };
  trend: { periods: number; keys: RatioKey[]; points: TrendPoint[] } | null;
  sourceLabels: Record<string, string>;
}

interface DimensionValue {
  id: string;
  kind: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface DimensionSetting {
  kind: string;
  isEnabled: boolean;
  label: string | null;
  defaultLabel: string;
}

interface ChartAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  is_postable: boolean;
}

/** Jalali month start, so the default range is the one a Persian reader thinks in. */
function currentJalaliMonthStart(): string {
  const today = todayJalali();
  const { gy, gm, gd } = toGregorian(today.jy, today.jm, 1);
  return `${gy}-${String(gm).padStart(2, "0")}-${String(gd).padStart(2, "0")}`;
}

function daysBefore(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function ratioUnit(key: RatioKey): "ratio" | "percent" | "days" {
  if (key.endsWith("_margin") || key === "return_on_assets" || key === "return_on_equity") return "percent";
  if (key === "days_inventory_outstanding" || key === "days_sales_outstanding" || key === "days_payable_outstanding") {
    return "days";
  }
  return "ratio";
}

function statusLabel(status: RatioStatus): string {
  if (status === "unavailable") return "ناموجود";
  if (status === "not_applicable") return "قابل محاسبه نیست";
  return "محاسبه‌شده";
}

function errorText(status: number): string {
  if (status === 401) return "نشست شما منقضی شده است. دوباره وارد شوید.";
  if (status === 403) return "شما به این گزارش یا فیلتر آن دسترسی ندارید.";
  if (status === 400) return "بازهٔ تاریخ یا فیلتر انتخاب‌شده معتبر نیست.";
  if (status >= 500) return "خطای سرور هنگام محاسبهٔ نسبت‌ها. کمی بعد دوباره تلاش کنید.";
  return "محاسبهٔ نسبت‌ها ممکن نشد.";
}

const BALANCE_INPUTS = new Set([
  "cashAndEquivalents",
  "tradeReceivables",
  "tradePayables",
  "inventory",
  "currentAssets",
  "currentLiabilities",
  "totalAssets",
  "totalLiabilities",
  "totalEquity",
]);

const OPENING_INPUTS = new Set([
  "openingTotalAssets",
  "openingTotalEquity",
  "openingInventory",
  "openingTradeReceivables",
  "openingTradePayables",
]);

export function FinancialRatiosSection({
  canExport,
  canBusinessWide,
  canUseDimensions,
  canManageMapping,
}: {
  canExport: boolean;
  /** `reports.business_wide`: may ask for the consolidated books. */
  canBusinessWide: boolean;
  /** `ledger.view`: may read accounting dimensions and the account picker. */
  canUseDimensions: boolean;
  /** `reports.manage`: may save the reviewed interest-expense mapping. */
  canManageMapping: boolean;
}) {
  const money = useMoney();
  const today = todayIsoDate();
  const [dateFrom, setDateFrom] = useState(() => currentJalaliMonthStart());
  const [dateTo, setDateTo] = useState(today);
  const [compare, setCompare] = useState(true);
  const [businessWide, setBusinessWide] = useState(false);
  const [trendPeriods, setTrendPeriods] = useState(6);
  const [dimensionKind, setDimensionKind] = useState("");
  const [dimensionValue, setDimensionValue] = useState("");
  const [dimensionSettings, setDimensionSettings] = useState<DimensionSetting[]>([]);
  const [dimensionValues, setDimensionValues] = useState<DimensionValue[]>([]);
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [report, setReport] = useState<RatioReport | null>(null);
  const [loaded, setLoaded] = useState<{
    dateFrom: string;
    dateTo: string;
    scope: "branch" | "business-wide";
    dimensionKind: string;
    dimensionValue: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [drillDown, setDrillDown] = useState<DrillDownTarget | null>(null);
  const [selectedTrendKey, setSelectedTrendKey] = useState<RatioKey>("current_ratio");
  const [mappingCode, setMappingCode] = useState("");
  const [mappingBusy, setMappingBusy] = useState(false);
  const [mappingError, setMappingError] = useState("");

  const enabledDimensions = useMemo(
    () => dimensionSettings.filter((setting) => setting.isEnabled),
    [dimensionSettings],
  );

  // Options for the ledger-scoped pickers. Both endpoints are already gated by
  // `ledger.view`; this section only asks for them when the member holds it.
  useEffect(() => {
    if (!canUseDimensions) return;
    let cancelled = false;
    Promise.all([
      api<{ settings: DimensionSetting[]; values: DimensionValue[] }>("/api/ledger/dimensions"),
      api<{ accounts: ChartAccount[] }>("/api/ledger/accounts"),
    ])
      .then(([dimensions, chart]) => {
        if (cancelled) return;
        if (dimensions.ok) {
          setDimensionSettings(dimensions.data.settings ?? []);
          setDimensionValues(dimensions.data.values ?? []);
        }
        if (chart.ok) setAccounts(chart.data.accounts ?? []);
      })
      .catch(() => {
        // A failure here only hides optional filter chrome; the report itself
        // still runs branch-scoped without it.
      });
    return () => {
      cancelled = true;
    };
  }, [canUseDimensions]);

  useEffect(() => {
    if (!report) return;
    setMappingCode(report.mapping.interestExpenseAccountCodes[0] ?? "");
  }, [report]);

  const dateRangeValid = Boolean(dateFrom && dateTo && dateFrom <= dateTo);
  const dimensionQuery = dimensionKind && dimensionValue ? { dimensionKind, dimensionValue } : {};

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!dateFrom || !dateTo || dateFrom > dateTo) {
        setError("تاریخ شروع باید پیش از تاریخ پایان باشد.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      const params = new URLSearchParams({
        dateFrom,
        dateTo,
        compare: compare ? "1" : "0",
        trend: String(trendPeriods),
      });
      if (businessWide && canBusinessWide) params.set("scope", "business-wide");
      if (dimensionQuery.dimensionKind) {
        params.set("dimensionKind", dimensionQuery.dimensionKind);
        params.set("dimensionValue", dimensionQuery.dimensionValue);
      }
      try {
        const result = await api<{ report: RatioReport }>(`/api/reports/financial-ratios?${params}`, {
          signal,
        });
        if (signal.aborted) return;
        if (!result.ok) {
          setError(errorText(result.status));
          setReport(null);
          return;
        }
        setReport(result.data.report);
        setLoaded({
          dateFrom,
          dateTo,
          scope: businessWide && canBusinessWide ? "business-wide" : "branch",
          dimensionKind: dimensionQuery.dimensionKind ?? "",
          dimensionValue: dimensionQuery.dimensionValue ?? "",
        });
      } catch {
        if (!signal.aborted) setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    // `dimensionQuery` is derived from the two primitives below, which are the
    // values that actually change the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dateFrom, dateTo, compare, businessWide, canBusinessWide, trendPeriods, dimensionKind, dimensionValue, refreshToken],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const ratios = useMemo(
    () => (report ? report.groups.flatMap((group) => group.ratios) : []),
    [report],
  );
  const ratioByKey = useMemo(() => new Map(ratios.map((ratio) => [ratio.key, ratio])), [ratios]);
  const inputDetailByKey = useMemo(
    () => new Map((report?.inputs ?? []).map((input) => [input.key, input])),
    [report],
  );

  const expenses = useMemo(
    () => accounts.filter((account) => account.type === "expense" && account.is_postable),
    [accounts],
  );

  const drill = useCallback(
    (inputKey: string, account: { code: string; name: string; amount: number }) => {
      if (!report || !loaded || !account.code) return;
      const period = { dateFrom: report.period.dateFrom, dateTo: report.period.dateTo };
      const range = OPENING_INPUTS.has(inputKey)
        ? { dateTo: daysBefore(period.dateFrom, 1) }
        : BALANCE_INPUTS.has(inputKey)
          ? { dateTo: period.dateTo }
          : period;
      setDrillDown({
        accountCode: account.code,
        accountName: `${account.name} (${account.code})`,
        ...range,
        permissionScope: "reports",
        scope: loaded.scope,
      });
    },
    [loaded, report],
  );

  async function saveMapping(codes: string[]) {
    setMappingBusy(true);
    setMappingError("");
    try {
      const result = await api<{ error?: string; message?: string }>(
        "/api/reports/financial-ratios/mapping",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interestExpenseAccountCodes: codes }),
        },
      );
      if (!result.ok) {
        setMappingError(result.data.message ?? "ذخیرهٔ حساب هزینهٔ بهره ممکن نشد.");
        return;
      }
      setRefreshToken((token) => token + 1);
    } catch {
      setMappingError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      setMappingBusy(false);
    }
  }

  const trendKey = report?.trend?.keys.includes(selectedTrendKey)
    ? selectedTrendKey
    : report?.trend?.keys[0];
  const trendPoints = report?.trend && trendKey
    ? report.trend.points
        .map((point) => ({ label: point.label, value: point.values[trendKey] }))
        .filter((point): point is { label: string; value: number } => typeof point.value === "number")
    : [];
  const trendLabel = trendKey ? ratioByKey.get(trendKey)?.label : null;

  function inputValueText(input: InputDetail): string {
    if (input.value === null) return "—";
    if (input.unit === "days") return `${toPersianDigits(input.value)} روز`;
    return money.formatText(String(input.value));
  }

  function ratioInputValueText(line: RatioInputLine): string {
    if (line.value === null) return "—";
    if (line.key === "periodDays") return `${toPersianDigits(line.value)} روز`;
    return money.formatText(String(line.value));
  }

  function changeText(ratio: RatioResult): string {
    if (!ratio.previous || ratio.previous.display === null) return "دورهٔ قبل: ناموجود";
    if (ratio.change === null) return `دورهٔ قبل: ${ratio.previous.display}`;
    const sign = ratio.change > 0 ? "+" : ratio.change < 0 ? "−" : "";
    const magnitude = formatRatioValue(Math.abs(ratio.change), ratio.unit);
    return `دورهٔ قبل: ${ratio.previous.display} — تغییر: ${sign}${magnitude}`;
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title="بازه و دامنهٔ گزارش"
        description="هر عدد از دفتر کل همان بازه، شعبه و بُعد انتخابی محاسبه می‌شود؛ تغییر هر فیلتر، محاسبه را از نو انجام می‌دهد."
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="از تاریخ">
            <JalaliDatePicker value={dateFrom} onChange={setDateFrom} ariaLabel="تاریخ شروع دوره" />
          </Field>
          <Field label="تا تاریخ">
            <JalaliDatePicker value={dateTo} onChange={setDateTo} ariaLabel="تاریخ پایان دوره" />
          </Field>
          {canUseDimensions && enabledDimensions.length > 0 ? (
            <Field label="بُعد حسابداری">
              <SearchableSelect
                value={dimensionKind}
                onChange={(value) => {
                  setDimensionKind(value);
                  setDimensionValue("");
                }}
                ariaLabel="نوع بُعد حسابداری"
                options={[
                  { value: "", label: "بدون فیلتر بُعد" },
                  ...enabledDimensions.map((setting) => ({
                    value: setting.kind,
                    label: setting.label ?? setting.defaultLabel,
                  })),
                ]}
              />
            </Field>
          ) : null}
          {canUseDimensions && dimensionKind ? (
            <Field label="مقدار بُعد">
              <SearchableSelect
                value={dimensionValue}
                onChange={setDimensionValue}
                ariaLabel="مقدار بُعد حسابداری"
                options={[
                  { value: "", label: "همهٔ مقادیر" },
                  { value: "unassigned", label: "بدون بُعد" },
                  ...dimensionValues
                    .filter((value) => value.kind === dimensionKind && value.isActive)
                    .map((value) => ({ value: value.id, label: `${value.code} — ${value.name}` })),
                ]}
              />
            </Field>
          ) : null}
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

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
            <Checkbox checked={compare} onCheckedChange={(value) => setCompare(value === true)} />
            مقایسه با دورهٔ قبل
          </label>
          {canBusinessWide ? (
            <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={businessWide}
                onCheckedChange={(value) => setBusinessWide(value === true)}
              />
              کل کسب‌وکار (همهٔ شعبه‌ها)
            </label>
          ) : null}
          <div className="min-w-36">
            <Field label="روند">
              <SearchableSelect
                value={String(trendPeriods)}
                onChange={(value) => setTrendPeriods(Number(value))}
                ariaLabel="تعداد دوره‌های روند"
                options={[
                  { value: "0", label: "بدون روند" },
                  { value: "4", label: "۴ دوره" },
                  { value: "6", label: "۶ دوره" },
                  { value: "12", label: "۱۲ دوره" },
                ]}
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => setRefreshToken((token) => token + 1)}
            disabled={loading || !dateRangeValid}
          >
            <RefreshCwIcon aria-hidden="true" />
            به‌روزرسانی
          </Button>
          {canExport && report && loaded ? (
            <ExportButtons
              disabled={loading}
              request={{
                title: "تحلیل مالی و نسبت‌ها",
                kind: "financial_ratios",
                dateFrom: loaded.dateFrom,
                dateTo: loaded.dateTo,
                scope: loaded.scope,
                ...(loaded.dimensionKind
                  ? { dimensionKind: loaded.dimensionKind, dimensionValue: loaded.dimensionValue }
                  : {}),
              }}
            />
          ) : null}
        </div>
      </SectionCard>

      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {loading ? (
        <div className="space-y-5" role="status" aria-live="polite" aria-busy="true" aria-label="در حال محاسبهٔ نسبت‌ها">
          <KpiRowSkeleton standalone={false} />
          <SectionCardSkeleton rows={5} label="در حال محاسبهٔ نسبت‌ها" />
          <SectionCardSkeleton rows={4} label="در حال خواندن ورودی‌های محاسبه" />
        </div>
      ) : report ? (
        <>
          {report.warnings.length > 0 ? (
            <InfoBox>
              <ul className="list-disc space-y-1 ps-5">
                {report.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </InfoBox>
          ) : null}

          {!report.checks.hasLedgerActivity ? (
            <SectionCard title="داده‌ای برای تحلیل نیست">
              <EmptyState
                icon={ListFilterIcon}
                title="در این بازه سندی در دفتر ثبت نشده است"
                action={
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setDateFrom(currentJalaliMonthStart());
                      setDateTo(today);
                    }}
                  >
                    بازگشت به ماه جاری
                  </Button>
                }
              >
                نسبت‌ها فقط از اسناد ثبت‌شده محاسبه می‌شوند؛ برای دوره‌ای که سند یا مانده ندارد، هیچ عددی ساخته نمی‌شود.
              </EmptyState>
            </SectionCard>
          ) : (
            <>
              <KpiRow>
                {(["current_ratio", "quick_ratio", "net_margin", "debt_to_equity"] as RatioKey[]).map((key) => {
                  const ratio = ratioByKey.get(key);
                  if (!ratio) return null;
                  return (
                    <KpiCard
                      key={key}
                      label={ratio.label}
                      value={ratio.display ?? "ناموجود"}
                      hint={ratio.status === "available" ? changeText(ratio) : ratio.reasonText ?? statusLabel(ratio.status)}
                    />
                  );
                })}
              </KpiRow>

              {report.groups.map((group) => (
                <SectionCard key={group.key} title={group.label} description={group.description}>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {group.ratios.map((ratio) => {
                      const inputDetails = ratio.inputs
                        .map((line) => inputDetailByKey.get(line.key))
                        .filter((detail): detail is InputDetail => Boolean(detail));
                      return (
                        <article
                          key={ratio.key}
                          className="rounded-xl border border-border/80 bg-card p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <h3 className="text-sm font-semibold text-foreground">{ratio.label}</h3>
                            {ratio.status === "available" ? (
                              <p className="text-xl font-bold tabular-nums text-foreground">{ratio.display}</p>
                            ) : (
                              <StatusBadge tone="neutral">{statusLabel(ratio.status)}</StatusBadge>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{ratio.formula}</p>
                          <p className="mt-2 text-sm leading-6 text-muted-foreground">{ratio.explanation}</p>
                          {ratio.status === "available" ? (
                            <p className="mt-2 text-xs text-muted-foreground">{changeText(ratio)}</p>
                          ) : (
                            <p className="mt-2 text-xs leading-5 text-amber-800 dark:text-amber-300">
                              {ratio.reasonText ?? "این نسبت با دادهٔ موجود قابل محاسبه نیست."}
                            </p>
                          )}

                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs font-medium text-primary underline-offset-2 hover:underline">
                              ورودی‌ها، منبع و اسناد
                            </summary>
                            <div className="mt-3 space-y-3">
                              <dl className="space-y-1 text-xs">
                                {ratio.inputs.map((line) => (
                                  <div key={line.key} className="flex flex-wrap justify-between gap-2">
                                    <dt className="text-muted-foreground">{line.label}</dt>
                                    <dd className="font-medium tabular-nums text-foreground">
                                      {ratioInputValueText(line)}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                              <p className="text-xs text-muted-foreground">
                                منبع: {report.sourceLabels[ratio.source] ?? ratio.source}
                                {ratio.periodConvention === "average_balance"
                                  ? " — میانگین ماندهٔ ابتدا و پایان دوره"
                                  : ratio.periodConvention === "movement"
                                    ? " — گردش دورهٔ انتخابی"
                                    : " — ماندهٔ پایان دوره"}
                              </p>
                              {inputDetails.length > 0 ? (
                                <div className="space-y-2">
                                  {inputDetails.map((input) => (
                                    <div key={input.key}>
                                      <p className="text-xs font-medium text-foreground">{input.label}</p>
                                      {input.accounts.length === 0 ? (
                                        <p className="mt-1 text-xs text-muted-foreground">
                                          این ورودی از جمع چند نسبت ساخته می‌شود و حساب مستقلی ندارد.
                                        </p>
                                      ) : (
                                        <ul className="mt-1 space-y-1">
                                          {input.accounts.map((account, index) => (
                                            <li
                                              key={`${input.key}-${account.code}-${index}`}
                                              className="flex flex-wrap items-center justify-between gap-2 text-xs"
                                            >
                                              <span className="min-w-0 text-muted-foreground">
                                                <bdi>{account.name}</bdi>
                                                {account.code ? ` — ${toPersianDigits(account.code)}` : ""}
                                              </span>
                                              <span className="flex items-center gap-2">
                                                <span className="tabular-nums text-foreground">
                                                  {money.formatText(String(account.amount))}
                                                </span>
                                                {account.code ? (
                                                  <button
                                                    type="button"
                                                    onClick={() => drill(input.key, account)}
                                                    className="rounded-md px-1.5 py-1 text-primary underline decoration-primary/40 underline-offset-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45"
                                                    aria-label={`نمایش اسناد حساب ${account.name} در دفتر`}
                                                  >
                                                    اسناد
                                                  </button>
                                                ) : null}
                                              </span>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </details>
                        </article>
                      );
                    })}
                  </div>
                </SectionCard>
              ))}

              {report.trend && report.trend.keys.length > 0 ? (
                <SectionCard
                  title="روند دوره‌های هم‌طول"
                  description="هر نقطه، همان نسبتی است که برای یک دورهٔ کامل با طول دورهٔ انتخابی محاسبه شده؛ آخرین نقطه همان ستون دورهٔ جاری است."
                >
                  <FilterChipRow label="انتخاب نسبت برای نمودار">
                    {report.trend.keys.map((key) => {
                      const ratio = ratioByKey.get(key);
                      if (!ratio) return null;
                      return (
                        <FilterChip
                          key={key}
                          selected={trendKey === key}
                          onClick={() => setSelectedTrendKey(key)}
                        >
                          {ratio.label}
                        </FilterChip>
                      );
                    })}
                  </FilterChipRow>
                  {trendPoints.length >= 2 && trendKey ? (
                    <figure className="mt-4" aria-label={`روند ${trendLabel ?? trendKey}`}>
                      <LineChart
                        data={trendPoints}
                        height={260}
                        formatValue={(value) => formatRatioValue(value, ratioUnit(trendKey))}
                      />
                      <figcaption className="mt-2 text-xs text-muted-foreground">
                        {trendLabel} — {toPersianDigits(trendPoints.length)} دوره از{" "}
                        {toPersianDigits(report.trend.points.length)} دورهٔ محاسبه‌شده دادهٔ معتبر داشت.
                      </figcaption>
                    </figure>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">
                      برای رسم روند، دست‌کم دو دورهٔ کامل با دادهٔ واقعی لازم است؛ در این بازه دادهٔ کافی برای این نسبت وجود ندارد.
                    </p>
                  )}
                </SectionCard>
              ) : null}

              <SectionCard
                title="ورودی‌های محاسبه"
                description="همهٔ مقادیر از دفتر کل همان بازه، شعبه و بُعد خوانده شده‌اند. هر ردیف همان عددی است که در فرمول نسبت‌ها به کار رفته."
              >
                <div className="divide-y divide-border/70">
                  {report.inputs.map((input) => (
                    <div key={input.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="text-sm text-foreground">{input.label}</span>
                      <span className="text-sm font-medium tabular-nums text-foreground">
                        {inputValueText(input)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  وضعیت تراز: {report.checks.balanceSheetBalanced === null
                    ? "با فیلتر بُعد سنجیده نمی‌شود"
                    : report.checks.balanceSheetBalanced
                      ? "دارایی‌ها با بدهی‌ها و حقوق صاحبان سرمایه برابر است"
                      : "دارایی‌ها با بدهی‌ها و حقوق صاحبان سرمایه برابر نیست"}
                  {" — "}
                  دورهٔ قبل:{" "}
                  {report.comparisonPeriod
                    ? `${formatJalali(report.comparisonPeriod.dateFrom)} تا ${formatJalali(report.comparisonPeriod.dateTo)}`
                    : "محاسبه نشده"}
                  .
                </p>
              </SectionCard>

              {canUseDimensions ? (
                <SectionCard
                  title="حساب هزینهٔ بهره"
                  description="نقشهٔ حساب‌های پیش‌فرض حساب هزینهٔ بهره ندارد. برای محاسبهٔ نسبت پوشش بهره، حساب هزینهٔ بهره را یک‌بار اینجا تعیین کنید."
                >
                  {report.mapping.interestExpenseAccountCodes.length > 0 ? (
                    <p className="text-sm text-foreground">
                      حساب تعیین‌شده:{" "}
                      {report.mapping.interestExpenseAccountCodes
                        .map((code) => {
                          const account = accounts.find((item) => item.code === code);
                          return account ? `${account.name} (${toPersianDigits(account.code)})` : toPersianDigits(code);
                        })
                        .join("، ")}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      هنوز حسابی تعیین نشده است؛ نسبت پوشش بهره ناموجود گزارش می‌شود.
                    </p>
                  )}
                  {canManageMapping ? (
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <div className="min-w-56 flex-1">
                        <Field label="حساب هزینهٔ بهره">
                          <SearchableSelect
                            value={mappingCode}
                            onChange={setMappingCode}
                            ariaLabel="حساب هزینهٔ بهره"
                            options={[
                              { value: "", label: "بدون حساب (تعیین‌نشده)" },
                              ...expenses.map((account) => ({
                                value: account.code,
                                label: `${account.code} — ${account.name}`,
                              })),
                            ]}
                          />
                        </Field>
                      </div>
                      <Button
                        type="button"
                        onClick={() => void saveMapping(mappingCode ? [mappingCode] : [])}
                        disabled={mappingBusy}
                      >
                        {mappingBusy ? "در حال ذخیره…" : "ذخیرهٔ نقشه"}
                      </Button>
                    </div>
                  ) : null}
                  {mappingError ? (
                    <p role="alert" className="mt-2 text-xs text-destructive">
                      {mappingError}
                    </p>
                  ) : null}
                </SectionCard>
              ) : null}

              <p className="text-xs leading-5 text-muted-foreground">
                نسخهٔ تعریف نسبت‌ها: {toPersianDigits(report.catalogueVersion)} — دامنه:{" "}
                {report.scope === "business-wide" ? "همهٔ شعبه‌ها" : "شعبهٔ جاری"} — محاسبه در{" "}
                {formatJalali(report.generatedAt, { withTime: true })} — طول دوره:{" "}
                {report.period.days === null ? "نامعتبر" : `${toPersianDigits(report.period.days)} روز`}.
                این گزارش یک لایهٔ تحلیلی از دفتر است، نه سند حسابداری، رتبهٔ اعتباری یا پیش‌بینی.
              </p>
            </>
          )}
        </>
      ) : null}

      {drillDown ? <DrillDownPanel target={drillDown} onClose={() => setDrillDown(null)} /> : null}
    </div>
  );
}
