/**
 * Issue #799 §25 — «حالت کارگاه»: the field flows, on a phone.
 *
 * §25 lists the eleven things a site user does from a phone and then states the
 * rules: RTL, responsive, touch friendly, **no desktop-only large tables for
 * critical work**, fast file/photo capture, clear upload progress, drafts where
 * safe, Shamsi dates. This module is the machine-readable half of that list:
 *
 *   * `AEC_FIELD_ACTIONS` — one entry per §25 bullet, with the capability that
 *     has to be on for it to mean anything, whether a partial draft is *safe*
 *     (a site log that was never sent is a draft; a rejection that was never
 *     sent is a decision that silently did not happen), and the panel that owns
 *     the long form — §34 forbids a second screen for the same information, so
 *     the phone captures inline and hands reviews to the project's own panels;
 *   * `fieldBoard(owner, projectId)` — the queues the phone opens on, composed
 *     from the registers' own list functions rather than a fifth query for each
 *     of them: what is open, what is late and what is waiting for a decision,
 *     each capped so the board stays a queue rather than a table (§34).
 *
 * Nothing here writes. The writers are the existing services the panels already
 * call, which is why the field screen can be a thin, fast surface instead of a
 * parallel API with its own bugs.
 */
import { businessToday } from "./business-day-service";
import type { AecCapabilityKey } from "./aec";
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

/** How the phone finishes a flow. */
export type AecFieldActionKind = "capture" | "update" | "review";

export interface AecFieldAction {
  key: string;
  label: string;
  /** One line of Persian that says what the button will ask for. */
  hint: string;
  /** Its §25 bullet, kept verbatim so the mapping is auditable. */
  requirement: string;
  kind: AecFieldActionKind;
  /** The capability that must be on; `null` for the project register itself. */
  capability: AecCapabilityKey | null;
  /**
   * Whether leaving it half-sent is harmless. A capture can be kept in the
   * browser and sent later; an approval cannot — "approved" that was never
   * sent is a decision that did not happen.
   */
  draftSafe: boolean;
  /**
   * The project tab that owns the long form, for reviews and corrections — a
   * `ProjectTab` key, so the phone links into the same screen with `?tab=`
   * rather than growing a second editor (§34).
   */
  section: "site" | "inspections" | "rfis" | "submittals" | "files" | "procurement" | "work";
}

/** The nine captures and two reviews §25 lists, in the order the issue lists them. */
export const AEC_FIELD_ACTIONS: readonly AecFieldAction[] = [
  {
    key: "site_log",
    label: "گزارش روزانه",
    hint: "کار انجام‌شده، نیرو، ماشین و حادثهٔ امروز",
    requirement: "create site log",
    kind: "capture",
    capability: "site_operations",
    draftSafe: true,
    section: "site",
  },
  {
    key: "site_photo",
    label: "عکس کارگاه",
    hint: "دوربین را باز می‌کند و عکس را با پیشرفت بارگذاری می‌فرستد",
    requirement: "take/upload site photos",
    kind: "capture",
    capability: "site_operations",
    // A binary is not a draft: a half-uploaded photo cannot be resumed from
    // localStorage, so the phone keeps the bytes in the picker instead.
    draftSafe: false,
    section: "site",
  },
  {
    key: "snag",
    label: "ثبت نقص",
    hint: "عنوان، محل، شدت و عکس — شماره را سیستم می‌دهد",
    requirement: "create snag",
    kind: "capture",
    capability: "snagging",
    draftSafe: true,
    section: "inspections",
  },
  {
    key: "inspection",
    label: "بازرسی",
    hint: "از چک‌لیست استاندارد، با آیتم‌های همان چک‌لیست",
    requirement: "create inspection",
    kind: "capture",
    capability: "qa_qc",
    draftSafe: true,
    section: "inspections",
  },
  {
    key: "rfi",
    label: "پرسش فنی (RFI)",
    hint: "موضوع و متن پرسش؛ مهلت پاسخ را انتخاب کنید",
    requirement: "create RFI",
    kind: "capture",
    capability: null,
    draftSafe: true,
    section: "rfis",
  },
  {
    key: "checklist",
    label: "تکمیل چک‌لیست",
    hint: "آیتم‌های باز بازرسی‌های در جریان را همین‌جا تیک بزنید",
    requirement: "complete checklist",
    kind: "update",
    capability: "qa_qc",
    // The ticks are a draft; leaving it never sends a verdict — closing the
    // inspection is a separate, deliberate action.
    draftSafe: true,
    section: "inspections",
  },
  {
    key: "task",
    label: "به‌روزرسانی وظیفه",
    hint: "وضعیت وظیفه‌های باز، با تاریخ شمسی",
    requirement: "update task",
    kind: "update",
    capability: null,
    draftSafe: false,
    section: "work",
  },
  {
    key: "delivery",
    label: "ثبت تحویل مصالح",
    hint: "کدام تعهد تأمین، چه روزی تحویل شد و چه کسی تحویل گرفت",
    requirement: "record material delivery",
    kind: "capture",
    capability: "procurement",
    draftSafe: true,
    section: "procurement",
  },
  {
    key: "latest_drawing",
    label: "آخرین نقشه",
    hint: "آخرین رویزیون صادرشدهٔ همان رشته، با پیوند فایل",
    requirement: "view latest drawing",
    kind: "review",
    capability: "document_control",
    draftSafe: false,
    section: "files",
  },
  {
    key: "submittal_review",
    label: "بررسی سابمیتال",
    hint: "سابمیتال‌های منتظر تأیید، برای مشاهده و پاسخ",
    requirement: "review submittal",
    kind: "review",
    capability: "document_control",
    draftSafe: false,
    section: "submittals",
  },
  {
    key: "approve_reject",
    label: "تأیید / رد",
    hint: "تصمیم‌های منتظر شما — تصمیم هرگز به‌صورت پیش‌نویس نمی‌ماند",
    requirement: "approve/reject",
    kind: "review",
    capability: "approvals",
    draftSafe: false,
    section: "submittals",
  },
] as const;

export const AEC_FIELD_ACTION_KEYS = AEC_FIELD_ACTIONS.map((action) => action.key);

export function aecFieldAction(key: string): AecFieldAction | null {
  return AEC_FIELD_ACTIONS.find((action) => action.key === key) ?? null;
}

/** The §25 rules, quoted on the screen so the list stays auditable. */
export const AEC_FIELD_RULES = [
  "RTL",
  "responsive",
  "touch friendly",
  "no desktop-only large tables for critical work",
  "fast file/photo capture",
  "clear upload progress",
  "drafts where safe",
  "Shamsi dates",
] as const;

/* ===========================================================================
 * The board
 * ======================================================================== */

export interface FieldQueueRow {
  id: string;
  title: string;
  /** The register's own number, when it has one. */
  number: string | null;
  status: string;
  /** Shamsi, ready to render — the board never formats a date itself. */
  dateJalali: string | null;
  /** Days until the due date measured from the business's today; negative = late. */
  daysRemaining: number | null;
  /** Severity/urgency chip, already Persian. */
  chip: string | null;
  /** What the phone may do with the row: open it, or check it off. */
  action: "open" | "check" | "status";
}

export interface FieldBoard {
  today: string;
  todayJalali: string;
  /** The project's name and status, so the phone's header needs no second read. */
  project: { id: string; name: string; status: string; statusLabel: string };
  capabilities: string[];
  /** The checklists an inspection may be started from, when `qa_qc` is on. */
  checklists: SiteChecklistSummary[];
  /**
   * Numbers the phone can prefill so a capture is two taps, not a typing test.
   * They are *suggestions* and the register's own uniqueness still decides: an
   * RFI number is the team's, not the server's (§10) — the field screen only
   * spares a foreman the arithmetic.
   */
  suggestions: { rfiNumber: string };
  queues: {
    /** `todayLogId` lets the phone edit today's day instead of failing on a second one. */
    siteLog: { todayLogged: boolean; todayLogId: string | null };
    snags: { openCount: number; rows: FieldQueueRow[] };
    inspections: { openCount: number; rows: FieldQueueRow[] };
    rfis: { openCount: number; rows: FieldQueueRow[] };
    tasks: { openCount: number; rows: FieldQueueRow[] };
    deliveries: { pendingCount: number; rows: FieldQueueRow[] };
    drawings: { rows: FieldDrawingRow[] };
    submittals: { waitingCount: number; rows: FieldQueueRow[] };
  };
}

/** The latest revision of one drawing, as the phone links to it. */
export interface FieldDrawingRow {
  id: string;
  documentNumber: string;
  title: string;
  revisionCode: string | null;
  revisionId: string | null;
  statusLabel: string | null;
}

/** The board is a queue, not a table (§34): every register is capped. */
export const AEC_FIELD_QUEUE_LIMIT = 5;

const JALALI = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** Shamsi for a `YYYY-MM-DD` string, in UTC so a timezone cannot shift the day. */
export function fieldDateJalali(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return JALALI.format(date);
}

/** Whole days from one `YYYY-MM-DD` to another; negative means the second is past. */
export function fieldDaysBetween(fromIso: string, toIso: string): number {
  const from = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  );
  return Math.round((to - from) / 86_400_000);
}

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
