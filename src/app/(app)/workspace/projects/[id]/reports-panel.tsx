"use client";

/**
 * Issue #799 §30 on screen — «گزارش‌ها»: the project's report set.
 *
 * §30 asks for seventeen reports and one rule, and the rule is why this screen
 * is a *reader*: every figure comes from the register or the service that owns
 * it (the ledger through `projectReport`, §20's commercial summary, the
 * procurement/RFI/submittal/drawing/site/quality registers), so a report and the
 * tab it summarises cannot disagree. The screen adds three things the registers
 * do not print:
 *
 *   * the **aging and variance** questions §30 writes down — what is late, by
 *     how much, and which change orders are exposed;
 *   * the **totals** across rows;
 *   * the **source line** (§34's "AI summaries with transparent source links"):
 *     the assistant read that answers the same question, named under the table,
 *     so a narration can be checked against the read that produced it.
 *
 * The columns arrive with a `kind` (`money`, `date`, `percent`, `status`), so a
 * rial figure goes through the business's own `useMoney()` and a date through
 * the shared Shamsi cell — a report that formatted its own numbers would be the
 * one screen where they look different.
 *
 * A report the business's capabilities do not cover is not rendered at all: the
 * server decides that before it answers, which is §21's rule (an unbuilt or
 * switched-off section is absent, never greyed out).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3Icon, SparklesIcon } from "lucide-react";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import type { AecReport, AecReportBundle } from "@/lib/aec-reports-service";
import { DateCell, stackedTableClass, workspaceError } from "../../workspace-ui";

const n = (value: number) => toPersianDigits(String(value));

/** The money figure a KPI reads, or `null` when that report is not available. */
function totalOf(bundle: AecReportBundle, key: string, label: string): number | null {
  const report = bundle.reports.find((entry) => entry.key === key);
  const total = report?.totals.find((entry) => entry.label === label);
  return total?.value ?? null;
}

function hasReport(bundle: AecReportBundle, key: string): boolean {
  return bundle.reports.some((entry) => entry.key === key);
}

export function AecReportsTab({ projectId }: { projectId: string }) {
  const money = useMoney();
  const [bundle, setBundle] = useState<AecReportBundle | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<AecReportBundle>(`/api/aec/projects/${projectId}/reports`);
    if (!ok) {
      setError(workspaceError((data as unknown as { error?: string }).error));
      setBundle(null);
      return;
    }
    setBundle(data);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const kpis = useMemo(() => {
    if (!bundle) return null;
    return {
      budget: hasReport(bundle, "budget_vs_actual")
        ? totalOf(bundle, "budget_vs_actual", "مبنا")
        : null,
      actual: hasReport(bundle, "budget_vs_actual")
        ? totalOf(bundle, "budget_vs_actual", "هزینهٔ ثبت‌شده")
        : null,
      forecastFinal: hasReport(bundle, "forecast_final_cost")
        ? totalOf(bundle, "forecast_final_cost", "هزینهٔ نهایی")
        : null,
      delayed: hasReport(bundle, "procurement_delay")
        ? totalOf(bundle, "procurement_delay", "تعهدهای تأخیری")
        : null,
    };
  }, [bundle]);

  if (!bundle) {
    return (
      <div className="flex flex-col gap-4">
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <KpiRow>
          <KpiCard label="مبنای بودجه" value="—" />
          <KpiCard label="هزینهٔ ثبت‌شده" value="—" />
          <KpiCard label="هزینهٔ نهایی پیش‌بینی‌شده" value="—" />
          <KpiCard label="تعهدهای تأخیری" value="—" />
        </KpiRow>
        <SectionCardSkeleton rows={5} />
      </div>
    );
  }

  const reports = bundle.reports;

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <KpiRow>
        <KpiCard
          label="مبنای بودجه"
          value={kpis?.budget === null || kpis?.budget === undefined ? "—" : money.format(kpis.budget)}
          hint="برآورد مصوب، یا بودجهٔ پروژه وقتی برآوردی نیست"
        />
        <KpiCard
          label="هزینهٔ ثبت‌شده"
          value={kpis?.actual === null || kpis?.actual === undefined ? "—" : money.format(kpis.actual)}
          hint={
            kpis?.actual === null || kpis?.actual === undefined
              ? "نیازمند دسترسی به دفاتر حسابداری"
              : "از دفتر روزنامهٔ حسابداری"
          }
        />
        <KpiCard
          label="هزینهٔ نهایی پیش‌بینی‌شده"
          value={
            kpis?.forecastFinal === null || kpis?.forecastFinal === undefined
              ? "—"
              : money.format(kpis.forecastFinal)
          }
          hint="بر پایهٔ هزینهٔ ثبت‌شده، تعهدات باز و باقی‌ماندهٔ برآورد"
        />
        <KpiCard
          label="تعهدهای تأخیری"
          value={kpis?.delayed === null || kpis?.delayed === undefined ? "—" : n(kpis.delayed)}
          hint="تعهدات تأمین گذشته از موعد تحویل"
        />
      </KpiRow>

      {reports.length === 0 ? (
        <SectionCard title="گزارشی در دسترس نیست" flush>
          <EmptyState icon={BarChart3Icon} title="گزارشی برای این کسب‌وکار فعال نیست">
            گزارش‌ها با قابلیت‌های همین کسب‌وکار باز و بسته می‌شوند؛ هر گزارشی که قابلیتش خاموش
            باشد اینجا نمایش داده نمی‌شود.
          </EmptyState>
        </SectionCard>
      ) : (
        reports.map((report) => <ReportCard key={report.key} report={report} />)
      )}
    </div>
  );
}

function ReportCard({ report }: { report: AecReport }) {
  const money = useMoney();
  return (
    <SectionCard
      title={report.label}
      description={report.description}
      flush
      actions={
        report.sourceTool ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <SparklesIcon className="size-3.5" aria-hidden />
            همین پرسش از دستیار: {report.sourceTool}
          </span>
        ) : null
      }
    >
      {report.totals.length > 0 ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border/80 p-4">
          {report.totals.map((total) => (
            <div key={total.label} className="min-w-32">
              <div className="text-xs text-muted-foreground">{total.label}</div>
              <div className="tabular-nums font-medium">
                {total.value === null
                  ? "—"
                  : total.kind === "money"
                    ? money.format(total.value)
                    : total.kind === "percent"
                      ? `${toPersianDigits(String(total.value))}٪`
                      : toPersianDigits(String(total.value))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {report.rows.length === 0 ? (
        <EmptyState icon={BarChart3Icon} title={report.emptyMessage} />
      ) : (
        <DataTable caption={report.label} frame={false} tableClassName={stackedTableClass}>
          <DataTableHead>
            <tr>
              {report.columns.map((column) => (
                <Th key={column.key}>{column.label}</Th>
              ))}
            </tr>
          </DataTableHead>
          <DataTableBody>
            {report.rows.map((row, index) => (
              <DataTableRow key={index}>
                {report.columns.map((column) => (
                  <Td key={column.key} data-label={column.label}>
                    <ReportCell
                      kind={column.kind}
                      value={row[column.key] ?? null}
                      formatMoney={(value) => money.format(value)}
                    />
                  </Td>
                ))}
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}

      <div className="flex flex-col gap-1 border-t border-border/80 p-4 text-xs text-muted-foreground">
        {report.omittedRows > 0 ? (
          <p>
            {toPersianDigits(String(report.omittedRows))} ردیف دیگر در دفتر همان بخش؛ این گزارش
            بدترین/تازه‌ترین ردیف‌ها را نشان می‌دهد.
          </p>
        ) : null}
        {report.note ? <p>{report.note}</p> : null}
      </div>
    </SectionCard>
  );
}

function ReportCell({
  kind,
  value,
  formatMoney,
}: {
  kind: AecReport["columns"][number]["kind"];
  value: string | number | boolean | null;
  formatMoney: (value: number) => string;
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  switch (kind) {
    case "money":
      return <span className="tabular-nums">{formatMoney(Number(value))}</span>;
    case "percent":
      return <span className="tabular-nums">{toPersianDigits(String(value))}٪</span>;
    case "number":
      return <span className="tabular-nums">{toPersianDigits(String(value))}</span>;
    case "date":
      return <DateCell date={String(value)} />;
    case "status":
      return <StatusBadge tone="neutral">{String(value)}</StatusBadge>;
    default:
      return <span>{String(value)}</span>;
  }
}
