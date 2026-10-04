"use client";

/**
 * «گزارش‌ها» — project health and profitability.
 *
 * The spent figure is NOT kept here. It is read from the ledger through
 * `journal_entries.project_id`, the cost-centre dimension Accounting already
 * owns, so the workspace and the books can never disagree about what a project
 * cost. Budget − spent is the margin; a project with no budget shows «—»
 * rather than a misleading zero.
 */

import { InsightsPanel } from "./insights-panel";
import { useEffect, useMemo, useState } from "react";
import { BarChart3Icon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  completionPercent,
  type WorkspacePriority,
  type WorkspaceProjectStatus,
} from "@/lib/workspace-shared";
import {
  DateCell,
  PriorityBadge,
  ProgressBar,
  ProjectStatusBadge,
  workspaceError,
  stackedTableClass,
} from "./workspace-ui";

interface ReportRow {
  projectId: string;
  name: string;
  status: WorkspaceProjectStatus;
  priority: WorkspacePriority;
  partyName: string | null;
  ownerName: string | null;
  startDate: string | null;
  endDate: string | null;
  budgetRial: number | null;
  /** Null when the member may not read the ledger (ledger.view). */
  spentRial: number | null;
  contractValueRial: number;
  taskCount: number;
  doneTaskCount: number;
  overdueTaskCount: number;
  openApprovals: number;
}

export function ReportsSection() {
  const money = useMoney();
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<WorkspaceProjectStatus | "">("");

  useEffect(() => {
    api<{ rows: ReportRow[] }>("/api/workspace/reports").then(({ ok, data }) => {
      if (ok) setRows(data.rows);
      else setError(workspaceError((data as unknown as { error?: string }).error));
    });
  }, []);

  const visible = useMemo(
    () => (rows ?? []).filter((row) => !status || row.status === status),
    [rows, status],
  );

  const totals = useMemo(() => {
    let budget = 0;
    let spent = 0;
    let contracts = 0;
    let overdue = 0;
    // The server sends null spend to a member who may not read the books, so
    // the screen says "not available" rather than "nothing spent".
    const financials = visible.some((row) => row.spentRial !== null);
    for (const row of visible) {
      budget += row.budgetRial ?? 0;
      spent += row.spentRial ?? 0;
      contracts += row.contractValueRial;
      overdue += row.overdueTaskCount;
    }
    return { budget, spent, contracts, overdue, financials };
  }, [visible]);

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {/* Questions first (#761 §15); the full table stays below for the power user. */}
      <InsightsPanel />

      <KpiRow>
        <KpiCard
          label="بودجهٔ کل"
          value={money.format(totals.budget)}
          hint="جمع بودجهٔ پروژه‌های این نما"
          icon={BarChart3Icon}
        />
        <KpiCard
          label="هزینهٔ ثبت‌شده"
          value={totals.financials ? money.format(totals.spent) : "—"}
          hint={totals.financials ? "از دفتر روزنامهٔ حسابداری" : "نیازمند دسترسی به دفاتر حسابداری"}
        />
        <KpiCard
          label="مانده نسبت به بودجه"
          value={totals.financials ? money.format(totals.budget - totals.spent) : "—"}
          hint={totals.budget ? undefined : "بودجه‌ای ثبت نشده است"}
        />
        <KpiCard
          label="ارزش قراردادهای اجرا"
          value={money.format(totals.contracts)}
          hint={`${toPersianDigits(String(totals.overdue))} وظیفهٔ عقب‌افتاده`}
        />
      </KpiRow>

      <SectionCard
        title="سلامت و سودآوری پروژه‌ها"
        description="هزینه از سندهای حسابداریِ همین پروژه خوانده می‌شود؛ میز کار نسخهٔ دومی از این عدد نگه نمی‌دارد."
        flush
      >
        <div className="border-b border-border/80 p-4">
          <FilterChipRow label="فیلتر وضعیت">
            <FilterChip selected={!status} onClick={() => setStatus("")}>
              همه
            </FilterChip>
            {PROJECT_STATUSES.map((value) => (
              <FilterChip
                key={value}
                selected={status === value}
                onClick={() => setStatus(status === value ? "" : value)}
              >
                {PROJECT_STATUS_LABELS[value]}
              </FilterChip>
            ))}
          </FilterChipRow>
        </div>

        {rows === null ? (
          <LoadingSkeleton rows={6} label="در حال بارگذاری گزارش" />
        ) : visible.length === 0 ? (
          <EmptyState icon={BarChart3Icon} title="پروژه‌ای برای گزارش نیست">
            پس از ساخت پروژه و ثبت هزینه‌ها، وضعیت مالی و پیشرفت هر پروژه اینجا جمع می‌شود.
          </EmptyState>
        ) : (
          <DataTable caption="گزارش سلامت و سودآوری پروژه‌ها" frame={false} tableClassName={stackedTableClass}>
            <DataTableHead>
              <tr>
                <Th>پروژه</Th>
                <Th>وضعیت</Th>
                <Th>پیشرفت</Th>
                <Th>بودجه</Th>
                <Th>هزینه</Th>
                <Th>مانده</Th>
                <Th>قراردادها</Th>
                <Th>مهلت پایان</Th>
              </tr>
            </DataTableHead>
            <DataTableBody>
              {visible.map((row) => {
                const percent = completionPercent(row.doneTaskCount, row.taskCount);
                const remaining =
                  row.budgetRial === null || row.spentRial === null ? null : row.budgetRial - row.spentRial;
                return (
                  <DataTableRow key={row.projectId}>
                    <Td data-label="پروژه">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{row.name}</span>
                        <PriorityBadge priority={row.priority} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[row.ownerName, row.partyName].filter(Boolean).join(" • ") || "—"}
                      </div>
                    </Td>
                    <Td data-label="وضعیت">
                      <ProjectStatusBadge status={row.status} />
                      {row.openApprovals > 0 ? (
                        <div className="text-xs text-muted-foreground">
                          {toPersianDigits(String(row.openApprovals))} تأیید باز
                        </div>
                      ) : null}
                    </Td>
                    <Td data-label="پیشرفت">
                      <ProgressBar percent={percent} label={`پیشرفت ${row.name}`} />
                      <div className="text-xs text-muted-foreground">
                        {toPersianDigits(String(row.doneTaskCount))} از{" "}
                        {toPersianDigits(String(row.taskCount))} وظیفه
                        {row.overdueTaskCount > 0
                          ? ` • ${toPersianDigits(String(row.overdueTaskCount))} عقب‌افتاده`
                          : ""}
                      </div>
                    </Td>
                    <Td data-label="بودجه">
                      {row.budgetRial === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="tabular-nums">{money.format(row.budgetRial)}</span>
                      )}
                    </Td>
                    <Td data-label="هزینه">
                      {row.spentRial === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="tabular-nums">{money.format(row.spentRial)}</span>
                      )}
                    </Td>
                    <Td data-label="مانده">
                      {remaining === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={
                            remaining < 0
                              ? "tabular-nums text-rose-700 dark:text-rose-300"
                              : "tabular-nums text-emerald-700 dark:text-emerald-300"
                          }
                        >
                          {money.format(remaining)}
                        </span>
                      )}
                    </Td>
                    <Td data-label="قراردادها">
                      <span className="tabular-nums">{money.format(row.contractValueRial)}</span>
                    </Td>
                    <Td data-label="مهلت پایان">
                      <DateCell date={row.endDate} />
                    </Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}
