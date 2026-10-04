/**
 * Issue #799 §13 and §14 — the site execution service: the daily log with its
 * lines, and the one register everything found on site goes into.
 *
 * The shapes and the rules live in `aec-site.ts` (pure); this file is the part
 * that talks to PostgreSQL. It follows `aec-rfi-service.ts` and
 * `aec-doc-service.ts`'s conventions: every write takes a `WorkspaceOwner`, every
 * read takes a `businessId`, every refusal is an `AecError` code the API guard
 * maps to a status, and migration 0199's triggers are the backstop rather than
 * the first line.
 *
 * ## The four things this file is careful about
 *
 *   * **One register, seven kinds.** §14 lists nine artifacts and one field
 *     list, so an inspection, an NCR, a corrective action, a snag, an HSE
 *     observation and a handover item are one table with a `kind` — and the two
 *     kinds whose switch is their own capability (`snag`, `hse_observation`) are
 *     refused by `assertSiteIssueKindEnabled` rather than merely hidden by a
 *     panel. The *shapes* that genuinely differ are modelled: a checklist
 *     belongs to an inspection or a handover, and a result is required to
 *     resolve one.
 *   * **It never lets the database be the first to say no.** Every rule the
 *     trigger enforces — the four-eyes closeout, the result on an inspection,
 *     the frozen submitted day, the wholesale-replaced checklist — is checked
 *     here first, so a caller gets «این مورد را نمی‌توان پیش از ثبت نتیجه
 *     بست» instead of a constraint name.
 *   * **The numbers are generated under a lock.** A daily log is one per project
 *     per day, and an issue number (`SNG-004`) is unique per project; both are
 *     produced inside the transaction that writes the row, with an advisory lock
 *     on the project so two foremen filing at once cannot both be told `-004`.
 *   * **The files are the platform's files.** Photos and evidence are
 *     `workspace_documents` rows linked by 0199's two columns, through the same
 *     `workspace-document-links.ts` helper the RFI and submittal registers use.
 */
import { disciplineLabel } from "./aec-docs";
import {
  canTransitionSiteIssue,
  canTransitionSiteLog,
  isEditableSiteIssue,
  isEditableSiteLog,
  isSiteCheckResult,
  isSiteChecklistKind,
  isSiteIssueCategory,
  isSiteIssueKind,
  isSiteIssueOverdue,
  isSiteIssueResult,
  isSiteIssueSeverity,
  isSiteLogLineKind,
  isOpenSiteIssue,
  issueNeedsResult,
  issueSupportsChecks,
  siteIssueKindCapability,
  siteIssueNumberPrefix,
  SITE_CHECK_RESULT_LABELS,
  SITE_ISSUE_CATEGORY_LABELS,
  SITE_ISSUE_KIND_LABELS,
  SITE_ISSUE_RESULT_LABELS,
  SITE_ISSUE_SEVERITY_LABELS,
  SITE_ISSUE_STATUS_LABELS,
  SITE_LOG_LINE_LABELS,
  SITE_LOG_LINE_SHAPES,
  SITE_LOG_STATUS_LABELS,
  summariseSiteChecks,
  type SiteCheckSummary,
  type SiteIssueKind,
  type SiteIssueStatus,
  type SiteLogLineKind,
  type SiteLogStatus,
} from "./aec-site";
import { isAecSpecialty } from "./aec";
import { AecError, assertAecIndustry, loadBusinessAecProfile } from "./aec-service";
import { businessToday } from "./business-day-service";
import { query, withTenantTransaction } from "./db";
import { recordActivity, type WorkspaceOwner } from "./workspace";
import {
  loadLinkedDocuments,
  replaceLinkedDocuments,
  type LinkedDocument,
} from "./workspace-document-links";

/* ===========================================================================
 * Coercion
 * ======================================================================== */

function trimTo(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}

function optionalDate(value: unknown, code = "invalid_date"): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AecError(code);
  return value;
}

function requiredDate(value: unknown, code = "invalid_date"): string {
  const date = optionalDate(value, code);
  if (!date) throw new AecError(code);
  return date;
}

function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F-]{36}$/.test(value)) {
    throw new AecError("invalid_reference");
  }
  return value;
}

function optionalNumber(value: unknown, code: string, integer = false): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new AecError(code);
  if (integer && !Number.isInteger(parsed)) throw new AecError(code);
  return parsed;
}

function daysOverdue(dueDate: string | null, today: string): number {
  if (!dueDate) return 0;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.round((now - due) / 86_400_000);
}

/* ===========================================================================
 * Shapes
 * ======================================================================== */

export interface SiteLogLine {
  id: string;
  kind: SiteLogLineKind;
  kindLabel: string;
  title: string;
  partyId: string | null;
  partyName: string | null;
  quantity: number | null;
  unit: string | null;
  headcount: number | null;
  hours: number | null;
  note: string;
  position: number;
}

export interface SiteLogSummary {
  id: string;
  projectId: string;
  logDate: string;
  status: SiteLogStatus;
  statusLabel: string;
  authorUserId: string | null;
  authorName: string;
  workPerformed: string;
  weather: string;
  safetyNote: string;
  notes: string;
  submittedByName: string;
  submittedAt: string | null;
  createdAt: string;
  createdByName: string;
  lineCount: number;
  workforce: number;
  incidentCount: number;
  deliveryCount: number;
  attachmentCount: number;
  isEditable: boolean;
}

export interface SiteLogDetail extends SiteLogSummary {
  lines: SiteLogLine[];
  attachments: LinkedDocument[];
}

export interface SiteChecklistItem {
  id: string;
  title: string;
  guidance: string;
  position: number;
}

export interface SiteChecklistSummary {
  id: string;
  projectId: string | null;
  projectName: string | null;
  name: string;
  kind: string;
  kindLabel: string;
  discipline: string | null;
  disciplineLabel: string;
  description: string;
  isActive: boolean;
  itemCount: number;
  createdAt: string;
  createdByName: string;
}

export interface SiteChecklistDetail extends SiteChecklistSummary {
  items: SiteChecklistItem[];
}

export interface SiteIssueCheck {
  id: string;
  checklistItemId: string | null;
  label: string;
  guidance: string;
  result: string;
  resultLabel: string;
  note: string;
  position: number;
  checkedByName: string;
  checkedAt: string | null;
}

export interface SiteIssueSummary {
  id: string;
  projectId: string;
  issueNumber: string;
  kind: SiteIssueKind;
  kindLabel: string;
  title: string;
  description: string;
  location: string;
  category: string | null;
  categoryLabel: string;
  severity: string;
  severityLabel: string;
  responsiblePartyId: string | null;
  responsiblePartyName: string | null;
  raisedById: string | null;
  raisedByName: string;
  raisedDate: string;
  assignedToId: string | null;
  assignedToName: string;
  dueDate: string | null;
  status: SiteIssueStatus;
  statusLabel: string;
  result: string | null;
  resultLabel: string;
  resolutionNote: string;
  resolvedByName: string;
  resolvedAt: string | null;
  verifiedByName: string;
  verifiedAt: string | null;
  closeoutNote: string;
  parentIssueId: string | null;
  siteLogId: string | null;
  checklistId: string | null;
  checklistName: string | null;
  createdAt: string;
  createdByName: string;
  isOverdue: boolean;
  isEditable: boolean;
  isOpen: boolean;
  checkCount: number;
  pendingCheckCount: number;
  attachmentCount: number;
}

export interface SiteIssueDetail extends SiteIssueSummary {
  checks: SiteIssueCheck[];
  checkSummary: SiteCheckSummary;
  attachments: LinkedDocument[];
}

/** A row the overdue scan and the assistant read: §14's work, plus how late it is. */
export interface OverdueSiteIssueRow {
  id: string;
  projectId: string;
  issueNumber: string;
  kind: string;
  kindLabel: string;
  title: string;
  severity: string;
  severityLabel: string;
  status: string;
  dueDate: string | null;
  daysOverdue: number;
  assigneeName: string;
  responsiblePartyName: string | null;
}

/* ===========================================================================
 * Selects
 * ======================================================================== */

// Dates are cast to text in SQL, the repo's own convention: node-postgres would
// otherwise hand back `Date` objects and every screen would be formatting
// whatever `String(date)` produced.
const LOG_SELECT = `
  l.id, l.project_id, l.log_date::text AS log_date, l.status,
  l.author_user_id, l.author_name, l.work_performed, l.weather, l.safety_note, l.notes,
  l.submitted_by_name, l.submitted_at::text AS submitted_at,
  l.created_at::text AS created_at, l.created_by_name,
  (SELECT count(*)::integer FROM aec_site_log_lines ln WHERE ln.log_id = l.id) AS line_count,
  (SELECT count(*)::integer FROM aec_site_log_lines ln
    WHERE ln.log_id = l.id AND ln.kind = 'attendance') AS crew_count,
  (SELECT COALESCE(sum(ln.headcount), 0)::integer FROM aec_site_log_lines ln
    WHERE ln.log_id = l.id AND ln.kind = 'attendance') AS workforce,
  (SELECT count(*)::integer FROM aec_site_log_lines ln
    WHERE ln.log_id = l.id AND ln.kind = 'incident') AS incident_count,
  (SELECT count(*)::integer FROM aec_site_log_lines ln
    WHERE ln.log_id = l.id AND ln.kind = 'material') AS delivery_count,
  (SELECT count(*)::integer FROM workspace_documents wd
    WHERE wd.site_log_id = l.id AND wd.business_id = l.business_id) AS attachment_count`;

const LOG_JOINS = `FROM aec_site_logs l`;

const ISSUE_SELECT = `
  i.id, i.project_id, i.issue_number, i.kind, i.title, i.description, i.location,
  i.category, i.severity, i.responsible_party_id, party.name AS responsible_party_name,
  i.raised_by, i.raised_by_name, i.raised_date::text AS raised_date,
  i.assigned_to, i.assigned_to_name, i.due_date::text AS due_date,
  i.status, i.result, i.resolution_note, i.resolved_by_name, i.resolved_at::text AS resolved_at,
  i.verified_by, i.verified_by_name, i.verified_at::text AS verified_at, i.closeout_note,
  i.parent_issue_id, i.site_log_id, i.checklist_id, c.name AS checklist_name,
  i.created_at::text AS created_at, i.created_by_name,
  (SELECT count(*)::integer FROM aec_site_issue_checks ck WHERE ck.issue_id = i.id) AS check_count,
  (SELECT count(*)::integer FROM aec_site_issue_checks ck
    WHERE ck.issue_id = i.id AND ck.result = 'pending') AS pending_check_count,
  (SELECT count(*)::integer FROM workspace_documents wd
    WHERE wd.site_issue_id = i.id AND wd.business_id = i.business_id) AS attachment_count`;

const ISSUE_JOINS = `
  FROM aec_site_issues i
  LEFT JOIN parties party ON party.id = i.responsible_party_id
  LEFT JOIN aec_inspection_checklists c ON c.id = i.checklist_id`;

/* ===========================================================================
 * Mappers
 * ======================================================================== */

function toLog(row: Record<string, unknown>): SiteLogSummary {
  const status = String(row.status) as SiteLogStatus;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    logDate: String(row.log_date),
    status,
    statusLabel: SITE_LOG_STATUS_LABELS[status] ?? status,
    authorUserId: (row.author_user_id as string | null) ?? null,
    authorName: String(row.author_name ?? ""),
    workPerformed: String(row.work_performed ?? ""),
    weather: String(row.weather ?? ""),
    safetyNote: String(row.safety_note ?? ""),
    notes: String(row.notes ?? ""),
    submittedByName: String(row.submitted_by_name ?? ""),
    submittedAt: (row.submitted_at as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    createdByName: String(row.created_by_name ?? ""),
    lineCount: Number(row.line_count ?? 0),
    workforce: Number(row.workforce ?? 0),
    incidentCount: Number(row.incident_count ?? 0),
    deliveryCount: Number(row.delivery_count ?? 0),
    attachmentCount: Number(row.attachment_count ?? 0),
    isEditable: isEditableSiteLog(status),
  };
}

function toIssue(row: Record<string, unknown>, today: string): SiteIssueSummary {
  const status = String(row.status) as SiteIssueStatus;
  const kind = String(row.kind) as SiteIssueKind;
  const severity = String(row.severity);
  const category = (row.category as string | null) ?? null;
  const result = (row.result as string | null) ?? null;
  const dueDate = (row.due_date as string | null) ?? null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    issueNumber: String(row.issue_number),
    kind,
    kindLabel: SITE_ISSUE_KIND_LABELS[kind] ?? kind,
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    location: String(row.location ?? ""),
    category,
    categoryLabel: category ? SITE_ISSUE_CATEGORY_LABELS[category as never] ?? category : "",
    severity,
    severityLabel: SITE_ISSUE_SEVERITY_LABELS[severity as never] ?? severity,
    responsiblePartyId: (row.responsible_party_id as string | null) ?? null,
    responsiblePartyName: (row.responsible_party_name as string | null) ?? null,
    raisedById: (row.raised_by as string | null) ?? null,
    raisedByName: String(row.raised_by_name ?? ""),
    raisedDate: String(row.raised_date),
    assignedToId: (row.assigned_to as string | null) ?? null,
    assignedToName: String(row.assigned_to_name ?? ""),
    dueDate,
    status,
    statusLabel: SITE_ISSUE_STATUS_LABELS[status] ?? status,
    result,
    resultLabel: result ? SITE_ISSUE_RESULT_LABELS[result as never] ?? result : "",
    resolutionNote: String(row.resolution_note ?? ""),
    resolvedByName: String(row.resolved_by_name ?? ""),
    resolvedAt: (row.resolved_at as string | null) ?? null,
    verifiedByName: String(row.verified_by_name ?? ""),
    verifiedAt: (row.verified_at as string | null) ?? null,
    closeoutNote: String(row.closeout_note ?? ""),
    parentIssueId: (row.parent_issue_id as string | null) ?? null,
    siteLogId: (row.site_log_id as string | null) ?? null,
    checklistId: (row.checklist_id as string | null) ?? null,
    checklistName: (row.checklist_name as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    createdByName: String(row.created_by_name ?? ""),
    isOverdue: isSiteIssueOverdue({ status, dueDate }, today),
    isEditable: isEditableSiteIssue(status),
    isOpen: isOpenSiteIssue(status),
    checkCount: Number(row.check_count ?? 0),
    pendingCheckCount: Number(row.pending_check_count ?? 0),
    attachmentCount: Number(row.attachment_count ?? 0),
  };
}

function toChecklist(row: Record<string, unknown>): SiteChecklistSummary {
  const discipline = (row.discipline as string | null) ?? null;
  return {
    id: String(row.id),
    projectId: (row.project_id as string | null) ?? null,
    projectName: (row.project_name as string | null) ?? null,
    name: String(row.name ?? ""),
    kind: String(row.kind),
    kindLabel: String(row.kind) === "handover" ? "چک‌لیست تحویل" : "چک‌لیست بازرسی",
    discipline,
    disciplineLabel: discipline ? disciplineLabel(discipline) : "",
    description: String(row.description ?? ""),
    isActive: row.is_active !== false,
    itemCount: Number(row.item_count ?? 0),
    createdAt: String(row.created_at ?? ""),
    createdByName: String(row.created_by_name ?? ""),
  };
}

function toCheck(row: Record<string, unknown>): SiteIssueCheck {
  const result = String(row.result);
  return {
    id: String(row.id),
    checklistItemId: (row.checklist_item_id as string | null) ?? null,
    label: String(row.label ?? ""),
    guidance: String(row.guidance ?? ""),
    result,
    resultLabel: SITE_CHECK_RESULT_LABELS[result as never] ?? result,
    note: String(row.note ?? ""),
    position: Number(row.position ?? 0),
    checkedByName: String(row.checked_by_name ?? ""),
    checkedAt: (row.checked_at as string | null) ?? null,
  };
}

/* ===========================================================================
 * Guards
 * ======================================================================== */

/** §13 needs the industry and the `site_operations` capability. */
async function assertSiteLogEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes("site_operations")) throw new AecError("capability_disabled");
}

/** §14's register needs the industry and `qa_qc`; each kind may need more. */
async function assertQaEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes("qa_qc")) throw new AecError("capability_disabled");
}

/**
 * The kind's own switch, on top of `qa_qc`: a snag needs `snagging` and an HSE
 * observation needs `hse` (§14's "where enabled"). The refusal is a sentence,
 * not a hidden button — a switch that only greys out a control is a switch the
 * API does not really have.
 */
async function assertSiteIssueKindEnabled(businessId: string, kind: string): Promise<void> {
  if (!isSiteIssueKind(kind)) throw new AecError("invalid_site_issue_kind");
  await assertQaEnabled(businessId);
  const needed = siteIssueKindCapability(kind);
  if (needed === "qa_qc") return;
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes(needed)) throw new AecError("capability_disabled");
}

async function assertProjectOwned(businessId: string, projectId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [businessId, projectId],
  );
  if (!rows[0]) throw new AecError("project_not_found");
}

async function assertUserOwned(businessId: string, userId: string | null): Promise<void> {
  if (!userId) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE business_id = $1 AND id = $2`,
    [businessId, userId],
  );
  if (!rows[0]) throw new AecError("user_not_found");
}

/**
 * A party named on the register must be this business's, live, and unmerged —
 * the same predicate `aec-rfi-service.ts` uses, and the same one
 * `party-merge-references.ts` leaves behind after a merge.
 */
async function assertPartyOwned(businessId: string, partyId: string | null): Promise<void> {
  if (!partyId) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM parties
      WHERE business_id = $1 AND id = $2 AND is_active AND merged_into_id IS NULL`,
    [businessId, partyId],
  );
  if (!rows[0]) throw new AecError("party_not_found");
}

export async function siteLogProjectId(businessId: string, logId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_site_logs WHERE business_id = $1 AND id = $2`,
    [businessId, logId],
  );
  if (!rows[0]) throw new AecError("site_log_not_found");
  return rows[0].project_id;
}

export async function siteIssueProjectId(businessId: string, issueId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_site_issues WHERE business_id = $1 AND id = $2`,
    [businessId, issueId],
  );
  if (!rows[0]) throw new AecError("site_issue_not_found");
  return rows[0].project_id;
}

export async function checklistProjectId(businessId: string, checklistId: string): Promise<string | null> {
  const { rows } = await query<{ project_id: string | null }>(
    `SELECT project_id FROM aec_inspection_checklists WHERE business_id = $1 AND id = $2`,
    [businessId, checklistId],
  );
  if (!rows[0]) throw new AecError("checklist_not_found");
  return rows[0].project_id;
}

async function recordSiteActivity(
  owner: WorkspaceOwner,
  entry: {
    projectId: string;
    subjectType: "site_log" | "site_issue";
    subjectId: string;
    action: string;
    summary: string;
  },
): Promise<void> {
  await recordActivity(owner, entry);
}

/* ===========================================================================
 * The daily log (§13)
 * ======================================================================== */

export interface SiteLogListFilters {
  from?: string;
  to?: string;
  status?: string;
  search?: string;
  limit?: number;
}

export async function listProjectSiteLogs(
  businessId: string,
  projectId: string,
  filters: SiteLogListFilters = {},
): Promise<SiteLogSummary[]> {
  await assertSiteLogEnabled(businessId);
  const where: string[] = ["l.business_id = $1", "l.project_id = $2"];
  const params: unknown[] = [businessId, projectId];
  if (filters.from) {
    params.push(filters.from);
    where.push(`l.log_date >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`l.log_date <= $${params.length}::date`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`l.status = $${params.length}`);
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    where.push(
      `(l.work_performed ILIKE $${params.length} OR l.weather ILIKE $${params.length}
        OR l.safety_note ILIKE $${params.length} OR l.notes ILIKE $${params.length}
        OR l.author_name ILIKE $${params.length})`,
    );
  }
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${LOG_SELECT} ${LOG_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY l.log_date DESC, l.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toLog);
}

export async function loadSiteLog(businessId: string, logId: string): Promise<SiteLogDetail> {
  await assertSiteLogEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${LOG_SELECT} ${LOG_JOINS} WHERE l.business_id = $1 AND l.id = $2`,
    [businessId, logId],
  );
  if (!rows[0]) throw new AecError("site_log_not_found");
  const summary = toLog(rows[0]);

  const { rows: lineRows } = await query<Record<string, unknown>>(
    `SELECT ln.id, ln.kind, ln.title, ln.party_id, party.name AS party_name,
            ln.quantity::float8 AS quantity, ln.unit, ln.headcount, ln.hours::float8 AS hours,
            ln.note, ln.position
       FROM aec_site_log_lines ln
       LEFT JOIN parties party ON party.id = ln.party_id
      WHERE ln.business_id = $1 AND ln.log_id = $2
      ORDER BY ln.position, ln.created_at`,
    [businessId, logId],
  );
  const lines: SiteLogLine[] = lineRows.map((row) => {
    const kind = String(row.kind) as SiteLogLineKind;
    return {
      id: String(row.id),
      kind,
      kindLabel: SITE_LOG_LINE_LABELS[kind] ?? kind,
      title: String(row.title ?? ""),
      partyId: (row.party_id as string | null) ?? null,
      partyName: (row.party_name as string | null) ?? null,
      quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
      unit: (row.unit as string | null) ?? null,
      headcount: row.headcount === null || row.headcount === undefined ? null : Number(row.headcount),
      hours: row.hours === null || row.hours === undefined ? null : Number(row.hours),
      note: String(row.note ?? ""),
      position: Number(row.position ?? 0),
    };
  });

  return {
    ...summary,
    lines,
    attachments: await loadLinkedDocuments(businessId, "site_log_id", logId),
  };
}

export interface SiteLogInput {
  logDate?: unknown;
  authorUserId?: unknown;
  authorName?: unknown;
  workPerformed?: unknown;
  weather?: unknown;
  safetyNote?: unknown;
  notes?: unknown;
  lines?: unknown;
  attachments?: unknown;
}

/** One line, validated against the shape its kind must have. */
function coerceLogLine(raw: unknown, index: number): Record<string, unknown> {
  const item = (raw ?? {}) as Record<string, unknown>;
  const kind = trimTo(item.kind, 40);
  if (!isSiteLogLineKind(kind)) throw new AecError("invalid_site_log_line");
  const title = trimTo(item.title, 300);
  if (!title) throw new AecError("invalid_site_log_line");
  const shape = SITE_LOG_LINE_SHAPES[kind];

  const quantity = optionalNumber(item.quantity, "invalid_site_log_line");
  const headcount = optionalNumber(item.headcount, "invalid_site_log_line", true);
  const hours = optionalNumber(item.hours, "invalid_site_log_line");
  const unit = trimTo(item.unit, 40);

  // The same shape migration 0199's CHECK states, refused here with a Persian
  // code rather than a constraint name: a delivery without a quantity is not a
  // delivery, and a crew without a headcount is not attendance.
  if (shape.headcount && (headcount === null || headcount <= 0)) {
    throw new AecError("invalid_site_log_line");
  }
  if (!shape.headcount && headcount !== null) throw new AecError("invalid_site_log_line");
  if (shape.quantity && quantity === null) throw new AecError("invalid_site_log_line");
  if (!shape.quantity && quantity !== null) throw new AecError("invalid_site_log_line");
  if (shape.unit && !unit) throw new AecError("invalid_site_log_line");
  if (!shape.unit && unit) throw new AecError("invalid_site_log_line");

  return {
    kind,
    title,
    partyId: optionalUuid(item.partyId),
    quantity: shape.quantity ? quantity : null,
    unit: shape.unit ? unit : null,
    headcount: shape.headcount ? headcount : null,
    hours: shape.hours ? hours : null,
    note: trimTo(item.note, 2000),
    position: index,
  };
}

/** Replace a draft log's lines with the ones the screen sent. */
async function replaceLogLines(owner: WorkspaceOwner, logId: string, input: unknown): Promise<void> {
  if (input === undefined) return;
  const incoming = Array.isArray(input) ? input : [];
  await query(`DELETE FROM aec_site_log_lines WHERE business_id = $1 AND log_id = $2`, [
    owner.businessId,
    logId,
  ]);
  for (const [index, raw] of incoming.slice(0, 200).entries()) {
    const line = coerceLogLine(raw, index);
    await assertPartyOwned(owner.businessId, line.partyId as string | null);
    await query(
      `INSERT INTO aec_site_log_lines
         (business_id, log_id, kind, title, party_id, quantity, unit, headcount, hours, note, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        owner.businessId,
        logId,
        line.kind,
        line.title,
        line.partyId,
        line.quantity,
        line.unit,
        line.headcount,
        line.hours,
        line.note,
        line.position,
      ],
    );
  }
}

export async function createSiteLog(
  owner: WorkspaceOwner,
  projectId: string,
  input: SiteLogInput,
): Promise<SiteLogDetail> {
  await assertSiteLogEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);

  const today = await businessToday(owner.businessId);
  const logDate = optionalDate(input.logDate) ?? today;
  const authorUserId = optionalUuid(input.authorUserId) ?? owner.actorUserId;
  await assertUserOwned(owner.businessId, authorUserId);

  const { rows: duplicate } = await query<{ id: string }>(
    `SELECT id FROM aec_site_logs WHERE project_id = $1 AND log_date = $2::date`,
    [projectId, logDate],
  );
  if (duplicate[0]) throw new AecError("site_log_exists");

  const logId = await withTenantTransaction(owner.businessId, async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_site_logs
         (business_id, project_id, log_date, author_user_id, author_name, work_performed,
          weather, safety_note, notes, created_by, created_by_name)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        logDate,
        authorUserId,
        trimTo(input.authorName, 200) || owner.actorName || "",
        trimTo(input.workPerformed, 8000),
        trimTo(input.weather, 500),
        trimTo(input.safetyNote, 2000),
        trimTo(input.notes, 4000),
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const id = rows[0].id;
    await replaceLogLines(owner, id, input.lines);
    if (input.attachments !== undefined) {
      await replaceLinkedDocuments(owner, { column: "site_log_id", targetId: id }, projectId, input.attachments);
    }
    return id;
  });

  await recordSiteActivity(owner, {
    projectId,
    subjectType: "site_log",
    subjectId: logId,
    action: "created",
    summary: `گزارش روزانهٔ ${logDate} ثبت شد`,
  });
  return loadSiteLog(owner.businessId, logId);
}

export async function updateSiteLog(
  owner: WorkspaceOwner,
  logId: string,
  input: SiteLogInput,
): Promise<SiteLogDetail> {
  await assertSiteLogEnabled(owner.businessId);
  const current = await loadSiteLog(owner.businessId, logId);
  if (!isEditableSiteLog(current.status)) throw new AecError("site_log_not_editable");

  const authorUserId =
    input.authorUserId === undefined ? current.authorUserId : optionalUuid(input.authorUserId);
  await assertUserOwned(owner.businessId, authorUserId);
  const logDate = input.logDate === undefined ? current.logDate : requiredDate(input.logDate);
  if (logDate !== current.logDate) {
    const { rows: duplicate } = await query<{ id: string }>(
      `SELECT id FROM aec_site_logs WHERE project_id = $1 AND log_date = $2::date AND id <> $3`,
      [current.projectId, logDate, logId],
    );
    if (duplicate[0]) throw new AecError("site_log_exists");
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_site_logs
          SET log_date = $3::date,
              author_user_id = $4,
              author_name = COALESCE(NULLIF($5, ''), author_name),
              work_performed = $6, weather = $7, safety_note = $8, notes = $9,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        logId,
        logDate,
        authorUserId,
        trimTo(input.authorName, 200),
        input.workPerformed === undefined ? current.workPerformed : trimTo(input.workPerformed, 8000),
        input.weather === undefined ? current.weather : trimTo(input.weather, 500),
        input.safetyNote === undefined ? current.safetyNote : trimTo(input.safetyNote, 2000),
        input.notes === undefined ? current.notes : trimTo(input.notes, 4000),
      ],
    );
    await replaceLogLines(owner, logId, input.lines);
    if (input.attachments !== undefined) {
      await replaceLinkedDocuments(
        owner,
        { column: "site_log_id", targetId: logId },
        current.projectId,
        input.attachments,
      );
    }
  });

  await recordSiteActivity(owner, {
    projectId: current.projectId,
    subjectType: "site_log",
    subjectId: logId,
    action: "updated",
    summary: `گزارش روزانهٔ ${logDate} ویرایش شد`,
  });
  return loadSiteLog(owner.businessId, logId);
}

export async function deleteSiteLog(owner: WorkspaceOwner, logId: string): Promise<void> {
  await assertSiteLogEnabled(owner.businessId);
  const current = await loadSiteLog(owner.businessId, logId);
  if (current.status !== "draft") throw new AecError("site_log_not_editable");
  // An issue raised from the day outlives the day: the link is detached rather
  // than the issue taken with it, so deleting a mistaken log cannot delete what
  // somebody found on that day.
  await query(
    `UPDATE aec_site_issues SET site_log_id = NULL, updated_at = now()
      WHERE business_id = $1 AND site_log_id = $2`,
    [owner.businessId, logId],
  );
  await query(`DELETE FROM aec_site_logs WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    logId,
  ]);
  await recordSiteActivity(owner, {
    projectId: current.projectId,
    subjectType: "site_log",
    subjectId: logId,
    action: "deleted",
    summary: `گزارش روزانهٔ ${current.logDate} حذف شد`,
  });
}

/**
 * §13's one move that matters: the author signs the day (`submit`) or takes it
 * back to fix something (`reopen`). Migration 0199's guard freezes a submitted
 * day and its lines, and permits exactly these two transitions.
 */
export async function applySiteLogAction(
  owner: WorkspaceOwner,
  logId: string,
  action: "submit" | "reopen",
): Promise<SiteLogDetail> {
  await assertSiteLogEnabled(owner.businessId);
  const current = await loadSiteLog(owner.businessId, logId);
  const next: SiteLogStatus = action === "submit" ? "submitted" : "draft";
  if (!canTransitionSiteLog(current.status, next)) throw new AecError("invalid_site_log_transition");
  if (action === "submit" && !current.workPerformed.trim()) {
    // A day with nothing written in it is not a report; signing it would file a
    // blank page in the project's record.
    throw new AecError("site_log_work_required");
  }

  await query(
    `UPDATE aec_site_logs
        SET status = $3,
            submitted_by = CASE WHEN $3 = 'submitted' THEN $4::uuid ELSE NULL END,
            submitted_by_name = CASE WHEN $3 = 'submitted' THEN $5 ELSE '' END,
            submitted_at = CASE WHEN $3 = 'submitted' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, logId, next, owner.actorUserId, owner.actorName ?? ""],
  );
  await recordSiteActivity(owner, {
    projectId: current.projectId,
    subjectType: "site_log",
    subjectId: logId,
    action: action === "submit" ? "submitted" : "reopened",
    summary:
      action === "submit"
        ? `گزارش روزانهٔ ${current.logDate} ثبت نهایی شد`
        : `گزارش روزانهٔ ${current.logDate} برای ویرایش باز شد`,
  });
  return loadSiteLog(owner.businessId, logId);
}

/* ===========================================================================
 * The issue register (§14)
 * ======================================================================== */

export interface SiteIssueListFilters {
  kind?: string;
  status?: string;
  severity?: string;
  category?: string;
  search?: string;
  openOnly?: boolean;
  overdueOnly?: boolean;
  limit?: number;
}

export async function listProjectSiteIssues(
  businessId: string,
  projectId: string,
  filters: SiteIssueListFilters = {},
): Promise<SiteIssueSummary[]> {
  await assertQaEnabled(businessId);
  const today = await businessToday(businessId);
  const where: string[] = ["i.business_id = $1", "i.project_id = $2"];
  const params: unknown[] = [businessId, projectId];
  if (filters.kind) {
    params.push(filters.kind);
    where.push(`i.kind = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`i.status = $${params.length}`);
  }
  if (filters.severity) {
    params.push(filters.severity);
    where.push(`i.severity = $${params.length}`);
  }
  if (filters.category) {
    params.push(filters.category);
    where.push(`i.category = $${params.length}`);
  }
  if (filters.openOnly) where.push(`i.status IN ('open', 'in_progress', 'resolved')`);
  if (filters.overdueOnly) {
    params.push(today);
    where.push(
      `i.due_date IS NOT NULL AND i.due_date < $${params.length}::date
        AND i.status IN ('open', 'in_progress', 'resolved')`,
    );
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    where.push(
      `(i.issue_number ILIKE $${params.length} OR i.title ILIKE $${params.length}
        OR i.description ILIKE $${params.length} OR i.location ILIKE $${params.length})`,
    );
  }
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${ISSUE_SELECT} ${ISSUE_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY
        CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        i.due_date NULLS LAST, i.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => toIssue(row, today));
}

export async function loadSiteIssue(businessId: string, issueId: string): Promise<SiteIssueDetail> {
  await assertQaEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${ISSUE_SELECT} ${ISSUE_JOINS} WHERE i.business_id = $1 AND i.id = $2`,
    [businessId, issueId],
  );
  if (!rows[0]) throw new AecError("site_issue_not_found");
  const summary = toIssue(rows[0], today);

  const { rows: checkRows } = await query<Record<string, unknown>>(
    `SELECT ck.id, ck.checklist_item_id, ck.label, ck.guidance, ck.result, ck.note,
            ck.position, ck.checked_by_name, ck.checked_at::text AS checked_at
       FROM aec_site_issue_checks ck
      WHERE ck.business_id = $1 AND ck.issue_id = $2
      ORDER BY ck.position, ck.created_at`,
    [businessId, issueId],
  );
  const checks = checkRows.map(toCheck);

  return {
    ...summary,
    checks,
    checkSummary: summariseSiteChecks(checks),
    attachments: await loadLinkedDocuments(businessId, "site_issue_id", issueId),
  };
}

export interface SiteIssueInput {
  issueNumber?: unknown;
  kind?: unknown;
  title?: unknown;
  description?: unknown;
  location?: unknown;
  category?: unknown;
  severity?: unknown;
  responsiblePartyId?: unknown;
  raisedDate?: unknown;
  assignedToId?: unknown;
  assignedToName?: unknown;
  dueDate?: unknown;
  siteLogId?: unknown;
  parentIssueId?: unknown;
  checklistId?: unknown;
  checks?: unknown;
  attachments?: unknown;
}

/**
 * The next number for a project, under an advisory lock.
 *
 * `SNG-004` is unique per project, and two foremen filing a snag at the same
 * moment must not both be handed `-004` — so the read and the insert happen
 * inside one transaction that first takes a project-scoped advisory lock, which
 * is the pattern `branch-service.ts` and `loyalty-service.ts` already use for
 * the same reason.
 */
async function nextIssueNumber(projectId: string, kind: SiteIssueKind): Promise<string> {
  const prefix = siteIssueNumberPrefix(kind);
  await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 7997))`, [`site-issue:${projectId}`]);
  const { rows } = await query<{ max: number | null }>(
    `SELECT MAX(NULLIF(regexp_replace(issue_number, '^.*-', ''), '')::integer) AS max
       FROM aec_site_issues
      WHERE project_id = $1 AND issue_number LIKE $2`,
    [projectId, `${prefix}-%`],
  );
  const next = (rows[0]?.max ?? 0) + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

/**
 * The checklist's items, copied onto the issue.
 *
 * Snapshot rather than reference: the label and the acceptance criterion are
 * what the inspector actually measured against, so editing the firm's standard
 * checklist tomorrow cannot rewrite yesterday's record (§33).
 */
async function applyChecklistSnapshot(
  owner: WorkspaceOwner,
  issueId: string,
  checklistId: string,
  projectId: string,
): Promise<void> {
  const { rows: checklist } = await query<{ kind: string; project_id: string | null }>(
    `SELECT kind, project_id FROM aec_inspection_checklists
      WHERE business_id = $1 AND id = $2 AND is_active`,
    [owner.businessId, checklistId],
  );
  if (!checklist[0]) throw new AecError("checklist_not_found");
  if (checklist[0].project_id !== null && checklist[0].project_id !== projectId) {
    throw new AecError("checklist_not_found");
  }
  const { rows: items } = await query<Record<string, unknown>>(
    `SELECT id, title, guidance, position
       FROM aec_inspection_checklist_items
      WHERE business_id = $1 AND checklist_id = $2
      ORDER BY position, created_at`,
    [owner.businessId, checklistId],
  );
  await query(`DELETE FROM aec_site_issue_checks WHERE business_id = $1 AND issue_id = $2`, [
    owner.businessId,
    issueId,
  ]);
  for (const item of items.slice(0, 200)) {
    await query(
      `INSERT INTO aec_site_issue_checks
         (business_id, issue_id, checklist_item_id, label, guidance, result, position)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [
        owner.businessId,
        issueId,
        item.id,
        String(item.title),
        String(item.guidance ?? ""),
        Number(item.position ?? 0),
      ],
    );
  }
}

/** Replace an issue's checklist with the rows the screen sent (draft work). */
async function replaceIssueChecks(
  owner: WorkspaceOwner,
  issueId: string,
  input: unknown,
): Promise<void> {
  const incoming = Array.isArray(input) ? input : [];
  await query(`DELETE FROM aec_site_issue_checks WHERE business_id = $1 AND issue_id = $2`, [
    owner.businessId,
    issueId,
  ]);
  for (const [index, raw] of incoming.slice(0, 200).entries()) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const label = trimTo(item.label, 300);
    if (!label) throw new AecError("invalid_site_check");
    const result = trimTo(item.result, 20) || "pending";
    if (!isSiteCheckResult(result)) throw new AecError("invalid_site_check");
    const checklistItemId = optionalUuid(item.checklistItemId);
    if (checklistItemId) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM aec_inspection_checklist_items
          WHERE business_id = $1 AND id = $2`,
        [owner.businessId, checklistItemId],
      );
      if (!rows[0]) throw new AecError("checklist_not_found");
    }
    await query(
      `INSERT INTO aec_site_issue_checks
         (business_id, issue_id, checklist_item_id, label, guidance, result, note, position,
          checked_by, checked_by_name, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               CASE WHEN $6 = 'pending' THEN NULL ELSE now() END)`,
      [
        owner.businessId,
        issueId,
        checklistItemId,
        label,
        trimTo(item.guidance, 1000),
        result,
        trimTo(item.note, 1000),
        Number.isInteger(Number(item.position)) ? Number(item.position) : index,
        result === "pending" ? null : owner.actorUserId,
        result === "pending" ? "" : owner.actorName ?? "",
      ],
    );
  }
}

async function assertChecklistUsable(
  owner: WorkspaceOwner,
  projectId: string,
  checklistId: string,
): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM aec_inspection_checklists
      WHERE business_id = $1 AND id = $2 AND is_active
        AND (project_id IS NULL OR project_id = $3)`,
    [owner.businessId, checklistId, projectId],
  );
  if (!rows[0]) throw new AecError("checklist_not_found");
}

export async function createSiteIssue(
  owner: WorkspaceOwner,
  projectId: string,
  input: SiteIssueInput,
): Promise<SiteIssueDetail> {
  const kind = trimTo(input.kind, 40) || "snag";
  if (!isSiteIssueKind(kind)) throw new AecError("invalid_site_issue_kind");
  await assertSiteIssueKindEnabled(owner.businessId, kind);
  await assertProjectOwned(owner.businessId, projectId);

  const title = trimTo(input.title, 300);
  if (!title) throw new AecError("site_issue_title_required");
  const category = trimTo(input.category, 40);
  if (category && !isSiteIssueCategory(category)) throw new AecError("invalid_category");
  const severity = trimTo(input.severity, 20) || "medium";
  if (!isSiteIssueSeverity(severity)) throw new AecError("invalid_severity");

  const responsiblePartyId = optionalUuid(input.responsiblePartyId);
  const assignedToId = optionalUuid(input.assignedToId);
  const siteLogId = optionalUuid(input.siteLogId);
  const parentIssueId = optionalUuid(input.parentIssueId);
  const checklistId = optionalUuid(input.checklistId);
  await assertPartyOwned(owner.businessId, responsiblePartyId);
  await assertUserOwned(owner.businessId, assignedToId);

  if (siteLogId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM aec_site_logs
        WHERE business_id = $1 AND id = $2 AND project_id = $3`,
      [owner.businessId, siteLogId, projectId],
    );
    if (!rows[0]) throw new AecError("site_log_not_found");
  }
  if (parentIssueId) {
    const { rows } = await query<{ project_id: string }>(
      `SELECT project_id FROM aec_site_issues
        WHERE business_id = $1 AND id = $2`,
      [owner.businessId, parentIssueId],
    );
    if (!rows[0] || rows[0].project_id !== projectId) throw new AecError("site_issue_not_found");
  }
  if (checklistId) {
    await assertChecklistUsable(owner, projectId, checklistId);
    if (!issueSupportsChecks(kind)) throw new AecError("checklist_not_for_kind");
  }

  const today = await businessToday(owner.businessId);
  const issueId = await withTenantTransaction(owner.businessId, async () => {
    const explicit = trimTo(input.issueNumber, 60);
    const issueNumber = explicit || (await nextIssueNumber(projectId, kind));
    const { rows: duplicate } = await query<{ id: string }>(
      `SELECT id FROM aec_site_issues WHERE project_id = $1 AND issue_number = $2`,
      [projectId, issueNumber],
    );
    if (duplicate[0]) throw new AecError("site_issue_number_taken");

    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_site_issues
         (business_id, project_id, site_log_id, checklist_id, issue_number, kind, title,
          description, location, category, severity, responsible_party_id,
          raised_by, raised_by_name, raised_date, assigned_to, assigned_to_name, due_date,
          parent_issue_id, status, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15::date, $16, $17, $18::date, $19, 'open', $13, $14)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        siteLogId,
        checklistId,
        issueNumber,
        kind,
        title,
        trimTo(input.description, 8000),
        trimTo(input.location, 300),
        category || null,
        severity,
        responsiblePartyId,
        owner.actorUserId,
        owner.actorName ?? "",
        optionalDate(input.raisedDate) ?? today,
        assignedToId,
        trimTo(input.assignedToName, 200),
        optionalDate(input.dueDate),
        parentIssueId,
      ],
    );
    const id = rows[0].id;
    if (checklistId) await applyChecklistSnapshot(owner, id, checklistId, projectId);
    if (input.checks !== undefined) await replaceIssueChecks(owner, id, input.checks);
    if (input.attachments !== undefined) {
      await replaceLinkedDocuments(owner, { column: "site_issue_id", targetId: id }, projectId, input.attachments);
    }
    return id;
  });

  await recordSiteActivity(owner, {
    projectId,
    subjectType: "site_issue",
    subjectId: issueId,
    action: "created",
    summary: `${SITE_ISSUE_KIND_LABELS[kind]} ثبت شد — ${title}`,
  });
  return loadSiteIssue(owner.businessId, issueId);
}

export async function updateSiteIssue(
  owner: WorkspaceOwner,
  issueId: string,
  input: SiteIssueInput & { status?: unknown },
): Promise<SiteIssueDetail> {
  const current = await loadSiteIssue(owner.businessId, issueId);
  await assertSiteIssueKindEnabled(owner.businessId, current.kind);
  if (!isEditableSiteIssue(current.status)) throw new AecError("site_issue_not_editable");
  // A state change is an *act* on the issue, and the acts live in one place:
  // `/status` is where a resolution records who did it and a closeout records
  // who verified it. A PATCH that quietly moved the status would be a second
  // way to close things, with no verifier.
  if (input.status !== undefined && String(input.status) !== current.status) {
    throw new AecError("invalid_site_issue_transition");
  }
  if (input.kind !== undefined && String(input.kind) !== current.kind) {
    throw new AecError("invalid_site_issue_kind");
  }

  const category = input.category === undefined ? current.category : trimTo(input.category, 40) || null;
  if (category && !isSiteIssueCategory(category)) throw new AecError("invalid_category");
  const severity = input.severity === undefined ? current.severity : trimTo(input.severity, 20);
  if (!isSiteIssueSeverity(severity)) throw new AecError("invalid_severity");
  const responsiblePartyId =
    input.responsiblePartyId === undefined
      ? current.responsiblePartyId
      : optionalUuid(input.responsiblePartyId);
  const assignedToId =
    input.assignedToId === undefined ? current.assignedToId : optionalUuid(input.assignedToId);
  await assertPartyOwned(owner.businessId, responsiblePartyId);
  await assertUserOwned(owner.businessId, assignedToId);

  const checklistId =
    input.checklistId === undefined ? current.checklistId : optionalUuid(input.checklistId);
  if (checklistId && checklistId !== current.checklistId) {
    await assertChecklistUsable(owner, current.projectId, checklistId);
    if (!issueSupportsChecks(current.kind)) throw new AecError("checklist_not_for_kind");
  }
  const siteLogId = input.siteLogId === undefined ? current.siteLogId : optionalUuid(input.siteLogId);
  if (siteLogId && siteLogId !== current.siteLogId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM aec_site_logs WHERE business_id = $1 AND id = $2 AND project_id = $3`,
      [owner.businessId, siteLogId, current.projectId],
    );
    if (!rows[0]) throw new AecError("site_log_not_found");
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_site_issues
          SET title = $3, description = $4, location = $5, category = $6, severity = $7,
              responsible_party_id = $8, assigned_to = $9,
              assigned_to_name = CASE WHEN $10 = '' THEN assigned_to_name ELSE $10 END,
              due_date = $11::date, site_log_id = $12, checklist_id = $13, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        issueId,
        input.title === undefined ? current.title : trimTo(input.title, 300) || current.title,
        input.description === undefined ? current.description : trimTo(input.description, 8000),
        input.location === undefined ? current.location : trimTo(input.location, 300),
        category,
        severity,
        responsiblePartyId,
        assignedToId,
        trimTo(input.assignedToName, 200),
        input.dueDate === undefined ? current.dueDate : optionalDate(input.dueDate),
        siteLogId,
        checklistId,
      ],
    );
    if (input.checklistId !== undefined && checklistId && checklistId !== current.checklistId) {
      await applyChecklistSnapshot(owner, issueId, checklistId, current.projectId);
    }
    if (input.checks !== undefined) await replaceIssueChecks(owner, issueId, input.checks);
    if (input.attachments !== undefined) {
      await replaceLinkedDocuments(
        owner,
        { column: "site_issue_id", targetId: issueId },
        current.projectId,
        input.attachments,
      );
    }
  });

  await recordSiteActivity(owner, {
    projectId: current.projectId,
    subjectType: "site_issue",
    subjectId: issueId,
    action: "updated",
    summary: `${current.issueNumber} ویرایش شد`,
  });
  return loadSiteIssue(owner.businessId, issueId);
}

export async function deleteSiteIssue(owner: WorkspaceOwner, issueId: string): Promise<void> {
  const current = await loadSiteIssue(owner.businessId, issueId);
  await assertSiteIssueKindEnabled(owner.businessId, current.kind);
  // Only a just-raised issue can go: once somebody has started work on it, it is
  // part of what happened on the project.
  if (current.status !== "open") throw new AecError("site_issue_not_editable");
  await query(`DELETE FROM aec_site_issues WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    issueId,
  ]);
  await recordSiteActivity(owner, {
    projectId: current.projectId,
    subjectType: "site_issue",
    subjectId: issueId,
    action: "deleted",
    summary: `${current.issueNumber} حذف شد`,
  });
}

/**
 * §14's four moves, one function.
 *
 * `close` is the closeout verification: it records who accepted the fix, and it
 * is refused when that is the person the issue was assigned to — the four-eyes
 * rule that makes the verification mean something. `resolve` records what was
 * done and, for an inspection or a handover, the result.
 */
export async function applySiteIssueAction(
  owner: WorkspaceOwner,
  issueId: string,
  action: "start" | "resolve" | "close" | "cancel",
  input: { resolutionNote?: unknown; result?: unknown; closeoutNote?: unknown } = {},
): Promise<SiteIssueDetail> {
  const current = await loadSiteIssue(owner.businessId, issueId);
  await assertSiteIssueKindEnabled(owner.businessId, current.kind);

  const next: SiteIssueStatus =
    action === "start"
      ? "in_progress"
      : action === "resolve"
        ? "resolved"
        : action === "close"
          ? "closed"
          : "cancelled";
  if (!canTransitionSiteIssue(current.status, next)) {
    throw new AecError("invalid_site_issue_transition");
  }

  const resolutionNote =
    input.resolutionNote === undefined ? current.resolutionNote : trimTo(input.resolutionNote, 8000);
  const result =
    input.result === undefined ? current.result : trimTo(input.result, 30) || null;
  if (result && !isSiteIssueResult(result)) throw new AecError("invalid_site_issue_result");
  if (result && !issueNeedsResult(current.kind)) throw new AecError("invalid_site_issue_result");

  if (next === "resolved") {
    if (!resolutionNote.trim()) throw new AecError("site_issue_resolution_required");
    if (issueNeedsResult(current.kind) && !result) throw new AecError("site_issue_result_required");
  }
  if (next === "closed") {
    // The verifier is the caller: the act of closing *is* the verification, and
    // recording it under somebody else's name would be a lie the audit trail
    // could not detect.
    if (current.assignedToId && current.assignedToId === owner.actorUserId) {
      throw new AecError("site_issue_verifier_is_assignee");
    }
  }

  await query(
    `UPDATE aec_site_issues
        SET status = $3,
            result = $4,
            resolution_note = CASE WHEN $3 IN ('resolved', 'closed') THEN $5 ELSE resolution_note END,
            resolved_by = CASE WHEN $3 = 'resolved' THEN $6::uuid ELSE resolved_by END,
            resolved_by_name = CASE WHEN $3 = 'resolved' THEN $7 ELSE resolved_by_name END,
            resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE resolved_at END,
            verified_by = CASE WHEN $3 = 'closed' THEN $6::uuid ELSE verified_by END,
            verified_by_name = CASE WHEN $3 = 'closed' THEN $7 ELSE verified_by_name END,
            verified_at = CASE WHEN $3 = 'closed' THEN now() ELSE verified_at END,
            closeout_note = CASE WHEN $3 = 'closed' THEN $8 ELSE closeout_note END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      owner.businessId,
      issueId,
      next,
      result,
      resolutionNote,
      owner.actorUserId,
      owner.actorName ?? "",
      trimTo(input.closeoutNote, 4000),
    ],
  );

  await recordSiteActivity(owner, {
    projectId: current.projectId,
    subjectType: "site_issue",
    subjectId: issueId,
    action:
      action === "start"
        ? "started"
        : action === "resolve"
          ? "resolved"
          : action === "close"
            ? "closed"
            : "cancelled",
    summary:
      action === "close"
        ? `${current.issueNumber} با تأیید بسته شد`
        : action === "resolve"
          ? `${current.issueNumber} اصلاح و ثبت شد`
          : action === "start"
            ? `${current.issueNumber} در دست اقدام شد`
            : `${current.issueNumber} لغو شد`,
  });
  return loadSiteIssue(owner.businessId, issueId);
}

/* ===========================================================================
 * Checklists (§14)
 * ======================================================================== */

export async function listChecklists(
  businessId: string,
  filters: { projectId?: string; kind?: string; includeInactive?: boolean } = {},
): Promise<SiteChecklistSummary[]> {
  await assertQaEnabled(businessId);
  const where: string[] = ["c.business_id = $1"];
  const params: unknown[] = [businessId];
  if (filters.projectId) {
    params.push(filters.projectId);
    where.push(`(c.project_id IS NULL OR c.project_id = $${params.length})`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    where.push(`c.kind = $${params.length}`);
  }
  if (!filters.includeInactive) where.push("c.is_active");
  const { rows } = await query<Record<string, unknown>>(
    `SELECT c.id, c.project_id, p.name AS project_name, c.name, c.kind, c.discipline,
            c.description, c.is_active, c.created_at::text AS created_at, c.created_by_name,
            (SELECT count(*)::integer FROM aec_inspection_checklist_items i
              WHERE i.checklist_id = c.id) AS item_count
       FROM aec_inspection_checklists c
       LEFT JOIN ai_projects p ON p.id = c.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.kind, c.name`,
    params,
  );
  return rows.map(toChecklist);
}

export async function loadChecklist(businessId: string, checklistId: string): Promise<SiteChecklistDetail> {
  await assertQaEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT c.id, c.project_id, p.name AS project_name, c.name, c.kind, c.discipline,
            c.description, c.is_active, c.created_at::text AS created_at, c.created_by_name,
            (SELECT count(*)::integer FROM aec_inspection_checklist_items i
              WHERE i.checklist_id = c.id) AS item_count
       FROM aec_inspection_checklists c
       LEFT JOIN ai_projects p ON p.id = c.project_id
      WHERE c.business_id = $1 AND c.id = $2`,
    [businessId, checklistId],
  );
  if (!rows[0]) throw new AecError("checklist_not_found");
  const { rows: items } = await query<Record<string, unknown>>(
    `SELECT id, title, guidance, position
       FROM aec_inspection_checklist_items
      WHERE business_id = $1 AND checklist_id = $2
      ORDER BY position, created_at`,
    [businessId, checklistId],
  );
  return {
    ...toChecklist(rows[0]),
    items: items.map((item) => ({
      id: String(item.id),
      title: String(item.title ?? ""),
      guidance: String(item.guidance ?? ""),
      position: Number(item.position ?? 0),
    })),
  };
}

export interface ChecklistInput {
  name?: unknown;
  kind?: unknown;
  discipline?: unknown;
  description?: unknown;
  projectId?: unknown;
  isActive?: unknown;
  items?: unknown;
}

function coerceChecklistItems(input: unknown): Array<{ title: string; guidance: string; position: number }> {
  const incoming = Array.isArray(input) ? input : [];
  const items: Array<{ title: string; guidance: string; position: number }> = [];
  const seen = new Set<string>();
  for (const raw of incoming.slice(0, 200)) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const title = trimTo(item.title, 300);
    if (!title) throw new AecError("checklist_item_required");
    if (seen.has(title)) continue;
    seen.add(title);
    items.push({
      title,
      guidance: trimTo(item.guidance, 1000),
      position: Number.isInteger(Number(item.position)) ? Number(item.position) : items.length,
    });
  }
  return items;
}

async function replaceChecklistItems(
  owner: WorkspaceOwner,
  checklistId: string,
  input: unknown,
): Promise<void> {
  if (input === undefined) return;
  const items = coerceChecklistItems(input);
  await query(`DELETE FROM aec_inspection_checklist_items WHERE business_id = $1 AND checklist_id = $2`, [
    owner.businessId,
    checklistId,
  ]);
  for (const item of items) {
    await query(
      `INSERT INTO aec_inspection_checklist_items
         (business_id, checklist_id, title, guidance, position)
       VALUES ($1, $2, $3, $4, $5)`,
      [owner.businessId, checklistId, item.title, item.guidance, item.position],
    );
  }
}

export async function createChecklist(
  owner: WorkspaceOwner,
  input: ChecklistInput,
): Promise<SiteChecklistDetail> {
  await assertQaEnabled(owner.businessId);
  const name = trimTo(input.name, 200);
  if (!name) throw new AecError("checklist_name_required");
  const kind = trimTo(input.kind, 20) || "inspection";
  if (!isSiteChecklistKind(kind)) throw new AecError("invalid_checklist_kind");
  const discipline = trimTo(input.discipline, 40);
  if (discipline && !isAecSpecialty(discipline)) throw new AecError("invalid_discipline");
  const projectId = optionalUuid(input.projectId);
  if (projectId) await assertProjectOwned(owner.businessId, projectId);

  const { rows: duplicate } = await query<{ id: string }>(
    `SELECT id FROM aec_inspection_checklists
      WHERE business_id = $1 AND name = $2
        AND (project_id = $3 OR (project_id IS NULL AND $3::uuid IS NULL))`,
    [owner.businessId, name, projectId],
  );
  if (duplicate[0]) throw new AecError("checklist_name_taken");

  const checklistId = await withTenantTransaction(owner.businessId, async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_inspection_checklists
         (business_id, project_id, name, kind, discipline, description, is_active,
          created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        name,
        kind,
        discipline || null,
        trimTo(input.description, 1000),
        input.isActive === undefined ? true : input.isActive !== false,
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    await replaceChecklistItems(owner, rows[0].id, input.items);
    return rows[0].id;
  });
  return loadChecklist(owner.businessId, checklistId);
}

export async function updateChecklist(
  owner: WorkspaceOwner,
  checklistId: string,
  input: ChecklistInput,
): Promise<SiteChecklistDetail> {
  const current = await loadChecklist(owner.businessId, checklistId);
  const name = input.name === undefined ? current.name : trimTo(input.name, 200) || current.name;
  const kind = input.kind === undefined ? current.kind : trimTo(input.kind, 20);
  if (!isSiteChecklistKind(kind)) throw new AecError("invalid_checklist_kind");
  const discipline = input.discipline === undefined ? current.discipline : trimTo(input.discipline, 40) || null;
  if (discipline && !isAecSpecialty(discipline)) throw new AecError("invalid_discipline");
  const projectId = input.projectId === undefined ? current.projectId : optionalUuid(input.projectId);
  if (projectId) await assertProjectOwned(owner.businessId, projectId);
  if (name !== current.name || projectId !== current.projectId) {
    const { rows: duplicate } = await query<{ id: string }>(
      `SELECT id FROM aec_inspection_checklists
        WHERE business_id = $1 AND name = $2 AND id <> $3
          AND (project_id = $4 OR (project_id IS NULL AND $4::uuid IS NULL))`,
      [owner.businessId, name, checklistId, projectId],
    );
    if (duplicate[0]) throw new AecError("checklist_name_taken");
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_inspection_checklists
          SET name = $3, kind = $4, discipline = $5, description = $6, project_id = $7,
              is_active = $8, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        checklistId,
        name,
        kind,
        discipline,
        input.description === undefined ? current.description : trimTo(input.description, 1000),
        projectId,
        input.isActive === undefined ? current.isActive : input.isActive !== false,
      ],
    );
    await replaceChecklistItems(owner, checklistId, input.items);
  });
  return loadChecklist(owner.businessId, checklistId);
}

/**
 * Deleting a template never deletes an inspection: the checks an issue carries
 * are snapshots, and migration 0199's `ON DELETE SET NULL` on their provenance
 * column is what says so.
 */
export async function deleteChecklist(owner: WorkspaceOwner, checklistId: string): Promise<void> {
  await assertQaEnabled(owner.businessId);
  await loadChecklist(owner.businessId, checklistId);
  await query(`DELETE FROM aec_inspection_checklists WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    checklistId,
  ]);
}

/* ===========================================================================
 * The queues the widgets, the assistant and the reminder scan read
 * ======================================================================== */

/**
 * Everything still open, newest urgency first. The assistant's
 * `list_site_issues` (§23) and the «امروز در کارگاه» widget's neighbour read
 * this, so a chat answer and the tab cannot disagree about what is open.
 */
export async function pendingSiteIssues(
  businessId: string,
  filters: { projectId?: string; kind?: string; severity?: string; overdueOnly?: boolean; limit?: number } = {},
): Promise<OverdueSiteIssueRow[]> {
  await assertQaEnabled(businessId);
  const today = await businessToday(businessId);
  const where: string[] = [
    "i.business_id = $1",
    "i.status IN ('open', 'in_progress', 'resolved')",
  ];
  const params: unknown[] = [businessId];
  if (filters.projectId) {
    params.push(filters.projectId);
    where.push(`i.project_id = $${params.length}`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    where.push(`i.kind = $${params.length}`);
  }
  if (filters.severity) {
    params.push(filters.severity);
    where.push(`i.severity = $${params.length}`);
  }
  if (filters.overdueOnly) {
    params.push(today);
    where.push(`i.due_date IS NOT NULL AND i.due_date < $${params.length}::date`);
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.id, i.project_id, i.issue_number, i.kind, i.title, i.severity, i.status,
            i.due_date::text AS due_date, i.assigned_to_name,
            party.name AS responsible_party_name
       FROM aec_site_issues i
       LEFT JOIN parties party ON party.id = i.responsible_party_id
      WHERE ${where.join(" AND ")}
      ORDER BY
        CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        i.due_date NULLS LAST, i.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => {
    const kind = String(row.kind) as SiteIssueKind;
    const severity = String(row.severity);
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      issueNumber: String(row.issue_number),
      kind,
      kindLabel: SITE_ISSUE_KIND_LABELS[kind] ?? kind,
      title: String(row.title ?? ""),
      severity,
      severityLabel: SITE_ISSUE_SEVERITY_LABELS[severity as never] ?? severity,
      status: String(row.status),
      dueDate: (row.due_date as string | null) ?? null,
      daysOverdue: daysOverdue((row.due_date as string | null) ?? null, today),
      assigneeName: String(row.assigned_to_name ?? ""),
      responsiblePartyName: (row.responsible_party_name as string | null) ?? null,
    };
  });
}

/** The overdue half, for the reminder scan (§29). */
export async function overdueSiteIssues(
  businessId: string,
  limit = 20,
): Promise<OverdueSiteIssueRow[]> {
  // The scan runs for every business hour after hour; a non-AEC tenant must
  // cost it one profile read, not an error, so the industry check is the only
  // one here.
  await assertAecIndustry(businessId);
  const rows = await pendingSiteIssues(businessId, { overdueOnly: true, limit });
  return rows.filter((row) => row.daysOverdue > 0);
}
