"use client";

/**
 * Issue #839 §14 — the dealership's reports, rendered in «گزارش‌های آماده».
 *
 * Same shell, same table, same date range as every other trade report
 * (`trade-report-views.tsx` next door): the numbers come from
 * `/api/reports/standard/[key]`, which runs the *same* service functions the
 * manager's own screens read, so a report opened from «گزارش‌ها» cannot
 * disagree with the board.
 *
 * Read-only on purpose. Recording a cost, releasing a hold or issuing an
 * invoice are actions, and actions stay on the trade's own page.
 */
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { EmptyState, StatusBadge } from "../page-chrome";
import { ReportTable } from "./report-table";
import { StatStrip } from "./trade-report-views";

/* ------------------------------------------------------------------ *
 * Payload shapes — mirrors src/lib/automotive-reports.ts. Declared here
 * so this stays a client module with no server-only dependency.
 * ------------------------------------------------------------------ */

export interface VehicleInventoryReportPayload {
  today: string;
  rows: {
    serialId: string;
    stockNumber: string;
    displayName: string;
    make: string;
    model: string;
    modelYear: number | null;
    condition: "new" | "used";
    state: string;
    locationName: string | null;
    acquiredOn: string;
    daysInStock: number;
    ageBucket: "fresh" | "slow" | "dead";
    acquisitionCostRial: number;
    capitalizedCostRial: number;
    periodExpenseRial: number;
    effectiveCostRial: number;
    askingPriceRial: number;
    potentialMarginRial: number;
    minimumPriceRial: number | null;
    vin: string | null;
    plateNumber: string | null;
  }[];
  summary: {
    count: number;
    newCount: number;
    usedCount: number;
    inStockCount: number;
    reservedCount: number;
    totalAcquisitionCostRial: number;
    totalCapitalizedCostRial: number;
    totalPeriodExpenseRial: number;
    totalEffectiveCostRial: number;
    totalAskingPriceRial: number;
    totalPotentialMarginRial: number;
    averageAgeDays: number | null;
    slowCount: number;
    deadCount: number;
    ageBuckets: { bucket: "fresh" | "slow" | "dead"; label: string; count: number }[];
    byBranch: { locationId: string; locationName: string | null; count: number; effectiveCostRial: number; askingPriceRial: number }[];
  };
}

export interface VehicleSalesReportPayload {
  dateFrom: string | null;
  dateTo: string | null;
  rows: {
    serialId: string;
    stockNumber: string;
    displayName: string;
    make: string;
    model: string;
    modelYear: number | null;
    condition: "new" | "used";
    soldOn: string;
    daysToSale: number | null;
    salePriceRial: number;
    revenueRial: number;
    effectiveCostRial: number;
    grossProfitRial: number;
    marginPercent: number | null;
    salespersonName: string | null;
    locationName: string | null;
    reversed: boolean;
  }[];
  summary: {
    unitsSold: number;
    revenueGrossRial: number;
    revenueRial: number;
    cogsRial: number;
    grossProfitRial: number;
    averageMarginPercent: number | null;
    averageDaysToSale: number | null;
    acquisitions: { count: number; costRial: number };
    bySalesperson: VehicleProfitGroupPayload[];
    byMakeModel: VehicleProfitGroupPayload[];
    reversedCount: number;
  };
}

export interface VehicleProfitGroupPayload {
  key: string;
  label: string;
  units: number;
  revenueRial: number;
  grossProfitRial: number;
  marginPercent: number | null;
  averageDaysToSale: number | null;
}

export interface VehicleReservationsReportPayload {
  today: string;
  rows: {
    id: string;
    stockNumber: string;
    displayName: string;
    customerName: string | null;
    status: "active" | "converted" | "released" | "expired";
    expiresAt: string | null;
    expiresAtTime: string | null;
    depositRial: number;
    depositMethod: string | null;
    depositRefundable: boolean;
    depositRefundedRial: number;
    createdAt: string;
    closedAt: string | null;
    ageDays: number;
    locationName: string | null;
    releaseReason: string | null;
  }[];
  summary: {
    total: number;
    activeCount: number;
    convertedCount: number;
    releasedCount: number;
    expiredCount: number;
    depositHeldRial: number;
    depositRefundedRial: number;
    nonRefundableHeldRial: number;
    expiringSoonCount: number;
  };
}

const HOLD_STATUS_LABELS: Record<string, string> = {
  active: "فعال",
  converted: "تبدیل به فروش",
  released: "آزادشده",
  expired: "منقضی",
};

const HOLD_STATUS_TONE: Record<string, "active" | "positive" | "neutral" | "danger"> = {
  active: "active",
  converted: "positive",
  released: "neutral",
  expired: "danger",
};

const DEPOSIT_METHOD_LABELS: Record<string, string> = {
  cash: "نقدی",
  card: "کارت‌خوان",
  card_to_card: "کارت به کارت",
  online: "آنلاین",
};

const AGE_BUCKET_TONE: Record<string, "positive" | "active" | "danger"> = {
  fresh: "positive",
  slow: "active",
  dead: "danger",
};

const AGE_BUCKET_LABELS: Record<string, string> = {
  fresh: "تازه",
  slow: "کند",
  dead: "راکد",
};

const percent = (value: number | null | undefined) =>
  value == null ? "—" : `${toPersianDigits(String(value))}٪`;

/* ------------------------------------------------------------------ */

export function VehicleInventoryView({ report }: { report: VehicleInventoryReportPayload }) {
  const money = useMoney();
  const rows = report.rows ?? [];
  const summary = report.summary;

  return (
    <div className="min-w-0">
      {summary ? (
        <StatStrip
          stats={[
            { label: "تعداد خودرو", value: formatPersianNumber(summary.count) },
            { label: "ارزش موجودی (ریال)", value: money.format(summary.totalEffectiveCostRial) },
            { label: "جمع قیمت فروش", value: money.format(summary.totalAskingPriceRial) },
            { label: "حاشیهٔ بالقوه", value: money.format(summary.totalPotentialMarginRial) },
            { label: "میانگین روز در انبار", value: summary.averageAgeDays == null ? "—" : formatPersianNumber(summary.averageAgeDays) },
            { label: "کند / راکد", value: `${formatPersianNumber(summary.slowCount)} / ${formatPersianNumber(summary.deadCount)}` },
            { label: "نو / کارکرده", value: `${formatPersianNumber(summary.newCount)} / ${formatPersianNumber(summary.usedCount)}` },
            { label: "هزینهٔ دوره‌ای (غیر سرمایه‌ای)", value: money.format(summary.totalPeriodExpenseRial) },
          ]}
        />
      ) : null}

      <ReportTable
        caption="موجودی و ارزش‌گذاری خودرو"
        rows={rows}
        rowKey={(row) => row.serialId}
        empty={<EmptyState>خودرویی در موجودی نیست.</EmptyState>}
        cardTitle={(row) => `${row.displayName} — ${row.stockNumber}`}
        columns={[
          {
            key: "car",
            header: "خودرو",
            cell: (row) => (
              <div className="min-w-0">
                <div className="font-medium">{row.displayName}</div>
                <div className="text-xs text-muted-foreground">
                  <span dir="ltr">{row.stockNumber}</span>
                  {row.vin ? ` · ${row.vin}` : row.plateNumber ? ` · ${row.plateNumber}` : ""}
                </div>
              </div>
            ),
          },
          {
            key: "type",
            header: "نوع",
            muted: true,
            cell: (row) => (row.condition === "new" ? "نو" : "کارکرده"),
          },
          {
            key: "branch",
            header: "شعبه",
            muted: true,
            desktopOnly: true,
            cell: (row) => row.locationName ?? "—",
          },
          {
            key: "acquired",
            header: "تاریخ خرید",
            muted: true,
            align: "end",
            desktopOnly: true,
            cell: (row) => toPersianDigits(formatJalali(row.acquiredOn)),
          },
          {
            key: "age",
            header: "روز در انبار",
            numeric: true,
            align: "end",
            cell: (row) => <span>{formatPersianNumber(row.daysInStock)}</span>,
          },
          {
            key: "bucket",
            header: "سن",
            align: "end",
            cell: (row) => (
              <StatusBadge tone={AGE_BUCKET_TONE[row.ageBucket] ?? "neutral"}>
                {AGE_BUCKET_LABELS[row.ageBucket] ?? row.ageBucket}
              </StatusBadge>
            ),
          },
          {
            key: "state",
            header: "وضعیت",
            muted: true,
            align: "end",
            cell: (row) => row.state,
          },
          {
            key: "purchase",
            header: "بهای خرید",
            numeric: true,
            align: "end",
            desktopOnly: true,
            cell: (row) => money.format(row.acquisitionCostRial),
          },
          {
            key: "capitalized",
            header: "هزینهٔ سرمایه‌ای",
            numeric: true,
            align: "end",
            desktopOnly: true,
            cell: (row) => money.format(row.capitalizedCostRial),
          },
          {
            key: "effective",
            header: "بهای تمام‌شدهٔ مؤثر",
            numeric: true,
            align: "end",
            cell: (row) => <span className="font-semibold">{money.format(row.effectiveCostRial)}</span>,
          },
          {
            key: "asking",
            header: "قیمت فروش",
            numeric: true,
            align: "end",
            cell: (row) => money.format(row.askingPriceRial),
          },
          {
            key: "margin",
            header: "حاشیهٔ بالقوه",
            numeric: true,
            align: "end",
            cell: (row) => money.format(row.potentialMarginRial),
          },
        ]}
        footer={
          summary
            ? [
                { key: "label", content: `${formatPersianNumber(summary.count)} خودرو` },
                { key: "purchase", content: money.format(summary.totalAcquisitionCostRial), align: "end", numeric: true, label: "بهای خرید" },
                { key: "effective", content: money.format(summary.totalEffectiveCostRial), align: "end", numeric: true, label: "بهای تمام‌شدهٔ مؤثر" },
                { key: "asking", content: money.format(summary.totalAskingPriceRial), align: "end", numeric: true, label: "قیمت فروش" },
                { key: "margin", content: money.format(summary.totalPotentialMarginRial), align: "end", numeric: true, label: "حاشیهٔ بالقوه" },
              ]
            : undefined
        }
      />

      {summary?.byBranch && summary.byBranch.length > 1 ? (
        <div className="mt-4">
          <h3 className="px-1 pb-2 text-sm font-semibold text-foreground">موجودی هر شعبه</h3>
          <ReportTable
            caption="موجودی هر شعبه"
            rows={summary.byBranch}
            rowKey={(branch) => branch.locationId}
            empty={<EmptyState>شعبه‌ای نیست.</EmptyState>}
            columns={[
              { key: "branch", header: "شعبه", cell: (branch) => branch.locationName ?? "—" },
              { key: "count", header: "تعداد", numeric: true, align: "end", cell: (branch) => formatPersianNumber(branch.count) },
              {
                key: "cost",
                header: "ارزش موجودی",
                numeric: true,
                align: "end",
                cell: (branch) => money.format(branch.effectiveCostRial),
              },
              {
                key: "asking",
                header: "جمع قیمت فروش",
                numeric: true,
                align: "end",
                cell: (branch) => money.format(branch.askingPriceRial),
              },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

export function VehicleSalesView({ report }: { report: VehicleSalesReportPayload }) {
  const money = useMoney();
  const rows = report.rows ?? [];
  const summary = report.summary;

  const groupTable = (title: string, groups: VehicleProfitGroupPayload[]) =>
    groups.length > 0 ? (
      <div className="mt-4">
        <h3 className="px-1 pb-2 text-sm font-semibold text-foreground">{title}</h3>
        <ReportTable
          caption={title}
          rows={groups}
          rowKey={(group) => group.key}
          empty={<EmptyState>داده‌ای نیست.</EmptyState>}
          columns={[
            { key: "label", header: title, cell: (group) => group.label },
            { key: "units", header: "تعداد", numeric: true, align: "end", cell: (group) => formatPersianNumber(group.units) },
            { key: "revenue", header: "درآمد خالص", numeric: true, align: "end", cell: (group) => money.format(group.revenueRial) },
            {
              key: "profit",
              header: "سود ناخالص",
              numeric: true,
              align: "end",
              cell: (group) => <span className="font-semibold">{money.format(group.grossProfitRial)}</span>,
            },
            { key: "margin", header: "حاشیه", numeric: true, align: "end", cell: (group) => percent(group.marginPercent) },
            {
              key: "days",
              header: "میانگین روز تا فروش",
              numeric: true,
              align: "end",
              desktopOnly: true,
              cell: (group) => (group.averageDaysToSale == null ? "—" : formatPersianNumber(group.averageDaysToSale)),
            },
          ]}
        />
      </div>
    ) : null;

  return (
    <div className="min-w-0">
      {summary ? (
        <StatStrip
          stats={[
            { label: "خودروهای فروخته‌شده", value: formatPersianNumber(summary.unitsSold) },
            { label: "درآمد خالص (بدون مالیات)", value: money.format(summary.revenueRial) },
            { label: "بهای تمام‌شدهٔ فروش", value: money.format(summary.cogsRial) },
            { label: "سود ناخالص", value: money.format(summary.grossProfitRial) },
            { label: "میانگین حاشیه", value: percent(summary.averageMarginPercent) },
            {
              label: "میانگین روز تا فروش",
              value: summary.averageDaysToSale == null ? "—" : formatPersianNumber(summary.averageDaysToSale),
            },
            {
              label: "خریداری‌شدهٔ دوره",
              value: `${formatPersianNumber(summary.acquisitions.count)} خودرو — ${money.format(summary.acquisitions.costRial)}`,
            },
            ...(summary.reversedCount > 0
              ? [{ label: "برگشت‌خورده", value: formatPersianNumber(summary.reversedCount), tone: "negative" as const }]
              : []),
          ]}
        />
      ) : null}

      <ReportTable
        caption="فروش خودرو در دوره"
        rows={rows}
        rowKey={(row) => row.serialId}
        empty={<EmptyState>در این دوره خودرویی فروش نرفته است.</EmptyState>}
        cardTitle={(row) => `${row.displayName} — ${row.stockNumber}`}
        columns={[
          {
            key: "car",
            header: "خودرو",
            cell: (row) => (
              <div className="min-w-0">
                <div className="font-medium">{row.displayName}</div>
                <div className="text-xs text-muted-foreground">
                  <span dir="ltr">{row.stockNumber}</span>
                  {row.salespersonName ? ` · ${row.salespersonName}` : ""}
                </div>
              </div>
            ),
          },
          { key: "soldOn", header: "تاریخ فروش", muted: true, align: "end", cell: (row) => toPersianDigits(formatJalali(row.soldOn)) },
          {
            key: "days",
            header: "روز تا فروش",
            numeric: true,
            align: "end",
            cell: (row) => (row.daysToSale == null ? "—" : formatPersianNumber(row.daysToSale)),
          },
          { key: "gross", header: "مبلغ فاکتور", numeric: true, align: "end", desktopOnly: true, cell: (row) => money.format(row.salePriceRial) },
          { key: "revenue", header: "درآمد خالص", numeric: true, align: "end", cell: (row) => money.format(row.revenueRial) },
          { key: "cost", header: "بهای منجمد", numeric: true, align: "end", desktopOnly: true, cell: (row) => money.format(row.effectiveCostRial) },
          {
            key: "profit",
            header: "سود ناخالص",
            numeric: true,
            align: "end",
            cell: (row) => <span className="font-semibold">{money.format(row.grossProfitRial)}</span>,
          },
          { key: "margin", header: "حاشیه", numeric: true, align: "end", cell: (row) => percent(row.marginPercent) },
          {
            key: "status",
            header: "وضعیت",
            align: "end",
            cell: (row) =>
              row.reversed ? <StatusBadge tone="danger">برگشت‌خورده</StatusBadge> : <StatusBadge tone="positive">فروخته‌شده</StatusBadge>,
          },
        ]}
        footer={
          summary
            ? [
                { key: "label", content: `${formatPersianNumber(summary.unitsSold)} خودرو` },
                { key: "revenue", content: money.format(summary.revenueRial), align: "end", numeric: true, label: "درآمد خالص" },
                { key: "cogs", content: money.format(summary.cogsRial), align: "end", numeric: true, label: "بهای تمام‌شدهٔ فروش" },
                { key: "profit", content: money.format(summary.grossProfitRial), align: "end", numeric: true, label: "سود ناخالص" },
                { key: "margin", content: percent(summary.averageMarginPercent), align: "end", numeric: true, label: "میانگین حاشیه" },
              ]
            : undefined
        }
      />

      {summary ? groupTable("عملکرد فروشندگان", summary.bySalesperson) : null}
      {summary ? groupTable("عملکرد برند و مدل", summary.byMakeModel) : null}
    </div>
  );
}

export function VehicleReservationsView({ report }: { report: VehicleReservationsReportPayload }) {
  const money = useMoney();
  const rows = report.rows ?? [];
  const summary = report.summary;

  return (
    <div className="min-w-0">
      {summary ? (
        <StatStrip
          stats={[
            { label: "رزروهای فعال", value: formatPersianNumber(summary.activeCount) },
            { label: "بیعانهٔ در دست (تعهد)", value: money.format(summary.depositHeldRial) },
            { label: "بیعانهٔ غیرقابل استردادِ در دست", value: money.format(summary.nonRefundableHeldRial) },
            { label: "بیعانهٔ بازگشتی دوره", value: money.format(summary.depositRefundedRial) },
            { label: "تبدیل‌شده به فروش", value: formatPersianNumber(summary.convertedCount) },
            { label: "آزادشده / منقضی", value: `${formatPersianNumber(summary.releasedCount)} / ${formatPersianNumber(summary.expiredCount)}` },
            { label: "در شرف انقضا (۳ روز)", value: formatPersianNumber(summary.expiringSoonCount) },
          ]}
        />
      ) : null}

      <ReportTable
        caption="رزروها و بیعانه‌های خودرو"
        rows={rows}
        rowKey={(row) => row.id}
        empty={<EmptyState>رزروی ثبت نشده است.</EmptyState>}
        cardTitle={(row) => `${row.displayName} — ${row.customerName ?? "بدون مشتری"}`}
        columns={[
          {
            key: "car",
            header: "خودرو",
            cell: (row) => (
              <div className="min-w-0">
                <div className="font-medium">{row.displayName}</div>
                <div className="text-xs text-muted-foreground" dir="ltr">
                  {row.stockNumber}
                </div>
              </div>
            ),
          },
          { key: "customer", header: "مشتری", cell: (row) => row.customerName ?? "—" },
          {
            key: "status",
            header: "وضعیت",
            align: "end",
            cell: (row) => (
              <StatusBadge tone={HOLD_STATUS_TONE[row.status] ?? "neutral"}>
                {HOLD_STATUS_LABELS[row.status] ?? row.status}
              </StatusBadge>
            ),
          },
          {
            key: "expires",
            header: "تا تاریخ",
            muted: true,
            align: "end",
            cell: (row) =>
              row.expiresAt
                ? `${toPersianDigits(formatJalali(row.expiresAt))}${row.expiresAtTime ? ` — ${row.expiresAtTime}` : ""}`
                : "تا آزادسازی",
          },
          {
            key: "deposit",
            header: "بیعانه",
            numeric: true,
            align: "end",
            cell: (row) => (
              <span>
                {money.format(row.depositRial)}
                {row.depositRial > 0 ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {DEPOSIT_METHOD_LABELS[row.depositMethod ?? ""] ?? row.depositMethod}
                    {row.depositRefundable ? " · قابل استرداد" : " · غیرقابل استرداد"}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            key: "refunded",
            header: "بازگشتی",
            numeric: true,
            align: "end",
            desktopOnly: true,
            cell: (row) => (row.depositRefundedRial > 0 ? money.format(row.depositRefundedRial) : "—"),
          },
          { key: "branch", header: "شعبه", muted: true, desktopOnly: true, cell: (row) => row.locationName ?? "—" },
          {
            key: "age",
            header: "عمر رزرو",
            numeric: true,
            align: "end",
            desktopOnly: true,
            cell: (row) => `${formatPersianNumber(row.ageDays)} روز`,
          },
          { key: "reason", header: "دلیل آزادسازی", muted: true, desktopOnly: true, cell: (row) => row.releaseReason ?? "—" },
        ]}
      />
    </div>
  );
}
