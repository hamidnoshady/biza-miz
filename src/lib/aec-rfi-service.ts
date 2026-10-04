/**
 * Issue #799 §10 and §11 — the RFI and submittal service: the two registers, the
 * submission cycle, and the reviews that decide one.
 *
 * The shapes and the rules live in `aec-rfi.ts` (pure); this file is the part
 * that talks to PostgreSQL. It follows `aec-boq-service.ts` and
 * `aec-doc-service.ts`'s conventions: every write takes a `WorkspaceOwner`,
 * every read takes a `businessId`, every refusal is an `AecError` code the API
 * guard maps to a status, and the migration's triggers are the backstop rather
 * than the first line.
 *
 * ## The four things this file is careful about
 *
 *   * **A review is the workspace's review.** A submitted revision files one
 *     `workspace_approvals` row with `subject_type = 'submittal_revision'`,
 *     exactly as a BOQ revision does. §11's "Approved / Approved with Comments /
 *     Revise & Resubmit / Rejected" is therefore a *projection* of a decision
 *     made through the queue that already exists, on `workspace.approve`, and
 *     appears in the approvals counters and the widgets for free. There is no
 *     second approval mechanism and no `submittal.approve` permission.
 *   * **It never rewrites what a reviewer saw.** A revision that is no longer a
 *     draft is refused here *and* by migration 0198's trigger; «Revise &
 *     Resubmit» inserts revision n+1 instead. The way to correct a rejected
 *     submission is the next revision, which is what a real submittal log does.
 *   * **It reuses `workspace_documents`.** A revision's file is a document row
 *     (chosen from the Media Library or already in the project), and attachments
 *     to an RFI or a submittal are document rows linked by the two columns 0198
 *     adds — so the Media Library keeps its single storage charge, its single
 *     access check and its existing screen, and §11's "attachments" is not a
 *     second upload path.
 *   * **It is honest about what a queue can express.** The four review outcomes
 *     are stated in words on the submittal screen; the queue's binary decision
 *     maps onto the two of them it can express unambiguously (`approved` →
 *     approved, `rejected` → rejected) rather than guessing that a rejection
 *     meant "revise and resubmit".
 */
import { disciplineLabel } from "./aec-docs";
import {
  canTransitionRfi,
  canTransitionSubmittal,
  isEditableRfi,
  isEditableSubmittal,
  isRfiOverdue,
  isRfiStatus,
  isRfiWaiting,
  isSubmittalDecision,
  isSubmittalOverdue,
  isSubmittalStatus,
  isSubmittalType,
  isSubmittalWaiting,
  RFI_STATUS_LABELS,
  SUBMITTAL_STATUS_LABELS,
  SUBMITTAL_TYPE_LABELS,
  type RfiStatus,
  type SubmittalDecision,
  type SubmittalStatus,
  type SubmittalType,
} from "./aec-rfi";
import { isAecSpecialty } from "./aec";
import { AecError, assertAecIndustry, loadBusinessAecProfile } from "./aec-service";
import { assertDocumentControlEnabled } from "./aec-doc-service";
import { businessToday } from "./business-day-service";
import { query, withTenantTransaction } from "./db";
import { recordActivity, type WorkspaceOwner } from "./workspace";
import {
  loadLinkedDocuments,
  replaceLinkedDocuments,
  resolveLinkedDocument,
} from "./workspace-document-links";

/* ===========================================================================
 * Coercion
 * ======================================================================== */

function trimTo(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}

function optionalText(value: unknown, max: number): string | null {
  const text = trimTo(value, max);
  return text === "" ? null : text;
}

/** ISO `YYYY-MM-DD` or null — the UI converts from Shamsi (issue §5). */
function optionalDate(value: unknown, code = "invalid_date"): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AecError(code);
  return value;
}

function optionalUuid(value: unknown, code = "invalid_reference"): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F-]{36}$/.test(value)) throw new AecError(code);
  return value;
}

/** A Rial amount: a non-negative whole number, or null for "not assessed". */
function optionalRial(value: unknown, code = "invalid_cost_impact"): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new AecError(code);
  return amount;
}

function optionalDays(value: unknown, code = "invalid_schedule_impact"): number | null {
  if (value === null || value === undefined || value === "") return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0) throw new AecError(code);
  return days;
}

/* ===========================================================================
 * Shapes
 * ======================================================================== */

export interface RfiAttachment {
  documentId: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  mediaAssetId: string | null;
  createdAt: string;
}

export interface RfiSummary {
  id: string;
  projectId: string;
  rfiNumber: string;
  subject: string;
  question: string;
  discipline: string | null;
  disciplineLabel: string;
  raisedById: string | null;
  raisedByName: string;
  assignedToId: string | null;
  assignedToName: string;
  responsiblePartyId: string | null;
  responsiblePartyName: string | null;
  documentId: string | null;
  documentNumber: string | null;
  documentTitle: string | null;
  raisedDate: string;
  dueDate: string | null;
  response: string;
  respondedByName: string;
  responseDate: string | null;
  status: RfiStatus;
  statusLabel: string;
  costImpactRial: number | null;
  scheduleImpactDays: number | null;
  closedAt: string | null;
  createdAt: string;
  createdByName: string;
  /** §10 — surfaced, not left for the reader to work out. */
  isOverdue: boolean;
  /** §22/§23 — an unanswered question. One definition, shared by the queue. */
  isWaiting: boolean;
  isEditable: boolean;
  attachmentCount: number;
}

export interface RfiDetail extends RfiSummary {
  attachments: RfiAttachment[];
}

export interface SubmittalRevisionSummary {
  id: string;
  submittalId: string;
  revisionNo: number;
  status: SubmittalStatus;
  statusLabel: string;
  isEditable: boolean;
  /** Where the reviewer's answer lives, so the screen can link to the queue item. */
  approvalId: string | null;
  approvalStatus: string | null;
  workspaceDocumentId: string | null;
  fileName: string | null;
  mimeType: string | null;
  submittedById: string | null;
  submittedByName: string;
  submittedAt: string | null;
  dueDate: string | null;
  reviewerUserId: string | null;
  reviewerName: string;
  response: string;
  decidedByName: string;
  decidedAt: string | null;
  closedAt: string | null;
  notes: string;
  createdAt: string;
  createdByName: string;
  /** The revision's own review dates resolved from the approval it filed. */
  approvalRequestedAt: string | null;
  isOverdue: boolean;
}

export interface SubmittalSummary {
  id: string;
  projectId: string;
  submittalNumber: string;
  title: string;
  submissionType: SubmittalType;
  submissionTypeLabel: string;
  specSection: string;
  discipline: string | null;
  disciplineLabel: string;
  documentId: string | null;
  documentNumber: string | null;
  documentTitle: string | null;
  responsiblePartyId: string | null;
  responsiblePartyName: string | null;
  responseRequiredBy: string | null;
  latestRevisionId: string | null;
  latestRevisionNo: number | null;
  latestRevisionStatus: SubmittalStatus | null;
  latestRevisionStatusLabel: string | null;
  latestRevisionDueDate: string | null;
  reviewerName: string;
  revisionCount: number;
  notes: string;
  createdAt: string;
  createdByName: string;
  /** Waiting on a reviewer — §22's «سابمیتالهای منتظر تأیید». */
  isWaiting: boolean;
  isOverdue: boolean;
  attachmentCount: number;
}

export interface SubmittalDetail extends SubmittalSummary {
  attachments: RfiAttachment[];
  revisions: SubmittalRevisionSummary[];
}

/** The assistant's and the widget's row: one answer, small enough to read aloud. */
export interface PendingRfiRow {
  id: string;
  projectId: string;
  projectName: string;
  rfiNumber: string;
  subject: string;
  assignedToName: string;
  responsiblePartyName: string | null;
  dueDate: string | null;
  daysOverdue: number;
}

export interface PendingSubmittalRow {
  id: string;
  projectId: string;
  projectName: string;
  submittalNumber: string;
  title: string;
  submissionTypeLabel: string;
  reviewerName: string;
  dueDate: string | null;
  daysOverdue: number;
  status: SubmittalStatus;
  statusLabel: string;
}

/* ===========================================================================
 * Selects
 * ======================================================================== */

// Dates are cast to text in SQL, the repo's own convention (`workspace.ts`,
// `aec-doc-service.ts`): node-postgres would otherwise hand back `Date` objects
// and every screen would be formatting whatever `String(date)` produced.
const RFI_SELECT = `
  r.id, r.project_id, r.rfi_number, r.subject, r.question, r.discipline,
  r.raised_by, r.raised_by_name, r.assigned_to, r.assigned_to_name,
  r.responsible_party_id, party.name AS responsible_party_name,
  r.document_id, d.document_number, d.title AS document_title,
  r.raised_date::text AS raised_date, r.due_date::text AS due_date,
  r.response, r.responded_by_name, r.response_date::text AS response_date,
  r.status, r.cost_impact_rial, r.schedule_impact_days,
  r.closed_at::text AS closed_at, r.created_at::text AS created_at, r.created_by_name,
  (SELECT count(*)::integer FROM workspace_documents wd
    WHERE wd.rfi_id = r.id AND wd.business_id = r.business_id) AS attachment_count`;

const RFI_JOINS = `
  FROM aec_rfis r
  LEFT JOIN parties party ON party.id = r.responsible_party_id
  LEFT JOIN aec_documents d ON d.id = r.document_id`;

const SUBMITTAL_SELECT = `
  s.id, s.project_id, s.submittal_number, s.title, s.submission_type, s.spec_section,
  s.discipline, s.document_id, d.document_number, d.title AS document_title,
  s.responsible_party_id, party.name AS responsible_party_name,
  s.response_required_by::text AS response_required_by,
  s.latest_revision_id, s.latest_revision_no, s.latest_revision_status,
  s.revision_count, s.notes, s.created_at::text AS created_at, s.created_by_name,
  latest.due_date::text AS latest_due_date, latest.reviewer_name,
  (SELECT count(*)::integer FROM workspace_documents wd
    WHERE wd.submittal_id = s.id AND wd.business_id = s.business_id) AS attachment_count`;

const SUBMITTAL_JOINS = `
  FROM aec_submittals s
  LEFT JOIN parties party ON party.id = s.responsible_party_id
  LEFT JOIN aec_documents d ON d.id = s.document_id
  LEFT JOIN aec_submittal_revisions latest ON latest.id = s.latest_revision_id`;

const SUBMITTAL_REVISION_SELECT = `
  r.id, r.submittal_id, r.revision_no, r.status, r.workspace_document_id,
  ma.file_name, ma.mime_type,
  r.submitted_by, r.submitted_by_name, r.submitted_at::text AS submitted_at,
  r.due_date::text AS due_date, r.reviewer_user_id, r.reviewer_name,
  r.response, r.decided_by_name, r.decided_at::text AS decided_at,
  r.closed_at::text AS closed_at, r.notes,
  r.created_at::text AS created_at, r.created_by_name,
  a.id AS approval_id, a.status AS approval_status,
  a.created_at::text AS approval_requested_at`;

const SUBMITTAL_REVISION_JOINS = `
  FROM aec_submittal_revisions r
  LEFT JOIN workspace_documents wd ON wd.id = r.workspace_document_id
  LEFT JOIN media_assets ma ON ma.id = wd.media_asset_id
  LEFT JOIN LATERAL (
    SELECT id, status, created_at
      FROM workspace_approvals
     WHERE business_id = r.business_id AND subject_type = 'submittal_revision'
       AND subject_id = r.id
     ORDER BY created_at DESC
     LIMIT 1
  ) a ON true`;

/* ===========================================================================
 * Mappers
 * ======================================================================== */

function toRfi(row: Record<string, unknown>, today: string): RfiSummary {
  const r = row as Record<string, string | number | null>;
  const status = isRfiStatus(String(r.status)) ? (r.status as RfiStatus) : "draft";
  const dueDate = (r.due_date as string | null) ?? null;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    rfiNumber: String(r.rfi_number ?? ""),
    subject: String(r.subject ?? ""),
    question: String(r.question ?? ""),
    discipline: (r.discipline as string | null) ?? null,
    disciplineLabel: disciplineLabel((r.discipline as string | null) ?? null),
    raisedById: (r.raised_by as string | null) ?? null,
    raisedByName: String(r.raised_by_name ?? ""),
    assignedToId: (r.assigned_to as string | null) ?? null,
    assignedToName: String(r.assigned_to_name ?? ""),
    responsiblePartyId: (r.responsible_party_id as string | null) ?? null,
    responsiblePartyName: (r.responsible_party_name as string | null) ?? null,
    documentId: (r.document_id as string | null) ?? null,
    documentNumber: (r.document_number as string | null) ?? null,
    documentTitle: (r.document_title as string | null) ?? null,
    raisedDate: String(r.raised_date ?? ""),
    dueDate,
    response: String(r.response ?? ""),
    respondedByName: String(r.responded_by_name ?? ""),
    responseDate: (r.response_date as string | null) ?? null,
    status,
    statusLabel: RFI_STATUS_LABELS[status],
    costImpactRial: r.cost_impact_rial === null ? null : Number(r.cost_impact_rial),
    scheduleImpactDays: r.schedule_impact_days === null ? null : Number(r.schedule_impact_days),
    closedAt: (r.closed_at as string | null) ?? null,
    createdAt: String(r.created_at ?? ""),
    createdByName: String(r.created_by_name ?? ""),
    isOverdue: isRfiOverdue({ status, dueDate }, today),
    isWaiting: isRfiWaiting(status),
    isEditable: isEditableRfi(status),
    attachmentCount: Number(r.attachment_count ?? 0),
  };
}

function toSubmittal(row: Record<string, unknown>, today: string): SubmittalSummary {
  const r = row as Record<string, string | number | null>;
  const type = isSubmittalType(String(r.submission_type))
    ? (r.submission_type as SubmittalType)
    : "other";
  const revisionStatus =
    r.latest_revision_status && isSubmittalStatus(String(r.latest_revision_status))
      ? (r.latest_revision_status as SubmittalStatus)
      : null;
  const dueDate = (r.latest_due_date as string | null) ?? null;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    submittalNumber: String(r.submittal_number ?? ""),
    title: String(r.title ?? ""),
    submissionType: type,
    submissionTypeLabel: SUBMITTAL_TYPE_LABELS[type],
    specSection: String(r.spec_section ?? ""),
    discipline: (r.discipline as string | null) ?? null,
    disciplineLabel: disciplineLabel((r.discipline as string | null) ?? null),
    documentId: (r.document_id as string | null) ?? null,
    documentNumber: (r.document_number as string | null) ?? null,
    documentTitle: (r.document_title as string | null) ?? null,
    responsiblePartyId: (r.responsible_party_id as string | null) ?? null,
    responsiblePartyName: (r.responsible_party_name as string | null) ?? null,
    responseRequiredBy: (r.response_required_by as string | null) ?? null,
    latestRevisionId: (r.latest_revision_id as string | null) ?? null,
    latestRevisionNo: r.latest_revision_no === null ? null : Number(r.latest_revision_no),
    latestRevisionStatus: revisionStatus,
    latestRevisionStatusLabel: revisionStatus ? SUBMITTAL_STATUS_LABELS[revisionStatus] : null,
    latestRevisionDueDate: dueDate,
    reviewerName: String(r.reviewer_name ?? ""),
    revisionCount: Number(r.revision_count ?? 0),
    notes: String(r.notes ?? ""),
    createdAt: String(r.created_at ?? ""),
    createdByName: String(r.created_by_name ?? ""),
    isWaiting: revisionStatus ? isSubmittalWaiting(revisionStatus) : false,
    isOverdue: revisionStatus
      ? isSubmittalOverdue({ status: revisionStatus, dueDate }, today)
      : false,
    attachmentCount: Number(r.attachment_count ?? 0),
  };
}

function toSubmittalRevision(
  row: Record<string, unknown>,
  today: string,
): SubmittalRevisionSummary {
  const r = row as Record<string, string | number | null>;
  const status = isSubmittalStatus(String(r.status))
    ? (r.status as SubmittalStatus)
    : "draft";
  const dueDate = (r.due_date as string | null) ?? null;
  return {
    id: String(r.id),
    submittalId: String(r.submittal_id),
    revisionNo: Number(r.revision_no),
    status,
    statusLabel: SUBMITTAL_STATUS_LABELS[status],
    isEditable: isEditableSubmittal(status),
    approvalId: (r.approval_id as string | null) ?? null,
    approvalStatus: (r.approval_status as string | null) ?? null,
    workspaceDocumentId: (r.workspace_document_id as string | null) ?? null,
    fileName: (r.file_name as string | null) ?? null,
    mimeType: (r.mime_type as string | null) ?? null,
    submittedById: (r.submitted_by as string | null) ?? null,
    submittedByName: String(r.submitted_by_name ?? ""),
    submittedAt: (r.submitted_at as string | null) ?? null,
    dueDate,
    reviewerUserId: (r.reviewer_user_id as string | null) ?? null,
    reviewerName: String(r.reviewer_name ?? ""),
    response: String(r.response ?? ""),
    decidedByName: String(r.decided_by_name ?? ""),
    decidedAt: (r.decided_at as string | null) ?? null,
    closedAt: (r.closed_at as string | null) ?? null,
    notes: String(r.notes ?? ""),
    createdAt: String(r.created_at ?? ""),
    createdByName: String(r.created_by_name ?? ""),
    approvalRequestedAt: (r.approval_requested_at as string | null) ?? null,
    isOverdue: isSubmittalOverdue({ status, dueDate }, today),
  };
}

/* ===========================================================================
 * Guards
 * ======================================================================== */

/**
 * An RFI register exists for every AEC business — §10's questions are what a
 * project team runs on, and the individual profile asks them as often as a
 * contractor does. So there is no capability gate here, only the industry one.
 */
async function assertRfiEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
}

/**
 * Submittals gate on `document_control`: §11 is a *document* cycle (shop
 * drawings, material submissions, method statements), the register it points at
 * is §9's, and the cockpit tab is gated the same way — so the API and the tab
 * cannot disagree about whether a business has submittals.
 */
async function assertSubmittalsEnabled(businessId: string): Promise<void> {
  await assertDocumentControlEnabled(businessId);
}

/** The business's resolved capability list — the overdue scan reads it once. */
async function rfiCapabilities(businessId: string): Promise<readonly string[]> {
  const profile = await loadBusinessAecProfile(businessId);
  return profile.capabilities;
}

export async function rfiProjectId(businessId: string, rfiId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_rfis WHERE business_id = $1 AND id = $2`,
    [businessId, rfiId],
  );
  if (!rows[0]) throw new AecError("rfi_not_found");
  return rows[0].project_id;
}

export async function submittalProjectId(
  businessId: string,
  submittalId: string,
): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_submittals WHERE business_id = $1 AND id = $2`,
    [businessId, submittalId],
  );
  if (!rows[0]) throw new AecError("submittal_not_found");
  return rows[0].project_id;
}

/** Resolves the owning project of a *revision*, for the route that acts on one. */
export async function submittalRevisionProjectId(
  businessId: string,
  revisionId: string,
): Promise<{ projectId: string; submittalId: string }> {
  const { rows } = await query<{ project_id: string; submittal_id: string }>(
    `SELECT s.project_id, r.submittal_id
       FROM aec_submittal_revisions r
       JOIN aec_submittals s ON s.id = r.submittal_id
      WHERE r.business_id = $1 AND r.id = $2`,
    [businessId, revisionId],
  );
  if (!rows[0]) throw new AecError("submittal_revision_not_found");
  return { projectId: rows[0].project_id, submittalId: rows[0].submittal_id };
}

async function assertProjectOwned(businessId: string, projectId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [businessId, projectId],
  );
  if (!rows[0]) throw new AecError("project_not_found");
}

async function recordRfiActivity(
  owner: WorkspaceOwner,
  entry: {
    projectId: string;
    subjectType: "rfi" | "submittal";
    subjectId: string | null;
    action: string;
    summary: string;
  },
): Promise<void> {
  await recordActivity(owner, entry);
}

/* ===========================================================================
 * Attachments
 * ======================================================================== */

/**
 * The attachment trio, over the shared `workspace-document-links.ts` module.
 *
 * These were private to this file until Wave 7's site registers needed the same
 * three operations; they are thin adapters now so the RFI, submittal, site-log
 * and site-issue registers cannot drift apart on how a file is attached, and so
 * a `mediaAssetId` lookup is fixed once rather than in four places.
 */
async function replaceAttachments(
  owner: WorkspaceOwner,
  target: { rfiId?: string; submittalId?: string },
  projectId: string,
  input: unknown,
): Promise<void> {
  await replaceLinkedDocuments(
    owner,
    {
      column: target.rfiId ? "rfi_id" : "submittal_id",
      targetId: (target.rfiId ?? target.submittalId) as string,
    },
    projectId,
    input,
  );
}

async function loadAttachments(
  businessId: string,
  column: "rfi_id" | "submittal_id",
  targetId: string,
): Promise<RfiAttachment[]> {
  return loadLinkedDocuments(businessId, column, targetId);
}

/** The file a revision points at, from either form the screen can send. */
function resolveRevisionDocument(
  owner: WorkspaceOwner,
  projectId: string,
  input: { workspaceDocumentId?: unknown; mediaAssetId?: unknown },
): Promise<string | null | undefined> {
  return resolveLinkedDocument(owner, projectId, input);
}

/* ===========================================================================
 * RFIs
 * ======================================================================== */

export async function listProjectRfis(
  businessId: string,
  projectId: string,
  options: { status?: string; discipline?: string; search?: string; openOnly?: boolean } = {},
): Promise<RfiSummary[]> {
  await assertRfiEnabled(businessId);
  const today = await businessToday(businessId);
  const params: unknown[] = [businessId, projectId];
  const where = ["r.business_id = $1", "r.project_id = $2"];
  if (options.status && isRfiStatus(options.status)) {
    params.push(options.status);
    where.push(`r.status = $${params.length}`);
  }
  if (options.openOnly) where.push(`r.status = 'open'`);
  if (options.discipline && isAecSpecialty(options.discipline)) {
    params.push(options.discipline);
    where.push(`r.discipline = $${params.length}`);
  }
  const search = trimTo(options.search, 100);
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(r.rfi_number ILIKE $${params.length} OR r.subject ILIKE $${params.length}
        OR r.question ILIKE $${params.length} OR r.assigned_to_name ILIKE $${params.length})`,
    );
  }
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RFI_SELECT} ${RFI_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY r.rfi_number`,
    params,
  );
  return rows.map((row) => toRfi(row, today));
}

export async function loadRfi(businessId: string, rfiId: string): Promise<RfiDetail> {
  await assertRfiEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RFI_SELECT} ${RFI_JOINS} WHERE r.business_id = $1 AND r.id = $2`,
    [businessId, rfiId],
  );
  if (!rows[0]) throw new AecError("rfi_not_found");
  const rfi = toRfi(rows[0], today);
  return { ...rfi, attachments: await loadAttachments(businessId, "rfi_id", rfiId) };
}

export interface RfiInput {
  rfiNumber?: unknown;
  subject?: unknown;
  question?: unknown;
  discipline?: unknown;
  raisedById?: unknown;
  raisedByName?: unknown;
  assignedToId?: unknown;
  assignedToName?: unknown;
  responsiblePartyId?: unknown;
  documentId?: unknown;
  raisedDate?: unknown;
  dueDate?: unknown;
  costImpactRial?: unknown;
  scheduleImpactDays?: unknown;
  attachments?: unknown;
}

/**
 * A user named on an RFI must be one of this business's own members.
 *
 * The three reference checks below are the friendly layer over migration 0198's
 * triggers, exactly as `aec-service.ts` does it for participants: the trigger is
 * what makes cross-tenant references impossible, and the service is what turns
 * the same refusal into a code a form can show instead of a 500.
 */
async function assertUserOwned(businessId: string, userId: string | null): Promise<void> {
  if (!userId) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE business_id = $1 AND id = $2`,
    [businessId, userId],
  );
  if (!rows[0]) throw new AecError("user_not_found");
}

/** A party named on a register must be live, unmerged and of this business. */
async function assertPartyOwned(businessId: string, partyId: string | null): Promise<void> {
  if (!partyId) return;
  const { rows } = await query(
    `SELECT 1 FROM parties
      WHERE id = $1 AND business_id = $2 AND is_active AND merged_into_id IS NULL`,
    [partyId, businessId],
  );
  if (!rows[0]) throw new AecError("party_not_found");
}

/** The related drawing of §10/§11 must be in this business's own register. */
async function assertDocumentOwned(businessId: string, documentId: string | null): Promise<void> {
  if (!documentId) return;
  const { rows } = await query(`SELECT 1 FROM aec_documents WHERE id = $1 AND business_id = $2`, [
    documentId,
    businessId,
  ]);
  if (!rows[0]) throw new AecError("document_not_found");
}

export async function createRfi(
  owner: WorkspaceOwner,
  projectId: string,
  input: RfiInput,
): Promise<RfiDetail> {
  await assertRfiEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);

  const rfiNumber = trimTo(input.rfiNumber, 60);
  if (!rfiNumber) throw new AecError("rfi_number_required");
  const subject = trimTo(input.subject, 300);
  if (!subject) throw new AecError("rfi_subject_required");
  // §10 lists a question, and an RFI without one is a number rather than a
  // request — the answer has nothing to answer.
  const question = trimTo(input.question, 8000);
  if (!question) throw new AecError("rfi_question_required");
  const discipline = trimTo(input.discipline, 40);
  if (discipline && !isAecSpecialty(discipline)) throw new AecError("invalid_discipline");
  const responsiblePartyId = optionalUuid(input.responsiblePartyId);
  const documentId = optionalUuid(input.documentId);
  const assignedToId = optionalUuid(input.assignedToId);
  await assertUserOwned(owner.businessId, assignedToId);
  await assertPartyOwned(owner.businessId, responsiblePartyId);
  await assertDocumentOwned(owner.businessId, documentId);

  const { rows: duplicate } = await query<{ id: string }>(
    `SELECT id FROM aec_rfis WHERE project_id = $1 AND rfi_number = $2`,
    [projectId, rfiNumber],
  );
  if (duplicate[0]) throw new AecError("rfi_number_taken");

  const today = await businessToday(owner.businessId);

  const rfiId = await withTenantTransaction(owner.businessId, async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_rfis
         (business_id, project_id, rfi_number, subject, question, discipline,
          raised_by, raised_by_name, assigned_to, assigned_to_name, responsible_party_id,
          document_id, raised_date, due_date, cost_impact_rial, schedule_impact_days,
          status, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $14::date,
               $15, $16, 'draft', $7, $8)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        rfiNumber,
        subject,
        question,
        discipline || null,
        owner.actorUserId,
        owner.actorName ?? "",
        assignedToId,
        trimTo(input.assignedToName, 200),
        responsiblePartyId,
        documentId,
        optionalDate(input.raisedDate) ?? today,
        optionalDate(input.dueDate),
        optionalRial(input.costImpactRial),
        optionalDays(input.scheduleImpactDays),
      ],
    );
    const id = rows[0].id;
    if (input.attachments !== undefined) {
      await replaceAttachments(owner, { rfiId: id }, projectId, input.attachments);
    }
    return id;
  });

  await recordRfiActivity(owner, {
    projectId,
    subjectType: "rfi",
    subjectId: rfiId,
    action: "created",
    summary: `RFI ${rfiNumber} ثبت شد — ${subject}`,
  });
  return loadRfi(owner.businessId, rfiId);
}

/**
 * Edit an RFI.
 *
 * The question and the number are only editable while the RFI is a draft, which
 * is §33 read strictly: a question that has been asked is what the answer answers.
 * The impacts, the assignee and the attachments stay editable while the RFI is
 * open, because those are how the *answer* is negotiated.
 */
export async function updateRfi(
  owner: WorkspaceOwner,
  rfiId: string,
  input: RfiInput & { status?: unknown },
): Promise<RfiDetail> {
  await assertRfiEnabled(owner.businessId);
  const current = await loadRfi(owner.businessId, rfiId);
  if (current.status === "closed" || current.status === "cancelled") {
    throw new AecError("rfi_not_editable");
  }
  const editsIdentity = input.rfiNumber !== undefined || input.subject !== undefined
    || input.question !== undefined || input.raisedDate !== undefined;
  if (editsIdentity && !isEditableRfi(current.status)) throw new AecError("rfi_not_editable");

  const nextStatus = input.status === undefined ? current.status : String(input.status);
  if (!isRfiStatus(nextStatus)) throw new AecError("invalid_rfi_status");
  if (nextStatus !== current.status && !canTransitionRfi(current.status, nextStatus)) {
    throw new AecError("invalid_rfi_transition");
  }

  const discipline = input.discipline === undefined
    ? current.discipline
    : trimTo(input.discipline, 40) || null;
  if (discipline && !isAecSpecialty(discipline)) throw new AecError("invalid_discipline");
  const assignedToId = input.assignedToId === undefined
    ? current.assignedToId
    : optionalUuid(input.assignedToId);
  await assertUserOwned(owner.businessId, assignedToId);
  const responsiblePartyId =
    input.responsiblePartyId === undefined
      ? current.responsiblePartyId
      : optionalUuid(input.responsiblePartyId);
  await assertPartyOwned(owner.businessId, responsiblePartyId);
  const documentId = input.documentId === undefined ? current.documentId : optionalUuid(input.documentId);
  await assertDocumentOwned(owner.businessId, documentId);
  const rfiNumber = input.rfiNumber === undefined ? current.rfiNumber : trimTo(input.rfiNumber, 60);
  if (!rfiNumber) throw new AecError("rfi_number_required");
  const subject = input.subject === undefined ? current.subject : trimTo(input.subject, 300);
  if (!subject) throw new AecError("rfi_subject_required");

  if (rfiNumber !== current.rfiNumber) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM aec_rfis WHERE project_id = $1 AND rfi_number = $2 AND id <> $3`,
      [current.projectId, rfiNumber, rfiId],
    );
    if (rows[0]) throw new AecError("rfi_number_taken");
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_rfis
          SET rfi_number = $3, subject = $4, question = $5, discipline = $6,
              assigned_to = $7, assigned_to_name = $8, responsible_party_id = $9,
              document_id = $10, raised_date = $11::date, due_date = $12::date,
              cost_impact_rial = $13, schedule_impact_days = $14,
              status = $15, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        rfiId,
        rfiNumber,
        subject,
        input.question === undefined ? current.question : trimTo(input.question, 8000),
        discipline,
        assignedToId,
        input.assignedToName === undefined
          ? current.assignedToName
          : trimTo(input.assignedToName, 200),
        responsiblePartyId,
        documentId,
        input.raisedDate === undefined ? current.raisedDate : optionalDate(input.raisedDate),
        input.dueDate === undefined ? current.dueDate : optionalDate(input.dueDate),
        input.costImpactRial === undefined
          ? current.costImpactRial
          : optionalRial(input.costImpactRial),
        input.scheduleImpactDays === undefined
          ? current.scheduleImpactDays
          : optionalDays(input.scheduleImpactDays),
        nextStatus,
      ],
    );
    if (input.attachments !== undefined) {
      await replaceAttachments(owner, { rfiId }, current.projectId, input.attachments);
    }
  });

  return loadRfi(owner.businessId, rfiId);
}

export async function deleteRfi(owner: WorkspaceOwner, rfiId: string): Promise<void> {
  await assertRfiEnabled(owner.businessId);
  const current = await loadRfi(owner.businessId, rfiId);
  if (!isEditableRfi(current.status)) throw new AecError("rfi_not_editable");
  await query(`DELETE FROM aec_rfis WHERE business_id = $1 AND id = $2`, [owner.businessId, rfiId]);
}

/**
 * The four moves of §10's chain: open, answer, close, cancel.
 *
 * One function rather than four, because they share the transition rule and the
 * activity entry; the route decides which permission each needs.
 */
export async function applyRfiAction(
  owner: WorkspaceOwner,
  rfiId: string,
  action: "open" | "answer" | "close" | "cancel",
  input: { response?: unknown; respondedByName?: unknown; note?: unknown } = {},
): Promise<RfiDetail> {
  await assertRfiEnabled(owner.businessId);
  const current = await loadRfi(owner.businessId, rfiId);
  const target: RfiStatus =
    action === "open" ? "open" : action === "answer" ? "answered" : action === "close" ? "closed" : "cancelled";
  if (!canTransitionRfi(current.status, target)) throw new AecError("invalid_rfi_transition");

  const today = await businessToday(owner.businessId);
  const response = trimTo(input.response, 8000) || current.response;
  if (target === "answered" && !response) throw new AecError("rfi_response_required");

  await query(
    `UPDATE aec_rfis
        SET status = $3,
            response = $4,
            responded_by = CASE WHEN $3 = 'answered' THEN $5 ELSE responded_by END,
            responded_by_name = CASE WHEN $3 = 'answered' THEN $6 ELSE responded_by_name END,
            response_date = CASE WHEN $3 = 'answered' THEN $7::date ELSE response_date END,
            closed_at = CASE WHEN $3 IN ('closed', 'cancelled') THEN now() ELSE closed_at END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      owner.businessId,
      rfiId,
      target,
      response,
      owner.actorUserId,
      trimTo(input.respondedByName, 200) || owner.actorName || "",
      today,
    ],
  );

  await recordRfiActivity(owner, {
    projectId: current.projectId,
    subjectType: "rfi",
    subjectId: rfiId,
    action: action === "answer" ? "answered" : target,
    summary:
      action === "answer"
        ? `پاسخ RFI ${current.rfiNumber} ثبت شد`
        : action === "open"
          ? `RFI ${current.rfiNumber} برای پاسخ باز شد`
          : action === "close"
            ? `RFI ${current.rfiNumber} بسته شد`
            : `RFI ${current.rfiNumber} لغو شد`,
  });
  return loadRfi(owner.businessId, rfiId);
}

/** §22/§23 — the waiting queue, business-wide, newest deadline first. */
export async function pendingRfis(
  businessId: string,
  options: { projectId?: string | null; limit?: number } = {},
): Promise<PendingRfiRow[]> {
  await assertRfiEnabled(businessId);
  const today = await businessToday(businessId);
  const params: unknown[] = [businessId];
  const where = ["r.business_id = $1", "r.status = 'open'"];
  if (options.projectId) {
    params.push(options.projectId);
    where.push(`r.project_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 25, 1), 100));
  const { rows } = await query<Record<string, unknown>>(
    `SELECT r.id, r.project_id, p.name AS project_name, r.rfi_number, r.subject,
            r.assigned_to_name, party.name AS responsible_party_name,
            r.due_date::text AS due_date
       FROM aec_rfis r
       JOIN ai_projects p ON p.id = r.project_id
       LEFT JOIN parties party ON party.id = r.responsible_party_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.due_date NULLS LAST, r.rfi_number
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    projectName: String(row.project_name ?? ""),
    rfiNumber: String(row.rfi_number ?? ""),
    subject: String(row.subject ?? ""),
    assignedToName: String(row.assigned_to_name ?? ""),
    responsiblePartyName: (row.responsible_party_name as string | null) ?? null,
    dueDate: (row.due_date as string | null) ?? null,
    daysOverdue: daysBetween(String(row.due_date ?? ""), today),
  }));
}

/** Whole days `dueDate` is in the past; 0 when there is no due date or it is ahead. */
function daysBetween(dueDate: string, today: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return 0;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now) || due >= now) return 0;
  return Math.round((now - due) / 86_400_000);
}

/* ===========================================================================
 * Submittals
 * ======================================================================== */

export async function listProjectSubmittals(
  businessId: string,
  projectId: string,
  options: { status?: string; type?: string; search?: string; waitingOnly?: boolean } = {},
): Promise<SubmittalSummary[]> {
  await assertSubmittalsEnabled(businessId);
  const today = await businessToday(businessId);
  const params: unknown[] = [businessId, projectId];
  const where = ["s.business_id = $1", "s.project_id = $2"];
  if (options.status && isSubmittalStatus(options.status)) {
    params.push(options.status);
    where.push(`s.latest_revision_status = $${params.length}`);
  }
  if (options.waitingOnly) where.push(`s.latest_revision_status IN ('submitted', 'under_review')`);
  if (options.type && isSubmittalType(options.type)) {
    params.push(options.type);
    where.push(`s.submission_type = $${params.length}`);
  }
  const search = trimTo(options.search, 100);
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(s.submittal_number ILIKE $${params.length} OR s.title ILIKE $${params.length}
        OR s.spec_section ILIKE $${params.length})`,
    );
  }
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${SUBMITTAL_SELECT} ${SUBMITTAL_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY s.submittal_number`,
    params,
  );
  return rows.map((row) => toSubmittal(row, today));
}

export async function loadSubmittal(
  businessId: string,
  submittalId: string,
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${SUBMITTAL_SELECT} ${SUBMITTAL_JOINS} WHERE s.business_id = $1 AND s.id = $2`,
    [businessId, submittalId],
  );
  if (!rows[0]) throw new AecError("submittal_not_found");
  const submittal = toSubmittal(rows[0], today);
  const { rows: revisions } = await query<Record<string, unknown>>(
    `SELECT ${SUBMITTAL_REVISION_SELECT} ${SUBMITTAL_REVISION_JOINS}
      WHERE r.business_id = $1 AND r.submittal_id = $2
      ORDER BY r.revision_no DESC`,
    [businessId, submittalId],
  );
  return {
    ...submittal,
    attachments: await loadAttachments(businessId, "submittal_id", submittalId),
    revisions: revisions.map((row) => toSubmittalRevision(row, today)),
  };
}

export interface SubmittalInput {
  submittalNumber?: unknown;
  title?: unknown;
  submissionType?: unknown;
  specSection?: unknown;
  discipline?: unknown;
  documentId?: unknown;
  responsiblePartyId?: unknown;
  responseRequiredBy?: unknown;
  notes?: unknown;
  attachments?: unknown;
}

export async function createSubmittal(
  owner: WorkspaceOwner,
  projectId: string,
  input: SubmittalInput,
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);

  const submittalNumber = trimTo(input.submittalNumber, 60);
  if (!submittalNumber) throw new AecError("submittal_number_required");
  const title = trimTo(input.title, 300);
  if (!title) throw new AecError("submittal_title_required");
  const submissionType = trimTo(input.submissionType, 40) || "shop_drawing";
  if (!isSubmittalType(submissionType)) throw new AecError("invalid_submittal_type");
  const discipline = trimTo(input.discipline, 40);
  if (discipline && !isAecSpecialty(discipline)) throw new AecError("invalid_discipline");
  const responsiblePartyId = optionalUuid(input.responsiblePartyId);
  const documentId = optionalUuid(input.documentId);
  await assertPartyOwned(owner.businessId, responsiblePartyId);
  await assertDocumentOwned(owner.businessId, documentId);

  const { rows: duplicate } = await query<{ id: string }>(
    `SELECT id FROM aec_submittals WHERE project_id = $1 AND submittal_number = $2`,
    [projectId, submittalNumber],
  );
  if (duplicate[0]) throw new AecError("submittal_number_taken");

  const submittalId = await withTenantTransaction(owner.businessId, async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_submittals
         (business_id, project_id, submittal_number, title, submission_type, spec_section,
          discipline, document_id, responsible_party_id, response_required_by, notes,
          created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        submittalNumber,
        title,
        submissionType,
        trimTo(input.specSection, 120),
        discipline || null,
        documentId,
        responsiblePartyId,
        optionalDate(input.responseRequiredBy),
        trimTo(input.notes, 4000),
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const id = rows[0].id;
    // Every submittal starts with revision 1 in draft: the register row is what
    // the number identifies, and the revisions are what goes back and forth.
    await insertSubmittalRevision(owner, id, 1, {});
    if (input.attachments !== undefined) {
      await replaceAttachments(owner, { submittalId: id }, projectId, input.attachments);
    }
    return id;
  });

  await recordRfiActivity(owner, {
    projectId,
    subjectType: "submittal",
    subjectId: submittalId,
    action: "created",
    summary: `سابمیتال ${submittalNumber} ثبت شد — ${title}`,
  });
  return loadSubmittal(owner.businessId, submittalId);
}

async function insertSubmittalRevision(
  owner: WorkspaceOwner,
  submittalId: string,
  revisionNo: number,
  input: {
    workspaceDocumentId?: unknown;
    mediaAssetId?: unknown;
    dueDate?: unknown;
    reviewerUserId?: unknown;
    reviewerName?: unknown;
    notes?: unknown;
  },
): Promise<string> {
  const { rows } = await query<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM aec_submittals WHERE business_id = $1 AND id = $2`,
    [owner.businessId, submittalId],
  );
  const submittal = rows[0];
  if (!submittal) throw new AecError("submittal_not_found");

  const reviewerUserId = optionalUuid(input.reviewerUserId);
  await assertUserOwned(owner.businessId, reviewerUserId);
  const documentId = (await resolveRevisionDocument(owner, submittal.project_id, input)) ?? null;

  const { rows: created } = await query<{ id: string }>(
    `INSERT INTO aec_submittal_revisions
       (business_id, submittal_id, revision_no, workspace_document_id, due_date,
        reviewer_user_id, reviewer_name, notes, created_by, created_by_name, status)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, 'draft')
     RETURNING id`,
    [
      owner.businessId,
      submittalId,
      revisionNo,
      documentId,
      optionalDate(input.dueDate),
      reviewerUserId,
      trimTo(input.reviewerName, 200),
      trimTo(input.notes, 4000),
      owner.actorUserId,
      owner.actorName ?? "",
    ],
  );
  return created[0].id;
}

export async function updateSubmittal(
  owner: WorkspaceOwner,
  submittalId: string,
  input: SubmittalInput,
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(owner.businessId);
  const current = await loadSubmittal(owner.businessId, submittalId);
  // The register's identity is frozen once it has a revision with a reviewer —
  // the same rule migration 0198's `aec_submittal_guard()` enforces.
  const hasOutstanding = current.revisions.some((revision) => revision.status !== "draft");
  if (hasOutstanding && (input.submittalNumber !== undefined || input.submissionType !== undefined
      || input.specSection !== undefined)) {
    throw new AecError("submittal_not_editable");
  }

  const submittalNumber = input.submittalNumber === undefined
    ? current.submittalNumber
    : trimTo(input.submittalNumber, 60);
  if (!submittalNumber) throw new AecError("submittal_number_required");
  const title = input.title === undefined ? current.title : trimTo(input.title, 300);
  if (!title) throw new AecError("submittal_title_required");
  const submissionType = input.submissionType === undefined
    ? current.submissionType
    : trimTo(input.submissionType, 40);
  if (!isSubmittalType(submissionType)) throw new AecError("invalid_submittal_type");
  const discipline = input.discipline === undefined
    ? current.discipline
    : trimTo(input.discipline, 40) || null;
  if (discipline && !isAecSpecialty(discipline)) throw new AecError("invalid_discipline");
  const responsiblePartyId =
    input.responsiblePartyId === undefined
      ? current.responsiblePartyId
      : optionalUuid(input.responsiblePartyId);
  await assertPartyOwned(owner.businessId, responsiblePartyId);
  const documentId = input.documentId === undefined ? current.documentId : optionalUuid(input.documentId);
  await assertDocumentOwned(owner.businessId, documentId);

  if (submittalNumber !== current.submittalNumber) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM aec_submittals
        WHERE project_id = $1 AND submittal_number = $2 AND id <> $3`,
      [current.projectId, submittalNumber, submittalId],
    );
    if (rows[0]) throw new AecError("submittal_number_taken");
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_submittals
          SET submittal_number = $3, title = $4, submission_type = $5, spec_section = $6,
              discipline = $7, document_id = $8, responsible_party_id = $9,
              response_required_by = $10::date, notes = $11, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        submittalId,
        submittalNumber,
        title,
        submissionType,
        input.specSection === undefined ? current.specSection : trimTo(input.specSection, 120),
        discipline,
        documentId,
        responsiblePartyId,
        input.responseRequiredBy === undefined
          ? current.responseRequiredBy
          : optionalDate(input.responseRequiredBy),
        input.notes === undefined ? current.notes : trimTo(input.notes, 4000),
      ],
    );
    if (input.attachments !== undefined) {
      await replaceAttachments(owner, { submittalId }, current.projectId, input.attachments);
    }
  });

  return loadSubmittal(owner.businessId, submittalId);
}

export async function deleteSubmittal(
  owner: WorkspaceOwner,
  submittalId: string,
): Promise<void> {
  await assertSubmittalsEnabled(owner.businessId);
  const current = await loadSubmittal(owner.businessId, submittalId);
  if (current.revisions.some((revision) => revision.status !== "draft")) {
    throw new AecError("submittal_has_submitted_revisions");
  }
  await query(`DELETE FROM aec_submittals WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    submittalId,
  ]);
}

/** A new draft revision: the «اصلاح و ارسال مجدد» step, and the import path. */
export async function addSubmittalRevision(
  owner: WorkspaceOwner,
  submittalId: string,
  input: {
    workspaceDocumentId?: unknown;
    dueDate?: unknown;
    reviewerUserId?: unknown;
    reviewerName?: unknown;
    notes?: unknown;
  } = {},
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(owner.businessId);
  const current = await loadSubmittal(owner.businessId, submittalId);
  const nextNo = current.revisions.reduce((max, r) => (r.revisionNo > max ? r.revisionNo : max), 0) + 1;
  await insertSubmittalRevision(owner, submittalId, nextNo, input);
  await recordRfiActivity(owner, {
    projectId: current.projectId,
    subjectType: "submittal",
    subjectId: submittalId,
    action: "revision_added",
    summary: `بازنگری ${nextNo} سابمیتال ${current.submittalNumber} ساخته شد`,
  });
  return loadSubmittal(owner.businessId, submittalId);
}

export async function updateSubmittalRevision(
  owner: WorkspaceOwner,
  revisionId: string,
  input: {
    workspaceDocumentId?: unknown;
    mediaAssetId?: unknown;
    dueDate?: unknown;
    reviewerUserId?: unknown;
    reviewerName?: unknown;
    notes?: unknown;
  },
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(owner.businessId);
  const { submittalId, projectId } = await submittalRevisionProjectId(owner.businessId, revisionId);
  const detail = await loadSubmittal(owner.businessId, submittalId);
  const revision = detail.revisions.find((row) => row.id === revisionId);
  if (!revision) throw new AecError("submittal_revision_not_found");
  if (!isEditableSubmittal(revision.status)) throw new AecError("submittal_revision_not_editable");

  const reviewerUserId = input.reviewerUserId === undefined
    ? revision.reviewerUserId
    : optionalUuid(input.reviewerUserId);
  await assertUserOwned(owner.businessId, reviewerUserId);

  const resolvedDocument = await resolveRevisionDocument(owner, projectId, input);

  await query(
    `UPDATE aec_submittal_revisions
        SET workspace_document_id = $3, due_date = $4::date, reviewer_user_id = $5,
            reviewer_name = $6, notes = $7, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      owner.businessId,
      revisionId,
      resolvedDocument === undefined ? revision.workspaceDocumentId : resolvedDocument,
      input.dueDate === undefined ? revision.dueDate : optionalDate(input.dueDate),
      reviewerUserId,
      input.reviewerName === undefined ? revision.reviewerName : trimTo(input.reviewerName, 200),
      input.notes === undefined ? revision.notes : trimTo(input.notes, 4000),
    ],
  );
  return loadSubmittal(owner.businessId, submittalId);
}

export async function deleteSubmittalRevision(
  owner: WorkspaceOwner,
  revisionId: string,
): Promise<void> {
  await assertSubmittalsEnabled(owner.businessId);
  const { rows } = await query<{ status: string; revision_no: number }>(
    `SELECT status, revision_no FROM aec_submittal_revisions
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, revisionId],
  );
  if (!rows[0]) throw new AecError("submittal_revision_not_found");
  if (rows[0].status !== "draft") throw new AecError("submittal_revision_not_editable");
  if (rows[0].revision_no === 1) throw new AecError("submittal_first_revision_required");
  await query(`DELETE FROM aec_submittal_revisions WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    revisionId,
  ]);
}

/* ===========================================================================
 * The submission cycle
 * ======================================================================== */

/** §11's "Submitted": freeze the revision and file the review in the queue. */
export async function submitSubmittalRevision(
  owner: WorkspaceOwner,
  revisionId: string,
  input: { approverUserId?: unknown; dueDate?: unknown; note?: unknown } = {},
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(owner.businessId);
  const { submittalId, projectId } = await submittalRevisionProjectId(owner.businessId, revisionId);
  const detail = await loadSubmittal(owner.businessId, submittalId);
  const revision = detail.revisions.find((row) => row.id === revisionId);
  if (!revision) throw new AecError("submittal_revision_not_found");
  if (!canTransitionSubmittal(revision.status, "submitted")) {
    throw new AecError("invalid_submittal_transition");
  }
  if (!revision.workspaceDocumentId) throw new AecError("submittal_file_required");

  const approverUserId = optionalUuid(input.approverUserId);
  await assertUserOwned(owner.businessId, approverUserId);
  const dueDate = input.dueDate === undefined ? revision.dueDate : optionalDate(input.dueDate);

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_submittal_revisions
          SET status = 'submitted', submitted_by = $3, submitted_by_name = $4,
              submitted_at = now(), due_date = $5::date, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [owner.businessId, revisionId, owner.actorUserId, owner.actorName ?? "", dueDate],
    );

    const title = `${detail.submittalNumber} — ${detail.title} (بازنگری ${revision.revisionNo})`;
    await query(
      `INSERT INTO workspace_approvals
         (business_id, subject_type, subject_id, project_id, title, requested_by,
          approver_user_id, due_date, note)
       VALUES ($1, 'submittal_revision', $2, $3, $4, $5, $6, $7::date, $8)`,
      [
        owner.businessId,
        revisionId,
        projectId,
        title,
        owner.actorUserId,
        approverUserId,
        dueDate,
        trimTo(input.note, 1000),
      ],
    );
    await recordRfiActivity(owner, {
      projectId,
      subjectType: "submittal",
      subjectId: submittalId,
      action: "submitted",
      summary: `بازنگری ${revision.revisionNo} سابمیتال ${detail.submittalNumber} ارسال شد`,
    });
  });

  return loadSubmittal(owner.businessId, submittalId);
}

/** The reviewer picked it up. `workspace.approve` at the route, per §24. */
export async function startSubmittalReview(
  owner: WorkspaceOwner,
  revisionId: string,
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(owner.businessId);
  const { submittalId, projectId } = await submittalRevisionProjectId(owner.businessId, revisionId);
  const detail = await loadSubmittal(owner.businessId, submittalId);
  const revision = detail.revisions.find((row) => row.id === revisionId);
  if (!revision) throw new AecError("submittal_revision_not_found");
  if (!canTransitionSubmittal(revision.status, "under_review")) {
    throw new AecError("invalid_submittal_transition");
  }
  await query(
    `UPDATE aec_submittal_revisions
        SET status = 'under_review',
            reviewer_user_id = COALESCE(reviewer_user_id, $3),
            reviewer_name = CASE WHEN btrim(reviewer_name) = '' THEN $4 ELSE reviewer_name END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, revisionId, owner.actorUserId, owner.actorName ?? ""],
  );
  await recordRfiActivity(owner, {
    projectId,
    subjectType: "submittal",
    subjectId: submittalId,
    action: "under_review",
    summary: `بررسی بازنگری ${revision.revisionNo} سابمیتال ${detail.submittalNumber} آغاز شد`,
  });
  return loadSubmittal(owner.businessId, submittalId);
}

/**
 * §11's four determinations, made from the submittal screen.
 *
 * On «اصلاح و ارسال مجدد» the next draft revision is created in the same
 * transaction: that is what the request means, and leaving it to a second click
 * would let a submittal sit "returned" with nothing to edit.
 */
export async function decideSubmittalRevision(
  owner: WorkspaceOwner,
  revisionId: string,
  decision: SubmittalDecision,
  note = "",
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(owner.businessId);
  const { submittalId, projectId } = await submittalRevisionProjectId(owner.businessId, revisionId);
  const detail = await loadSubmittal(owner.businessId, submittalId);
  const revision = detail.revisions.find((row) => row.id === revisionId);
  if (!revision) throw new AecError("submittal_revision_not_found");
  if (!canTransitionSubmittal(revision.status, decision)) {
    throw new AecError("invalid_submittal_transition");
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_submittal_revisions
          SET status = $3, response = $4, decided_by = $5, decided_by_name = $6,
              decided_at = now(),
              reviewer_user_id = COALESCE(reviewer_user_id, $5),
              reviewer_name = CASE WHEN btrim(reviewer_name) = '' THEN $6 ELSE reviewer_name END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        revisionId,
        decision,
        trimTo(note, 4000) || revision.response,
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );

    if (decision === "revise_and_resubmit") {
      const nextNo =
        detail.revisions.reduce((max, row) => (row.revisionNo > max ? row.revisionNo : max), 0) + 1;
      await insertSubmittalRevision(owner, submittalId, nextNo, {
        dueDate: revision.dueDate,
        reviewerUserId: revision.reviewerUserId,
        reviewerName: revision.reviewerName,
      });
    }

    await recordRfiActivity(owner, {
      projectId,
      subjectType: "submittal",
      subjectId: submittalId,
      action: "decided",
      summary: `بازنگری ${revision.revisionNo} سابمیتال ${detail.submittalNumber} — ${SUBMITTAL_STATUS_LABELS[decision]}`,
    });
  });

  return loadSubmittal(owner.businessId, submittalId);
}

/** §11's «Closed». */
export async function closeSubmittalRevision(
  owner: WorkspaceOwner,
  revisionId: string,
): Promise<SubmittalDetail> {
  await assertSubmittalsEnabled(owner.businessId);
  const { submittalId, projectId } = await submittalRevisionProjectId(owner.businessId, revisionId);
  const detail = await loadSubmittal(owner.businessId, submittalId);
  const revision = detail.revisions.find((row) => row.id === revisionId);
  if (!revision) throw new AecError("submittal_revision_not_found");
  if (!canTransitionSubmittal(revision.status, "closed")) {
    throw new AecError("invalid_submittal_transition");
  }
  await query(
    `UPDATE aec_submittal_revisions
        SET status = 'closed', closed_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, revisionId],
  );
  await recordRfiActivity(owner, {
    projectId,
    subjectType: "submittal",
    subjectId: submittalId,
    action: "closed",
    summary: `بازنگری ${revision.revisionNo} سابمیتال ${detail.submittalNumber} بسته شد`,
  });
  return loadSubmittal(owner.businessId, submittalId);
}

/**
 * Decide a review through the approval it filed — the path the approvals queue
 * and the notification e-mail take, as opposed to the buttons on the submittal
 * screen. Both call the same functions above, so there is one implementation of
 * "approved" and one of "rejected".
 *
 * Deliberately NOT gated on `document_control`, like the BOQ's equivalent and
 * for the same reason: a request that is already in the queue must be decidable
 * even if the business has since switched the capability off, or the queue would
 * keep an item nobody can ever clear.
 */
export async function decideSubmittalApproval(
  owner: WorkspaceOwner,
  approvalId: string,
  decision: "approved" | "rejected" | "cancelled",
  note = "",
): Promise<{ revisionId: string | null; applied: boolean }> {
  await assertAecIndustry(owner.businessId);
  const { rows } = await query<{ subject_id: string; status: string }>(
    `SELECT subject_id, status FROM workspace_approvals
      WHERE business_id = $1 AND id = $2 AND subject_type = 'submittal_revision'`,
    [owner.businessId, approvalId],
  );
  const approval = rows[0];
  if (!approval) throw new AecError("approval_not_found");
  if (approval.status !== "pending") return { revisionId: approval.subject_id, applied: false };

  const { submittalId } = await submittalRevisionProjectId(owner.businessId, approval.subject_id);
  const detail = await loadSubmittal(owner.businessId, submittalId);
  const revision = detail.revisions.find((row) => row.id === approval.subject_id);
  if (!revision) throw new AecError("submittal_revision_not_found");

  if (decision === "cancelled") {
    await query(
      `UPDATE workspace_approvals
          SET status = 'cancelled', decided_by = $3, decided_at = now(),
              note = COALESCE(NULLIF($4, ''), note), updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [owner.businessId, approvalId, owner.actorUserId, trimTo(note, 1000)],
    );
    return { revisionId: approval.subject_id, applied: true };
  }

  // The queue's two decisions are the two the four outcomes contain verbatim:
  // "revise and resubmit" and "approved with comments" need the note they were
  // accompanied by, and the queue's comment box cannot say which of the two was
  // meant, so the submittal screen is where those are chosen.
  const mapped: SubmittalDecision = decision === "approved" ? "approved" : "rejected";
  await decideSubmittalRevision(owner, approval.subject_id, mapped, note);
  await query(
    `UPDATE workspace_approvals
        SET status = $3, decided_by = $4, decided_at = now(),
            note = COALESCE(NULLIF($5, ''), note), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, approvalId, decision, owner.actorUserId, trimTo(note, 1000)],
  );
  return { revisionId: approval.subject_id, applied: true };
}

/** §22/§23 — the reviews nobody has answered yet. */
export async function pendingSubmittals(
  businessId: string,
  options: { projectId?: string | null; limit?: number } = {},
): Promise<PendingSubmittalRow[]> {
  await assertSubmittalsEnabled(businessId);
  const today = await businessToday(businessId);
  const params: unknown[] = [businessId];
  const where = ["s.business_id = $1", "s.latest_revision_status IN ('submitted', 'under_review')"];
  if (options.projectId) {
    params.push(options.projectId);
    where.push(`s.project_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 25, 1), 100));
  const { rows } = await query<Record<string, unknown>>(
    `SELECT s.id, s.project_id, p.name AS project_name, s.submittal_number, s.title,
            s.submission_type, s.latest_revision_status, r.due_date::text AS due_date,
            r.reviewer_name
       FROM aec_submittals s
       JOIN ai_projects p ON p.id = s.project_id
       LEFT JOIN aec_submittal_revisions r ON r.id = s.latest_revision_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.due_date NULLS LAST, s.submittal_number
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => {
    const status = isSubmittalStatus(String(row.latest_revision_status))
      ? (row.latest_revision_status as SubmittalStatus)
      : "submitted";
    const dueDate = (row.due_date as string | null) ?? null;
    const type = isSubmittalType(String(row.submission_type))
      ? (row.submission_type as SubmittalType)
      : "other";
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      projectName: String(row.project_name ?? ""),
      submittalNumber: String(row.submittal_number ?? ""),
      title: String(row.title ?? ""),
      submissionTypeLabel: SUBMITTAL_TYPE_LABELS[type],
      reviewerName: String(row.reviewer_name ?? ""),
      dueDate,
      daysOverdue: daysBetween(dueDate ?? "", today),
      status,
      statusLabel: SUBMITTAL_STATUS_LABELS[status],
    };
  });
}

/**
 * Every waiting record of one business, for the overdue notification scan.
 *
 * RFIs are read whenever the business is AEC at all; submittals only when the
 * capability is on, because `pendingSubmittals` refuses otherwise and a scan that
 * threw for one tenant would stop the rest of the sweep.
 */
export async function overdueRegisters(
  businessId: string,
): Promise<{ rfis: PendingRfiRow[]; submittals: PendingSubmittalRow[] }> {
  const capabilities = await rfiCapabilities(businessId);
  const rfis = await pendingRfis(businessId, { limit: 100 });
  const submittals = capabilities.includes("document_control")
    ? await pendingSubmittals(businessId, { limit: 100 })
    : [];
  return { rfis, submittals };
}
