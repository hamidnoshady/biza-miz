/**
 * Issue #799 §9 and §12 — the document-control service: the drawing register,
 * its revisions, and the transmittals that issue them.
 *
 * The shapes and the rules live in `aec-docs.ts` (pure); this file is the part
 * that talks to PostgreSQL. It follows `aec-boq-service.ts`'s conventions: every
 * write takes a `WorkspaceOwner`, every read takes a `businessId`, every refusal
 * is an `AecError` code the API guard maps to a status, and the migration's
 * constraints are the backstop rather than the first line.
 *
 * ## The three things this file is careful about
 *
 *   * **It never rewrites history.** A revision that is no longer a draft is
 *     refused here *and* by migration 0197's trigger — there is no branch in
 *     this file that could update one, because editing an issued drawing is not
 *     a thing the product does. The way to correct an issued revision is to
 *     register the next one, which supersedes it.
 *   * **It reuses `workspace_documents` rather than copying it.** Choosing a
 *     file from the Media Library for a revision creates the document row that
 *     every other screen already understands (title, project, review status,
 *     comments, version chain), and the revision points at it. That is what
 *     makes §9's "reuse `workspace_documents`, Media Library" literal instead
 *     of aspirational, and it is why the register never stores bytes.
 *   * **Issuing is one transaction.** A transmittal's status, the revisions it
 *     carries and the superseding of the previous revision all move together,
 *     so the register can never show a revision as issued while the transmittal
 *     that issued it is still a draft.
 */
import {
  disciplineLabel,
  DOCUMENT_TYPE_LABELS,
  isDocumentType,
  isIssuePurpose,
  ISSUE_PURPOSE_LABELS,
  nextRevisionNumber,
  REVISION_STATUS_LABELS,
  suggestRevisionCode,
  TRANSMITTAL_STATUS_LABELS,
  type DocumentType,
  type IssuePurpose,
  type RevisionStatus,
  type TransmittalStatus,
} from "./aec-docs";
import { isAecSpecialty } from "./aec";
import { AecError, assertAecIndustry, loadBusinessAecProfile } from "./aec-service";
import { businessToday } from "./business-day-service";
import { query, withTenantTransaction } from "./db";
import { recordActivity, type WorkspaceOwner } from "./workspace";

/* ===========================================================================
 * Coercion
 * ======================================================================== */

function trimTo(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}

/** ISO `YYYY-MM-DD` or null. The UI converts from Shamsi; the database only ever sees Gregorian (issue §5). */
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

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value) === "true";
}

/* ===========================================================================
 * Shapes
 * ======================================================================== */

/** A transmittal a revision went out on — the answer to «این بازنگری کجا رفت؟». */
export interface RevisionTransmittalRef {
  id: string;
  transmittalNumber: string;
  status: TransmittalStatus;
  statusLabel: string;
  issueDate: string | null;
  purpose: IssuePurpose;
  purposeLabel: string;
}

export interface DrawingRevisionSummary {
  id: string;
  documentId: string;
  revisionNo: number;
  revisionCode: string;
  revisionDate: string | null;
  issuePurpose: IssuePurpose;
  issuePurposeLabel: string;
  status: RevisionStatus;
  statusLabel: string;
  isEditable: boolean;
  preparedByName: string;
  checkedByName: string;
  approvedByName: string;
  notes: string;
  workspaceDocumentId: string | null;
  fileName: string | null;
  mimeType: string | null;
  issuedAt: string | null;
  issuedByName: string;
  createdAt: string;
  createdByName: string;
  /** Where this revision was sent. Empty until it is issued on a transmittal. */
  transmittals: RevisionTransmittalRef[];
}

/** One row of the register: a document and its current revision. */
export interface DrawingSummary {
  id: string;
  projectId: string;
  documentNumber: string;
  drawingNumber: string;
  title: string;
  documentType: DocumentType;
  documentTypeLabel: string;
  discipline: string | null;
  disciplineLabel: string;
  notes: string;
  phaseId: string | null;
  phaseName: string | null;
  taskId: string | null;
  latestRevisionId: string | null;
  latestRevisionNo: number | null;
  latestRevisionCode: string;
  latestRevisionStatus: RevisionStatus | null;
  latestRevisionStatusLabel: string | null;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
  createdByName: string;
}

export interface DrawingDetail extends DrawingSummary {
  /** Newest revision first — the order the register reads in. */
  revisions: DrawingRevisionSummary[];
}

export interface TransmittalItemSummary {
  id: string;
  revisionId: string;
  documentId: string;
  documentNumber: string;
  documentTitle: string;
  revisionCode: string;
  issuePurpose: IssuePurpose;
  issuePurposeLabel: string;
  note: string;
  /** The revision's *current* status, so the screen can mark a superseded line. */
  revisionStatus: RevisionStatus;
  revisionStatusLabel: string;
}

export interface TransmittalRecipientSummary {
  id: string;
  partyId: string;
  partyName: string;
  requiresAcknowledgement: boolean;
  acknowledgedAt: string | null;
  acknowledgedByName: string;
  note: string;
}

export interface TransmittalSummary {
  id: string;
  projectId: string;
  transmittalNumber: string;
  subject: string;
  senderPartyId: string | null;
  senderPartyName: string | null;
  issueDate: string | null;
  purpose: IssuePurpose;
  purposeLabel: string;
  status: TransmittalStatus;
  statusLabel: string;
  itemCount: number;
  recipientCount: number;
  pendingAcknowledgements: number;
  issuedAt: string | null;
  issuedByName: string;
  acknowledgedAt: string | null;
  createdAt: string;
  createdByName: string;
}

export interface TransmittalDetail extends TransmittalSummary {
  comments: string;
  items: TransmittalItemSummary[];
  recipients: TransmittalRecipientSummary[];
}

/* ===========================================================================
 * Queries
 * ======================================================================== */

// Dates and timestamps are cast to text in SQL, the repo's own convention
// (`workspace.ts`, `aec-boq-service.ts`): node-postgres would otherwise hand
// back `Date` objects for `date`/`timestamptz`, and every screen would then be
// formatting whatever `String(date)` happens to produce.
const DRAWING_SELECT = `
  d.id, d.project_id, d.document_number, d.drawing_number, d.title, d.document_type,
  d.discipline, d.notes, d.phase_id, ph.name AS phase_name, d.task_id,
  d.latest_revision_id, d.latest_revision_no, d.latest_revision_code,
  d.latest_revision_status, d.revision_count,
  d.created_at::text AS created_at, d.updated_at::text AS updated_at, d.created_by_name`;

const DRAWING_JOINS = `
  FROM aec_documents d
  LEFT JOIN workspace_project_phases ph ON ph.id = d.phase_id`;

function toDrawing(row: Record<string, unknown>): DrawingSummary {
  const r = row as Record<string, string | number | null>;
  const status = (r.latest_revision_status as RevisionStatus | null) ?? null;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    documentNumber: String(r.document_number ?? ""),
    drawingNumber: String(r.drawing_number ?? ""),
    title: String(r.title ?? ""),
    documentType: r.document_type as DocumentType,
    documentTypeLabel: DOCUMENT_TYPE_LABELS[r.document_type as DocumentType] ?? "",
    discipline: (r.discipline as string | null) ?? null,
    disciplineLabel: disciplineLabel((r.discipline as string | null) ?? null),
    notes: String(r.notes ?? ""),
    phaseId: (r.phase_id as string | null) ?? null,
    phaseName: (r.phase_name as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    latestRevisionId: (r.latest_revision_id as string | null) ?? null,
    latestRevisionNo: r.latest_revision_no === null || r.latest_revision_no === undefined
      ? null
      : Number(r.latest_revision_no),
    latestRevisionCode: String(r.latest_revision_code ?? ""),
    latestRevisionStatus: status,
    latestRevisionStatusLabel: status ? REVISION_STATUS_LABELS[status] : null,
    revisionCount: Number(r.revision_count ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    createdByName: String(r.created_by_name ?? ""),
  };
}

const REVISION_SELECT = `
  r.id, r.document_id, r.revision_no, r.revision_code,
  r.revision_date::text AS revision_date, r.issue_purpose,
  r.status, r.prepared_by_name, r.checked_by_name, r.approved_by_name, r.notes,
  r.workspace_document_id, ma.file_name, ma.mime_type,
  r.issued_at::text AS issued_at, r.issued_by_name,
  r.created_at::text AS created_at, r.created_by_name`;

const REVISION_JOINS = `
  LEFT JOIN media_assets ma ON ma.id = (
    SELECT wd.media_asset_id FROM workspace_documents wd WHERE wd.id = r.workspace_document_id
  )`;

function toRevision(row: Record<string, unknown>): Omit<DrawingRevisionSummary, "transmittals"> {
  const r = row as Record<string, string | number | null>;
  const status = r.status as RevisionStatus;
  const purpose = r.issue_purpose as IssuePurpose;
  return {
    id: String(r.id),
    documentId: String(r.document_id),
    revisionNo: Number(r.revision_no),
    revisionCode: String(r.revision_code ?? ""),
    revisionDate: (r.revision_date as string | null) ?? null,
    issuePurpose: purpose,
    issuePurposeLabel: ISSUE_PURPOSE_LABELS[purpose] ?? "",
    status,
    statusLabel: REVISION_STATUS_LABELS[status] ?? "",
    isEditable: status === "draft",
    preparedByName: String(r.prepared_by_name ?? ""),
    checkedByName: String(r.checked_by_name ?? ""),
    approvedByName: String(r.approved_by_name ?? ""),
    notes: String(r.notes ?? ""),
    workspaceDocumentId: (r.workspace_document_id as string | null) ?? null,
    fileName: (r.file_name as string | null) ?? null,
    mimeType: (r.mime_type as string | null) ?? null,
    issuedAt: (r.issued_at as string | null) ?? null,
    issuedByName: String(r.issued_by_name ?? ""),
    createdAt: String(r.created_at),
    createdByName: String(r.created_by_name ?? ""),
  };
}

function toTransmittal(row: Record<string, unknown>): TransmittalSummary {
  const r = row as Record<string, string | number | null>;
  const status = r.status as TransmittalStatus;
  const purpose = r.purpose as IssuePurpose;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    transmittalNumber: String(r.transmittal_number ?? ""),
    subject: String(r.subject ?? ""),
    senderPartyId: (r.sender_party_id as string | null) ?? null,
    senderPartyName: (r.sender_party_name as string | null) ?? null,
    issueDate: (r.issue_date as string | null) ?? null,
    purpose,
    purposeLabel: ISSUE_PURPOSE_LABELS[purpose] ?? "",
    status,
    statusLabel: TRANSMITTAL_STATUS_LABELS[status] ?? "",
    itemCount: Number(r.item_count ?? 0),
    recipientCount: Number(r.recipient_count ?? 0),
    pendingAcknowledgements: Number(r.pending_acknowledgements ?? 0),
    issuedAt: (r.issued_at as string | null) ?? null,
    issuedByName: String(r.issued_by_name ?? ""),
    acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
    createdAt: String(r.created_at),
    createdByName: String(r.created_by_name ?? ""),
  };
}

const TRANSMITTAL_SELECT = `
  t.id, t.project_id, t.transmittal_number, t.subject, t.sender_party_id,
  party.name AS sender_party_name, t.issue_date::text AS issue_date, t.purpose, t.status,
  t.issued_at::text AS issued_at, t.issued_by_name, t.acknowledged_at::text AS acknowledged_at,
  t.created_at::text AS created_at, t.created_by_name,
  (SELECT count(*) FROM aec_transmittal_items i WHERE i.transmittal_id = t.id) AS item_count,
  (SELECT count(*) FROM aec_transmittal_recipients rec WHERE rec.transmittal_id = t.id) AS recipient_count,
  (SELECT count(*) FROM aec_transmittal_recipients rec
    WHERE rec.transmittal_id = t.id AND rec.requires_acknowledgement
      AND rec.acknowledged_at IS NULL) AS pending_acknowledgements`;

const TRANSMITTAL_JOINS = `
  FROM aec_transmittals t
  LEFT JOIN parties party ON party.id = t.sender_party_id`;

/* ===========================================================================
 * Guards
 * ======================================================================== */

/** §9 needs the industry and the `document_control` capability, exactly as §7 needed `boq`. */
async function assertDocumentControlEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes("document_control")) throw new AecError("capability_disabled");
}

async function assertProjectOwned(businessId: string, projectId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [businessId, projectId],
  );
  if (!rows[0]) throw new AecError("project_not_found");
}

/** The project a drawing belongs to — the route needs it to check the project role. */
export async function drawingProjectId(businessId: string, drawingId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_documents WHERE business_id = $1 AND id = $2`,
    [businessId, drawingId],
  );
  if (!rows[0]) throw new AecError("drawing_not_found");
  return rows[0].project_id;
}

export async function transmittalProjectId(
  businessId: string,
  transmittalId: string,
): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_transmittals WHERE business_id = $1 AND id = $2`,
    [businessId, transmittalId],
  );
  if (!rows[0]) throw new AecError("transmittal_not_found");
  return rows[0].project_id;
}

/** The document a revision belongs to, and that document's project. */
async function loadRevisionContext(
  businessId: string,
  revisionId: string,
): Promise<{ documentId: string; projectId: string; status: RevisionStatus }> {
  const { rows } = await query<{ document_id: string; project_id: string; status: RevisionStatus }>(
    `SELECT r.document_id, d.project_id, r.status
       FROM aec_document_revisions r
       JOIN aec_documents d ON d.id = r.document_id
      WHERE r.business_id = $1 AND r.id = $2`,
    [businessId, revisionId],
  );
  if (!rows[0]) throw new AecError("revision_not_found");
  return {
    documentId: rows[0].document_id,
    projectId: rows[0].project_id,
    status: rows[0].status,
  };
}

export async function revisionProjectId(businessId: string, revisionId: string): Promise<string> {
  const context = await loadRevisionContext(businessId, revisionId);
  return context.projectId;
}

/* ===========================================================================
 * Activity
 * ======================================================================== */

async function recordDocActivity(
  owner: WorkspaceOwner,
  entry: {
    projectId: string;
    subjectType: "document" | "document_revision" | "transmittal";
    subjectId: string | null;
    action: string;
    summary: string;
  },
): Promise<void> {
  await recordActivity(owner, entry);
}

/* ===========================================================================
 * The register
 * ======================================================================== */

export async function listProjectDrawings(
  businessId: string,
  projectId: string,
  options: { search?: string; discipline?: string } = {},
): Promise<DrawingSummary[]> {
  await assertDocumentControlEnabled(businessId);
  const params: unknown[] = [businessId, projectId];
  const where = ["d.business_id = $1", "d.project_id = $2"];
  const search = trimTo(options.search, 100);
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(d.document_number ILIKE $${params.length} OR d.drawing_number ILIKE $${params.length}
        OR d.title ILIKE $${params.length})`,
    );
  }
  if (options.discipline && isAecSpecialty(options.discipline)) {
    params.push(options.discipline);
    where.push(`d.discipline = $${params.length}`);
  }

  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${DRAWING_SELECT} ${DRAWING_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY d.document_number`,
    params,
  );
  return rows.map(toDrawing);
}

export async function loadDrawing(businessId: string, drawingId: string): Promise<DrawingDetail> {
  await assertDocumentControlEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${DRAWING_SELECT} ${DRAWING_JOINS}
      WHERE d.business_id = $1 AND d.id = $2`,
    [businessId, drawingId],
  );
  if (!rows[0]) throw new AecError("drawing_not_found");
  const drawing = toDrawing(rows[0]);

  const { rows: revisionRows } = await query<Record<string, unknown>>(
    `SELECT ${REVISION_SELECT} FROM aec_document_revisions r ${REVISION_JOINS}
      WHERE r.business_id = $1 AND r.document_id = $2
      ORDER BY r.revision_no DESC`,
    [businessId, drawingId],
  );
  // Which transmittals each revision went out on — the answer to «این بازنگری
  // کجا رفت؟», loaded in one query for the whole history.
  const sent = await loadRevisionTransmittals(
    businessId,
    revisionRows.map((row) => String(row.id)),
  );

  return {
    ...drawing,
    revisions: revisionRows.map((row) => ({
      ...toRevision(row),
      transmittals: sent.get(String(row.id)) ?? [],
    })),
  };
}

export async function createDrawing(
  owner: WorkspaceOwner,
  projectId: string,
  input: Record<string, unknown>,
): Promise<DrawingSummary> {
  await assertDocumentControlEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);

  const documentNumber = trimTo(input.documentNumber, 60);
  if (!documentNumber) throw new AecError("document_number_required");
  const title = trimTo(input.title, 300);
  if (!title) throw new AecError("drawing_title_required");

  const documentType = trimTo(input.documentType, 30) || "drawing";
  if (!isDocumentType(documentType)) throw new AecError("invalid_document_type");
  const discipline = trimTo(input.discipline, 40);
  if (discipline && !isAecSpecialty(discipline)) throw new AecError("invalid_discipline");

  const { rows: duplicate } = await query<{ id: string }>(
    `SELECT id FROM aec_documents WHERE project_id = $1 AND document_number = $2`,
    [projectId, documentNumber],
  );
  if (duplicate[0]) throw new AecError("document_number_taken");

  const { rows } = await query<{ id: string }>(
    `INSERT INTO aec_documents
       (business_id, project_id, document_number, drawing_number, title, document_type,
        discipline, phase_id, task_id, notes, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      owner.businessId,
      projectId,
      documentNumber,
      trimTo(input.drawingNumber, 60),
      title,
      documentType,
      discipline || null,
      optionalUuid(input.phaseId),
      optionalUuid(input.taskId),
      trimTo(input.notes, 2000),
      owner.actorUserId,
      owner.actorName ?? "",
    ],
  );

  await recordDocActivity(owner, {
    projectId,
    subjectType: "document",
    subjectId: rows[0].id,
    action: "created",
    summary: `سند «${documentNumber} — ${title}» در دفتر نقشهها ثبت شد`,
  });

  return loadDrawingSummary(owner.businessId, rows[0].id);
}

async function loadDrawingSummary(businessId: string, drawingId: string): Promise<DrawingSummary> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${DRAWING_SELECT} ${DRAWING_JOINS}
      WHERE d.business_id = $1 AND d.id = $2`,
    [businessId, drawingId],
  );
  if (!rows[0]) throw new AecError("drawing_not_found");
  return toDrawing(rows[0]);
}

export async function updateDrawing(
  owner: WorkspaceOwner,
  drawingId: string,
  input: Record<string, unknown>,
): Promise<DrawingSummary> {
  await assertDocumentControlEnabled(owner.businessId);
  const existing = await loadDrawingSummary(owner.businessId, drawingId);

  const documentNumber = input.documentNumber === undefined
    ? existing.documentNumber
    : trimTo(input.documentNumber, 60);
  if (!documentNumber) throw new AecError("document_number_required");
  const title = input.title === undefined ? existing.title : trimTo(input.title, 300);
  if (!title) throw new AecError("drawing_title_required");

  const documentType = input.documentType === undefined
    ? existing.documentType
    : trimTo(input.documentType, 30);
  if (!isDocumentType(documentType)) throw new AecError("invalid_document_type");

  const discipline = input.discipline === undefined
    ? existing.discipline ?? ""
    : trimTo(input.discipline, 40);
  if (discipline && !isAecSpecialty(discipline)) throw new AecError("invalid_discipline");

  if (documentNumber !== existing.documentNumber) {
    const { rows: duplicate } = await query<{ id: string }>(
      `SELECT id FROM aec_documents
        WHERE project_id = $1 AND document_number = $2 AND id <> $3`,
      [existing.projectId, documentNumber, drawingId],
    );
    if (duplicate[0]) throw new AecError("document_number_taken");
  }

  await query(
    `UPDATE aec_documents
        SET document_number = $3, drawing_number = $4, title = $5, document_type = $6,
            discipline = $7, phase_id = $8, task_id = $9, notes = $10, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      owner.businessId,
      drawingId,
      documentNumber,
      input.drawingNumber === undefined ? existing.drawingNumber : trimTo(input.drawingNumber, 60),
      title,
      documentType,
      discipline || null,
      input.phaseId === undefined ? existing.phaseId : optionalUuid(input.phaseId),
      input.taskId === undefined ? existing.taskId : optionalUuid(input.taskId),
      input.notes === undefined ? existing.notes : trimTo(input.notes, 2000),
    ],
  );

  await recordDocActivity(owner, {
    projectId: existing.projectId,
    subjectType: "document",
    subjectId: drawingId,
    action: "updated",
    summary: `سند «${documentNumber} — ${title}» ویرایش شد`,
  });

  return loadDrawingSummary(owner.businessId, drawingId);
}

/**
 * Deleting a register entry takes its revisions with it (the FK cascades), and
 * the database refuses while any revision is issued: history is superseded, not
 * erased. The files stay in the document library — this service never deletes a
 * `workspace_documents` row, because that row is the documents screen's to
 * manage and may be referenced elsewhere.
 */
export async function deleteDrawing(owner: WorkspaceOwner, drawingId: string): Promise<void> {
  await assertDocumentControlEnabled(owner.businessId);
  const drawing = await loadDrawingSummary(owner.businessId, drawingId);

  const { rows: frozen } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM aec_document_revisions
      WHERE business_id = $1 AND document_id = $2 AND status <> 'draft'`,
    [owner.businessId, drawingId],
  );
  if (Number(frozen[0]?.count ?? 0) > 0) throw new AecError("drawing_has_issued_revisions");

  await query(`DELETE FROM aec_documents WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    drawingId,
  ]);
  await recordDocActivity(owner, {
    projectId: drawing.projectId,
    subjectType: "document",
    subjectId: null,
    action: "deleted",
    summary: `سند «${drawing.documentNumber} — ${drawing.title}» از دفتر نقشهها حذف شد`,
  });
}

/* ===========================================================================
 * Revisions
 * ======================================================================== */

/**
 * Register the next revision of a drawing.
 *
 * The revision number is allocated here (highest + 1) and the code is only
 * *suggested* — a drawing office writes «01», «A» or «C2», so the caller may
 * send anything and the unique constraint is what actually protects the
 * register.
 *
 * A file may arrive two ways, and both are honest about it: `mediaAssetId`
 * creates the `workspace_documents` row for this revision (that is the normal
 * path from the Media Library), while `workspaceDocumentId` links a document
 * that already exists. When the revision has a predecessor, the new document row
 * supersedes the previous revision's file, so the documents screen's own version
 * chain tells the same story as the register.
 */
export async function addRevision(
  owner: WorkspaceOwner,
  drawingId: string,
  input: Record<string, unknown>,
): Promise<DrawingRevisionSummary> {
  await assertDocumentControlEnabled(owner.businessId);
  const drawing = await loadDrawingSummary(owner.businessId, drawingId);

  const issuePurpose = trimTo(input.issuePurpose, 30) || "wip";
  if (!isIssuePurpose(issuePurpose)) throw new AecError("invalid_issue_purpose");

  const { rows: existing } = await query<{ revision_code: string; revision_no: number }>(
    `SELECT revision_code, revision_no FROM aec_document_revisions
      WHERE business_id = $1 AND document_id = $2`,
    [owner.businessId, drawingId],
  );
  const revisionNo = nextRevisionNumber(existing.map((row) => Number(row.revision_no)));
  const revisionCode =
    trimTo(input.revisionCode, 20) ||
    suggestRevisionCode(existing.map((row) => row.revision_code));
  if (revisionCode.length > 20) throw new AecError("invalid_revision_code");

  const { rows: taken } = await query<{ id: string }>(
    `SELECT id FROM aec_document_revisions
      WHERE business_id = $1 AND document_id = $2 AND revision_code = $3`,
    [owner.businessId, drawingId, revisionCode],
  );
  if (taken[0]) throw new AecError("revision_code_taken");

  const revisionId = await withTenantTransaction(owner.businessId, async () => {
    const { rows: previous } = await query<{ workspace_document_id: string | null }>(
      `SELECT r.workspace_document_id
         FROM aec_document_revisions r
        WHERE r.business_id = $1 AND r.document_id = $2
        ORDER BY r.revision_no DESC
        LIMIT 1`,
      [owner.businessId, drawingId],
    );

    let workspaceDocumentId = optionalUuid(input.workspaceDocumentId);
    const mediaAssetId = optionalUuid(input.mediaAssetId);
    if (!workspaceDocumentId && mediaAssetId) {
      const { rows: created } = await query<{ id: string }>(
        `INSERT INTO workspace_documents
           (business_id, media_asset_id, title, description, project_id, status, version,
            supersedes_id, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', 1, $6, $7)
         RETURNING id`,
        [
          owner.businessId,
          mediaAssetId,
          `${drawing.documentNumber} — ${drawing.title} (بازنگری ${revisionCode})`.slice(0, 300),
          `فایل بازنگری ${revisionCode} سند ${drawing.documentNumber}`,
          drawing.projectId,
          previous[0]?.workspace_document_id ?? null,
          owner.actorUserId,
        ],
      );
      workspaceDocumentId = created[0].id;
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_document_revisions
         (business_id, document_id, revision_no, revision_code, revision_date, issue_purpose,
          status, prepared_by_name, checked_by_name, approved_by_name, notes,
          workspace_document_id, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        owner.businessId,
        drawingId,
        revisionNo,
        revisionCode,
        optionalDate(input.revisionDate),
        issuePurpose,
        trimTo(input.preparedByName, 200),
        trimTo(input.checkedByName, 200),
        trimTo(input.approvedByName, 200),
        trimTo(input.notes, 2000),
        workspaceDocumentId,
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    return rows[0].id;
  });

  await recordDocActivity(owner, {
    projectId: drawing.projectId,
    subjectType: "document_revision",
    subjectId: revisionId,
    action: "created",
    summary: `بازنگری ${revisionCode} سند ${drawing.documentNumber} ثبت شد`,
  });

  const loaded = await loadRevision(owner.businessId, revisionId);
  return loaded;
}

async function loadRevision(
  businessId: string,
  revisionId: string,
): Promise<DrawingRevisionSummary> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${REVISION_SELECT} FROM aec_document_revisions r ${REVISION_JOINS}
      WHERE r.business_id = $1 AND r.id = $2`,
    [businessId, revisionId],
  );
  if (!rows[0]) throw new AecError("revision_not_found");
  // A draft revision can already sit on a draft transmittal, so the reference
  // is loaded here too rather than only in the register view.
  const sent = await loadRevisionTransmittals(businessId, [revisionId]);
  return { ...toRevision(rows[0]), transmittals: sent.get(revisionId) ?? [] };
}

/**
 * Which transmittals a set of revisions went out on. One query for a whole
 * register rather than one per revision: a drawing with ten revisions would
 * otherwise be eleven round trips.
 */
async function loadRevisionTransmittals(
  businessId: string,
  revisionIds: readonly string[],
): Promise<Map<string, RevisionTransmittalRef[]>> {
  const sent = new Map<string, RevisionTransmittalRef[]>();
  if (revisionIds.length === 0) return sent;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.revision_id, t.id, t.transmittal_number, t.status,
            t.issue_date::text AS issue_date, t.purpose
       FROM aec_transmittal_items i
       JOIN aec_transmittals t ON t.id = i.transmittal_id
      WHERE i.business_id = $1 AND i.revision_id = ANY($2::uuid[])
      ORDER BY t.issue_date DESC NULLS LAST, t.created_at DESC`,
    [businessId, [...revisionIds]],
  );
  for (const row of rows) {
    const key = String(row.revision_id);
    const status = row.status as TransmittalStatus;
    const purpose = row.purpose as IssuePurpose;
    const list = sent.get(key) ?? [];
    list.push({
      id: String(row.id),
      transmittalNumber: String(row.transmittal_number ?? ""),
      status,
      statusLabel: TRANSMITTAL_STATUS_LABELS[status] ?? "",
      issueDate: (row.issue_date as string | null) ?? null,
      purpose,
      purposeLabel: ISSUE_PURPOSE_LABELS[purpose] ?? "",
    });
    sent.set(key, list);
  }
  return sent;
}

export async function updateRevision(
  owner: WorkspaceOwner,
  revisionId: string,
  input: Record<string, unknown>,
): Promise<DrawingRevisionSummary> {
  await assertDocumentControlEnabled(owner.businessId);
  const context = await loadRevisionContext(owner.businessId, revisionId);
  if (context.status !== "draft") throw new AecError("revision_not_editable");

  const { rows: currentRows } = await query<Record<string, unknown>>(
    `SELECT ${REVISION_SELECT} FROM aec_document_revisions r ${REVISION_JOINS}
      WHERE r.business_id = $1 AND r.id = $2`,
    [owner.businessId, revisionId],
  );
  if (!currentRows[0]) throw new AecError("revision_not_found");
  const current = toRevision(currentRows[0]);

  const revisionCode = input.revisionCode === undefined
    ? current.revisionCode
    : trimTo(input.revisionCode, 20);
  if (!revisionCode) throw new AecError("invalid_revision_code");

  const issuePurpose = input.issuePurpose === undefined
    ? current.issuePurpose
    : trimTo(input.issuePurpose, 30);
  if (!isIssuePurpose(issuePurpose)) throw new AecError("invalid_issue_purpose");

  if (revisionCode !== current.revisionCode) {
    const { rows: taken } = await query<{ id: string }>(
      `SELECT id FROM aec_document_revisions
        WHERE business_id = $1 AND document_id = $2 AND revision_code = $3 AND id <> $4`,
      [owner.businessId, context.documentId, revisionCode, revisionId],
    );
    if (taken[0]) throw new AecError("revision_code_taken");
  }

  await query(
    `UPDATE aec_document_revisions
        SET revision_code = $3, revision_date = $4, issue_purpose = $5,
            prepared_by_name = $6, checked_by_name = $7, approved_by_name = $8,
            notes = $9, workspace_document_id = $10, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      owner.businessId,
      revisionId,
      revisionCode,
      input.revisionDate === undefined ? current.revisionDate : optionalDate(input.revisionDate),
      issuePurpose,
      input.preparedByName === undefined ? current.preparedByName : trimTo(input.preparedByName, 200),
      input.checkedByName === undefined ? current.checkedByName : trimTo(input.checkedByName, 200),
      input.approvedByName === undefined ? current.approvedByName : trimTo(input.approvedByName, 200),
      input.notes === undefined ? current.notes : trimTo(input.notes, 2000),
      input.workspaceDocumentId === undefined
        ? current.workspaceDocumentId
        : optionalUuid(input.workspaceDocumentId),
    ],
  );

  await recordDocActivity(owner, {
    projectId: context.projectId,
    subjectType: "document_revision",
    subjectId: revisionId,
    action: "updated",
    summary: `بازنگری ${revisionCode} ویرایش شد`,
  });

  return loadRevision(owner.businessId, revisionId);
}

export async function deleteRevision(owner: WorkspaceOwner, revisionId: string): Promise<void> {
  await assertDocumentControlEnabled(owner.businessId);
  const context = await loadRevisionContext(owner.businessId, revisionId);
  // The database refuses this too (migration 0197's guard); saying it here is
  // what turns a constraint violation into an answer the screen can show.
  if (context.status !== "draft") throw new AecError("revision_not_editable");

  await query(`DELETE FROM aec_document_revisions WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    revisionId,
  ]);
  await recordDocActivity(owner, {
    projectId: context.projectId,
    subjectType: "document_revision",
    subjectId: null,
    action: "deleted",
    summary: "یک بازنگری پیشنویس حذف شد",
  });
}

/* ===========================================================================
 * Transmittals (§12)
 * ======================================================================== */

export async function listProjectTransmittals(
  businessId: string,
  projectId: string,
): Promise<TransmittalSummary[]> {
  await assertDocumentControlEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${TRANSMITTAL_SELECT} ${TRANSMITTAL_JOINS}
      WHERE t.business_id = $1 AND t.project_id = $2
      ORDER BY t.issue_date DESC NULLS LAST, t.created_at DESC`,
    [businessId, projectId],
  );
  return rows.map(toTransmittal);
}

export async function loadTransmittal(
  businessId: string,
  transmittalId: string,
): Promise<TransmittalDetail> {
  await assertDocumentControlEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${TRANSMITTAL_SELECT}, t.comments ${TRANSMITTAL_JOINS}
      WHERE t.business_id = $1 AND t.id = $2`,
    [businessId, transmittalId],
  );
  if (!rows[0]) throw new AecError("transmittal_not_found");
  const summary = toTransmittal(rows[0]);

  const { rows: itemRows } = await query<Record<string, unknown>>(
    `SELECT i.id, i.revision_id, i.document_number, i.document_title, i.revision_code,
            i.issue_purpose, i.note, r.status AS revision_status, r.document_id
       FROM aec_transmittal_items i
       LEFT JOIN aec_document_revisions r ON r.id = i.revision_id
      WHERE i.business_id = $1 AND i.transmittal_id = $2
      ORDER BY i.document_number, i.revision_code`,
    [businessId, transmittalId],
  );
  const { rows: recipientRows } = await query<Record<string, unknown>>(
    `SELECT rec.id, rec.party_id, p.name AS party_name, rec.requires_acknowledgement,
            rec.acknowledged_at, rec.acknowledged_by_name, rec.note
       FROM aec_transmittal_recipients rec
       LEFT JOIN parties p ON p.id = rec.party_id
      WHERE rec.business_id = $1 AND rec.transmittal_id = $2
      ORDER BY p.name`,
    [businessId, transmittalId],
  );

  return {
    ...summary,
    comments: String((rows[0] as Record<string, string>).comments ?? ""),
    items: itemRows.map((row) => {
      const purpose = row.issue_purpose as IssuePurpose;
      const status = (row.revision_status as RevisionStatus | null) ?? "draft";
      return {
        id: String(row.id),
        revisionId: String(row.revision_id),
        documentId: String(row.document_id ?? ""),
        documentNumber: String(row.document_number ?? ""),
        documentTitle: String(row.document_title ?? ""),
        revisionCode: String(row.revision_code ?? ""),
        issuePurpose: purpose,
        issuePurposeLabel: ISSUE_PURPOSE_LABELS[purpose] ?? "",
        note: String(row.note ?? ""),
        revisionStatus: status,
        revisionStatusLabel: REVISION_STATUS_LABELS[status] ?? "",
      };
    }),
    recipients: recipientRows.map((row) => ({
      id: String(row.id),
      partyId: String(row.party_id),
      partyName: String(row.party_name ?? ""),
      requiresAcknowledgement: row.requires_acknowledgement !== false,
      acknowledgedAt: (row.acknowledged_at as string | null) ?? null,
      acknowledgedByName: String(row.acknowledged_by_name ?? ""),
      note: String(row.note ?? ""),
    })),
  };
}

/** A recipient of a draft transmittal, as the caller may send it. */
interface RecipientInput {
  partyId: string;
  requiresAcknowledgement: boolean;
  note: string;
}

function parseRecipients(value: unknown): RecipientInput[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const recipients: RecipientInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new AecError("invalid_recipient");
    const raw = entry as Record<string, unknown>;
    const partyId = optionalUuid(raw.partyId, "invalid_recipient");
    if (!partyId) throw new AecError("invalid_recipient");
    if (seen.has(partyId)) continue;
    seen.add(partyId);
    recipients.push({
      partyId,
      requiresAcknowledgement: optionalBoolean(raw.requiresAcknowledgement, true),
      note: trimTo(raw.note, 500),
    });
  }
  return recipients;
}

/** Lines of a draft transmittal: which revisions it carries. */
function parseItems(value: unknown): Array<{ revisionId: string; note: string }> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: Array<{ revisionId: string; note: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new AecError("invalid_transmittal_item");
    const raw = entry as Record<string, unknown>;
    const revisionId = optionalUuid(raw.revisionId, "invalid_transmittal_item");
    if (!revisionId) throw new AecError("invalid_transmittal_item");
    if (seen.has(revisionId)) continue;
    seen.add(revisionId);
    items.push({ revisionId, note: trimTo(raw.note, 500) });
  }
  return items;
}

export async function createTransmittal(
  owner: WorkspaceOwner,
  projectId: string,
  input: Record<string, unknown>,
): Promise<TransmittalDetail> {
  await assertDocumentControlEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);

  const transmittalNumber = trimTo(input.transmittalNumber, 60);
  if (!transmittalNumber) throw new AecError("transmittal_number_required");
  const purpose = trimTo(input.purpose, 30) || "for_review";
  if (!isIssuePurpose(purpose)) throw new AecError("invalid_issue_purpose");

  const { rows: duplicate } = await query<{ id: string }>(
    `SELECT id FROM aec_transmittals WHERE project_id = $1 AND transmittal_number = $2`,
    [projectId, transmittalNumber],
  );
  if (duplicate[0]) throw new AecError("transmittal_number_taken");

  const items = parseItems(input.items);
  const recipients = parseRecipients(input.recipients);

  const transmittalId = await withTenantTransaction(owner.businessId, async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_transmittals
         (business_id, project_id, transmittal_number, subject, sender_party_id, issue_date,
          purpose, comments, status, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        transmittalNumber,
        trimTo(input.subject, 300),
        optionalUuid(input.senderPartyId),
        optionalDate(input.issueDate),
        purpose,
        trimTo(input.comments, 4000),
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const id = rows[0].id;
    await replaceTransmittalLines(owner, id, items, recipients);
    return id;
  });

  await recordDocActivity(owner, {
    projectId,
    subjectType: "transmittal",
    subjectId: transmittalId,
    action: "created",
    summary: `پیشنویس برگهٔ ارسال ${transmittalNumber} ساخته شد`,
  });

  return loadTransmittal(owner.businessId, transmittalId);
}

/** Replaces a draft transmittal's lines and recipients wholesale. */
async function replaceTransmittalLines(
  owner: WorkspaceOwner,
  transmittalId: string,
  items: Array<{ revisionId: string; note: string }>,
  recipients: RecipientInput[],
): Promise<void> {
  if (items.length > 0) {
    await query(
      `DELETE FROM aec_transmittal_items WHERE business_id = $1 AND transmittal_id = $2`,
      [owner.businessId, transmittalId],
    );
    for (const item of items) {
      await query(
        `INSERT INTO aec_transmittal_items (business_id, transmittal_id, revision_id, note)
         VALUES ($1, $2, $3, $4)`,
        [owner.businessId, transmittalId, item.revisionId, item.note],
      );
    }
  }
  if (recipients.length > 0) {
    await query(
      `DELETE FROM aec_transmittal_recipients WHERE business_id = $1 AND transmittal_id = $2`,
      [owner.businessId, transmittalId],
    );
    for (const recipient of recipients) {
      await query(
        `INSERT INTO aec_transmittal_recipients
           (business_id, transmittal_id, party_id, requires_acknowledgement, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          owner.businessId,
          transmittalId,
          recipient.partyId,
          recipient.requiresAcknowledgement,
          recipient.note,
        ],
      );
    }
  }
}

export async function updateTransmittal(
  owner: WorkspaceOwner,
  transmittalId: string,
  input: Record<string, unknown>,
): Promise<TransmittalDetail> {
  await assertDocumentControlEnabled(owner.businessId);
  const { rows } = await query<{ status: TransmittalStatus; project_id: string; transmittal_number: string }>(
    `SELECT status, project_id, transmittal_number FROM aec_transmittals
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, transmittalId],
  );
  if (!rows[0]) throw new AecError("transmittal_not_found");
  if (rows[0].status !== "draft") throw new AecError("transmittal_not_editable");

  const current = await loadTransmittal(owner.businessId, transmittalId);
  const transmittalNumber = input.transmittalNumber === undefined
    ? current.transmittalNumber
    : trimTo(input.transmittalNumber, 60);
  if (!transmittalNumber) throw new AecError("transmittal_number_required");
  const purpose = input.purpose === undefined ? current.purpose : trimTo(input.purpose, 30);
  if (!isIssuePurpose(purpose)) throw new AecError("invalid_issue_purpose");

  if (transmittalNumber !== current.transmittalNumber) {
    const { rows: duplicate } = await query<{ id: string }>(
      `SELECT id FROM aec_transmittals
        WHERE project_id = $1 AND transmittal_number = $2 AND id <> $3`,
      [current.projectId, transmittalNumber, transmittalId],
    );
    if (duplicate[0]) throw new AecError("transmittal_number_taken");
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_transmittals
          SET transmittal_number = $3, subject = $4, sender_party_id = $5, issue_date = $6,
              purpose = $7, comments = $8, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        transmittalId,
        transmittalNumber,
        input.subject === undefined ? current.subject : trimTo(input.subject, 300),
        input.senderPartyId === undefined ? current.senderPartyId : optionalUuid(input.senderPartyId),
        input.issueDate === undefined ? current.issueDate : optionalDate(input.issueDate),
        purpose,
        input.comments === undefined ? current.comments : trimTo(input.comments, 4000),
      ],
    );
    await replaceTransmittalLines(
      owner,
      transmittalId,
      parseItems(input.items),
      parseRecipients(input.recipients),
    );
  });

  await recordDocActivity(owner, {
    projectId: current.projectId,
    subjectType: "transmittal",
    subjectId: transmittalId,
    action: "updated",
    summary: `پیش‌نویس برگهٔ ارسال ${transmittalNumber} ویرایش شد`,
  });

  return loadTransmittal(owner.businessId, transmittalId);
}

export async function deleteTransmittal(
  owner: WorkspaceOwner,
  transmittalId: string,
): Promise<void> {
  await assertDocumentControlEnabled(owner.businessId);
  const { rows } = await query<{ status: TransmittalStatus; project_id: string; transmittal_number: string }>(
    `SELECT status, project_id, transmittal_number FROM aec_transmittals
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, transmittalId],
  );
  if (!rows[0]) throw new AecError("transmittal_not_found");
  if (rows[0].status !== "draft") throw new AecError("transmittal_not_editable");

  await query(`DELETE FROM aec_transmittals WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    transmittalId,
  ]);
  await recordDocActivity(owner, {
    projectId: rows[0].project_id,
    subjectType: "transmittal",
    subjectId: null,
    action: "deleted",
    summary: `پیش‌نویس برگهٔ ارسال ${rows[0].transmittal_number} حذف شد`,
  });
}

/**
 * Issue the transmittal: §12's act, and the moment the record becomes history.
 *
 * One transaction does four things, because a register that showed any subset of
 * them would be lying:
 *
 *   1. the transmittal becomes `issued`, stamped with who and when;
 *   2. every line's draft revision becomes `issued` — with the transmittal's
 *      purpose unless the register already named one — and gets its date;
 *   3. the previous issued revision of each document becomes `superseded`, which
 *      is what "latest revision" means in a drawing register;
 *   4. the file behind each newly-issued revision freezes with it, because
 *      migration 0197 freezes the document row the revision points at.
 */
export async function issueTransmittal(
  owner: WorkspaceOwner,
  transmittalId: string,
): Promise<TransmittalDetail> {
  await assertDocumentControlEnabled(owner.businessId);
  const detail = await loadTransmittal(owner.businessId, transmittalId);
  if (detail.status !== "draft") throw new AecError("transmittal_not_editable");
  if (detail.items.length === 0) throw new AecError("transmittal_empty");
  if (detail.recipients.length === 0) throw new AecError("transmittal_has_no_recipients");

  const today = await businessToday(owner.businessId);

  await withTenantTransaction(owner.businessId, async () => {
    // Lock the transmittal for the length of the transaction and re-check its
    // status inside it: two people clicking «صدور» at once must not both issue
    // the same transmittal (each would stamp its own issuer and re-run the
    // supersede sweep). The check inside the lock is the authoritative one.
    const { rows: locked } = await query<{ id: string }>(
      `SELECT id FROM aec_transmittals
        WHERE business_id = $1 AND id = $2 AND status = 'draft'
        FOR UPDATE`,
      [owner.businessId, transmittalId],
    );
    if (!locked[0]) throw new AecError("transmittal_not_editable");

    for (const item of detail.items) {
      const { rows } = await query<{ document_id: string; revision_no: number; status: RevisionStatus }>(
        `SELECT document_id, revision_no, status FROM aec_document_revisions
          WHERE business_id = $1 AND id = $2`,
        [owner.businessId, item.revisionId],
      );
      const revision = rows[0];
      if (!revision) continue;

      if (revision.status === "draft") {
        await query(
          `UPDATE aec_document_revisions
              SET status = 'issued',
                  issue_purpose = CASE WHEN issue_purpose = 'wip' THEN $3 ELSE issue_purpose END,
                  revision_date = COALESCE(revision_date, $4),
                  issued_by = $5, issued_by_name = $6, issued_at = now(),
                  updated_at = now()
            WHERE business_id = $1 AND id = $2 AND status = 'draft'`,
          [
            owner.businessId,
            item.revisionId,
            detail.purpose,
            today,
            owner.actorUserId,
            owner.actorName ?? "",
          ],
        );
        // The revision this one replaces is now history — unless something else
        // already retired it, in which case the guard's forward-only rule would
        // refuse the write and there is nothing to do.
        await query(
          `UPDATE aec_document_revisions
              SET status = 'superseded', updated_at = now()
            WHERE business_id = $1 AND document_id = $2 AND status = 'issued' AND revision_no < $3`,
          [owner.businessId, revision.document_id, revision.revision_no],
        );
      }

      await recordDocActivity(owner, {
        projectId: detail.projectId,
        subjectType: "document_revision",
        subjectId: item.revisionId,
        action: "issued",
        summary: `بازنگری ${item.revisionCode} سند ${item.documentNumber} صادر شد`,
      });
    }

    // The lines now say what they actually carry — including the purpose the
    // transmittal gave a revision that had none. This runs while the transmittal
    // is still a draft, because its line guard freezes the rows the moment the
    // flip below lands.
    await query(
      `UPDATE aec_transmittal_items i
          SET issue_purpose = r.issue_purpose,
              revision_code = r.revision_code,
              document_number = d.document_number,
              document_title = d.title
         FROM aec_document_revisions r
         JOIN aec_documents d ON d.id = r.document_id
        WHERE i.business_id = $1 AND i.transmittal_id = $2 AND i.revision_id = r.id`,
      [owner.businessId, transmittalId],
    );

    await query(
      `UPDATE aec_transmittals
          SET status = 'issued', issued_by = $3, issued_by_name = $4, issued_at = now(),
              issue_date = COALESCE(issue_date, $5), updated_at = now()
        WHERE business_id = $1 AND id = $2 AND status = 'draft'`,
      [owner.businessId, transmittalId, owner.actorUserId, owner.actorName ?? "", today],
    );
  });

  await recordDocActivity(owner, {
    projectId: detail.projectId,
    subjectType: "transmittal",
    subjectId: transmittalId,
    action: "issued",
    summary: `برگهٔ ارسال ${detail.transmittalNumber} با ${detail.items.length} سند صادر شد`,
  });

  return loadTransmittal(owner.businessId, transmittalId);
}

/**
 * Record one recipient's receipt (§12's "acknowledgement/receipt where
 * required"). When the last required signature lands, the transmittal itself
 * moves to `acknowledged` — the database checks that condition again on the way
 * in, so the two can never disagree.
 */
export async function acknowledgeTransmittal(
  owner: WorkspaceOwner,
  transmittalId: string,
  input: Record<string, unknown>,
): Promise<TransmittalDetail> {
  await assertDocumentControlEnabled(owner.businessId);
  const detail = await loadTransmittal(owner.businessId, transmittalId);
  if (detail.status === "draft") throw new AecError("transmittal_not_issued");

  const recipientId = optionalUuid(input.recipientId, "recipient_not_found");
  const target = recipientId
    ? detail.recipients.find((recipient) => recipient.id === recipientId)
    : detail.recipients.find(
        (recipient) => recipient.requiresAcknowledgement && !recipient.acknowledgedAt,
      );
  if (!target) throw new AecError("recipient_not_found");
  if (target.acknowledgedAt) throw new AecError("recipient_already_acknowledged");

  const acknowledgedByName = trimTo(input.acknowledgedByName, 200) || owner.actorName || "";

  await withTenantTransaction(owner.businessId, async () => {
    const { rowCount } = await query(
      `UPDATE aec_transmittal_recipients
          SET acknowledged_at = now(), acknowledged_by_name = $3
        WHERE business_id = $1 AND id = $2 AND acknowledged_at IS NULL`,
      [owner.businessId, target.id, acknowledgedByName],
    );
    if (rowCount === 0) throw new AecError("recipient_already_acknowledged");

    const { rows } = await query<{ pending: string }>(
      `SELECT count(*) AS pending FROM aec_transmittal_recipients
        WHERE business_id = $1 AND transmittal_id = $2
          AND requires_acknowledgement AND acknowledged_at IS NULL`,
      [owner.businessId, transmittalId],
    );
    if (Number(rows[0]?.pending ?? 0) === 0 && detail.status === "issued") {
      await query(
        `UPDATE aec_transmittals
            SET status = 'acknowledged', acknowledged_at = now(), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [owner.businessId, transmittalId],
      );
    }
  });

  await recordDocActivity(owner, {
    projectId: detail.projectId,
    subjectType: "transmittal",
    subjectId: transmittalId,
    action: "acknowledged",
    summary: `رسید «${target.partyName}» برای برگهٔ ارسال ${detail.transmittalNumber} ثبت شد`,
  });

  return loadTransmittal(owner.businessId, transmittalId);
}

/* ===========================================================================
 * The assistant's read (§23)
 * ======================================================================== */

export interface LatestDrawingRevision {
  projectId: string;
  projectName: string;
  documentId: string;
  documentNumber: string;
  drawingNumber: string;
  title: string;
  documentType: DocumentType;
  documentTypeLabel: string;
  disciplineLabel: string;
  revisionCode: string;
  revisionNo: number;
  revisionStatus: RevisionStatus;
  revisionStatusLabel: string;
  issuePurposeLabel: string;
  revisionDate: string | null;
  isDraft: boolean;
}

/**
 * §23's `get_latest_drawing_revision`: the current revision of each drawing, for
 * one project or the whole business, optionally filtered to a discipline or a
 * search term. Read-only, and read from the same columns the register shows, so
 * the assistant and the cockpit cannot disagree about what is current.
 */
export async function latestDrawingRevisions(
  businessId: string,
  options: { projectId?: string; search?: string; discipline?: string; limit?: number } = {},
): Promise<LatestDrawingRevision[]> {
  await assertDocumentControlEnabled(businessId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const params: unknown[] = [businessId];
  const where = ["d.business_id = $1", "d.latest_revision_id IS NOT NULL"];
  if (options.projectId) {
    params.push(options.projectId);
    where.push(`d.project_id = $${params.length}`);
  }
  const search = trimTo(options.search, 100);
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(d.document_number ILIKE $${params.length} OR d.title ILIKE $${params.length}
        OR d.latest_revision_code ILIKE $${params.length})`,
    );
  }
  if (options.discipline && isAecSpecialty(options.discipline)) {
    params.push(options.discipline);
    where.push(`d.discipline = $${params.length}`);
  }
  params.push(limit);

  const { rows } = await query<Record<string, unknown>>(
    `SELECT d.project_id, p.name AS project_name, d.id AS document_id, d.document_number,
            d.drawing_number, d.title, d.document_type, d.discipline,
            r.revision_code, r.revision_no, r.status AS revision_status, r.issue_purpose,
            r.revision_date::text AS revision_date
       FROM aec_documents d
       JOIN ai_projects p ON p.id = d.project_id
       JOIN aec_document_revisions r ON r.id = d.latest_revision_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.updated_at DESC, d.document_number
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => {
    const status = row.revision_status as RevisionStatus;
    const purpose = row.issue_purpose as IssuePurpose;
    const documentType = row.document_type as DocumentType;
    return {
      projectId: String(row.project_id),
      projectName: String(row.project_name ?? ""),
      documentId: String(row.document_id),
      documentNumber: String(row.document_number ?? ""),
      drawingNumber: String(row.drawing_number ?? ""),
      title: String(row.title ?? ""),
      documentType,
      documentTypeLabel: DOCUMENT_TYPE_LABELS[documentType] ?? "",
      disciplineLabel: disciplineLabel((row.discipline as string | null) ?? null),
      revisionCode: String(row.revision_code ?? ""),
      revisionNo: Number(row.revision_no),
      revisionStatus: status,
      revisionStatusLabel: REVISION_STATUS_LABELS[status] ?? "",
      issuePurposeLabel: ISSUE_PURPOSE_LABELS[purpose] ?? "",
      revisionDate: (row.revision_date as string | null) ?? null,
      isDraft: status === "draft",
    };
  });
}
