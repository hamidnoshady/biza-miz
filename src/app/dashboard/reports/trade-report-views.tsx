"use client";

/**
 * Phase 43 — the retail trades' reports, rendered inside «گزارش‌های آماده».
 *
 * Each of these used to exist only as a tab inside its own trade's manager
 * (`jewelry/reports-section.tsx`, `watch/reports-section.tsx`, …), which meant
 * a jeweller's «گزارش‌ها» page held the finance statements and their own page
 * held the weight reconciliation, with no way to export either from the other.
 * The numbers are unchanged — they come from the same service functions, now
 * reached through `/api/reports/standard/[key]` — but they are read here the
 * way every other report in the library is read: same shell, same date range,
 * same table.
 *
 * Read-only on purpose. Recording a weight count or settling a consignor is an
 * *action*, and actions stay on the trade's own page where the rest of that
 * workflow lives; a report section that quietly wrote to the ledger would be a
 * surprising place to do it from.
 */
import type { ReactNode } from "react";
import { EmptyState, StatusBadge } from "../page-chrome";
import { formatPersianNumber, formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { ReportTable } from "./report-table";

/* ------------------------------------------------------------------ *
 * Payload shapes — the JSON `/api/reports/standard/[key]` returns for
 * each trade report. Declared here rather than imported from the service
 * so this stays a client module with no server dependency.
 * ------------------------------------------------------------------ */

interface WeightCountRow {
  id: string;
  countDate: string;
  purity: string;
  countedWeight: string;
  systemWeight: string;
  variance: string;
  variancePercent: number | null;
}

export interface WeightReconciliationReport {
  reconciliation: {
    purity: string;
    systemWeight: string;
    pieces: number;
    lastCount: WeightCountRow | null;
  }[];
}

export interface ConsignorStatementsReport {
  summary?: { count: number; balance: number; totalOwed: number; totalPaid: number };
  summaries: {
    consignorId: string;
    name: string;
    itemsOnHand: number;
    totalOwed: number;
    totalPaid: number;
    balance: number;
  }[];
}

export interface LayawayBookReport {
  rows: {
    id: string;
    planNumber: number;
    grams: string;
    totalValueRial: number;
    paidRial: number;
    status: "open" | "completed" | "cancelled";
    promisedDate: string | null;
  }[];
  book: {
    openCount: number;
    openValueRial: number;
    openPaidRial: number;
    openOutstandingRial: number;
    completedCount: number;
    totalGrams: string;
  } | null;
}

type WarrantyState = "active" | "expiring" | "expired" | "none";

export interface WarrantyReport {
  totalCount?: number;
  rows: {
    serialId: string;
    serialNumber: string;
    itemName: string;
    startDate: string;
    endDate: string;
    months: number;
    state: WarrantyState;
  }[];
  counts: Partial<Record<WarrantyState, number>>;
}

export interface RepairsReport {
  totalCount?: number;
  rows: {
    ticketId: string;
    ticketNumber: number;
    itemDescription: string;
    status: string;
    underWarranty: boolean;
    net: number;
    partsCost: number;
  }[];
  byStatus: Record<string, number>;
  totals: { revenue: number; partsCost: number; margin: number };
}

export interface VariantSalesReport {
  rows: {
    itemId: string;
    itemName: string;
    parentName: string | null;
    attributes: { name: string; value: string }[];
    quantitySold: string;
    netRevenue: number;
    cogs: number;
    margin: number;
  }[];
}

export interface BrandSalesReport {
  rows: {
    brandId: string | null;
    brandName: string | null;
    quantitySold: string;
    netRevenue: number;
    cogs: number;
    margin: number;
  }[];
}

export interface NearExpiryReport {
  rows: {
    itemId: string;
    itemName: string;
    batchNumber: string;
    expiryDate: string | null;
    quantity: string;
    bucket: "expired" | "under30" | "under90";
  }[];
}

export interface LowStockReport {
  rows: {
    itemId: string;
    itemName: string;
    sku: string | null;
    quantity: string;
    reorderPoint: string;
    level: "out" | "low";
  }[];
}

export interface DeadStockReport {
  totalCount?: number;
  totalValueRial?: number;
  rows: {
    itemId: string;
    itemName: string;
    sku: string | null;
    quantity: string;
    lastSoldAt: string | null;
    valueRial: number;
  }[];
}

const PURITY_LABELS: Record<string, string> = {
  "18": "۱۸ عیار",
  "21": "۲۱ عیار",
  "24": "۲۴ عیار (طلای ۹۹۹)",
};

const WARRANTY_LABELS: Record<WarrantyState, string> = {
  active: "معتبر",
  expiring: "رو به پایان",
  expired: "منقضی",
  none: "بدون گارانتی",
};

const WARRANTY_TONE: Record<WarrantyState, "positive" | "active" | "neutral"> = {
  active: "positive",
  expiring: "active",
  expired: "neutral",
  none: "neutral",
};

const REPAIR_STATUS_LABELS: Record<string, string> = {
  received: "پذیرش شده",
  in_progress: "در حال تعمیر",
  ready: "آماده تحویل",
  closed: "تحویل شده",
  cancelled: "لغو شده",
};

const LAYAWAY_STATUS_LABELS: Record<string, string> = {
  open: "باز",
  completed: "تکمیل‌شده",
  cancelled: "لغو شده",
};

const EXPIRY_LABELS: Record<string, string> = {
  expired: "منقضی",
  under30: "زیر ۳۰ روز",
  under90: "زیر ۹۰ روز",
};

/** A row of headline figures above a report's table. */
function StatStrip({ stats }: { stats: { label: string; value: ReactNode; tone?: "default" | "negative" }[] }) {
  return (
    <dl className="grid gap-3 border-b border-border/80 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd
            className={
              stat.tone === "negative"
                ? "mt-1 font-bold tabular-nums text-destructive"
                : "mt-1 font-bold tabular-nums text-foreground"
            }
          >
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function grams(value: string): string {
  return `${formatQuantity(value)} گرم`;
}

/* ------------------------------------------------------------------ *
 * جواهر — weight reconciliation, consignors, layaway
 * ------------------------------------------------------------------ */

export function WeightReconciliationView({ report }: { report: WeightReconciliationReport }) {
  const rows = report.reconciliation ?? [];
  return (
    <ReportTable
      caption="تطبیق وزنی به تفکیک عیار"
      rows={rows}
      rowKey={(row) => row.purity}
      empty={<EmptyState>کالای وزنی موجودی ثبت نشده است.</EmptyState>}
      cardTitle={(row) => PURITY_LABELS[row.purity] ?? row.purity}
      columns={[
        { key: "purity", header: "عیار", cell: (row) => PURITY_LABELS[row.purity] ?? row.purity },
        { key: "pieces", header: "تعداد قطعه", numeric: true, align: "end", cell: (row) => formatPersianNumber(row.pieces) },
        { key: "system", header: "وزن دفاتر", numeric: true, align: "end", cell: (row) => grams(row.systemWeight) },
        {
          key: "counted",
          header: "آخرین شمارش",
          numeric: true,
          align: "end",
          cell: (row) => (row.lastCount ? grams(row.lastCount.countedWeight) : "—"),
        },
        {
          key: "variance",
          header: "مغایرت",
          numeric: true,
          align: "end",
          cell: (row) => {
            if (!row.lastCount) return <span className="text-muted-foreground">شمارش نشده</span>;
            const variance = Number(row.lastCount.variance);
            if (variance === 0) return <StatusBadge tone="positive">بدون مغایرت</StatusBadge>;
            return <StatusBadge tone="danger">{grams(row.lastCount.variance)}</StatusBadge>;
          },
        },
        {
          key: "countedAt",
          header: "تاریخ شمارش",
          muted: true,
          align: "end",
          cell: (row) =>
            row.lastCount ? toPersianDigits(formatJalali(row.lastCount.countDate, { withMonthName: true })) : "—",
        },
      ]}
    />
  );
}

export function ConsignorStatementsView({ report }: { report: ConsignorStatementsReport }) {
  const money = useMoney();
  const summaries = report.summaries ?? [];
  const outstanding = report.summary?.balance ?? summaries.reduce((sum, row) => sum + row.balance, 0);

  return (
    <div className="min-w-0">
      {summaries.length > 0 ? (
        <StatStrip
          stats={[
            { label: "تعداد امانت‌گذار", value: formatPersianNumber(report.summary?.count ?? summaries.length) },
            { label: "مانده کل", value: money.format(outstanding), tone: outstanding > 0 ? "negative" : "default" },
            {
              label: "جمع فروش امانی",
              value: money.format(report.summary?.totalOwed ?? summaries.reduce((sum, row) => sum + row.totalOwed, 0)),
            },
            {
              label: "جمع پرداختی",
              value: money.format(report.summary?.totalPaid ?? summaries.reduce((sum, row) => sum + row.totalPaid, 0)),
            },
          ]}
        />
      ) : null}
      <ReportTable
        caption="صورت‌حساب امانت‌گذاران"
        rows={summaries}
        rowKey={(row) => row.consignorId}
        empty={<EmptyState>امانت‌گذاری ثبت نشده است.</EmptyState>}
        cardTitle={(row) => row.name}
        columns={[
          { key: "name", header: "امانت‌گذار", cell: (row) => row.name },
          {
            key: "onHand",
            header: "قطعه نزد فروشگاه",
            numeric: true,
            align: "end",
            cell: (row) => formatPersianNumber(row.itemsOnHand),
          },
          { key: "owed", header: "فروش‌شده", numeric: true, align: "end", cell: (row) => money.format(row.totalOwed) },
          { key: "paid", header: "پرداخت‌شده", numeric: true, align: "end", cell: (row) => money.format(row.totalPaid) },
          {
            key: "balance",
            header: "مانده",
            numeric: true,
            align: "end",
            cell: (row) => <span className="font-semibold">{money.format(row.balance)}</span>,
          },
        ]}
      />
    </div>
  );
}

export function LayawayBookView({ report }: { report: LayawayBookReport }) {
  const money = useMoney();
  const rows = report.rows ?? [];
  const book = report.book;

  return (
    <div className="min-w-0">
      {book ? (
        <StatStrip
          stats={[
            { label: "طرح‌های باز", value: formatPersianNumber(book.openCount) },
            { label: "مانده دریافتنی", value: money.format(book.openOutstandingRial) },
            { label: "دریافت‌شده", value: money.format(book.openPaidRial) },
            { label: "وزن روی دفاتر", value: grams(book.totalGrams) },
          ]}
        />
      ) : null}
      <ReportTable
        caption="دفتر لیاوی"
        rows={rows}
        rowKey={(row) => row.id}
        empty={<EmptyState>طرح لیاوی ثبت نشده است.</EmptyState>}
        cardTitle={(row) => `طرح ${formatPersianNumber(row.planNumber)}`}
        columns={[
          { key: "plan", header: "شماره طرح", cell: (row) => formatPersianNumber(row.planNumber), numeric: true },
          { key: "grams", header: "وزن", numeric: true, align: "end", cell: (row) => grams(row.grams) },
          { key: "total", header: "ارزش طرح", numeric: true, align: "end", cell: (row) => money.format(row.totalValueRial) },
          { key: "paid", header: "پرداخت‌شده", numeric: true, align: "end", cell: (row) => money.format(row.paidRial) },
          {
            key: "outstanding",
            header: "مانده",
            numeric: true,
            align: "end",
            cell: (row) => (
              <span className="font-semibold">{money.format(row.totalValueRial - row.paidRial)}</span>
            ),
          },
          {
            key: "status",
            header: "وضعیت",
            align: "end",
            cell: (row) => (
              <StatusBadge tone={row.status === "open" ? "active" : row.status === "completed" ? "positive" : "neutral"}>
                {LAYAWAY_STATUS_LABELS[row.status] ?? row.status}
              </StatusBadge>
            ),
          },
          {
            key: "promised",
            header: "تاریخ تعهد",
            muted: true,
            align: "end",
            cell: (row) => (row.promisedDate ? toPersianDigits(formatJalali(row.promisedDate, { withMonthName: true })) : "—"),
          },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * گارانتی و تعمیرات
 * ------------------------------------------------------------------ */

export function WarrantyRegisterView({ report }: { report: WarrantyReport }) {
  const rows = report.rows ?? [];
  const counts = report.counts ?? {};

  return (
    <div className="min-w-0">
      {rows.length > 0 ? (
        <StatStrip
          stats={[
            { label: "معتبر", value: formatPersianNumber(counts.active ?? 0) },
            { label: "رو به پایان", value: formatPersianNumber(counts.expiring ?? 0) },
            { label: "منقضی", value: formatPersianNumber(counts.expired ?? 0) },
            { label: "جمع گارانتی‌ها", value: formatPersianNumber(report.totalCount ?? rows.length) },
          ]}
        />
      ) : null}
      <ReportTable
        caption="دفتر گارانتی‌ها"
        rows={rows}
        rowKey={(row) => row.serialId}
        empty={<EmptyState>هنوز گارانتی‌ای صادر نشده است.</EmptyState>}
        cardTitle={(row) => row.itemName}
        columns={[
          { key: "item", header: "کالا", cell: (row) => row.itemName },
          {
            key: "serial",
            header: "شماره سریال",
            muted: true,
            cell: (row) => <span dir="ltr">{row.serialNumber}</span>,
          },
          {
            key: "start",
            header: "شروع",
            muted: true,
            align: "end",
            cell: (row) => toPersianDigits(formatJalali(row.startDate, { withMonthName: true })),
          },
          {
            key: "end",
            header: "پایان",
            muted: true,
            align: "end",
            cell: (row) => toPersianDigits(formatJalali(row.endDate, { withMonthName: true })),
          },
          {
            key: "months",
            header: "مدت",
            numeric: true,
            align: "end",
            cell: (row) => `${formatPersianNumber(row.months)} ماه`,
          },
          {
            key: "state",
            header: "وضعیت",
            align: "end",
            cell: (row) => <StatusBadge tone={WARRANTY_TONE[row.state]}>{WARRANTY_LABELS[row.state]}</StatusBadge>,
          },
        ]}
      />
    </div>
  );
}

export function RepairsView({ report }: { report: RepairsReport }) {
  const money = useMoney();
  const rows = report.rows ?? [];
  const totals = report.totals ?? { revenue: 0, partsCost: 0, margin: 0 };

  return (
    <div className="min-w-0">
      <StatStrip
        stats={[
          { label: "تعداد تیکت", value: formatPersianNumber(report.totalCount ?? rows.length) },
          { label: "درآمد تعمیرات", value: money.format(totals.revenue) },
          { label: "بهای قطعات", value: money.format(totals.partsCost) },
          {
            label: "حاشیه",
            value: money.format(totals.margin),
            tone: totals.margin < 0 ? "negative" : "default",
          },
        ]}
      />
      <p className="border-b border-border/80 px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5">
        درآمد و بهای قطعات فقط برای تیکت‌های بسته‌شده محاسبه می‌شود؛ تیکت باز هنوز درآمد نیست. تعمیر گارانتی حاشیهٔ
        منفی دارد، چون قطعه مصرف شده اما مبلغی دریافت نشده است.
      </p>
      <ReportTable
        caption="سودآوری تعمیرات"
        rows={rows}
        rowKey={(row) => row.ticketId}
        empty={<EmptyState>تیکتی ثبت نشده است.</EmptyState>}
        cardTitle={(row) => (
          <span className="flex flex-wrap items-center gap-2">
            {`تیکت ${formatPersianNumber(row.ticketNumber)} — ${row.itemDescription}`}
            {row.underWarranty ? <StatusBadge tone="positive">گارانتی</StatusBadge> : null}
          </span>
        )}
        columns={[
          {
            key: "ticket",
            header: "تیکت",
            cell: (row) => (
              <span>
                {formatPersianNumber(row.ticketNumber)} — {row.itemDescription}
                {row.underWarranty ? (
                  <span className="ms-2 inline-block">
                    <StatusBadge tone="positive">گارانتی</StatusBadge>
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            key: "status",
            header: "وضعیت",
            cell: (row) => REPAIR_STATUS_LABELS[row.status] ?? row.status,
            muted: true,
          },
          { key: "net", header: "دریافتی", numeric: true, align: "end", cell: (row) => money.format(row.net) },
          { key: "parts", header: "بهای قطعات", numeric: true, align: "end", cell: (row) => money.format(row.partsCost) },
          {
            key: "margin",
            header: "حاشیه",
            numeric: true,
            align: "end",
            cell: (row) => {
              const margin = row.net - row.partsCost;
              return (
                <span className={margin < 0 ? "font-semibold text-destructive" : "font-semibold"}>
                  {money.format(margin)}
                </span>
              );
            },
          },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * کالاهای تجاری — variants, brands, batches, stock levels
 * ------------------------------------------------------------------ */

export function VariantSalesView({ report }: { report: VariantSalesReport }) {
  const money = useMoney();
  const rows = report.rows ?? [];

  return (
    <div className="min-w-0">
      <p className="border-b border-border/80 px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5">
        شامل فروش صندوق و فروش وب‌سایت (ووکامرس و فروشگاه سایت) است. فروشی که بهای تمام‌شده‌اش ثبت
        نشده، با بهای صفر در حاشیه آمده و سود آن موقت است.
      </p>
      <ReportTable
        caption="تحلیل فروش تنوع‌ها"
        rows={rows}
        rowKey={(row) => row.itemId}
        empty={<EmptyState>هنوز فروشی ثبت نشده است.</EmptyState>}
        cardTitle={(row) => row.itemName}
        columns={[
          {
            key: "item",
            header: "تنوع",
            cell: (row) => (
              <span className="min-w-0">
                <span className="font-medium text-foreground">{row.itemName}</span>
                {row.attributes.length > 0 ? (
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {row.attributes.map((attribute) => (
                      <span
                        key={attribute.name}
                        className="rounded-xl bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                      >
                        {attribute.name}: {attribute.value}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            key: "parent",
            header: "خانواده",
            muted: true,
            desktopOnly: true,
            cell: (row) => row.parentName ?? "—",
          },
          {
            key: "quantity",
            header: "تعداد فروش",
            numeric: true,
            align: "end",
            cell: (row) => formatQuantity(row.quantitySold),
          },
          { key: "revenue", header: "درآمد", numeric: true, align: "end", cell: (row) => money.format(row.netRevenue) },
          { key: "cogs", header: "بهای تمام‌شده", numeric: true, align: "end", cell: (row) => money.format(row.cogs) },
          {
            key: "margin",
            header: "حاشیه",
            numeric: true,
            align: "end",
            cell: (row) => <span className="font-semibold">{money.format(row.margin)}</span>,
          },
        ]}
      />
    </div>
  );
}

export function BrandSalesView({ report }: { report: BrandSalesReport }) {
  const money = useMoney();
  const rows = report.rows ?? [];

  return (
    <ReportTable
      caption="فروش به تفکیک برند"
      rows={rows}
      rowKey={(row, index) => row.brandId ?? `unbranded-${index}`}
      empty={<EmptyState>هنوز فروشی ثبت نشده است.</EmptyState>}
      cardTitle={(row) => row.brandName ?? "بدون برند"}
      columns={[
        { key: "brand", header: "برند", cell: (row) => row.brandName ?? "بدون برند" },
        {
          key: "quantity",
          header: "تعداد فروش",
          numeric: true,
          align: "end",
          cell: (row) => formatQuantity(row.quantitySold),
        },
        { key: "revenue", header: "درآمد", numeric: true, align: "end", cell: (row) => money.format(row.netRevenue) },
        { key: "cogs", header: "بهای تمام‌شده", numeric: true, align: "end", cell: (row) => money.format(row.cogs) },
        {
          key: "margin",
          header: "حاشیه",
          numeric: true,
          align: "end",
          cell: (row) => <span className="font-semibold">{money.format(row.margin)}</span>,
        },
      ]}
    />
  );
}

export function NearExpiryView({ report }: { report: NearExpiryReport }) {
  const rows = report.rows ?? [];
  return (
    <ReportTable
      caption="بچ‌های نزدیک انقضا"
      rows={rows}
      rowKey={(row, index) => `${row.itemId}-${row.batchNumber}-${index}`}
      empty={<EmptyState>بچ منقضی یا نزدیک به انقضا وجود ندارد.</EmptyState>}
      cardTitle={(row) => row.itemName}
      columns={[
        { key: "item", header: "کالا", cell: (row) => row.itemName },
        { key: "batch", header: "شمارهٔ بچ", muted: true, cell: (row) => <span dir="ltr">{row.batchNumber}</span> },
        {
          key: "quantity",
          header: "موجودی",
          numeric: true,
          align: "end",
          cell: (row) => formatQuantity(row.quantity),
        },
        {
          key: "expiry",
          header: "تاریخ انقضا",
          muted: true,
          align: "end",
          cell: (row) => (row.expiryDate ? toPersianDigits(formatJalali(row.expiryDate, { withMonthName: true })) : "—"),
        },
        {
          key: "bucket",
          header: "وضعیت",
          align: "end",
          cell: (row) => (
            <StatusBadge tone={row.bucket === "expired" ? "danger" : row.bucket === "under30" ? "active" : "neutral"}>
              {EXPIRY_LABELS[row.bucket] ?? row.bucket}
            </StatusBadge>
          ),
        },
      ]}
    />
  );
}

export function LowStockView({ report }: { report: LowStockReport }) {
  const rows = report.rows ?? [];
  return (
    <ReportTable
      caption="کمبود موجودی"
      rows={rows}
      rowKey={(row) => row.itemId}
      empty={<EmptyState>چیزی زیر نقطهٔ سفارش نیست.</EmptyState>}
      cardTitle={(row) => row.itemName}
      columns={[
        { key: "item", header: "کالا", cell: (row) => row.itemName },
        { key: "sku", header: "کد کالا", muted: true, cell: (row) => (row.sku ? <span dir="ltr">{row.sku}</span> : "—") },
        {
          key: "quantity",
          header: "موجودی",
          numeric: true,
          align: "end",
          cell: (row) => formatQuantity(row.quantity),
        },
        {
          key: "reorder",
          header: "نقطهٔ سفارش",
          numeric: true,
          align: "end",
          cell: (row) => formatQuantity(row.reorderPoint),
        },
        {
          key: "level",
          header: "وضعیت",
          align: "end",
          cell: (row) => (
            <StatusBadge tone={row.level === "out" ? "danger" : "active"}>
              {row.level === "out" ? "تمام شده" : "زیر نقطهٔ سفارش"}
            </StatusBadge>
          ),
        },
      ]}
    />
  );
}

export function DeadStockView({ report }: { report: DeadStockReport }) {
  const money = useMoney();
  const rows = report.rows ?? [];
  const tiedUp = report.totalValueRial ?? rows.reduce((sum, row) => sum + row.valueRial, 0);

  return (
    <div className="min-w-0">
      {rows.length > 0 ? (
        <StatStrip
          stats={[
            { label: "تعداد کالای راکد", value: formatPersianNumber(report.totalCount ?? rows.length) },
            { label: "سرمایهٔ خوابیده", value: money.format(tiedUp) },
          ]}
        />
      ) : null}
      <ReportTable
        caption="کالای راکد"
        rows={rows}
        rowKey={(row) => row.itemId}
        empty={<EmptyState>کالای راکدی نیست.</EmptyState>}
        cardTitle={(row) => row.itemName}
        columns={[
          { key: "item", header: "کالا", cell: (row) => row.itemName },
          { key: "sku", header: "کد کالا", muted: true, cell: (row) => (row.sku ? <span dir="ltr">{row.sku}</span> : "—") },
          {
            key: "quantity",
            header: "موجودی",
            numeric: true,
            align: "end",
            cell: (row) => formatQuantity(row.quantity),
          },
          {
            key: "lastSold",
            header: "آخرین فروش",
            muted: true,
            align: "end",
            cell: (row) => (row.lastSoldAt ? toPersianDigits(formatJalali(row.lastSoldAt, { withMonthName: true })) : "بدون فروش"),
          },
          {
            key: "value",
            header: "ارزش",
            numeric: true,
            align: "end",
            cell: (row) => <span className="font-semibold">{money.format(row.valueRial)}</span>,
          },
        ]}
      />
    </div>
  );
}
