"use client";
import type { ReportDetailPagination } from "@/lib/report-detail-page";
import { useState } from "react";
import { useBusiness } from "../context";
import { MoneyProvider, useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SectionCard, EmptyState, LoadingSkeleton, TabBar, TabPanel } from "@/app/dashboard/page-chrome";
import { Field, ErrorBox, InfoBox, inputClass } from "@/app/dashboard/ui";
import { FilterChip, SearchField } from "@/app/dashboard/filters";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { StructuredReportBody } from "@/app/dashboard/reports/structured-report-body";
import { ChartPreview } from "@/app/dashboard/reports/chart-preview";
import { PagedReportTable } from "@/app/dashboard/reports/paged-report-table";
import { rowsToChartData, type ReportRow } from "@/app/dashboard/reports/report-ui";
import { COMPARABLE_SHAPES, type ReportShape } from "@/app/dashboard/reports/standard-report-config";
import { businessDateRange, type BusinessDateRangePreset } from "@/lib/business-day";
import { normalizePosSearchText } from "@/lib/pos-selection";
import { formatPersianNumber } from "@/lib/digits";
import type { CrmOverview } from "@/lib/crm-overview";
import type { GrowthOverview } from "@/lib/growth-overview";
import type { BusinessOverview } from "@/lib/reports-service";
import { useReport } from "./use-report";
import { OverviewPanel, CrmPanel, GrowthPanel, WebsitesPanel, CmsPanel, HealthPanel, BranchesPanel,
  type Catalog, type Overview, type Websites, type Cms, type Health } from "./panels";

export function ReportingWorkspace() {
  const { id } = useBusiness();
  const [refresh, setRefresh] = useState(0);
  const [locationId, setLocation] = useState("");
  const base = `/api/platform/businesses/${id}/reports`;
  // Retrying the catalog must issue a new request. Keep this separate from
  // report refresh so the workspace does not unmount and lose tabs/filters.
  const [catalogRetry, setCatalogRetry] = useState(0);
  const catalog = useReport<Catalog>(`${base}/catalog`, catalogRetry);
  if (catalog.error) return <><ErrorBox>{catalog.error}</ErrorBox><Button onClick={() => setCatalogRetry((n) => n + 1)}>تلاش مجدد</Button></>;
  if (!catalog.data) return <LoadingSkeleton rows={5} />;
  return <MoneyProvider unit={catalog.data.currencyDisplay}>
    <WorkspaceBody base={base} catalog={catalog.data} locationId={locationId} setLocation={setLocation} refresh={refresh} onRefresh={() => setRefresh((n) => n + 1)} />
  </MoneyProvider>;
}
function WorkspaceBody({ base, catalog, locationId, setLocation, refresh, onRefresh }: {
  base: string; catalog: Catalog; locationId: string; setLocation: (v: string) => void; refresh: number; onRefresh: () => void;
}) {
  const [tab, setTab] = useState("overview");
  const day = useReport<{ today: string }>(`${base}/day${locationId ? `?locationId=${locationId}` : ""}`, refresh);
  const [range, setRange] = useState(() => businessDateRange("last_30_days", catalog.today));
  const params = new URLSearchParams({ ...(range.dateFrom ? { dateFrom: range.dateFrom } : {}), ...(range.dateTo ? { dateTo: range.dateTo } : {}), ...(locationId ? { locationId } : {}) });
  const filters = params.toString();
  const tabs = [
    { key: "overview", label: "نمای کلی" },
    ...(catalog.reports.length ? [{ key: "accounting", label: "حسابداری و فروش" }, { key: "operations", label: "عملیات و موجودی" }, { key: "branches", label: "مقایسهٔ شعب" }] : []),
    ...(catalog.apps.includes("crm") ? [{ key: "crm", label: "مشتریان / CRM" }] : []),
    ...(catalog.apps.includes("growth") ? [{ key: "growth", label: "رشد و بازاریابی" }] : []),
    ...(catalog.apps.includes("website") ? [{ key: "websites", label: "مدیریت وب‌سایت" }] : []),
    { key: "health", label: "سلامت سیستم" },
  ];
  const invalid = !!range.dateFrom && !!range.dateTo && range.dateFrom > range.dateTo;
  return <div className="space-y-4">
    <SectionCard title="گزارش‌ها و تحلیل" description="فضای مشاورهٔ پشتیبانی · فقط مشاهده · همان خدمات گزارش‌گیری کسب‌وکار">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="از روز کاری"><JalaliDatePicker ariaLabel="از روز کاری" value={range.dateFrom} onChange={(dateFrom) => setRange({ ...range, dateFrom })} /></Field>
        <Field label="تا روز کاری"><JalaliDatePicker ariaLabel="تا روز کاری" value={range.dateTo} onChange={(dateTo) => setRange({ ...range, dateTo })} /></Field>
        <Field label="شعبه"><select aria-label="شعبه" className={inputClass} value={locationId} onChange={(e) => setLocation(e.target.value)}>
          <option value="">همهٔ شعب (در گزارش‌های قابل تجمیع)</option>
          {catalog.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select></Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {([["current_day", "امروز"], ["previous_day", "دیروز"], ["last_7_days", "۷ روز اخیر"], ["last_30_days", "۳۰ روز اخیر"], ["current_month", "ماه جاری"]] as [BusinessDateRangePreset, string][]).map(([preset, label]) =>
          <FilterChip key={preset} selected={false} disabled={!day.data} onClick={() => day.data && setRange(businessDateRange(preset, day.data.today))}>{label}</FilterChip>)}
        <Button variant="outline" onClick={onRefresh}>تازه‌سازی</Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">تاریخ‌ها مطابق روز کاری مرجع کسب‌وکار هستند. موجودی و سلامت، وضعیت جاری‌اند؛ پنجرهٔ CRM و رشد در همان بخش نوشته شده است.</p>
    </SectionCard>
    <TabBar idPrefix="business-reports" label="بخش‌های گزارش" tabs={tabs} active={tab} onChange={setTab} />
    <TabPanel idPrefix="business-reports" active={tab}>
      {invalid ? <ErrorBox>تاریخ شروع نمی‌تواند پس از پایان باشد.</ErrorBox> :
        tab === "accounting" || tab === "operations" ? <ReportLibrary key={tab} base={base} catalog={catalog} filters={filters} refresh={refresh} operations={tab === "operations"} /> :
        <AppPanel key={tab} base={base} tab={tab} filters={filters} locationId={locationId} refresh={refresh} />}
    </TabPanel>
  </div>;
}
function AppPanel({ base, tab, filters, locationId, refresh }: { base: string; tab: string; filters: string; locationId: string; refresh: number }) {
  const response = useReport<Overview | CrmOverview | GrowthOverview | Websites | Health | BusinessOverview>(`${base}/${tab}?${filters}`, refresh);
  return <div className="space-y-4">
    {response.error ? <ErrorBox>{response.error}</ErrorBox> : !response.data ? <LoadingSkeleton rows={5} /> : (() => {
      switch (tab) {
        case "overview": return <OverviewPanel data={response.data as Overview} locationId={locationId} />;
        case "crm": return <CrmPanel data={response.data as CrmOverview} />;
        case "growth": return <GrowthPanel data={response.data as GrowthOverview} />;
        case "websites": return <WebsitesPanel data={response.data as Websites} />;
        case "health": return <HealthPanel data={response.data as Health} />;
        case "branches": return <BranchesPanel data={response.data as BusinessOverview} />;
      }
    })()}
    {tab === "websites" && <RemoteCms base={base} refresh={refresh} />}
  </div>;
}
function RemoteCms({ base, refresh }: { base: string; refresh: number }) {
  const result = useReport<Cms>(`${base}/cms`, refresh);
  return result.error ? <ErrorBox>CMS در دسترس نیست. گزارش‌های دیگر مستقل‌اند.</ErrorBox> : result.data ? <CmsPanel data={result.data} /> : <SectionCard title="سایت‌ساز اشوبه"><LoadingSkeleton rows={3} /></SectionCard>;
}
type Definition = Catalog["reports"][number];
type Result = { pagination?: ReportDetailPagination | null; rows?: ReportRow[]; previous?: ReportRow[] | null; report?: Record<string, unknown>; comparison?: Record<string, unknown> };
function ReportLibrary({ base, catalog, filters, refresh, operations }: { base: string; catalog: Catalog; filters: string; refresh: number; operations: boolean }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [compare, setCompare] = useState(false);
  const [detailPage, setDetailPage] = useState({ filterKey: "", page: 1 });
  const pageKey = `${selected}:${filters}`;
  const page = detailPage.filterKey === pageKey ? detailPage.page : 1;
  const [previousAsOfDate, setPreviousAsOfDate] = useState("");
  const [builder, setBuilder] = useState(false);
  const available = catalog.reports.filter((r) => !operations || ["inventory", "operations"].includes(r.group));
  const reports = available.filter((r) => normalizePosSearchText(`${r.label} ${r.groupLabel}`).includes(normalizePosSearchText(search)));
  const def = available.find((r) => r.key === selected);
  const comparable = !!def && (COMPARABLE_SHAPES.has(def.shape) || (def.shape === "rows" && def.hasDateColumn));
  const query = `${filters}&page=${page}${compare && comparable ? "&compare=1" : ""}${previousAsOfDate && compare && def?.shape === "balance_sheet" ? `&previousAsOfDate=${previousAsOfDate}` : ""}`;
  const result = useReport<Result>(def && !builder ? `${base}/standard/${def.key}?${query}` : null, refresh);
  return <div className="space-y-4">
    <SectionCard title="فهرست گزارش‌های متناسب با صنعت">
      <SearchField label="جست‌وجوی گزارش" value={search} onChange={setSearch} placeholder="جست‌وجوی گزارش یا گروه" />
      <select className={`${inputClass} mt-3`} aria-label="انتخاب گزارش" value={selected} onChange={(e) => { setSelected(e.target.value); setBuilder(false); }}>
        <option value="">یک گزارش انتخاب کنید</option>
        {[...new Set(reports.map((r) => r.groupLabel))].map((group) => <optgroup key={group} label={group}>{reports.filter((r) => r.groupLabel === group).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup>)}
      </select>
      {!operations && <Button variant="outline" className="mt-3" onClick={() => setBuilder(!builder)}>پرس‌وجوی سفارشی (فقط خواندن)</Button>}
      {def && !builder && <>
        <p className="mt-3 text-sm text-muted-foreground">{def.description}</p>
        {comparable && <label className="mt-3 flex items-center gap-2"><Checkbox checked={compare} onCheckedChange={(v) => setCompare(v === true)} />مقایسه با دورهٔ قبل</label>}
        {compare && def.shape === "balance_sheet" && <Field label="تاریخ ترازنامهٔ قبلی"><JalaliDatePicker ariaLabel="تاریخ ترازنامهٔ قبلی" value={previousAsOfDate} onChange={setPreviousAsOfDate} /></Field>}
      </>}
    </SectionCard>
    {builder ? <CustomQuery base={base} catalog={catalog} filters={filters} refresh={refresh} /> :
      !def ? <EmptyState title="گزارشی انتخاب نشده است">گزارش‌ها فقط هنگام انتخاب اجرا می‌شوند.</EmptyState> :
      result.error ? <ErrorBox>{result.error}</ErrorBox> : !result.data ? <LoadingSkeleton rows={5} /> : <><ReportResult key={`${def.key}:${query}`} def={def} result={result.data} />
        {result.data.pagination && result.data.pagination.pages > 1 && <div className="flex items-center justify-between gap-3">
          <Button variant="outline" disabled={result.data.pagination.page <= 1} onClick={() => setDetailPage({ filterKey: pageKey, page: result.data!.pagination!.page - 1 })}>جزئیات قبلی</Button>
          <span>صفحهٔ {formatPersianNumber(result.data.pagination.page)} از {formatPersianNumber(result.data.pagination.pages)} · {formatPersianNumber(result.data.pagination.total)} ردیف</span>
          <Button variant="outline" disabled={result.data.pagination.page >= result.data.pagination.pages} onClick={() => setDetailPage({ filterKey: pageKey, page: result.data!.pagination!.page + 1 })}>جزئیات بعدی</Button>
        </div>}
      </>}
  </div>;
}
function ReportResult({ def, result }: { def: Pick<Definition, "label" | "shape" | "chartType" | "money" | "config">; result: Result }) {
  const money = useMoney();
  const formatter = def.money ? money.format : formatPersianNumber;
  const chart = rowsToChartData(result.rows ?? []);
  const previous = rowsToChartData(result.previous ?? []);
  const payload = result.comparison ?? result.report;
  return <SectionCard title={def.label}>
    {payload ? <StructuredReportBody readOnly shape={def.shape as ReportShape} payload={payload} /> : <>
      {chart.length === 0 ? <EmptyState>در این بازه داده‌ای ثبت نشده است؛ شعبه و تاریخ را بررسی کنید.</EmptyState> : <ChartPreview chartType={def.chartType ?? "bar"} data={chart} label={def.label} formatValue={formatter} />}
      <p className="my-3 text-xs text-muted-foreground">نمودار و جدول از یک مجموعهٔ نتیجه هستند؛ حداکثر {formatPersianNumber(def.config?.limit ?? 1000)} ردیف تجمیعی، نه همهٔ رکوردهای خام.</p>
      <PagedReportTable caption="داده‌های نمودار" rows={chart} columns={[
        { key: "dim", header: "بُعد", cell: (r) => r.label },
        { key: "value", header: "مقدار", cell: (r) => formatter(r.value), numeric: true },
      ]} />
      {result.previous && <SectionCard title="دورهٔ قبل — با همان معیار و مقیاس عددی">
        <PagedReportTable caption="دورهٔ قبل" rows={previous} columns={[
          { key: "dim", header: "بُعد", cell: (r) => r.label }, { key: "value", header: "مقدار", cell: (r) => formatter(r.value), numeric: true },
        ]} />
      </SectionCard>}
    </>}
  </SectionCard>;
}
function CustomQuery({ base, catalog, filters, refresh }: { base: string; catalog: Catalog; filters: string; refresh: number }) {
  const [viewKey, setView] = useState(catalog.views[0]?.key ?? "");
  const view = catalog.views.find((v) => v.key === viewKey);
  const [metricKey, setMetric] = useState("");
  const [dimensionKey, setDimension] = useState("");
  const [aggregationKey, setAggregation] = useState("");
  const metric = view?.metrics.find((m) => m.key === metricKey) ?? view?.metrics[0];
  const dimension = view?.dimensions.find((d) => d.key === dimensionKey) ?? view?.dimensions[0];
  const aggregation = metric?.aggregations.find((a) => a === aggregationKey) ?? metric?.aggregations[0];
  const [run, setRun] = useState<{ body: string; filterKey: string; money: boolean; label: string } | null>(null);
  const locationId = new URLSearchParams(filters).get("locationId");
  const result = useReport<Result>(run && run.filterKey === filters ? `${base}/query${locationId ? `?locationId=${locationId}` : ""}` : null, refresh, run?.body);
  if (!view || !metric || !dimension) return <EmptyState>منبع گزارش در دسترس نیست.</EmptyState>;
  return <SectionCard title="پرس‌وجوی سفارشی">
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="منبع"><select aria-label="منبع" className={inputClass} value={view.key} onChange={(e) => { setView(e.target.value); setRun(null); }}>{catalog.views.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}</select></Field>
      <Field label="معیار"><select aria-label="معیار" className={inputClass} value={metric.key} onChange={(e) => { setMetric(e.target.value); setRun(null); }}>{view.metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></Field>
      <Field label="بُعد"><select aria-label="بُعد" className={inputClass} value={dimension.key} onChange={(e) => { setDimension(e.target.value); setRun(null); }}>{view.dimensions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></Field>
      <Field label="تجمیع"><select aria-label="تجمیع" className={inputClass} value={aggregation} onChange={(e) => { setAggregation(e.target.value); setRun(null); }}>{metric.aggregations.map((a) => <option key={a} value={a}>{({ sum: "جمع", avg: "میانگین", count: "تعداد", count_distinct: "تعداد یکتا" })[a]}</option>)}</select></Field>
    </div>
    <Button className="my-3" onClick={() => {
      const params = new URLSearchParams(filters);
      setRun({ filterKey: filters, money: !!metric.money, label: `${view.label} · ${metric.label}`, body: JSON.stringify({
        view: view.key, metric: metric.key, dimension: dimension.key, aggregation, limit: 1000,
        ...(view.hasDateColumn ? { filters: { dateFrom: params.get("dateFrom") || undefined, dateTo: params.get("dateTo") || undefined } } : {}),
      }) });
    }}>اجرای گزارش</Button>
    {run?.filterKey === filters && (result.error ? <ErrorBox>{result.error}</ErrorBox> : !result.data ? <LoadingSkeleton rows={3} /> : <ReportResult def={{ label: run.label, money: run.money, shape: "rows", chartType: "bar", config: null }} result={result.data} />)}
    <InfoBox>فقط منابع، معیارها و ابعاد موجود در فهرست مجازند؛ ورود SQL یا شناسهٔ کسب‌وکار مجاز نیست.</InfoBox>
  </SectionCard>;
}
