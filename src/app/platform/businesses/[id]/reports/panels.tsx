"use client";
import { LIFECYCLE_STAGES } from "@/lib/crm-scoring";
import { DEAL_STAGE_META } from "@/lib/crm-shared";
import { CAMPAIGN_STATE_LABELS, type CampaignState } from "@/lib/growth-shared";
import type { ReactNode } from "react";
import { KpiCard, KpiRow, SectionCard, EmptyState } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox } from "@/app/dashboard/ui";
import { ChartPreview, DataTable } from "@/app/dashboard/reports/chart-preview";
import { PagedReportTable } from "@/app/dashboard/reports/paged-report-table";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { CrmOverview } from "@/lib/crm-overview";
import type { GrowthOverview } from "@/lib/growth-overview";
import type { BusinessOverview } from "@/lib/reports-service";
import type { platformReportSection } from "@/lib/platform-business-reporting";

type Sections = Awaited<ReturnType<typeof platformReportSection>>;
export type Catalog = Extract<Sections, { currencyDisplay: string }>;
export type Overview = Extract<Sections, { sales: unknown }>;
export type Websites = Extract<Sections, { wp: unknown }>;
export type Cms = Extract<Sections, { managers: unknown }>;
export type Health = Extract<Sections, { sync: unknown }>;
const n = formatPersianNumber;
const day = (s: string | null | undefined) => s ? formatJalali(s) : "—";
function Stats({ items }: { items: [string, ReactNode][] }) {
  return <KpiRow>{items.map(([label, value]) => <KpiCard key={label} label={label} value={value} />)}</KpiRow>;
}
export function BranchesPanel({ data }: { data: BusinessOverview }) {
  const money = useMoney();
  const chart = data.branches.map((r) => ({ label: r.locationName, value: r.total }));
  return <SectionCard title="مقایسهٔ شعب — سفارش‌های تکمیل‌شده">
    <ChartPreview chartType="bar" data={chart} label="فروش شعب" formatValue={money.format} />
    <PagedReportTable caption="مقایسهٔ شعب" rows={data.branches} columns={[
      { key: "name", header: "شعبه", cell: (r) => r.locationName },
      { key: "orders", header: "سفارش", cell: (r) => n(r.orderCount), numeric: true },
      { key: "sales", header: "فروش", cell: (r) => money.format(r.total), numeric: true },
      { key: "discount", header: "تخفیف", cell: (r) => money.format(r.discount), numeric: true },
      { key: "tax", header: "مالیات", cell: (r) => money.format(r.tax), numeric: true },
      { key: "cogs", header: "بهای تمام‌شده", cell: (r) => money.format(r.cogs), numeric: true },
    ]} />
  </SectionCard>;
}
export function OverviewPanel({ data, locationId }: { data: Overview; locationId: string }) {
  const money = useMoney();
  const sales = locationId ? data.sales?.data?.branches.find((b) => b.locationId === locationId) : data.sales?.data?.consolidated;
  const pnl = data.accounting?.data;
  return <div className="space-y-4">
    {[data.sales, data.accounting, data.activity].some((p) => p?.error) && <ErrorBox>بخشی از گزارش در دسترس نیست؛ بخش‌های دیگر مستقل نمایش داده می‌شوند.</ErrorBox>}
    {sales && <Stats items={[["سفارش‌های تکمیل‌شده", n(sales.orderCount)], ["فروش", money.format(sales.total)], ["تخفیف", money.format(sales.discount)], ["مالیات", money.format(sales.tax)]]} />}
    {pnl && <Stats items={[["درآمد دفتر", money.format(pnl.totalRevenue)], ["هزینه‌ها", money.format(pnl.totalExpenses)], ["سود ناخالص", money.format(pnl.grossProfit)], ["سود خالص", money.format(pnl.netIncome)]]} />}
    {data.activity?.data && <SectionCard title="وضعیت جاری — کل کسب‌وکار، مستقل از بازه">
      <Stats items={[["سفارش باز", n(data.activity.data.openOrders)], ["اعضای فعال", n(data.activity.data.members)], ["آخرین فعالیت", day(data.activity.data.lastActivity)]]} />
    </SectionCard>}
    {sales?.orderCount === 0 && <InfoBox>در بازهٔ انتخاب‌شده فروش تکمیل‌شده‌ای ثبت نشده است. سفارش‌های باز جزو فروش تاریخی نیستند.</InfoBox>}
    {data.sales?.data && <BranchesPanel data={data.sales.data} />}
    <InfoBox>برای روندها، مقایسهٔ دوره‌ها و جزئیات، یک گزارش از فهرست انتخاب کنید. CRM و رشد پنجرهٔ زمانی تعریف‌شده در برنامهٔ خود را دارند.</InfoBox>
  </div>;
}
export function CrmPanel({ data: d }: { data: CrmOverview }) {
  const m = useMoney();
  const lifecycle = d.lifecycle.map((r) => ({ label: LIFECYCLE_STAGES[r.stage].label, value: r.count }));
  return <div className="space-y-4">
    <InfoBox>کل کسب‌وکار · پنجرهٔ مرجع CRM: {day(d.window.from)} تا {day(d.window.to)}. فیلتر شعبه و تاریخ بالا این نمای مرجع را تغییر نمی‌دهد.</InfoBox>
    <Stats items={[["کل مشتریان", n(d.customers.total)], ["مشتریان فعال", n(d.customers.active)], ["جدید در دوره", n(d.customers.new30d)], ["جدید در دورهٔ قبل", n(d.customers.newPrevious30d)], ["بدون خرید", n(d.customers.neverPurchased)], ["پرونده‌های تکراری", n(d.duplicates)]]} />
    <Stats items={[["ارزش خرید تاریخی", m.formatText(d.value.totalHistoricRial)], ["ارزش متوسط مشتری", m.formatText(d.value.averageCustomerRial)], ["اعتبار مشتری در دفتر", m.formatText(d.value.storeCreditRial)], ["فرصت‌های باز", n(d.pipeline.openCount)], ["ارزش موزون قیف", m.formatText(d.pipeline.weightedValueRial)], ["نرخ برد (درصد)", n(d.pipeline.winRatePercent)]]} />
    <SectionCard title="چرخهٔ عمر مشتریان">
      <ChartPreview chartType="bar" data={lifecycle} label="توزیع چرخهٔ عمر" />
      <DataTable columns={["مرحله", "تعداد مشتری"]} data={lifecycle} />
    </SectionCard>
    <Stats items={[["مشتری بازگشته", n(d.retention.retainedCount)], ["مشتری ازدست‌رفته", n(d.retention.churnedCount)], ["نرخ بازگشت (درصد)", n(d.retention.retentionRate)], ["نرخ ریزش (درصد)", n(d.retention.churnRate)]]} />
    <SectionCard title="رضایت و دسترسی ارتباطی"><Stats items={[["رضایت پیامک", n(d.consent.smsGranted)], ["قابل دسترس با پیامک", n(d.consent.smsReachable)], ["رضایت ایمیل", n(d.consent.emailGranted)], ["قابل دسترس با ایمیل", n(d.consent.emailReachable)]]} /></SectionCard>
    <SectionCard title="خدمات و پیگیری"><Stats items={[["پروندهٔ باز", n(d.cases.open)], ["فوری", n(d.cases.urgent)], ["حل‌شده در دوره", n(d.cases.resolved30d)], ["کارهای عقب‌افتاده", n(d.tasks.overdue)], ["بخش‌بندی‌های فعال", n(d.segments.total)]]} /></SectionCard>
    <SectionCard title="قیف فروش"><PagedReportTable caption="قیف فروش" rows={d.pipeline.byStage} columns={[
      { key: "stage", header: "مرحله", cell: (r) => DEAL_STAGE_META[r.stage].label }, { key: "count", header: "تعداد", cell: (r) => n(r.count) }, { key: "value", header: "ارزش", cell: (r) => m.formatText(r.valueRial) },
    ]} /></SectionCard>
  </div>;
}
export function GrowthPanel({ data: d }: { data: GrowthOverview }) {
  const m = useMoney();
  const campaignChart = d.campaigns.top.map((r) => ({ label: r.promotionName, value: r.discountRial }));
  return <div className="space-y-4">
    <InfoBox>پنجرهٔ مرجع رشد: {day(d.window.from)} تا {day(d.window.to)} · فیلتر شعبه فقط پیش‌بینی خرید مجدد را محدود می‌کند.</InfoBox>
    <Stats items={Object.entries(d.campaigns.counts).map(([key, value]) => [CAMPAIGN_STATE_LABELS[key as CampaignState], n(value)])} />
    <Stats items={[["کاربرد کمپین", n(d.campaigns.applications)], ["تخفیف کمپین", m.format(d.campaigns.discountRial)], ["امتیاز در گردش", n(d.loyalty.pointsOutstanding)], ["مشتری دارای امتیاز", n(d.loyalty.customersWithPoints)], ["بدهی کارت هدیه — دفتر", m.format(d.giftCards.outstandingRial)], ["پورسانت تعهدشده", d.commission ? m.format(d.commission.accrued30d) : "—"], ["نامزد خرید مجدد", d.hasLocation ? n(d.repurchase.due) : "یک شعبه انتخاب کنید"]]} />
    <Stats items={[["امتیاز کسب‌شده در دوره", n(d.loyalty.earned30d)], ["امتیاز مصرف‌شده در دوره", n(d.loyalty.redeemed30d)], ["ارزش تخمینی امتیازها — نه بدهی دفتر", m.format(d.loyalty.pointsValueEstimate)], ["کارت هدیه صادرشده در دوره", n(d.giftCards.issued30d)], ["ارزش صدور در دوره", m.format(d.giftCards.issuedValue30d)]]} />
    <SectionCard title="عملکرد کمپین‌ها"><ChartPreview chartType="bar" label="تخفیف کمپین" data={campaignChart} formatValue={m.format} /><DataTable columns={["کمپین", "تخفیف"]} data={campaignChart} formatValue={m.format} /></SectionCard>
    <SectionCard title="کمپین‌ها"><PagedReportTable caption="کمپین‌ها" rows={d.campaigns.list} columns={[
      { key: "name", header: "نام", cell: (r) => r.name }, { key: "state", header: "وضعیت", cell: (r) => CAMPAIGN_STATE_LABELS[r.state] },
      { key: "from", header: "شروع", cell: (r) => day(r.activeFrom) }, { key: "to", header: "پایان", cell: (r) => day(r.activeTo) },
    ]} /></SectionCard>
    <SectionCard title="پل حسابداری — ماندهٔ واقعی حساب‌ها"><PagedReportTable caption="مانده حساب‌ها" rows={d.bridge} columns={[
      { key: "account", header: "حساب", cell: (r) => `${r.code} · ${r.name}` }, { key: "balance", header: "مانده", cell: (r) => m.format(r.balance) },
    ]} /></SectionCard>
    <SectionCard title="فعالیت اخیر"><PagedReportTable caption="فعالیت رشد" rows={d.activity} columns={[
      { key: "subject", header: "موضوع", cell: (r) => r.subject }, { key: "at", header: "تاریخ", cell: (r) => day(r.at) },
      { key: "amount", header: "مقدار", cell: (r) => r.kind === "points" ? `${n(r.amount)} امتیاز` : m.format(r.amount) },
    ]} /></SectionCard>
  </div>;
}
export function WebsitesPanel({ data }: { data: Websites }) {
  const w = data.wp.data;
  return <SectionCard title="وردپرس و ووکامرس — وضعیت محلی همگام‌شده، کل کسب‌وکار">
    {!w ? <ErrorBox>آمار وردپرس در دسترس نیست.</ErrorBox> : <>
      <Stats items={[["اتصال‌ها", n(w.connections.total)], ["اتصال فعال", n(w.connections.active)], ["اتصال افزونه", n(w.connections.plugin)], ["اتصال REST", n(w.connections.rest)], ["محصول همگام‌شده", n(w.products)], ["سفارش آنلاین", n(w.orders)], ["مشتری آنلاین", n(w.customers)], ["دسته‌ها و برچسب‌ها", n(w.terms)], ["نوشته‌ها", n(w.content.posts)], ["برگه‌ها", n(w.content.pages)], ["رسانه‌ها", n(w.content.media)], ["صف در انتظار", n(w.pendingJobs)], ["خطای صف", n(w.failedJobs)], ["کار متوقف‌شده", n(w.deadJobs)], ["رویداد ورودی در انتظار", n(w.pendingInboxEvents)], ["رویداد ورودی ناموفق", n(w.failedInboxEvents)]]} />
      {(w.failedJobs > 0 || w.deadJobs > 0 || w.failedInboxEvents > 0) && <InfoBox>خطای همگام‌سازی نیاز به بررسی دارد. این صفحه عملیات تلاش مجدد یا تغییر اتصال ندارد.</InfoBox>}
      {w.connections.total === 0 && <EmptyState>فروشگاه وردپرسی متصل نشده است.</EmptyState>}
    </>}
  </SectionCard>;
}
export function CmsPanel({ data }: { data: Cms }) {
  const overview = data.overview.data;
  return <SectionCard title="سایت‌ساز اشوبه — مستقل از وردپرس">
    <p>{data.managers.data?.cms.domain ?? "دامنه ثبت نشده"}</p>
    {!overview?.connected ? <InfoBox>سایت متصل نیست یا دسترسی به CMS ممکن نشد؛ گزارش‌های محلی همچنان قابل استفاده‌اند.</InfoBox> : <>
      <p className="my-3 text-sm">{overview.site?.name} · {overview.site?.status === "active" ? "سایت فعال" : "سایت غیرفعال"} · {overview.site?.domainVerified ? "دامنه تأییدشده" : "دامنه تأییدنشده"}</p>
      <InfoBox>پیش‌نمایش محدود مرجع CMS: حداکثر ۲۰ برگه، ۲۰ نوشته، ۵۰ محصول و ۵۰ سفارش؛ این تعدادها مجموع کل سایت نیستند.</InfoBox>
      <PagedReportTable caption="محتوای CMS" rows={[...(overview.pages ?? []), ...(overview.posts ?? [])]} columns={[
        { key: "title", header: "عنوان", cell: (r) => r.title }, { key: "status", header: "وضعیت", cell: (r) => r.status === "published" ? "منتشرشده" : "پیش‌نویس" },
      ]} />
      <PagedReportTable caption="محصولات CMS (پیش‌نمایش محدود)" rows={overview.products ?? []} columns={[{ key: "title", header: "محصول", cell: (r) => r.title }]} />
      <PagedReportTable caption="ورود سفارش‌های CMS" rows={overview.orders ?? []} columns={[
        { key: "id", header: "شناسهٔ سفارش", cell: (r) => r.id }, { key: "status", header: "وضعیت ورود", cell: (r) => r.status ?? "وارد نشده" },
      ]} />
    </>}
  </SectionCard>;
}
export function HealthPanel({ data: d }: { data: Health }) {
  return <div className="space-y-4">
    <SectionCard title="همگام‌سازی — وضعیت جاری کل کسب‌وکار">
      {d.sync.data ? <><Stats items={[["ارسال‌نشده", n(d.sync.data.unsent)], ["ردشده", n(d.sync.data.refused)], ["موکول‌شده", n(d.sync.data.deferred)], ["رویدادهای کنارگذاشته‌شده", n(d.sync.data.openDeadLetters)], ["تعارض دادهٔ مرجع", n(d.sync.data.masterConflicts)], ["آخرین ارسال موفق", day(d.sync.data.lastPushSuccessAt)]]} />
        {d.sync.data.level !== "ok" && <InfoBox>هشدار همگام‌سازی: {d.sync.data.issues.map((i) => ({ sync_disabled: "همگام‌سازی غیرفعال", backlog_stale: "صف قدیمی", backlog_growing: "افزایش صف", events_refused: "رویداد ردشده", dead_letters: "رویداد کنارگذاشته‌شده", master_conflicts: "تعارض دادهٔ مرجع", drift: "اختلاف داده", no_recent_contact: "عدم ارتباط اخیر" })[i.code]).join("، ")}</InfoBox>}</> : <ErrorBox>وضعیت همگام‌سازی در دسترس نیست.</ErrorBox>}
    </SectionCard>
    <SectionCard title="پشتیبان‌گیری">
      {d.backup.data ? <><Stats items={[["آخرین موفق محلی", day(d.backup.data.localLastSuccessAt)], ["آخرین موفق ابری", day(d.backup.data.cloudLastSuccessAt)]]} />
        {d.backup.data.alert.level === "error" && <InfoBox>پشتیبان‌گیری ناموفق بوده یا از زمان مورد انتظار گذشته است.</InfoBox>}
        {!d.backup.data.enabled && <InfoBox>پشتیبان‌گیری این کسب‌وکار فعال نیست؛ این نما وضعیت پشتیبان کل استقرار را نشان نمی‌دهد.</InfoBox>}</> : <ErrorBox>وضعیت پشتیبان در دسترس نیست.</ErrorBox>}
    </SectionCard>
    <SectionCard title="دستگاه‌ها — فقط مشاهده">
      {d.devices.data ? <PagedReportTable caption="سلامت دستگاه‌ها" rows={d.devices.data} columns={[
        { key: "name", header: "دستگاه", cell: (r) => r.name }, { key: "location", header: "شعبه", cell: (r) => r.location },
        { key: "installed", header: "نسخهٔ نصب‌شده", cell: (r) => <bdi>{r.installedVersion ? toPersianDigits(r.installedVersion) : "نامشخص"}</bdi> },
        { key: "target", header: "نسخهٔ هدف", cell: (r) => <bdi>{r.targetVersion ? toPersianDigits(r.targetVersion) : "—"}</bdi> },
        { key: "version", header: "وضعیت نسخه", cell: (r) => ({ up_to_date: "به‌روز", update_available: "به‌روزرسانی موجود", ahead_of_target: "جلوتر از هدف", version_mismatch: "نسخه نامعتبر", unknown: "نامشخص", stale: "گزارش قدیمی", offline: "آفلاین", error: "خطا", unsupported: "پشتیبانی‌نشده", incompatible: "ناسازگار" })[r.compliance] },
        { key: "contact", header: "ارتباط", cell: (r) => ({ online: "آنلاین", delayed: "با تأخیر", stale: "قدیمی", offline: "آفلاین" })[r.connectivity] },
        { key: "reported", header: "آخرین گزارش نسخه", cell: (r) => day(r.lastReportAt) },
        { key: "last", header: "آخرین مشاهده", cell: (r) => day(r.lastSeenAt) }, { key: "sync", header: "آخرین ارسال موفق", cell: (r) => day(r.lastSuccessfulPushAt) },
        { key: "error", header: "خطا", cell: (r) => r.hasError ? "نیاز به بررسی" : "—" },
      ]} /> : <ErrorBox>فهرست دستگاه‌ها در دسترس نیست.</ErrorBox>}
    </SectionCard>
  </div>;
}
