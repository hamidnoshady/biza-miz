/**
 * Issue #799 §25 — «حالت کارگاه»: the field flows, on a phone.
 *
 * §25 lists the eleven things a site user does from a phone and then states the
 * rules: RTL, responsive, touch friendly, **no desktop-only large tables for
 * critical work**, fast file/photo capture, clear upload progress, drafts where
 * safe, Shamsi dates.
 *
 * `aec-field-catalogue.ts` carries the machine-readable half of that list — the
 * eleven flows with their capability, their draft safety and the panel that
 * owns the long form — and is importable from a browser. This module carries
 * the server half:
 *
 *   * `fieldBoard(owner, projectId)` — the queues the phone opens on, composed
 *     from the registers' own list functions rather than a fifth query for each
 *     of them: what is open, what is late and what is waiting for a decision,
 *     each capped so the board stays a queue rather than a table (§34).
 *
 * Nothing here writes. The writers are the existing services the panels already
 * call, which is why the field screen can be a thin, fast surface instead of a
 * parallel API with its own bugs.
 */
import type { AecCapabilityKey } from "./aec";
import { businessToday } from "./business-day-service";
import { AecError, loadBusinessAecProfile } from "./aec-service";
import { listProjectDrawings, type DrawingSummary } from "./aec-doc-service";
import { listProjectCommitments, type CommitmentSummary } from "./aec-procurement-service";
import {
  listProjectRfis,
  listProjectSubmittals,
  type RfiSummary,
  type SubmittalSummary,
} from "./aec-rfi-service";
import {
  listChecklists,
  listProjectSiteIssues,
  listProjectSiteLogs,
  type SiteChecklistSummary,
  type SiteIssueSummary,
  type SiteLogSummary,
} from "./aec-site-service";
import { nextNumberInSeries } from "./aec-numbering";
import { query } from "./db";
import { listWorkspaceTasks, type WorkspaceOwner, type WorkspaceTask } from "./workspace";
import { PROJECT_STATUS_LABELS, type WorkspaceProjectStatus } from "./workspace-shared";
import {
  AEC_FIELD_QUEUE_LIMIT,
  fieldDateJalali,
  fieldDaysBetween,
  type FieldBoard,
  type FieldDrawingRow,
  type FieldQueueRow,
} from "./aec-field-catalogue";

/**
 * §25's catalogue lives in `aec-field-catalogue.ts` — the phone screen renders
 * it, so it must be reachable without the database layer. Re-exported here so
 * the server side (and the tests that assert the eleven flows) keep one import
 * point.
 */
export * from "./aec-field-catalogue";

/** Severity as the phone shows it, never the raw enum. */
const SEVERITY_LABELS: Record<string, string> = {
  low: "کم",
  medium: "متوسط",
  high: "زیاد",
  critical: "بحرانی",
};

function issueRow(issue: SiteIssueSummary, today: string, action: FieldQueueRow["action"]): FieldQueueRow {
  const due = issue.dueDate ?? null;
  return {
    id: issue.id,
    title: issue.title,
    number: issue.issueNumber,
    status: issue.status,
    dateJalali: fieldDateJalali(due ?? issue.raisedDate),
    daysRemaining: due ? fieldDaysBetween(today, due) : null,
    chip: issue.severity ? SEVERITY_LABELS[issue.severity] ?? issue.severity : null,
    action,
  };
}

/** Soonest first, undated last — the same order a foreman would triage in. */
function soonest(rows: FieldQueueRow[], limit: number): FieldQueueRow[] {
  return rows
    .slice()
    .sort((a, b) => (a.daysRemaining ?? 9_999) - (b.daysRemaining ?? 9_999))
    .slice(0, limit);
}

/**
 * The phone's opening screen for one project.
 *
 * The capabilities are read once and each register is asked **only when its
 * capability is on** — the same rule the panels follow, and the reason a design
 * office that switched `site_operations` off sees a board without an empty site
 * queue that would 403 if tapped. The project's own visibility and the caller's
 * role are the route's `requireProjectCapability`, exactly like every other AEC
 * read.
 */
export async function fieldBoard(
  owner: WorkspaceOwner,
  projectId: string,
  options: { limit?: number } = {},
): Promise<FieldBoard> {
  const limit = Math.min(Math.max(options.limit ?? AEC_FIELD_QUEUE_LIMIT, 1), 20);
  const today = await businessToday(owner.businessId);
  const { rows: projectRows } = await query<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM ai_projects
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [owner.businessId, projectId],
  );
  const project = projectRows[0];
  // The route already proved the caller may see the project; this is the
  // register's own 404 for a race with an archive made between the two reads.
  if (!project) throw new AecError("project_not_found");
  const profile = await loadBusinessAecProfile(owner.businessId);
  const capabilities = [...profile.capabilities];
  const has = (capability: AecCapabilityKey) => capabilities.includes(capability);

  const [logs, snags, inspections, rfis, tasks, commitments, drawings, submittals, checklists] = await Promise.all([
    has("site_operations")
      ? listProjectSiteLogs(owner.businessId, projectId, { from: today, to: today })
      : Promise.resolve([] as SiteLogSummary[]),
    has("qa_qc") && has("snagging")
      ? listProjectSiteIssues(owner.businessId, projectId, { kind: "snag", openOnly: true })
      : Promise.resolve([] as SiteIssueSummary[]),
    has("qa_qc")
      ? listProjectSiteIssues(owner.businessId, projectId, { kind: "inspection", openOnly: true })
      : Promise.resolve([] as SiteIssueSummary[]),
    // RFIs are part of the project register (§9) and gate on the industry
    // alone, so the board always asks — there is no switch to read. Two reads
    // because the queue a foreman needs is "what I filed is not being answered
    // yet": the drafts the phone just captured plus the ones actually asked.
    Promise.all([
      listProjectRfis(owner.businessId, projectId, { openOnly: true }),
      listProjectRfis(owner.businessId, projectId, { status: "draft" }),
    ]).then(([open, drafts]) => [...drafts, ...open]),
    listWorkspaceTasks(owner, { projectId, status: "open_only", limit: 100 }),
    has("procurement")
      ? listProjectCommitments(owner.businessId, projectId)
      : Promise.resolve([] as CommitmentSummary[]),
    has("document_control")
      ? listProjectDrawings(owner.businessId, projectId)
      : Promise.resolve([] as DrawingSummary[]),
    has("document_control")
      ? listProjectSubmittals(owner.businessId, projectId, { waitingOnly: true })
      : Promise.resolve([] as SubmittalSummary[]),
    // The project's own checklists plus the firm-wide ones (`project_id IS
    // NULL`) — the same list the inspections panel starts from.
    has("qa_qc")
      ? listChecklists(owner.businessId, { projectId })
      : Promise.resolve([] as SiteChecklistSummary[]),
  ]);

  // §25's "update task": what is open and has a date the field cares about —
  // due within the week or already past. A task with no date is not field work.
  const taskRows: FieldQueueRow[] = (tasks as WorkspaceTask[])
    .filter((task) => task.dueDate !== null)
    .map((task) => ({
      id: task.id,
      title: task.title,
      number: null,
      status: task.status,
      dateJalali: fieldDateJalali(task.dueDate),
      daysRemaining: task.dueDate ? fieldDaysBetween(today, task.dueDate) : null,
      chip: task.assigneeName ?? null,
      action: "status" as const,
    }));

  // The next free RFI number for this project, in the register's own shape
  // (`RFI-004`). Only rows that already follow the shape are counted, so a
  // hand-typed number can never break the read.
  const { rows: rfiNumbers } = await query<{ rfi_number: string }>(
    `SELECT rfi_number FROM aec_rfis WHERE business_id = $1 AND project_id = $2`,
    [owner.businessId, projectId],
  );

  const pendingDeliveries = commitments.filter((commitment) => commitment.status === "approved");
  const deliveryRows: FieldQueueRow[] = pendingDeliveries.slice(0, limit).map((commitment) => {
    const expected = commitment.expectedDeliveryDate ?? null;
    return {
      id: commitment.id,
      title: commitment.title,
      number: commitment.commitmentNumber,
      status: commitment.status,
      dateJalali: fieldDateJalali(expected),
      daysRemaining: expected ? fieldDaysBetween(today, expected) : null,
      chip: commitment.isDelayed ? `${commitment.delayDays} روز تأخیر` : commitment.supplierName,
      action: "open" as const,
    };
  });

  return {
    today,
    todayJalali: fieldDateJalali(today) ?? today,
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      statusLabel: PROJECT_STATUS_LABELS[project.status as WorkspaceProjectStatus] ?? project.status,
    },
    capabilities,
    checklists,
    suggestions: {
      rfiNumber: nextNumberInSeries("RFI", rfiNumbers.map((row) => row.rfi_number)),
    },
    queues: {
      siteLog: { todayLogged: logs.length > 0, todayLogId: logs[0]?.id ?? null },
      snags: {
        openCount: snags.length,
        rows: soonest(snags.map((issue) => issueRow(issue, today, "open")), limit),
      },
      inspections: {
        openCount: inspections.length,
        // §25's "complete checklist" is the only field update with a checkbox
        // rather than a status select, so the row says which gesture it wants.
        rows: soonest(inspections.map((issue) => issueRow(issue, today, "check")), limit),
      },
      rfis: {
        openCount: rfis.length,
        rows: soonest(
          rfis.map((rfi) => ({
            id: rfi.id,
            title: rfi.subject,
            number: rfi.rfiNumber,
            status: rfi.status,
            dateJalali: fieldDateJalali(rfi.dueDate),
            daysRemaining: rfi.dueDate ? fieldDaysBetween(today, rfi.dueDate) : null,
            chip: rfi.status === "draft" ? "پیش‌نویس — هنوز ارسال نشده" : rfi.disciplineLabel || null,
            action: "open" as const,
          })),
          limit,
        ),
      },
      tasks: { openCount: taskRows.length, rows: soonest(taskRows, limit) },
      deliveries: { pendingCount: pendingDeliveries.length, rows: deliveryRows },
      drawings: {
        rows: drawings.slice(0, limit).map((drawing) => ({
          id: drawing.id,
          documentNumber: drawing.documentNumber,
          title: drawing.title,
          revisionCode: drawing.latestRevisionCode ?? null,
          revisionId: drawing.latestRevisionId ?? null,
          statusLabel: drawing.latestRevisionStatusLabel ?? null,
        })),
      },
      submittals: {
        waitingCount: submittals.length,
        rows: soonest(
          submittals.map((submittal) => ({
            id: submittal.id,
            title: submittal.title,
            number: submittal.submittalNumber,
            status: submittal.latestRevisionStatus ?? "awaiting_review",
            dateJalali: fieldDateJalali(submittal.latestRevisionDueDate ?? submittal.responseRequiredBy),
            daysRemaining: (() => {
              const due = submittal.latestRevisionDueDate ?? submittal.responseRequiredBy;
              return due ? fieldDaysBetween(today, due) : null;
            })(),
            chip: submittal.latestRevisionStatusLabel ?? null,
            action: "open" as const,
          })),
          limit,
        ),
      },
    },
  };
}
