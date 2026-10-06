/**
 * Issue #799 §30 — the AEC report service.
 *
 * The catalogue in `aec-reports.ts` says *what* each report asks; this file
 * answers it, and the rule that shapes every function here is §30's last line:
 * **"Financial amounts must use Accounting as the source where they represent
 * posted financial facts."**
 *
 * So the service does not recompute anything. It reads:
 *
 *   * the ledger through `projectReport` (actual cost — `null` without
 *     `ledger.view`, never a zero);
 *   * §20's commercial summary for the estimate, the revised contract value and
 *     the forecast (which is itself built from the committed cost §18's register
 *     owns);
 *   * the registers themselves for aging, exposure and status — `pendingRfis`,
 *     `pendingSubmittals`, `listProjectDrawings`, `delayedCommitments`,
 *     `pendingSiteIssues`, `listProjectVariations`, `listProjectCertificates`,
 *     `listProjectSiteLogs`.
 *
 * Only three reports need an aggregate no register prints — the supplier
 * performance table, the quality-register counts and the phase/task variance —
 * and all three read the same tables the registers write, with the same
 * predicates (an award counts from `approved`; a site issue is open while it is
 * not closed or cancelled).
 *
 * A report the business's capabilities do not cover is **absent**, not empty:
 * `reportsForCapabilities` decides that before a single query runs, so an
 * architecture office that switched `procurement` off gets no delay report and
 * pays for no query either.
 *
 * Row caps are deliberate: a report is a screen, not an export. Each list report
 * prints its worst rows (oldest, latest, biggest delay) and says how many it did
 * not print; the register is where the full list lives.
 */
import { type AecCapabilityKey } from "./aec";
import { AecError, assertAecIndustry, loadAecProjectCockpit } from "./aec-service";
import { boqVariance } from "./aec-boq-service";
import {
  getProjectCommercialSummary,
  listProjectCertificates,
  listProjectVariations,
  type ProjectCommercialSummary,
} from "./aec-commercial-service";
import { listProjectDrawings } from "./aec-doc-service";
import { delayedCommitments } from "./aec-procurement-service";
import { pendingRfis, pendingSubmittals } from "./aec-rfi-service";
import { SITE_ISSUE_KIND_LABELS, SITE_ISSUE_STATUS_LABELS, isSiteIssueKind, isSiteIssueStatus } from "./aec-site";
import { listProjectSiteLogs, pendingSiteIssues } from "./aec-site-service";
import { businessToday } from "./business-day-service";
import { PHASE_STATUSES, PHASE_STATUS_LABELS, type WorkspacePhaseStatus } from "./workspace-shared";
import { query } from "./db";
import { projectReport, type WorkspaceOwner } from "./workspace";
import {
  AEC_AGING_BUCKET_LABELS,
  AEC_REPORTS,
  agingBucket,
  reportAgeDays,
  reportPercent,
  reportsForCapabilities,
  type AecReportColumn,
  type AecReportDefinition,
  type AecReportKey,
} from "./aec-reports";

/** One already-computed cell: the UI renders by `kind`, never by guessing. */
export type AecReportCellValue = string | number | boolean | null;
export type AecReportRow = Record<string, AecReportCellValue>;

export interface AecReportTotals {
  label: string;
  /** `money` goes through `useMoney()`, `percent` through the digit formatter. */
  kind: "money" | "number" | "percent";
  value: number | null;
}

export interface AecReport extends Omit<AecReportDefinition, "columns"> {
  columns: readonly AecReportColumn[];
  rows: AecReportRow[];
  totals: AecReportTotals[];
  /** The read the figure came from, so a summary can name its source (§34). */
  sourceTool: string | null;
  /** Rows the report did not print, because a screen shows the worst ones. */
  omittedRows: number;
}

export interface AecReportBundle {
  projectId: string;
  projectName: string;
  /** The business's own today, which every age in the bundle is measured against. */
  today: string;
  capabilities: AecCapabilityKey[];
  reports: AecReport[];
}

/** The row cap each list report prints. The register is where the rest lives. */
export const AEC_REPORT_ROW_LIMIT = 25;

function report(
  definition: AecReportDefinition,
  rows: AecReportRow[],
  totals: AecReportTotals[] = [],
  sourceTool: string | null = null,
): AecReport {
  const printed = rows.slice(0, AEC_REPORT_ROW_LIMIT);
  return {
    ...definition,
    rows: printed,
    totals,
    sourceTool,
    omittedRows: Math.max(0, rows.length - printed.length),
  };
}

function emptyReport(definition: AecReportDefinition, sourceTool: string | null = null): AecReport {
  return report(definition, [], [], sourceTool);
}

const definitionFor = (key: AecReportKey): AecReportDefinition => {
  const found = AEC_REPORTS.find((entry) => entry.key === key);
  if (!found) throw new Error(`unknown AEC report: ${key}`);
  return found;
};

const bucketFor = (days: number): string => AEC_AGING_BUCKET_LABELS[agingBucket(days)];

/* ===========================================================================
 * The bundle
 * ======================================================================== */

/**
 * Every report a project can answer, in §30's order.
 *
 * The capability gate is checked *before* the reads, and each group of reports
 * shares one read rather than issuing its own: the commercial summary answers
 * four reports, the drawings register answers two, the commitment register
 * answers two. That is what keeps a report screen from being a fan-out of
 * near-identical queries whose halves can be a second apart.
 */
export async function projectAecReports(
  owner: WorkspaceOwner,
  projectId: string,
): Promise<AecReportBundle> {
  await assertAecIndustry(owner.businessId);

  const cockpit = await loadAecProjectCockpit(owner.businessId);
  const available = reportsForCapabilities(cockpit.capabilities);
  const has = (capability: AecCapabilityKey) => cockpit.capabilities.includes(capability);
  const wants = (key: AecReportKey) => available.some((entry) => entry.key === key);
  const today = await businessToday(owner.businessId);
  const project = await requireProject(owner.businessId, projectId);

  const reports: AecReport[] = [];

  // ---- the project's own health and plan (no capability) ------------------
  if (wants("project_health")) {
    reports.push(await projectHealthReport(owner, projectId));
  }
  if (wants("schedule_variance")) {
    reports.push(await scheduleVarianceReport(projectId, today));
  }

  // ---- §20's commercial half: one read, four reports ----------------------
  if (has("financials")) {
    const commercial = await getProjectCommercialSummary(owner, projectId);
    if (wants("budget_vs_actual")) reports.push(budgetVsActualReport(commercial));
    if (wants("committed_vs_budget")) reports.push(committedVsBudgetReport(commercial));
    if (wants("forecast_final_cost")) reports.push(forecastFinalCostReport(commercial));
    if (wants("project_margin")) reports.push(projectMarginReport(commercial));
  }

  if (has("boq") && wants("boq_variance")) {
    reports.push(await boqVarianceReport(owner.businessId, projectId));
  }

  if (has("variations") && wants("change_order_exposure")) {
    reports.push(await changeOrderExposureReport(owner.businessId, projectId, today));
  }

  // ---- §18's two: one register read, two reports --------------------------
  if (has("procurement")) {
    if (wants("procurement_delay")) {
      const delays = await delayedCommitments(owner.businessId, {
        projectId,
        limit: AEC_REPORT_ROW_LIMIT,
      });
      reports.push(procurementDelayReport(delays));
    }
    if (wants("contractor_performance")) {
      reports.push(await contractorPerformanceReport(owner.businessId, projectId, today));
    }
  }

  if (wants("rfi_aging")) {
    reports.push(await rfiAgingReport(owner.businessId, projectId));
  }

  if (has("document_control")) {
    if (wants("submittal_aging")) {
      const submittals = await pendingSubmittals(owner.businessId, { projectId, limit: 100 });
      reports.push(submittalAgingReport(submittals));
    }
    if (wants("document_status")) {
      reports.push(await documentStatusReport(owner.businessId, projectId));
    }
  }

  if (has("site_operations") && wants("site_productivity")) {
    reports.push(await siteProductivityReport(owner.businessId, projectId));
  }
  if (has("snagging") && wants("snag_aging")) {
    reports.push(await snagAgingReport(owner.businessId, projectId));
  }
  if (has("qa_qc") && wants("inspection_status")) {
    reports.push(await inspectionStatusReport(owner.businessId, projectId, today));
  }
  if (has("progress_claims") && wants("certificate_status")) {
    reports.push(await certificateStatusReport(owner.businessId, projectId));
  }

  // §30's order, not the read order, is what the reader sees.
  const order = new Map(AEC_REPORTS.map((entry, index) => [entry.key as string, index]));
  reports.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  return {
    projectId,
    projectName: project.name,
    today,
    capabilities: cockpit.capabilities,
    reports,
  };
}

/**
 * The project this bundle is about, or `project_not_found`.
 *
 * Read once, before the reports: every register below already refuses another
 * business's project, and an aggregate that answered an unknown id with a page
 * of empty reports would hide a typo behind a plausible screen. The name comes
 * from the same read, so the page's heading and the rows cannot disagree.
 */
async function requireProject(
  businessId: string,
  projectId: string,
): Promise<{ name: string }> {
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM ai_projects
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [businessId, projectId],
  );
  if (!rows[0]) throw new AecError("project_not_found");
  return { name: rows[0].name };
}

/* ===========================================================================
 * The individual reports
 * ======================================================================== */

async function projectHealthReport(owner: WorkspaceOwner, projectId: string): Promise<AecReport> {
  const definition = definitionFor("project_health");
  const [row] = await projectReport(owner, { projectId });
  if (!row) return emptyReport(definition, "get_aec_project_financial_health");
  const remaining =
    row.budgetRial === null || row.spentRial === null ? null : row.budgetRial - row.spentRial;
  const percent = row.taskCount === 0 ? 0 : Math.round((row.doneTaskCount / row.taskCount) * 100);
  return report(
    definition,
    [
      {
        project: row.name,
        status: row.status,
        progressPercent: percent,
        taskCount: row.taskCount,
        overdueTaskCount: row.overdueTaskCount,
        budgetRial: row.budgetRial,
        spentRial: row.spentRial,
        remainingRial: remaining,
        endDate: row.endDate,
      },
    ],
    [
      { label: "وظایف باز", kind: "number", value: Math.max(0, row.taskCount - row.doneTaskCount) },
      { label: "تأییدهای در انتظار", kind: "number", value: row.openApprovals },
      { label: "ارزش قراردادها", kind: "money", value: row.contractValueRial },
    ],
    "get_aec_project_financial_health",
  );
}

interface ScheduleRow extends Record<string, unknown> {
  name: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  task_count: number;
  done_task_count: number;
  overdue_task_count: number;
  worst_overdue_days: number;
}

async function scheduleVarianceReport(projectId: string, today: string): Promise<AecReport> {
  const definition = definitionFor("schedule_variance");
  const { rows } = await query<ScheduleRow>(
    `SELECT ph.name,
            ph.status,
            ph.start_date::text AS start_date,
            ph.end_date::text AS end_date,
            (SELECT count(*)::integer FROM ai_project_tasks t WHERE t.phase_id = ph.id) AS task_count,
            (SELECT count(*)::integer FROM ai_project_tasks t
              WHERE t.phase_id = ph.id AND t.status = 'done') AS done_task_count,
            (SELECT count(*)::integer FROM ai_project_tasks t
              WHERE t.phase_id = ph.id AND t.status <> 'done' AND t.due_date < $2::date) AS overdue_task_count,
            COALESCE((SELECT max($2::date - t.due_date) FROM ai_project_tasks t
                       WHERE t.phase_id = ph.id AND t.status <> 'done' AND t.due_date < $2::date), 0) AS worst_overdue_days
       FROM workspace_project_phases ph
      WHERE ph.project_id = $1
      ORDER BY ph.display_order, ph.start_date NULLS LAST`,
    [projectId, today],
  );

  const mapped: AecReportRow[] = rows.map((row) => ({
    phase: row.name,
    phaseStatus: (PHASE_STATUSES as readonly string[]).includes(row.status)
      ? PHASE_STATUS_LABELS[row.status as WorkspacePhaseStatus]
      : row.status,
    plannedStart: row.start_date,
    plannedEnd: row.end_date,
    taskCount: Number(row.task_count ?? 0),
    doneTaskCount: Number(row.done_task_count ?? 0),
    overdueTaskCount: Number(row.overdue_task_count ?? 0),
    worstOverdueDays: Number(row.worst_overdue_days ?? 0),
  }));

  // Tasks that belong to no phase are a real answer to "where is the delay?" —
  // the workspace lets a project run without phases, and a report that silently
  // dropped them would understate the schedule.
  const { rows: loose } = await query<{
    task_count: number;
    done_task_count: number;
    overdue_task_count: number;
    worst_overdue_days: number;
  }>(
    `SELECT count(*)::integer AS task_count,
            (SELECT count(*)::integer FROM ai_project_tasks t2
              WHERE t2.project_id = $1 AND t2.phase_id IS NULL AND t2.status = 'done') AS done_task_count,
            (SELECT count(*)::integer FROM ai_project_tasks t2
              WHERE t2.project_id = $1 AND t2.phase_id IS NULL AND t2.status <> 'done'
                AND t2.due_date < $2::date) AS overdue_task_count,
            COALESCE((SELECT max($2::date - t2.due_date) FROM ai_project_tasks t2
                       WHERE t2.project_id = $1 AND t2.phase_id IS NULL AND t2.status <> 'done'
                         AND t2.due_date < $2::date), 0) AS worst_overdue_days
       FROM ai_project_tasks t
      WHERE t.project_id = $1 AND t.phase_id IS NULL`,
    [projectId, today],
  );
  const looseRow = loose[0];
  if (Number(looseRow?.task_count ?? 0) > 0) {
    mapped.push({
      phase: "بدون فاز",
      phaseStatus: "—",
      plannedStart: null,
      plannedEnd: null,
      taskCount: Number(looseRow?.task_count ?? 0),
      doneTaskCount: Number(looseRow?.done_task_count ?? 0),
      overdueTaskCount: Number(looseRow?.overdue_task_count ?? 0),
      worstOverdueDays: Number(looseRow?.worst_overdue_days ?? 0),
    });
  }

  const totalTasks = mapped.reduce((sum, row) => sum + Number(row.taskCount ?? 0), 0);
  const totalOverdue = mapped.reduce((sum, row) => sum + Number(row.overdueTaskCount ?? 0), 0);
  const worst = mapped.reduce((max, row) => Math.max(max, Number(row.worstOverdueDays ?? 0)), 0);
  return report(
    definition,
    mapped,
    [
      { label: "وظایف", kind: "number", value: totalTasks },
      { label: "عقب‌افتاده", kind: "number", value: totalOverdue },
      { label: "بیشترین تأخیر (روز)", kind: "number", value: worst },
    ],
    "list_delayed_project_activities",
  );
}

function budgetVsActualReport(summary: ProjectCommercialSummary): AecReport {
  const definition = definitionFor("budget_vs_actual");
  const baseline = summary.approvedEstimateRial ?? summary.budgetRial;
  const actual = summary.actualCostRial;
  const variance = baseline === null || actual === null ? null : baseline - actual;
  const rows: AecReportRow[] = [
    {
      label: summary.approvedEstimateRial === null ? "بودجهٔ پروژه" : "برآورد مصوب",
      budgetRial: baseline,
      actualCostRial: actual,
      varianceRial: variance,
      usedPercent: reportPercent(actual, baseline),
    },
  ];
  if (summary.approvedEstimateRial !== null && summary.budgetRial !== null) {
    rows.push({
      label: "بودجهٔ پروژه",
      budgetRial: summary.budgetRial,
      actualCostRial: actual,
      varianceRial: actual === null ? null : summary.budgetRial - actual,
      usedPercent: reportPercent(actual, summary.budgetRial),
    });
  }
  return report(
    definition,
    rows,
    [
      { label: "مبنا", kind: "money", value: baseline },
      { label: "هزینهٔ ثبت‌شده", kind: "money", value: actual },
      { label: "انحراف", kind: "money", value: variance },
      { label: "مصرف‌شده", kind: "percent", value: reportPercent(actual, baseline) },
    ],
    "get_aec_project_financial_health",
  );
}

function committedVsBudgetReport(summary: ProjectCommercialSummary): AecReport {
  const definition = definitionFor("committed_vs_budget");
  const baseline = summary.approvedEstimateRial;
  const uncommitted =
    baseline === null
      ? null
      : Math.max(0, baseline - (summary.actualCostRial ?? 0) - summary.committedRial);
  return report(
    definition,
    [
      {
        label: "برآورد مصوب",
        baselineRial: baseline,
        actualCostRial: summary.actualCostRial,
        committedRial: summary.committedRial,
        deliveredRial: summary.deliveredRial,
        uncommittedRial: uncommitted,
      },
    ],
    [
      { label: "تعهدشده", kind: "money", value: summary.committedRial },
      { label: "تحویل‌شده", kind: "money", value: summary.deliveredRial },
      { label: "بدون تعهد", kind: "money", value: uncommitted },
      { label: "تعهدهای تأخیری", kind: "number", value: summary.delayedCommitmentCount },
    ],
    "list_procurement_delays",
  );
}

function forecastFinalCostReport(summary: ProjectCommercialSummary): AecReport {
  const definition = definitionFor("forecast_final_cost");
  return {
    ...report(
      definition,
      [
        {
          label: "هزینهٔ ثبت‌شده + تعهد + باقی‌ماندهٔ برآورد",
          actualCostRial: summary.actualCostRial,
          committedRial: summary.committedRial,
          costToCompleteRial: summary.costToCompleteRial,
          forecastFinalCostRial: summary.forecastFinalCostRial,
        },
      ],
      [
        { label: "هزینهٔ ثبت‌شده", kind: "money", value: summary.actualCostRial },
        { label: "تعهدشده", kind: "money", value: summary.committedRial },
        { label: "تا اتمام کار", kind: "money", value: summary.costToCompleteRial },
        { label: "هزینهٔ نهایی", kind: "money", value: summary.forecastFinalCostRial },
      ],
      "list_procurement_delays",
    ),
    // §20's own sentence: the report says how the number was made instead of
    // printing a formula the reader has to reconstruct.
    note: summary.forecastBasis,
  };
}

function projectMarginReport(summary: ProjectCommercialSummary): AecReport {
  const definition = definitionFor("project_margin");
  return report(
    definition,
    [
      {
        label: "ارزش اصلاح‌شدهٔ قرارداد − هزینهٔ نهایی پیش‌بینی‌شده",
        revisedContractRial: summary.revisedContractRial,
        forecastFinalCostRial: summary.forecastFinalCostRial,
        marginRial: summary.forecastMarginRial,
        marginPercent: reportPercent(summary.forecastMarginRial, summary.revisedContractRial),
      },
    ],
    [
      { label: "ارزش قرارداد", kind: "money", value: summary.revisedContractRial },
      { label: "هزینهٔ نهایی", kind: "money", value: summary.forecastFinalCostRial },
      { label: "حاشیه", kind: "money", value: summary.forecastMarginRial },
      {
        label: "درصد حاشیه",
        kind: "percent",
        value: reportPercent(summary.forecastMarginRial, summary.revisedContractRial),
      },
    ],
    "list_project_commercial_risks",
  );
}

async function boqVarianceReport(businessId: string, projectId: string): Promise<AecReport> {
  const definition = definitionFor("boq_variance");
  const variance = await boqVariance(businessId, projectId);
  if (!variance) return emptyReport(definition, "get_boq_variance");
  const total = variance.approvedEstimateRial;
  return report(
    definition,
    variance.bySection.map((section) => ({
      section: section.title,
      totalRial: section.totalRial,
      sharePercent: reportPercent(section.totalRial, total),
    })),
    [
      { label: "برآورد مصوب", kind: "money", value: total },
      { label: "هزینهٔ ثبت‌شده", kind: "money", value: variance.spentRial },
      { label: "مانده", kind: "money", value: variance.remainingRial },
      { label: "نسخهٔ در جریان", kind: "number", value: variance.openVersionCount },
    ],
    "get_boq_variance",
  );
}

async function changeOrderExposureReport(
  businessId: string,
  projectId: string,
  today: string,
): Promise<AecReport> {
  const definition = definitionFor("change_order_exposure");
  const variations = await listProjectVariations(businessId, projectId);
  const open = variations.filter((row) => row.isOpen);
  const submitted = variations.reduce((sum, row) => sum + (row.submittedAmountRial ?? 0), 0);
  const approved = variations.reduce((sum, row) => sum + (row.approvedAmountRial ?? 0), 0);
  return report(
    definition,
    variations.map((row) => ({
      variationNumber: row.variationNumber,
      description: row.description || row.reason,
      status: row.statusLabel,
      submittedAmountRial: row.submittedAmountRial,
      approvedAmountRial: row.approvedAmountRial,
      scheduleImpactDays: row.scheduleImpactDays,
      submittedDate: row.submittedDate,
      ageDays: reportAgeDays(row.submittedDate, today),
      agingBucket: bucketFor(reportAgeDays(row.submittedDate, today)),
    })),
    [
      { label: "تغییرات باز", kind: "number", value: open.length },
      { label: "مبلغ ارسالی", kind: "money", value: submitted },
      { label: "مبلغ تأییدشده", kind: "money", value: approved },
    ],
    "list_change_orders",
  );
}

function procurementDelayReport(delays: Awaited<ReturnType<typeof delayedCommitments>>): AecReport {
  const definition = definitionFor("procurement_delay");
  const total = delays.reduce((sum, row) => sum + row.valueRial, 0);
  const worst = delays.reduce((max, row) => Math.max(max, row.delayDays), 0);
  return report(
    definition,
    delays.map((row) => ({
      commitmentNumber: row.commitmentNumber,
      kind: row.kindLabel,
      supplierName: row.supplierName,
      title: row.title,
      valueRial: row.valueRial,
      expectedDeliveryDate: row.expectedDeliveryDate,
      delayDays: row.delayDays,
      agingBucket: bucketFor(row.delayDays),
    })),
    [
      { label: "تعهدهای تأخیری", kind: "number", value: delays.length },
      { label: "مبلغ در تأخیر", kind: "money", value: total },
      { label: "بدترین تأخیر (روز)", kind: "number", value: worst },
    ],
    "list_procurement_delays",
  );
}

async function contractorPerformanceReport(
  businessId: string,
  projectId: string,
  today: string,
): Promise<AecReport> {
  const definition = definitionFor("contractor_performance");
  // The same predicate the register uses (`isCommittedStatus`): an award counts
  // from `approved` and keeps counting through `delivered`/`closed`; a draft, a
  // rejected or a cancelled one is not a commitment.
  const { rows } = await query<Record<string, string | number | null>>(
    `SELECT s.name AS supplier_name,
            count(*)::integer AS commitment_count,
            COALESCE(sum(c.value_rial), 0) AS committed_rial,
            COALESCE(sum(CASE WHEN c.status IN ('delivered', 'closed') THEN c.value_rial ELSE 0 END), 0) AS delivered_rial,
            count(*) FILTER (
              WHERE c.status IN ('delivered', 'closed') AND c.delivered_date IS NOT NULL
                AND c.expected_delivery_date IS NOT NULL AND c.delivered_date <= c.expected_delivery_date
            )::integer AS on_time_count,
            count(*) FILTER (
              WHERE c.status = 'approved' AND c.expected_delivery_date IS NOT NULL
                AND c.expected_delivery_date < $2::date
            )::integer AS late_count,
            GREATEST(
              COALESCE(max(CASE WHEN c.delivered_date IS NOT NULL AND c.expected_delivery_date IS NOT NULL
                                THEN GREATEST(0, c.delivered_date - c.expected_delivery_date) END), 0),
              COALESCE(max(CASE WHEN c.status = 'approved' AND c.expected_delivery_date IS NOT NULL
                                THEN GREATEST(0, $2::date - c.expected_delivery_date) END), 0)
            )::integer AS worst_delay_days
       FROM aec_commitments c
       JOIN parties s ON s.id = c.supplier_party_id
      WHERE c.business_id = $1 AND c.project_id = $3 AND c.status IN ('approved', 'delivered', 'closed')
      GROUP BY s.name
      ORDER BY committed_rial DESC`,
    [businessId, today, projectId],
  );
  const mapped: AecReportRow[] = rows.map((row) => ({
    supplierName: String(row.supplier_name ?? ""),
    commitmentCount: Number(row.commitment_count ?? 0),
    committedRial: Number(row.committed_rial ?? 0),
    deliveredRial: Number(row.delivered_rial ?? 0),
    deliveredOnTimeCount: Number(row.on_time_count ?? 0),
    lateCount: Number(row.late_count ?? 0),
    worstDelayDays: Number(row.worst_delay_days ?? 0),
  }));
  const committed = mapped.reduce((sum, row) => sum + Number(row.committedRial ?? 0), 0);
  const late = mapped.reduce((sum, row) => sum + Number(row.lateCount ?? 0), 0);
  return report(
    definition,
    mapped,
    [
      { label: "تأمین‌کنندگان", kind: "number", value: mapped.length },
      { label: "مبلغ تعهد", kind: "money", value: committed },
      { label: "تعهدهای با تأخیر", kind: "number", value: late },
    ],
    "list_procurement_delays",
  );
}

async function rfiAgingReport(businessId: string, projectId: string): Promise<AecReport> {
  const definition = definitionFor("rfi_aging");
  const rfis = await pendingRfis(businessId, { projectId, limit: 100 });
  const overdue = rfis.filter((row) => row.daysOverdue > 0);
  const oldest = rfis.reduce((max, row) => Math.max(max, row.daysOverdue), 0);
  return report(
    definition,
    rfis.map((row) => ({
      rfiNumber: row.rfiNumber,
      subject: row.subject,
      assignedToName: row.assignedToName,
      responsiblePartyName: row.responsiblePartyName,
      dueDate: row.dueDate,
      daysOverdue: row.daysOverdue,
      agingBucket: bucketFor(row.daysOverdue),
    })),
    [
      { label: "استعلام باز", kind: "number", value: rfis.length },
      { label: "از مهلت گذشته", kind: "number", value: overdue.length },
      { label: "قدیمی‌ترین (روز)", kind: "number", value: oldest },
    ],
    "list_pending_rfis",
  );
}

function submittalAgingReport(submittals: Awaited<ReturnType<typeof pendingSubmittals>>): AecReport {
  const definition = definitionFor("submittal_aging");
  const overdue = submittals.filter((row) => row.daysOverdue > 0);
  return report(
    definition,
    submittals.map((row) => ({
      submittalNumber: row.submittalNumber,
      title: row.title,
      submissionType: row.submissionTypeLabel,
      status: row.statusLabel,
      reviewerName: row.reviewerName,
      dueDate: row.dueDate,
      daysOverdue: row.daysOverdue,
      agingBucket: bucketFor(row.daysOverdue),
    })),
    [
      { label: "در انتظار بررسی", kind: "number", value: submittals.length },
      { label: "از مهلت گذشته", kind: "number", value: overdue.length },
    ],
    "list_pending_submittals",
  );
}

async function documentStatusReport(businessId: string, projectId: string): Promise<AecReport> {
  const definition = definitionFor("document_status");
  const drawings = await listProjectDrawings(businessId, projectId);
  const pendingRevisions = drawings.filter(
    (row) => row.latestRevisionStatus === null || row.latestRevisionStatus === "draft",
  );
  return report(
    definition,
    drawings.map((row) => ({
      documentNumber: row.documentNumber,
      title: row.title,
      documentType: row.documentTypeLabel,
      latestRevisionCode: row.latestRevisionCode,
      latestRevisionStatus: row.latestRevisionStatusLabel ?? "—",
      revisionCount: row.revisionCount,
      updatedAt: row.updatedAt,
    })),
    [
      { label: "سند/نقشه", kind: "number", value: drawings.length },
      { label: "بازنگری باز", kind: "number", value: pendingRevisions.length },
    ],
    "get_latest_drawing_revision",
  );
}

async function siteProductivityReport(businessId: string, projectId: string): Promise<AecReport> {
  const definition = definitionFor("site_productivity");
  const logs = await listProjectSiteLogs(businessId, projectId, { limit: AEC_REPORT_ROW_LIMIT });
  const workforce = logs.reduce((sum, row) => sum + row.workforce, 0);
  const incidents = logs.reduce((sum, row) => sum + row.incidentCount, 0);
  const deliveries = logs.reduce((sum, row) => sum + row.deliveryCount, 0);
  return report(
    definition,
    logs.map((row) => ({
      logDate: row.logDate,
      status: row.statusLabel,
      workforce: row.workforce,
      lineCount: row.lineCount,
      deliveryCount: row.deliveryCount,
      incidentCount: row.incidentCount,
      authorName: row.authorName,
    })),
    [
      { label: "روزهای ثبت‌شده", kind: "number", value: logs.length },
      { label: "جمع نیرو", kind: "number", value: workforce },
      { label: "مصالح رسیده", kind: "number", value: deliveries },
      { label: "رخداد", kind: "number", value: incidents },
    ],
  );
}

async function snagAgingReport(businessId: string, projectId: string): Promise<AecReport> {
  const definition = definitionFor("snag_aging");
  const snags = await pendingSiteIssues(businessId, { projectId, kind: "snag", limit: 100 });
  const overdue = snags.filter((row) => row.daysOverdue > 0);
  const oldest = snags.reduce((max, row) => Math.max(max, row.daysOverdue), 0);
  return report(
    definition,
    snags.map((row) => ({
      issueNumber: row.issueNumber,
      title: row.title,
      severity: row.severityLabel,
      status: isSiteIssueStatus(row.status) ? SITE_ISSUE_STATUS_LABELS[row.status] : row.status,
      assigneeName: row.assigneeName,
      responsiblePartyName: row.responsiblePartyName,
      dueDate: row.dueDate,
      daysOverdue: row.daysOverdue,
      agingBucket: bucketFor(row.daysOverdue),
    })),
    [
      { label: "نقص باز", kind: "number", value: snags.length },
      { label: "از مهلت گذشته", kind: "number", value: overdue.length },
      { label: "قدیمی‌ترین (روز)", kind: "number", value: oldest },
    ],
    "list_site_issues",
  );
}

async function inspectionStatusReport(
  businessId: string,
  projectId: string,
  today: string,
): Promise<AecReport> {
  const definition = definitionFor("inspection_status");
  const { rows } = await query<Record<string, string | number | null>>(
    `SELECT i.kind,
            count(*) FILTER (WHERE i.status = 'open')::integer AS open_count,
            count(*) FILTER (WHERE i.status = 'in_progress')::integer AS in_progress_count,
            count(*) FILTER (WHERE i.status = 'resolved')::integer AS resolved_count,
            count(*) FILTER (
              WHERE i.status IN ('open', 'in_progress') AND i.due_date IS NOT NULL AND i.due_date < $2::date
            )::integer AS overdue_count,
            COALESCE(max($2::date - i.raised_date) FILTER (
              WHERE i.status IN ('open', 'in_progress', 'resolved')
            ), 0)::integer AS oldest_open_days
       FROM aec_site_issues i
      WHERE i.business_id = $1 AND i.project_id = $3
      GROUP BY i.kind
      ORDER BY i.kind`,
    [businessId, today, projectId],
  );
  const mapped: AecReportRow[] = rows.map((row) => {
    const kind = String(row.kind ?? "");
    return {
      kind: isSiteIssueKind(kind) ? SITE_ISSUE_KIND_LABELS[kind] : kind,
      openCount: Number(row.open_count ?? 0),
      inProgressCount: Number(row.in_progress_count ?? 0),
      resolvedCount: Number(row.resolved_count ?? 0),
      overdueCount: Number(row.overdue_count ?? 0),
      oldestOpenDays: Number(row.oldest_open_days ?? 0),
    };
  });
  const open = mapped.reduce(
    (sum, row) => sum + Number(row.openCount ?? 0) + Number(row.inProgressCount ?? 0),
    0,
  );
  const overdue = mapped.reduce((sum, row) => sum + Number(row.overdueCount ?? 0), 0);
  return report(
    definition,
    mapped,
    [
      { label: "موارد باز", kind: "number", value: open },
      { label: "از مهلت گذشته", kind: "number", value: overdue },
    ],
    "list_site_issues",
  );
}

async function certificateStatusReport(businessId: string, projectId: string): Promise<AecReport> {
  const definition = definitionFor("certificate_status");
  const certificates = await listProjectCertificates(businessId, projectId);
  const certified = certificates.filter((row) => row.status === "certified");
  const certifiedTotal = certified.reduce(
    (sum, row) => sum + (row.approvedAmountRial ?? row.netRial),
    0,
  );
  return report(
    definition,
    certificates.map((row) => ({
      certificateNumber: row.certificateNumber,
      kind: row.kindLabel,
      status: row.statusLabel,
      periodEnd: row.periodEnd,
      netRial: row.netRial,
      approvedAmountRial: row.approvedAmountRial,
      certifiedDate: row.certifiedDate,
    })),
    [
      { label: "صورت‌وضعیت/گواهی", kind: "number", value: certificates.length },
      { label: "گواهی‌شده", kind: "number", value: certified.length },
      { label: "مبلغ گواهی‌شده", kind: "money", value: certifiedTotal },
    ],
    "list_payment_certificates",
  );
}
