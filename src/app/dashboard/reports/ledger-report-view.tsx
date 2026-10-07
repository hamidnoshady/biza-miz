"use client";

import { useState, type ReactNode } from "react";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, formatPersianNumericText } from "@/lib/digits";
import { isNonCurrentCode } from "@/lib/coa-template";
import { DrillDownPanel, type DrillDownTarget } from "./drill-down-panel";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

interface PnlLine {
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface ProfitAndLoss {
  revenue: PnlLine[];
  expenses: PnlLine[];
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
  costOfSales: number;
  grossProfit: number;
  laborCost: number;
  primeCost: number;
  operatingExpenses: number;
}

export interface BalanceSheet {
  assets: PnlLine[];
  liabilities: PnlLine[];
  equity: PnlLine[];
  retainedEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
  currentAssets: number;
  nonCurrentAssets: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
}

export type CashFlowActivity = "operating" | "investing" | "financing";

export interface CashFlowLine {
  sourceType: string;
  label: string;
  amount: number;
  activity: CashFlowActivity;
}

export interface CashFlow {
  openingCash: number;
  closingCash: number;
  netChange: number;
  lines: CashFlowLine[];
  activities: Record<CashFlowActivity, number>;
  /** Net change in card/gateway clearing and platform receivables — disclosed, not cash. */
  clearingChange: number;
  cashDefinition: string;
}

const CASH_FLOW_ACTIVITY_LABELS: Record<CashFlowActivity, string> = {
  operating: "فعالیت‌های عملیاتی",
  investing: "فعالیت‌های سرمایه‌گذاری",
  financing: "فعالیت‌های تأمین مالی",
};
const CASH_FLOW_ACTIVITIES: CashFlowActivity[] = ["operating", "investing", "financing"];
const cashFlowLineKey = (line: CashFlowLine) => `${line.activity}:${line.sourceType}`;

export interface FoodCostVarianceItemLine {
  menuItemId: string | null;
  menuItemName: string;
  unitsSold: number;
  theoreticalCost: number;
  revenue: number;
  foodCostPct: number | null;
}

export interface FoodCostVariance {
  items: FoodCostVarianceItemLine[];
  theoreticalCost: number;
  actualCogs: number;
  wasteCost: number;
  actualTotalCost: number;
  variance: number;
  variancePct: number | null;
  unexplainedVariance: number;
}

export interface Comparison<T> {
  current: T;
  previous: T | null;
}

function isComparison<T>(report: T | Comparison<T>): report is Comparison<T> {
  return typeof report === "object" && report !== null && "current" in report;
}

interface DrillContext {
  dateFrom?: string;
  dateTo?: string;
  onDrillDown: (accountCode: string, accountName: string) => void;
}

function previousAmount(
  previous: PnlLine[] | undefined,
  code: string,
): number | null {
  if (!previous) return null;
  return previous.find((line) => line.accountCode === code)?.amount ?? 0;
}

function ReportLineName({
  line,
  drill,
}: {
  line: PnlLine;
  drill?: DrillContext;
}) {
  const clickable = Boolean(drill && line.accountCode);

  if (!clickable)
    return (
      <span className="font-semibold text-foreground">{line.accountName}</span>
    );

  return (
    <button
      type="button"
      onClick={() => drill!.onDrillDown(line.accountCode, line.accountName)}
      className="min-h-10 rounded-lg px-1 text-start font-semibold text-foreground underline-offset-4 hover:text-amber-800 dark:hover:text-amber-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
    >
      {line.accountName}
    </button>
  );
}

function Section({
  heading,
  lines,
  previousLines,
  total,
  previousTotal,
  totalLabel,
  drill,
}: {
  heading: string;
  lines: PnlLine[];
  previousLines?: PnlLine[];
  total: number;
  previousTotal?: number | null;
  totalLabel: string;
  drill?: DrillContext;
}) {
  const money = useMoney();
  const showPrevious = previousLines !== undefined;

  return (
    <section className="border-b border-border py-5 first:pt-0 last:border-b-0">
      <h3 className="mb-3 text-base font-bold text-foreground">{heading}</h3>

      <DataTable caption={heading} className="hidden sm:block" tableClassName="min-w-full">
        <DataTableHead>
          <Th>کد</Th>
          <Th>حساب</Th>
          <Th numeric>مبلغ</Th>
          {showPrevious ? <Th numeric>دورهٔ قبل</Th> : null}
        </DataTableHead>
        <DataTableBody>
          {lines.map((line) => {
            const previousValue = showPrevious
              ? previousAmount(previousLines, line.accountCode)
              : null;
            return (
              <DataTableRow key={line.accountCode || line.accountName}>
                <Td muted>{line.accountCode || "—"}</Td>
                <Td>
                  <ReportLineName line={line} drill={drill} />
                </Td>
                <Td numeric>{money.format(line.amount)}</Td>
                {showPrevious ? (
                  <Td numeric muted>
                    {previousValue !== null ? money.format(previousValue) : "—"}
                  </Td>
                ) : null}
              </DataTableRow>
            );
          })}
          {lines.length === 0 ? (
            <DataTableRow>
              <Td colSpan={showPrevious ? 4 : 3} muted className="py-8 text-center">
                بدون سطر
              </Td>
            </DataTableRow>
          ) : null}
        </DataTableBody>
        <DataTableFoot className="border-t-2 font-bold">
          <tr>
            <Th scope="row" colSpan={2}>
              {totalLabel}
            </Th>
            <Td numeric>{money.format(total)}</Td>
            {showPrevious ? (
              <Td numeric muted>
                {previousTotal != null ? money.format(previousTotal) : "—"}
              </Td>
            ) : null}
          </tr>
        </DataTableFoot>
      </DataTable>

      <div className="space-y-2 sm:hidden">
        {lines.map((line) => {
          const previousValue = showPrevious
            ? previousAmount(previousLines, line.accountCode)
            : null;
          return (
            <article
              key={line.accountCode || line.accountName}
              className="rounded-xl border border-border/80 bg-muted p-4"
            >
              <div className="flex items-start gap-3">
                <span className="mt-1 shrink-0 text-xs font-medium text-muted-foreground">
                  {line.accountCode || "—"}
                </span>
                <div className="min-w-0 flex-1">
                  <ReportLineName line={line} drill={drill} />
                </div>
              </div>
              <dl className="mt-3 grid gap-3 border-t border-border pt-3">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">مبلغ</dt>
                  <dd className="tabular-nums font-bold text-foreground">
                    {money.format(line.amount)}
                  </dd>
                </div>
                {showPrevious ? (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs text-muted-foreground">دورهٔ قبل</dt>
                    <dd className="tabular-nums text-muted-foreground">
                      {previousValue !== null
                        ? money.format(previousValue)
                        : "—"}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </article>
          );
        })}
        {lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/80 bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
            بدون سطر
          </p>
        ) : null}
        <dl className="rounded-xl border border-border/80 bg-muted p-4">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-sm font-bold text-foreground">{totalLabel}</dt>
            <dd className="tabular-nums font-bold text-foreground">
              {money.format(total)}
            </dd>
          </div>
          {showPrevious ? (
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/80 pt-2">
              <dt className="text-xs text-muted-foreground">دورهٔ قبل</dt>
              <dd className="tabular-nums text-muted-foreground">
                {previousTotal != null ? money.format(previousTotal) : "—"}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

function SummaryStat({
  label,
  value,
  previous,
}: {
  label: string;
  value: number;
  previous?: number | null;
}) {
  const money = useMoney();
  return (
    <div className="rounded-xl border border-border/80 bg-muted p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className={
          value < 0
            ? "mt-2 font-bold tabular-nums text-destructive"
            : "mt-2 font-bold tabular-nums text-foreground"
        }
      >
        {money.format(value)}
      </dd>
      {previous != null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          دورهٔ قبل: {money.format(previous)}
        </p>
      ) : null}
    </div>
  );
}

function formatPct(value: number | null): string {
  if (value === null) return "—";
  // Same Persian presentation the rest of the app uses (digits.ts): Persian
  // digits, «٫» for the decimal separator, no dangling «٫۰».
  const fixed = (value * 100).toFixed(1);
  const trimmed = fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
  return `${formatPersianNumericText(trimmed)}٪`;
}

/**
 * Per-item theoretical (recipe-standard) food cost vs. its revenue, plus a
 * period-level theoretical-vs-actual total (see buildFoodCostVariance's doc
 * comment in reports.ts for what each figure means and why there's no
 * per-item *actual* cost). No previous-period comparison or drill-down —
 * see the "compare" checkbox gating in standard-reports-section.tsx.
 */
export function FoodCostVarianceView({ report }: { report: FoodCostVariance }) {
  const money = useMoney();
  return (
    <div>
      <section className="border-b border-border pb-5">
        <h3 className="mb-3 text-base font-bold text-foreground">
          بهای تمام‌شده نظری هر قلم منو
        </h3>

        <DataTable
          caption="بهای تمام‌شده نظری هر قلم منو"
          className="hidden sm:block"
          tableClassName="min-w-full"
        >
          <DataTableHead>
            <Th>قلم منو</Th>
            <Th numeric>تعداد فروش</Th>
            <Th numeric>درآمد</Th>
            <Th numeric>بهای نظری</Th>
            <Th numeric>درصد بهای غذا</Th>
          </DataTableHead>
          <DataTableBody>
            {report.items.map((item) => (
              <DataTableRow key={item.menuItemId ?? item.menuItemName}>
                <Td className="font-semibold">{item.menuItemName}</Td>
                <Td numeric muted>{formatPersianNumber(item.unitsSold)}</Td>
                <Td numeric>{money.format(item.revenue)}</Td>
                <Td numeric>{money.format(item.theoreticalCost)}</Td>
                <Td numeric>{formatPct(item.foodCostPct)}</Td>
              </DataTableRow>
            ))}
            {report.items.length === 0 ? (
              <DataTableRow>
                <Td colSpan={5} muted className="py-8 text-center">
                  در این بازه فروشی ثبت نشده
                </Td>
              </DataTableRow>
            ) : null}
          </DataTableBody>
        </DataTable>

        <div className="space-y-2 sm:hidden">
          {report.items.map((item) => (
            <article key={item.menuItemId ?? item.menuItemName} className="rounded-xl border border-border/80 bg-muted p-4">
              <h4 className="font-semibold text-foreground">{item.menuItemName}</h4>
              <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3">
                <div>
                  <dt className="text-xs text-muted-foreground">تعداد فروش</dt>
                  <dd className="tabular-nums text-foreground">{formatPersianNumber(item.unitsSold)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">درآمد</dt>
                  <dd className="tabular-nums text-foreground">{money.format(item.revenue)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">بهای نظری</dt>
                  <dd className="tabular-nums text-foreground">{money.format(item.theoreticalCost)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">درصد بهای غذا</dt>
                  <dd className="tabular-nums font-bold text-foreground">{formatPct(item.foodCostPct)}</dd>
                </div>
              </dl>
            </article>
          ))}
          {report.items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/80 bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
              در این بازه فروشی ثبت نشده
            </p>
          ) : null}
        </div>
      </section>

      <dl className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        <SummaryStat label="بهای نظری (بر اساس دستور پخت)" value={report.theoreticalCost} />
        <SummaryStat label="بهای تمام‌شده واقعی (COGS)" value={report.actualCogs} />
        <SummaryStat label="ضایعات ثبت‌شده" value={report.wasteCost} />
        <SummaryStat label="جمع بهای واقعی (COGS + ضایعات)" value={report.actualTotalCost} />
        <SummaryStat label="مابه‌التفاوت (واریانس)" value={report.variance} />
        <SummaryStat label="مابه‌التفاوت توضیح‌نیافته (منهای ضایعات)" value={report.unexplainedVariance} />
      </dl>

      <dl className="mt-5 rounded-xl border border-border/80 bg-muted p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <dt className="font-bold text-foreground">درصد واریانس نسبت به بهای نظری</dt>
          <dd
            className={
              report.variance > 0
                ? "text-lg font-bold tabular-nums text-destructive"
                : "text-lg font-bold tabular-nums text-foreground"
            }
          >
            {formatPct(report.variancePct)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Owns the drill-down panel's open/close state, so every statement view opens the same overlay the same way. */
function useDrillDown(
  dateFrom?: string,
  dateTo?: string,
  readOnly = false,
): { drill: DrillContext | undefined; panel: ReactNode } {
  const [target, setTarget] = useState<DrillDownTarget | null>(null);
  const drill: DrillContext = {
    dateFrom,
    dateTo,
    onDrillDown: (accountCode, accountName) =>
      setTarget({ accountCode, accountName, dateFrom, dateTo }),
  };
  const panel = target ? (
    <DrillDownPanel target={target} onClose={() => setTarget(null)} />
  ) : null;
  return readOnly ? { drill: undefined, panel: null } : { drill, panel };
}

export function ProfitAndLossView({
  report,
  dateFrom,
  dateTo,
  readOnly = false,
}: {
  readOnly?: boolean;
  report: ProfitAndLoss | Comparison<ProfitAndLoss>;
  dateFrom?: string;
  dateTo?: string;
}) {
  const money = useMoney();
  const current = isComparison(report) ? report.current : report;
  const previous = isComparison(report) ? report.previous : null;
  const { drill, panel } = useDrillDown(dateFrom, dateTo, readOnly);

  return (
    <div>
      <Section
        heading="درآمدها"
        lines={current.revenue}
        previousLines={previous?.revenue}
        total={current.totalRevenue}
        previousTotal={previous?.totalRevenue}
        totalLabel="جمع درآمدها"
        drill={drill}
      />
      <Section
        heading="هزینه‌ها"
        lines={current.expenses}
        previousLines={previous?.expenses}
        total={current.totalExpenses}
        previousTotal={previous?.totalExpenses}
        totalLabel="جمع هزینه‌ها"
        drill={drill}
      />

      <dl className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        <SummaryStat
          label="بهای تمام‌شده کالای فروش‌رفته (COGS)"
          value={current.costOfSales}
          previous={previous?.costOfSales}
        />
        <SummaryStat
          label="سود ناخالص"
          value={current.grossProfit}
          previous={previous?.grossProfit}
        />
        <SummaryStat
          label="هزینه نیروی انسانی"
          value={current.laborCost}
          previous={previous?.laborCost}
        />
        <SummaryStat
          label="بهای اولیه (Prime Cost)"
          value={current.primeCost}
          previous={previous?.primeCost}
        />
        <SummaryStat
          label="سایر هزینه‌های عملیاتی"
          value={current.operatingExpenses}
          previous={previous?.operatingExpenses}
        />
      </dl>

      <dl className="mt-5 rounded-xl border border-border/80 bg-muted p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <dt className="font-bold text-foreground">سود (زیان) خالص</dt>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {previous ? (
              <span className="text-sm text-muted-foreground">
                دورهٔ قبل: {money.format(previous.netIncome)}
              </span>
            ) : null}
            <dd
              className={
                current.netIncome < 0
                  ? "text-lg font-bold tabular-nums text-destructive"
                  : "text-lg font-bold tabular-nums text-foreground"
              }
            >
              {money.format(current.netIncome)}
            </dd>
          </div>
        </div>
      </dl>
      {panel}
    </div>
  );
}

export function BalanceSheetView({
  report,
  dateTo,
  readOnly = false,
}: {
  readOnly?: boolean;
  report: BalanceSheet | Comparison<BalanceSheet>;
  dateTo?: string;
}) {
  const money = useMoney();
  const current = isComparison(report) ? report.current : report;
  const previous = isComparison(report) ? report.previous : null;
  const { drill, panel } = useDrillDown(undefined, dateTo, readOnly);

  const equityLines = [
    ...current.equity,
    {
      accountCode: "",
      accountName: "سود انباشته (جاری)",
      amount: current.retainedEarnings,
    },
  ];
  const previousEquityLines = previous
    ? [
        ...previous.equity,
        {
          accountCode: "",
          accountName: "سود انباشته (جاری)",
          amount: previous.retainedEarnings,
        },
      ]
    : undefined;

  // The جاری/غیرجاری split. Non-current groups are rendered only when they have
  // lines, so a business with no fixed assets and no borrowings still reads as
  // the flat sheet it effectively is.
  const split = (lines: PnlLine[], type: "asset" | "liability", nonCurrent: boolean) =>
    lines.filter((l) => isNonCurrentCode(type, l.accountCode) === nonCurrent);

  const currentAssetLines = split(current.assets, "asset", false);
  const nonCurrentAssetLines = split(current.assets, "asset", true);
  const currentLiabilityLines = split(current.liabilities, "liability", false);
  const nonCurrentLiabilityLines = split(current.liabilities, "liability", true);

  return (
    <div>
      <Section
        heading="دارایی‌های جاری"
        lines={currentAssetLines}
        previousLines={previous ? split(previous.assets, "asset", false) : undefined}
        total={current.currentAssets}
        previousTotal={previous?.currentAssets}
        totalLabel="جمع دارایی‌های جاری"
        drill={drill}
      />
      {nonCurrentAssetLines.length > 0 ? (
        <Section
          heading="دارایی‌های غیرجاری"
          lines={nonCurrentAssetLines}
          previousLines={previous ? split(previous.assets, "asset", true) : undefined}
          total={current.nonCurrentAssets}
          previousTotal={previous?.nonCurrentAssets}
          totalLabel="جمع دارایی‌های غیرجاری"
          drill={drill}
        />
      ) : null}
      <Section
        heading="بدهی‌های جاری"
        lines={currentLiabilityLines}
        previousLines={previous ? split(previous.liabilities, "liability", false) : undefined}
        total={current.currentLiabilities}
        previousTotal={previous?.currentLiabilities}
        totalLabel="جمع بدهی‌های جاری"
        drill={drill}
      />
      {nonCurrentLiabilityLines.length > 0 ? (
        <Section
          heading="بدهی‌های غیرجاری"
          lines={nonCurrentLiabilityLines}
          previousLines={previous ? split(previous.liabilities, "liability", true) : undefined}
          total={current.nonCurrentLiabilities}
          previousTotal={previous?.nonCurrentLiabilities}
          totalLabel="جمع بدهی‌های غیرجاری"
          drill={drill}
        />
      ) : null}
      <Section
        heading="حقوق صاحبان سرمایه"
        lines={equityLines}
        previousLines={previousEquityLines}
        total={current.totalEquity}
        previousTotal={previous?.totalEquity}
        totalLabel="جمع حقوق صاحبان سرمایه"
        drill={drill}
      />

      <dl className="mt-5 grid gap-3 rounded-xl border border-border/80 bg-muted p-4 sm:grid-cols-3">
        {[
          ["جمع دارایی‌ها", current.totalAssets],
          ["جمع بدهی‌ها", current.totalLiabilities],
          ["جمع حقوق صاحبان سرمایه", current.totalEquity],
        ].map(([label, amount]) => (
          <div key={label as string} className="flex items-center justify-between gap-3 sm:flex-col sm:items-start sm:gap-1">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="tabular-nums font-bold text-foreground">{money.format(amount as number)}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted p-4">
        <span className="font-bold text-foreground">وضعیت تراز</span>
        <span
          className={
            current.balanced
              ? "inline-flex items-center gap-2 rounded-full bg-emerald-50 dark:bg-emerald-500/15 px-3 py-1.5 text-sm font-bold text-emerald-700 dark:text-emerald-300"
              : "inline-flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1.5 text-sm font-bold text-destructive"
          }
        >
          <span
            aria-hidden="true"
            className={
              current.balanced
                ? "size-2 rounded-full bg-emerald-500 dark:bg-emerald-500"
                : "size-2 rounded-full bg-destructive"
            }
          />
          {current.balanced ? "متوازن" : "نامتوازن"}
        </span>
      </div>
      {panel}
    </div>
  );
}

export function CashFlowView({
  report,
}: {
  report: CashFlow | Comparison<CashFlow>;
}) {
  const money = useMoney();
  const current = isComparison(report) ? report.current : report;
  const previous = isComparison(report) ? report.previous : null;

  return (
    <div>
      <section>
        <h3 className="mb-1 text-base font-bold text-foreground">
          صورت جریان وجوه نقد
        </h3>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          وجه نقد در این صورت: {current.cashDefinition}
        </p>

        <dl className="mb-4 grid gap-2 sm:grid-cols-3">
          {CASH_FLOW_ACTIVITIES.map((activity) => (
            <div key={activity} className="rounded-xl border border-border/80 bg-muted p-3">
              <dt className="text-xs text-muted-foreground">{CASH_FLOW_ACTIVITY_LABELS[activity]}</dt>
              <dd className="mt-1 tabular-nums font-bold text-foreground">
                {money.format(current.activities?.[activity] ?? 0)}
              </dd>
            </div>
          ))}
        </dl>

        <DataTable
          caption="گردش وجوه نقد بر اساس فعالیت و نوع رویداد"
          className="hidden sm:block"
          tableClassName="min-w-full"
        >
          <DataTableHead>
            <Th>فعالیت</Th>
            <Th>نوع رویداد</Th>
            <Th numeric>مبلغ</Th>
            {previous ? <Th numeric>دورهٔ قبل</Th> : null}
          </DataTableHead>
          <DataTableBody>
            {current.lines.map((line) => {
              const previousValue =
                previous?.lines.find(
                  (item) => cashFlowLineKey(item) === cashFlowLineKey(line),
                )?.amount ?? null;
              return (
                <DataTableRow key={cashFlowLineKey(line)}>
                  <Td muted className="text-xs">{CASH_FLOW_ACTIVITY_LABELS[line.activity]}</Td>
                  <Td className="font-semibold">{line.label}</Td>
                  <Td numeric>{money.format(line.amount)}</Td>
                  {previous ? (
                    <Td numeric muted>
                      {previousValue !== null ? money.format(previousValue) : "—"}
                    </Td>
                  ) : null}
                </DataTableRow>
              );
            })}
            {current.lines.length === 0 ? (
              <DataTableRow>
                <Td colSpan={previous ? 4 : 3} muted className="py-8 text-center">
                  بدون رویداد نقدی
                </Td>
              </DataTableRow>
            ) : null}
          </DataTableBody>
        </DataTable>

        <div className="space-y-2 sm:hidden">
          {current.lines.map((line) => {
            const previousValue =
              previous?.lines.find(
                (item) => cashFlowLineKey(item) === cashFlowLineKey(line),
              )?.amount ?? null;
            return (
              <article
                key={cashFlowLineKey(line)}
                className="rounded-xl border border-border/80 bg-muted p-4"
              >
                <p className="text-xs text-muted-foreground">{CASH_FLOW_ACTIVITY_LABELS[line.activity]}</p>
                <h4 className="font-semibold text-foreground">{line.label}</h4>
                <dl className="mt-3 space-y-2 border-t border-border pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-xs text-muted-foreground">مبلغ</dt>
                    <dd className="tabular-nums font-bold text-foreground">
                      {money.format(line.amount)}
                    </dd>
                  </div>
                  {previous ? (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">دورهٔ قبل</dt>
                      <dd className="tabular-nums text-muted-foreground">
                        {previousValue !== null
                          ? money.format(previousValue)
                          : "—"}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            );
          })}
          {current.lines.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/80 bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
              بدون رویداد نقدی
            </p>
          ) : null}
        </div>
      </section>

      <dl className="mt-5 space-y-3 rounded-xl border border-border/80 bg-muted p-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <dt className="text-muted-foreground">موجودی ابتدای دوره</dt>
          <dd className="tabular-nums font-semibold text-foreground">
            {money.format(current.openingCash)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <dt className="text-muted-foreground">موجودی پایان دوره</dt>
          <dd className="tabular-nums font-semibold text-foreground">
            {money.format(current.closingCash)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/80 pt-3">
          <dt className="font-bold text-foreground">تغییر خالص وجه نقد</dt>
          <dd
            className={
              current.netChange < 0
                ? "font-bold tabular-nums text-destructive"
                : "font-bold tabular-nums text-foreground"
            }
          >
            {money.format(current.netChange)}
          </dd>
        </div>
        {current.clearingChange ? (
          <div className="flex items-center justify-between gap-3 border-t border-border/80 pt-3 text-sm">
            <dt className="text-muted-foreground">تغییر وجوه در راه (کارت‌خوان، درگاه، پلتفرم) — جزو نقد نیست</dt>
            <dd className="tabular-nums font-semibold text-foreground">{money.format(current.clearingChange)}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
