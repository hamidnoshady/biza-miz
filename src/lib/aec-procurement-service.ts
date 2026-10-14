/**
 * Issue #799 §18 — the procurement service: §18's requirement, RFQ, quotation
 * comparison, the purchase/subcontract commitment, its deliveries, and §33's
 * trail for all three.
 *
 * It follows `aec-commercial-service.ts` and the four services before it: every
 * write takes a `WorkspaceOwner`, every read takes a `businessId`, every refusal
 * is an `AecError` code the API guard maps to a status, and migration 0201's
 * triggers are the backstop rather than the first line.
 *
 * ## The five things this file is careful about
 *
 *   * **The suppliers are `parties`, and nothing here is a stock purchase.**
 *     §18 is explicit: "Suppliers remain `parties`". A commitment references a
 *     party and never touches the F&B `suppliers`/`purchases`/`items` model,
 *     which an AEC tenant cannot even reach (Wave 1's decision: no products
 *     workspace). The commitment is a commercial promise for a value; what
 *     arrived is a delivery record.
 *   * **The selection is the approved award.** There is no "choose a supplier"
 *     act of its own: the commitment names the quotation it was raised from, and
 *     it counts as money only once approved through `workspace_approvals`. A
 *     comparison screen can shortlist three suppliers and still leave the
 *     decision exactly where §18 puts it — one approval, on the award.
 *   * **Committed cost is one definition** (`commitmentTotals` in the pure
 *     module): approved and delivered awards, never closed-out ones, because from
 *     there the cost is the ledger's. The register, §20's cockpit, §22's widget
 *     and §23's tool all call the same function, which is why they cannot
 *     disagree about a number three screens show.
 *   * **Accounting keeps the posted money.** No table in this wave holds an
 *     invoice, an AP balance or a payment; the commitment is what we promised,
 *     the delivery is what arrived, and the invoice is the books'. The cockpit's
 *     actual cost still comes from `journal_lines` through `projectReport`.
 *   * **§24 decides the permission, per action.** Approving, rejecting or
 *     cancelling an award is `workspace.approve` (it is money, or the release of
 *     money); drafting the request, issuing an RFQ, shortlisting a quote,
 *     recording a delivery and closing the award out are `workspace.manage`. The
 *     routes read `*ActionNeedsApproval` from the pure module rather than each
 *     repeating the branch.
 */
import {
  canTransitionCommitment,
  canTransitionMaterialRequest,
  canTransitionQuotation,
  canTransitionRfq,
  commitmentTotals,
  COMMITMENT_ACTION_EVENTS,
  COMMITMENT_ACTION_PAST_LABELS,
  COMMITMENT_ACTION_TARGET,
  COMMITMENT_CAPABILITY_FOR,
  COMMITMENT_KIND_LABELS,
  COMMITMENT_NUMBER_PREFIX,
  COMMITMENT_STATUS_LABELS,
  commitmentDelayDays,
  isCommitmentKind,
  isCommitmentStatus,
  isCommittedStatus,
  isEditableCommitment,
  isEditableMaterialRequest,
  isEditableRfq,
  isMaterialRequestPriority,
  isMaterialRequestStatus,
  isQuotationDecided,
  isQuotationStatus,
  isRfqStatus,
  MATERIAL_REQUEST_ACTION_EVENTS,
  MATERIAL_REQUEST_ACTION_PAST_LABELS,
  MATERIAL_REQUEST_ACTION_TARGET,
  MATERIAL_REQUEST_PRIORITY_LABELS,
  MATERIAL_REQUEST_STATUS_LABELS,
  QUOTATION_ACTION_EVENTS,
  QUOTATION_ACTION_PAST_LABELS,
  QUOTATION_ACTION_TARGET,
  QUOTATION_STATUS_LABELS,
  REQUEST_NUMBER_PREFIX,
  RFQ_ACTION_EVENTS,
  RFQ_ACTION_PAST_LABELS,
  RFQ_ACTION_TARGET,
  RFQ_NUMBER_PREFIX,
  RFQ_STATUS_LABELS,
  type CommitmentAction,
  type CommitmentKind,
  type CommitmentStatus,
  type MaterialRequestAction,
  type MaterialRequestPriority,
  type MaterialRequestStatus,
  type QuotationAction,
  type QuotationStatus,
  type RfqAction,
  type RfqStatus,
} from "./aec-procurement";
import { nextAecNumber } from "./aec-numbering";
import { AecError, assertAecIndustry, loadBusinessAecProfile } from "./aec-service";
import type { AecCapabilityKey } from "./aec";
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

function requiredUuid(value: unknown, code: string): string {
  const id = optionalUuid(value);
  if (!id) throw new AecError(code);
  return id;
}

/** A money figure in integer Rial. `null` is "not stated", which is not zero. */
function optionalAmount(value: unknown, code: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) throw new AecError(code);
  return parsed;
}

function requiredAmount(value: unknown, code: string): number {
  const amount = optionalAmount(value, code);
  if (amount === null) throw new AecError(code);
  return amount;
}

function optionalCount(value: unknown, code: string, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max || !Number.isInteger(parsed)) {
    throw new AecError(code);
  }
  return parsed;
}

/** A positive quantity as the decimal string the column stores. */
function requiredQuantity(value: unknown, code: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new AecError(code);
  return String(value);
}

function money(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ===========================================================================
 * Wire shapes — `/api/aec/**`
 * ======================================================================== */

export interface ProcurementEvent {
  id: string;
  action: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

export interface RequestLine {
  id: string;
  boqItemId: string | null;
  boqItemLabel: string | null;
  description: string;
  unit: string;
  quantity: number;
  position: number;
}

export interface MaterialRequestSummary {
  id: string;
  projectId: string;
  requestNumber: string;
  title: string;
  workPackage: string;
  description: string;
  priority: MaterialRequestPriority;
  priorityLabel: string;
  requiredBy: string | null;
  status: MaterialRequestStatus;
  statusLabel: string;
  submittedDate: string | null;
  approvedDate: string | null;
  closedDate: string | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string;
  lineCount: number;
  /** §18's flow onward: how many RFQs were raised from this request. */
  rfqCount: number;
  approvalId: string | null;
  approvalStatus: string | null;
  /** Days until the site needs it — negative once the date has passed. */
  daysToRequiredBy: number | null;
  isEditable: boolean;
  isOpen: boolean;
}

export interface MaterialRequestDetail extends MaterialRequestSummary {
  lines: RequestLine[];
  events: ProcurementEvent[];
}

export interface RequestInput {
  title?: unknown;
  workPackage?: unknown;
  description?: unknown;
  priority?: unknown;
  requiredBy?: unknown;
  lines?: unknown;
  note?: unknown;
}

export interface QuotationSummary {
  id: string;
  rfqId: string;
  partyId: string;
  supplierName: string;
  amountRial: number;
  leadDays: number | null;
  validityDate: string | null;
  note: string;
  status: QuotationStatus;
  statusLabel: string;
  receivedDate: string;
  createdByName: string;
  createdAt: string;
}

export interface RfqSupplier {
  partyId: string;
  name: string;
  note: string;
  invitedAt: string;
  /** Did this supplier answer? The comparison sheet's first column. */
  quoted: boolean;
}

export interface RfqSummary {
  id: string;
  projectId: string;
  requestId: string | null;
  requestNumber: string | null;
  rfqNumber: string;
  title: string;
  scope: string;
  status: RfqStatus;
  statusLabel: string;
  dueDate: string | null;
  responseDue: string | null;
  issuedDate: string | null;
  closedDate: string | null;
  createdAt: string;
  createdByName: string;
  supplierCount: number;
  quotationCount: number;
  /** The comparison, summarized: cheapest quote and fastest lead time. */
  lowestAmountRial: number | null;
  bestLeadDays: number | null;
  commitmentCount: number;
  isEditable: boolean;
  isOpen: boolean;
}

export interface RfqDetail extends RfqSummary {
  suppliers: RfqSupplier[];
  quotations: QuotationSummary[];
  events: ProcurementEvent[];
}

export interface RfqInput {
  requestId?: unknown;
  title?: unknown;
  scope?: unknown;
  dueDate?: unknown;
  responseDue?: unknown;
  suppliers?: unknown;
  quotations?: unknown;
}

export interface DeliveryRow {
  id: string;
  deliveredOn: string;
  note: string;
  receivedById: string | null;
  receivedByName: string;
  createdAt: string;
}

export interface CommitmentSummary {
  id: string;
  projectId: string;
  kind: CommitmentKind;
  kindLabel: string;
  commitmentNumber: string;
  supplierPartyId: string;
  supplierName: string;
  requestId: string | null;
  requestNumber: string | null;
  rfqId: string | null;
  rfqNumber: string | null;
  quotationId: string | null;
  contractId: string | null;
  contractTitle: string | null;
  title: string;
  scope: string;
  workPackage: string;
  valueRial: number;
  expectedDeliveryDate: string | null;
  /** §18's delay warning: days past the expected date while still undelivered. */
  delayDays: number | null;
  isDelayed: boolean;
  status: CommitmentStatus;
  statusLabel: string;
  submittedDate: string | null;
  approvedDate: string | null;
  deliveredDate: string | null;
  closedDate: string | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string;
  deliveryCount: number;
  attachmentCount: number;
  approvalId: string | null;
  approvalStatus: string | null;
  /** Committed money — the figure §20's cockpit counts. */
  isCommitted: boolean;
  isEditable: boolean;
  isOpen: boolean;
}

export interface CommitmentDetail extends CommitmentSummary {
  deliveries: DeliveryRow[];
  events: ProcurementEvent[];
  attachments: LinkedDocument[];
}

export interface CommitmentInput {
  kind?: unknown;
  title?: unknown;
  scope?: unknown;
  workPackage?: unknown;
  supplierPartyId?: unknown;
  valueRial?: unknown;
  expectedDeliveryDate?: unknown;
  requestId?: unknown;
  rfqId?: unknown;
  quotationId?: unknown;
  contractId?: unknown;
  attachments?: unknown;
}

/** §18's register summary for one project — what the tab's KPI row reads. */
export interface ProjectProcurementSummary {
  projectId: string;
  openRequestCount: number;
  pendingRequestCount: number;
  issuedRfqCount: number;
  quotationCount: number;
  committedRial: number;
  deliveredRial: number;
  delayedCount: number;
  delayedRial: number;
  openCommitmentCount: number;
}

/** The delayed-delivery queue §22's widget, §23's tool and §29's scan share. */
export interface DelayedCommitmentRow {
  id: string;
  projectId: string;
  projectName: string;
  commitmentNumber: string;
  kind: CommitmentKind;
  kindLabel: string;
  title: string;
  supplierName: string;
  valueRial: number;
  expectedDeliveryDate: string;
  delayDays: number;
}

/* ===========================================================================
 * Selects
 * ======================================================================== */

const REQUEST_SELECT = `
  r.id, r.project_id, r.request_number, r.title, r.work_package, r.description,
  r.priority, r.required_by::text AS required_by, r.status,
  r.submitted_date::text AS submitted_date, r.approved_date::text AS approved_date,
  r.closed_date::text AS closed_date, r.created_at::text AS created_at,
  r.created_by, r.created_by_name,
  (SELECT count(*)::integer FROM aec_material_request_lines l
    WHERE l.request_id = r.id) AS line_count,
  (SELECT count(*)::integer FROM aec_rfqs q
    WHERE q.request_id = r.id AND q.status <> 'cancelled') AS rfq_count,
  (SELECT a.id FROM workspace_approvals a
    WHERE a.subject_type = 'material_request' AND a.subject_id = r.id
    ORDER BY a.created_at DESC LIMIT 1) AS approval_id,
  (SELECT a.status FROM workspace_approvals a
    WHERE a.subject_type = 'material_request' AND a.subject_id = r.id
    ORDER BY a.created_at DESC LIMIT 1) AS approval_status`;
const REQUEST_FROM = `FROM aec_material_requests r`;

const RFQ_SELECT = `
  q.id, q.project_id, q.request_id, r.request_number, q.rfq_number, q.title, q.scope, q.status,
  q.due_date::text AS due_date, q.response_due::text AS response_due,
  q.issued_date::text AS issued_date, q.closed_date::text AS closed_date,
  q.created_at::text AS created_at, q.created_by_name,
  (SELECT count(*)::integer FROM aec_rfq_suppliers s WHERE s.rfq_id = q.id) AS supplier_count,
  (SELECT count(*)::integer FROM aec_supplier_quotations t WHERE t.rfq_id = q.id) AS quotation_count,
  (SELECT min(t.amount_rial) FROM aec_supplier_quotations t WHERE t.rfq_id = q.id) AS lowest_amount_rial,
  (SELECT min(t.lead_days) FROM aec_supplier_quotations t
    WHERE t.rfq_id = q.id AND t.lead_days IS NOT NULL) AS best_lead_days,
  (SELECT count(*)::integer FROM aec_commitments c WHERE c.rfq_id = q.id AND c.status <> 'cancelled') AS commitment_count`;
const RFQ_FROM = `FROM aec_rfqs q
  LEFT JOIN aec_material_requests r ON r.id = q.request_id`;

const QUOTATION_SELECT = `
  t.id, t.rfq_id, t.party_id, p.name AS supplier_name, t.amount_rial, t.lead_days,
  t.validity_date::text AS validity_date, t.note, t.status,
  t.received_date::text AS received_date, t.created_by_name, t.created_at::text AS created_at`;
const QUOTATION_FROM = `FROM aec_supplier_quotations t
  JOIN parties p ON p.id = t.party_id`;

const COMMITMENT_SELECT = `
  c.id, c.project_id, c.kind, c.commitment_number, c.supplier_party_id,
  p.name AS supplier_name, c.request_id, r.request_number, c.rfq_id, q.rfq_number,
  c.quotation_id, c.contract_id, wc.title AS contract_title, c.title, c.scope, c.work_package,
  c.value_rial, c.expected_delivery_date::text AS expected_delivery_date, c.status,
  c.submitted_date::text AS submitted_date, c.approved_date::text AS approved_date,
  c.delivered_date::text AS delivered_date, c.closed_date::text AS closed_date,
  c.created_at::text AS created_at, c.created_by, c.created_by_name,
  (SELECT count(*)::integer FROM aec_commitment_deliveries d WHERE d.commitment_id = c.id)
    AS delivery_count,
  (SELECT count(*)::integer FROM workspace_documents doc WHERE doc.commitment_id = c.id)
    AS attachment_count,
  (SELECT a.id FROM workspace_approvals a
    WHERE a.subject_type = 'commitment' AND a.subject_id = c.id
    ORDER BY a.created_at DESC LIMIT 1) AS approval_id,
  (SELECT a.status FROM workspace_approvals a
    WHERE a.subject_type = 'commitment' AND a.subject_id = c.id
    ORDER BY a.created_at DESC LIMIT 1) AS approval_status`;
const COMMITMENT_FROM = `FROM aec_commitments c
  JOIN parties p ON p.id = c.supplier_party_id
  LEFT JOIN aec_material_requests r ON r.id = c.request_id
  LEFT JOIN aec_rfqs q ON q.id = c.rfq_id
  LEFT JOIN workspace_contracts wc ON wc.id = c.contract_id`;

/* ===========================================================================
 * Mappers
 * ======================================================================== */

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

function toRequest(row: Record<string, unknown>, today: string): MaterialRequestSummary {
  const status = isMaterialRequestStatus(String(row.status))
    ? (String(row.status) as MaterialRequestStatus)
    : "draft";
  const priority = isMaterialRequestPriority(String(row.priority))
    ? (String(row.priority) as MaterialRequestPriority)
    : "normal";
  const requiredBy = (row.required_by as string | null) ?? null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    requestNumber: String(row.request_number ?? ""),
    title: String(row.title ?? ""),
    workPackage: String(row.work_package ?? ""),
    description: String(row.description ?? ""),
    priority,
    priorityLabel: MATERIAL_REQUEST_PRIORITY_LABELS[priority],
    requiredBy,
    status,
    statusLabel: MATERIAL_REQUEST_STATUS_LABELS[status],
    submittedDate: (row.submitted_date as string | null) ?? null,
    approvedDate: (row.approved_date as string | null) ?? null,
    closedDate: (row.closed_date as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    createdById: (row.created_by as string | null) ?? null,
    createdByName: String(row.created_by_name ?? ""),
    lineCount: Number(row.line_count ?? 0),
    rfqCount: Number(row.rfq_count ?? 0),
    approvalId: (row.approval_id as string | null) ?? null,
    approvalStatus: (row.approval_status as string | null) ?? null,
    daysToRequiredBy: requiredBy ? daysBetween(today, requiredBy) : null,
    isEditable: isEditableMaterialRequest(status),
    isOpen: status === "draft" || status === "submitted" || status === "approved",
  };
}

function toLine(row: Record<string, unknown>): RequestLine {
  return {
    id: String(row.id),
    boqItemId: (row.boq_item_id as string | null) ?? null,
    boqItemLabel: (row.boq_item_label as string | null) ?? null,
    description: String(row.description ?? ""),
    unit: String(row.unit ?? ""),
    quantity: Number(row.quantity ?? 0),
    position: Number(row.position ?? 0),
  };
}

function toQuotation(row: Record<string, unknown>): QuotationSummary {
  const status = isQuotationStatus(String(row.status))
    ? (String(row.status) as QuotationStatus)
    : "received";
  return {
    id: String(row.id),
    rfqId: String(row.rfq_id),
    partyId: String(row.party_id),
    supplierName: String(row.supplier_name ?? ""),
    amountRial: money(row.amount_rial),
    leadDays: optionalMoney(row.lead_days),
    validityDate: (row.validity_date as string | null) ?? null,
    note: String(row.note ?? ""),
    status,
    statusLabel: QUOTATION_STATUS_LABELS[status],
    receivedDate: String(row.received_date ?? ""),
    createdByName: String(row.created_by_name ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function toRfq(row: Record<string, unknown>): RfqSummary {
  const status = isRfqStatus(String(row.status)) ? (String(row.status) as RfqStatus) : "draft";
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    requestId: (row.request_id as string | null) ?? null,
    requestNumber: (row.request_number as string | null) ?? null,
    rfqNumber: String(row.rfq_number ?? ""),
    title: String(row.title ?? ""),
    scope: String(row.scope ?? ""),
    status,
    statusLabel: RFQ_STATUS_LABELS[status],
    dueDate: (row.due_date as string | null) ?? null,
    responseDue: (row.response_due as string | null) ?? null,
    issuedDate: (row.issued_date as string | null) ?? null,
    closedDate: (row.closed_date as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    createdByName: String(row.created_by_name ?? ""),
    supplierCount: Number(row.supplier_count ?? 0),
    quotationCount: Number(row.quotation_count ?? 0),
    lowestAmountRial: optionalMoney(row.lowest_amount_rial),
    bestLeadDays: optionalMoney(row.best_lead_days),
    commitmentCount: Number(row.commitment_count ?? 0),
    isEditable: isEditableRfq(status),
    isOpen: status === "draft" || status === "issued",
  };
}

function toEvent(row: Record<string, unknown>): ProcurementEvent {
  return {
    id: String(row.id),
    action: String(row.action ?? ""),
    summary: String(row.summary ?? ""),
    actorName: String(row.actor_name ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function toCommitment(row: Record<string, unknown>, today: string): CommitmentSummary {
  const status = isCommitmentStatus(String(row.status))
    ? (String(row.status) as CommitmentStatus)
    : "draft";
  const kind = isCommitmentKind(String(row.kind)) ? (String(row.kind) as CommitmentKind) : "purchase";
  const expectedDeliveryDate = (row.expected_delivery_date as string | null) ?? null;
  const delayDays = commitmentDelayDays(expectedDeliveryDate, today);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind,
    kindLabel: COMMITMENT_KIND_LABELS[kind],
    commitmentNumber: String(row.commitment_number ?? ""),
    supplierPartyId: String(row.supplier_party_id),
    supplierName: String(row.supplier_name ?? ""),
    requestId: (row.request_id as string | null) ?? null,
    requestNumber: (row.request_number as string | null) ?? null,
    rfqId: (row.rfq_id as string | null) ?? null,
    rfqNumber: (row.rfq_number as string | null) ?? null,
    quotationId: (row.quotation_id as string | null) ?? null,
    contractId: (row.contract_id as string | null) ?? null,
    contractTitle: (row.contract_title as string | null) ?? null,
    title: String(row.title ?? ""),
    scope: String(row.scope ?? ""),
    workPackage: String(row.work_package ?? ""),
    valueRial: money(row.value_rial),
    expectedDeliveryDate,
    delayDays: delayDays !== null && delayDays > 0 ? delayDays : null,
    isDelayed: status === "approved" && delayDays !== null && delayDays > 0,
    status,
    statusLabel: COMMITMENT_STATUS_LABELS[status],
    submittedDate: (row.submitted_date as string | null) ?? null,
    approvedDate: (row.approved_date as string | null) ?? null,
    deliveredDate: (row.delivered_date as string | null) ?? null,
    closedDate: (row.closed_date as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    createdById: (row.created_by as string | null) ?? null,
    createdByName: String(row.created_by_name ?? ""),
    deliveryCount: Number(row.delivery_count ?? 0),
    attachmentCount: Number(row.attachment_count ?? 0),
    approvalId: (row.approval_id as string | null) ?? null,
    approvalStatus: (row.approval_status as string | null) ?? null,
    isCommitted: isCommittedStatus(status),
    isEditable: isEditableCommitment(status),
    isOpen: status === "draft" || status === "submitted" || status === "approved",
  };
}

/* ===========================================================================
 * Guards
 * ======================================================================== */

async function assertProcurementEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes("procurement")) throw new AecError("capability_disabled");
}

/**
 * A subcontract award needs the subcontractor capability as well as procurement.
 * The register is one and the switch is one per kind — a business that has
 * switched subcontractor packages off has no business writing one, which is the
 * same rule the preset applies to the subcontractor participant role.
 */
async function assertKindEnabled(businessId: string, kind: CommitmentKind): Promise<void> {
  const profile = await loadBusinessAecProfile(businessId);
  // The catalogue in the pure module names the capability as a string so it
  // stays dependency-free; the profile's list is typed, so the name is narrowed
  // here — one cast, at the single place the two meet.
  const capability = COMMITMENT_CAPABILITY_FOR[kind] as AecCapabilityKey;
  if (!profile.capabilities.includes(capability)) {
    throw new AecError("capability_disabled");
  }
}

async function assertProjectOwned(businessId: string, projectId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [businessId, projectId],
  );
  if (!rows[0]) throw new AecError("project_not_found");
}

async function assertPartyOwned(businessId: string, partyId: string | null): Promise<void> {
  if (!partyId) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM parties
      WHERE business_id = $1 AND id = $2 AND is_active AND merged_into_id IS NULL`,
    [businessId, partyId],
  );
  if (!rows[0]) throw new AecError("party_not_found");
}

async function assertUserOwned(businessId: string, userId: string | null): Promise<void> {
  if (!userId) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE business_id = $1 AND id = $2`,
    [businessId, userId],
  );
  if (!rows[0]) throw new AecError("user_not_found");
}

async function assertBoqItemOwned(
  businessId: string,
  boqItemId: string | null,
  projectId: string,
): Promise<void> {
  if (!boqItemId) return;
  const { rows } = await query<{ project_id: string }>(
    `SELECT e.project_id FROM aec_boq_items i
       JOIN aec_estimate_versions v ON v.id = i.version_id
       JOIN aec_estimates e ON e.id = v.estimate_id
      WHERE i.business_id = $1 AND i.id = $2`,
    [businessId, boqItemId],
  );
  if (!rows[0]) throw new AecError("boq_item_not_found");
  if (rows[0].project_id !== projectId) throw new AecError("boq_item_project_mismatch");
}

async function assertContractOwned(
  businessId: string,
  contractId: string | null,
  projectId: string,
): Promise<void> {
  if (!contractId) return;
  const { rows } = await query<{ project_id: string | null }>(
    `SELECT project_id FROM workspace_contracts WHERE business_id = $1 AND id = $2`,
    [businessId, contractId],
  );
  const contract = rows[0];
  if (!contract) throw new AecError("contract_not_found");
  if (contract.project_id && contract.project_id !== projectId) {
    throw new AecError("contract_project_mismatch");
  }
}

/** The project a register row belongs to — the same shape the other services use. */
export async function requestProjectId(businessId: string, requestId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_material_requests WHERE business_id = $1 AND id = $2`,
    [businessId, requestId],
  );
  if (!rows[0]) throw new AecError("request_not_found");
  return rows[0].project_id;
}

export async function rfqProjectId(businessId: string, rfqId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_rfqs WHERE business_id = $1 AND id = $2`,
    [businessId, rfqId],
  );
  if (!rows[0]) throw new AecError("rfq_not_found");
  return rows[0].project_id;
}

export async function quotationProjectId(businessId: string, quotationId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT q.project_id FROM aec_supplier_quotations t
       JOIN aec_rfqs q ON q.id = t.rfq_id
      WHERE t.business_id = $1 AND t.id = $2`,
    [businessId, quotationId],
  );
  if (!rows[0]) throw new AecError("quotation_not_found");
  return rows[0].project_id;
}

export async function deliveryProjectId(businessId: string, deliveryId: string): Promise<string> {
  const { rows } = await query<{ commitment_id: string }>(
    `SELECT commitment_id FROM aec_commitment_deliveries WHERE business_id = $1 AND id = $2`,
    [businessId, deliveryId],
  );
  if (!rows[0]) throw new AecError("delivery_not_found");
  return commitmentProjectId(businessId, rows[0].commitment_id);
}

export async function commitmentProjectId(businessId: string, commitmentId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_commitments WHERE business_id = $1 AND id = $2`,
    [businessId, commitmentId],
  );
  if (!rows[0]) throw new AecError("commitment_not_found");
  return rows[0].project_id;
}

/* ===========================================================================
 * §33's trail
 * ======================================================================== */

async function recordProcurementEvent(
  owner: WorkspaceOwner,
  entry: {
    projectId: string;
    requestId?: string;
    rfqId?: string;
    commitmentId?: string;
    action: string;
    summary: string;
  },
): Promise<void> {
  await query(
    `INSERT INTO aec_procurement_events
       (business_id, project_id, request_id, rfq_id, commitment_id, action, summary, actor_id, actor_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      owner.businessId,
      entry.projectId,
      entry.requestId ?? null,
      entry.rfqId ?? null,
      entry.commitmentId ?? null,
      entry.action,
      entry.summary.slice(0, 300),
      owner.actorUserId,
      owner.actorName ?? "",
    ],
  );
}

async function loadEvents(
  businessId: string,
  column: "request_id" | "rfq_id" | "commitment_id",
  id: string,
): Promise<ProcurementEvent[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, action, summary, actor_name, created_at::text AS created_at
       FROM aec_procurement_events
      WHERE business_id = $1 AND ${column} = $2
      ORDER BY created_at, id`,
    [businessId, id],
  );
  return rows.map(toEvent);
}

/* ===========================================================================
 * §18's material request
 * ======================================================================== */

export async function listProjectRequests(
  businessId: string,
  projectId: string,
): Promise<MaterialRequestSummary[]> {
  await assertProcurementEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${REQUEST_SELECT} ${REQUEST_FROM}
      WHERE r.business_id = $1 AND r.project_id = $2
      ORDER BY r.created_at DESC, r.request_number DESC`,
    [businessId, projectId],
  );
  return rows.map((row) => toRequest(row, today));
}

export async function loadMaterialRequest(
  businessId: string,
  requestId: string,
): Promise<MaterialRequestDetail> {
  await assertProcurementEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${REQUEST_SELECT} ${REQUEST_FROM}
      WHERE r.business_id = $1 AND r.id = $2`,
    [businessId, requestId],
  );
  if (!rows[0]) throw new AecError("request_not_found");
  const { rows: lineRows } = await query<Record<string, unknown>>(
    `SELECT l.id, l.boq_item_id, l.description, l.unit, l.quantity, l.position,
            i.description AS boq_item_label
       FROM aec_material_request_lines l
       LEFT JOIN aec_boq_items i ON i.id = l.boq_item_id
      WHERE l.business_id = $1 AND l.request_id = $2
      ORDER BY l.position, l.created_at`,
    [businessId, requestId],
  );
  return {
    ...toRequest(rows[0], today),
    lines: lineRows.map(toLine),
    events: await loadEvents(businessId, "request_id", requestId),
  };
}

async function replaceRequestLines(
  owner: WorkspaceOwner,
  projectId: string,
  requestId: string,
  input: unknown,
): Promise<void> {
  const incoming = Array.isArray(input) ? input : [];
  const keep: Array<{
    boqItemId: string | null;
    description: string;
    unit: string;
    quantity: string;
    position: number;
  }> = [];
  for (const [index, entry] of incoming.slice(0, 200).entries()) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const description = trimTo(item.description, 500);
    if (!description) throw new AecError("request_line_description_required");
    const boqItemId = optionalUuid(item.boqItemId);
    await assertBoqItemOwned(owner.businessId, boqItemId, projectId);
    keep.push({
      boqItemId,
      description,
      unit: trimTo(item.unit, 40),
      quantity: requiredQuantity(item.quantity, "invalid_line_quantity"),
      position: index,
    });
  }

  await query(
    `DELETE FROM aec_material_request_lines WHERE business_id = $1 AND request_id = $2`,
    [owner.businessId, requestId],
  );
  for (const line of keep) {
    await query(
      `INSERT INTO aec_material_request_lines
         (business_id, request_id, boq_item_id, description, unit, quantity, position)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7)`,
      [
        owner.businessId,
        requestId,
        line.boqItemId,
        line.description,
        line.unit,
        line.quantity,
        line.position,
      ],
    );
  }
}

/** §18's requirement, numbered `MR-001` per project. */
export async function createMaterialRequest(
  owner: WorkspaceOwner,
  projectId: string,
  input: RequestInput,
): Promise<MaterialRequestDetail> {
  await assertProcurementEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);

  const title = trimTo(input.title, 300);
  if (!title) throw new AecError("request_title_required");
  const priorityRaw = input.priority === undefined ? "normal" : input.priority;
  if (!isMaterialRequestPriority(String(priorityRaw))) throw new AecError("invalid_priority");
  const requiredBy = optionalDate(input.requiredBy);

  const requestId = await withTenantTransaction(owner.businessId, async () => {
    const requestNumber = await nextAecNumber("aec_material_requests", projectId, REQUEST_NUMBER_PREFIX);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_material_requests
         (business_id, project_id, request_number, title, work_package, description, priority,
          required_by, status, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, 'draft', $9, $10)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        requestNumber,
        title,
        trimTo(input.workPackage, 200),
        trimTo(input.description, 2000),
        String(priorityRaw),
        requiredBy,
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const id = rows[0].id;
    if (input.lines !== undefined) await replaceRequestLines(owner, projectId, id, input.lines);
    await recordProcurementEvent(owner, {
      projectId,
      requestId: id,
      action: "created",
      summary: `درخواست کالا ${requestNumber} ثبت شد`,
    });
    return id;
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "material_request",
    subjectId: requestId,
    action: "created",
    summary: `درخواست کالا: ${title}`,
  });
  return loadMaterialRequest(owner.businessId, requestId);
}

export async function updateMaterialRequest(
  owner: WorkspaceOwner,
  requestId: string,
  input: RequestInput,
): Promise<MaterialRequestDetail> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await requestProjectId(owner.businessId, requestId);
  const current = await loadMaterialRequest(owner.businessId, requestId);
  if (!current.isEditable) throw new AecError("request_not_editable");

  const title = input.title === undefined ? current.title : trimTo(input.title, 300);
  if (!title) throw new AecError("request_title_required");
  const priorityRaw = input.priority === undefined ? current.priority : input.priority;
  if (!isMaterialRequestPriority(String(priorityRaw))) throw new AecError("invalid_priority");

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_material_requests
          SET title = $3, work_package = $4, description = $5, priority = $6,
              required_by = $7::date, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        requestId,
        title,
        input.workPackage === undefined ? current.workPackage : trimTo(input.workPackage, 200),
        input.description === undefined ? current.description : trimTo(input.description, 2000),
        String(priorityRaw),
        input.requiredBy === undefined ? current.requiredBy : optionalDate(input.requiredBy),
      ],
    );
    if (input.lines !== undefined) await replaceRequestLines(owner, projectId, requestId, input.lines);
    await recordProcurementEvent(owner, {
      projectId,
      requestId,
      action: "updated",
      summary: `درخواست ${current.requestNumber} ویرایش شد`,
    });
  });
  return loadMaterialRequest(owner.businessId, requestId);
}

export async function deleteMaterialRequest(
  owner: WorkspaceOwner,
  requestId: string,
): Promise<void> {
  await assertProcurementEnabled(owner.businessId);
  const current = await loadMaterialRequest(owner.businessId, requestId);
  if (current.status !== "draft") throw new AecError("request_not_editable");
  await query(`DELETE FROM aec_material_requests WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    requestId,
  ]);
  await recordActivity(owner, {
    projectId: current.projectId,
    subjectType: "material_request",
    subjectId: null,
    action: "deleted",
    summary: `درخواست ${current.requestNumber} حذف شد`,
  });
}

/**
 * Walk §18's request chain.
 *
 * `submit` files the approval — the requirement is what the firm is being asked
 * to go and buy — and `approve`/`reject` are the two determinations, which the
 * route gates on `workspace.approve`. Closing a request after its award has been
 * placed is bookkeeping.
 */
export async function applyMaterialRequestAction(
  owner: WorkspaceOwner,
  requestId: string,
  action: MaterialRequestAction,
  input: { note?: unknown } = {},
): Promise<MaterialRequestDetail> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await requestProjectId(owner.businessId, requestId);
  const current = await loadMaterialRequest(owner.businessId, requestId);
  const target = MATERIAL_REQUEST_ACTION_TARGET[action];
  if (!canTransitionMaterialRequest(current.status, target)) {
    throw new AecError("invalid_request_transition");
  }

  await withTenantTransaction(owner.businessId, async () => {
    const today = await businessToday(owner.businessId);
    await query(
      `UPDATE aec_material_requests
          SET status = $3,
              submitted_date = CASE WHEN $3 IN ('submitted', 'approved', 'rejected', 'closed')
                                    THEN COALESCE(submitted_date, $4::date) ELSE submitted_date END,
              approved_date = CASE WHEN $3 IN ('approved', 'closed')
                                   THEN COALESCE(approved_date, $4::date) ELSE approved_date END,
              closed_date = CASE WHEN $3 = 'closed'
                                 THEN COALESCE(closed_date, $4::date) ELSE closed_date END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [owner.businessId, requestId, target, today],
    );

    if (action === "submit") {
      await query(
        `INSERT INTO workspace_approvals
           (business_id, subject_type, subject_id, project_id, title, requested_by, note)
         VALUES ($1, 'material_request', $2, $3, $4, $5, $6)`,
        [
          owner.businessId,
          requestId,
          projectId,
          `${current.requestNumber} — ${current.title.slice(0, 180)}`,
          owner.actorUserId,
          trimTo(input.note, 1000),
        ],
      );
    }

    await recordProcurementEvent(owner, {
      projectId,
      requestId,
      action: MATERIAL_REQUEST_ACTION_EVENTS[action],
      summary: `درخواست ${current.requestNumber} ${MATERIAL_REQUEST_ACTION_PAST_LABELS[action]}`,
    });
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "material_request",
    subjectId: requestId,
    action: MATERIAL_REQUEST_ACTION_EVENTS[action],
    summary: `درخواست ${current.requestNumber} ${MATERIAL_REQUEST_ACTION_PAST_LABELS[action]}`,
  });
  return loadMaterialRequest(owner.businessId, requestId);
}

/**
 * The approvals queue's decision, projected onto the request — the same
 * arrangement as the submittal revision, the change order and the claim.
 * `approved` is what lets the firm go to market; a rejection returns the request
 * to `rejected`, where it can be revised and re-submitted.
 */
export async function decideMaterialRequestApproval(
  owner: WorkspaceOwner,
  approvalId: string,
  decision: "approved" | "rejected" | "changes_requested" | "cancelled",
  note = "",
): Promise<{ requestId: string | null; applied: boolean }> {
  await assertAecIndustry(owner.businessId);
  const { rows } = await query<{ subject_id: string; status: string }>(
    `SELECT subject_id, status FROM workspace_approvals
      WHERE business_id = $1 AND id = $2 AND subject_type = 'material_request'`,
    [owner.businessId, approvalId],
  );
  const approval = rows[0];
  if (!approval) throw new AecError("approval_not_found");
  if (approval.status !== "pending") return { requestId: approval.subject_id, applied: false };

  if (decision !== "cancelled") {
    await applyMaterialRequestAction(
      owner,
      approval.subject_id,
      decision === "approved" ? "approve" : "reject",
      { note },
    );
  }

  await query(
    `UPDATE workspace_approvals
        SET status = $3, decided_by = $4, decided_at = now(),
            note = COALESCE(NULLIF($5, ''), note), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, approvalId, decision, owner.actorUserId, trimTo(note, 1000)],
  );
  return { requestId: approval.subject_id, applied: true };
}

/* ===========================================================================
 * §18's RFQ and its quotations
 * ======================================================================== */

export async function listProjectRfqs(businessId: string, projectId: string): Promise<RfqSummary[]> {
  await assertProcurementEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RFQ_SELECT} ${RFQ_FROM}
      WHERE q.business_id = $1 AND q.project_id = $2
      ORDER BY q.created_at DESC, q.rfq_number DESC`,
    [businessId, projectId],
  );
  return rows.map(toRfq);
}

export async function loadRfq(businessId: string, rfqId: string): Promise<RfqDetail> {
  await assertProcurementEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RFQ_SELECT} ${RFQ_FROM}
      WHERE q.business_id = $1 AND q.id = $2`,
    [businessId, rfqId],
  );
  if (!rows[0]) throw new AecError("rfq_not_found");
  const [supplierRows, quotationRows] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT s.party_id, p.name, s.note, s.created_at::text AS invited_at,
              EXISTS (SELECT 1 FROM aec_supplier_quotations t
                       WHERE t.rfq_id = s.rfq_id AND t.party_id = s.party_id) AS quoted
         FROM aec_rfq_suppliers s
         JOIN parties p ON p.id = s.party_id
        WHERE s.business_id = $1 AND s.rfq_id = $2
        ORDER BY p.name`,
      [businessId, rfqId],
    ),
    query<Record<string, unknown>>(
      `SELECT ${QUOTATION_SELECT} ${QUOTATION_FROM}
        WHERE t.business_id = $1 AND t.rfq_id = $2
        ORDER BY t.amount_rial, p.name`,
      [businessId, rfqId],
    ),
  ]);
  return {
    ...toRfq(rows[0]),
    suppliers: supplierRows.rows.map((row) => ({
      partyId: String(row.party_id),
      name: String(row.name ?? ""),
      note: String(row.note ?? ""),
      invitedAt: String(row.invited_at ?? ""),
      quoted: row.quoted === true,
    })),
    quotations: quotationRows.rows.map(toQuotation),
    events: await loadEvents(businessId, "rfq_id", rfqId),
  };
}

/**
 * The invitation list, replaced wholesale like every other child list in this
 * module. Only while the RFQ is a draft: who was asked is part of what was sent.
 */
async function replaceRfqSuppliers(
  owner: WorkspaceOwner,
  rfqId: string,
  input: unknown,
): Promise<void> {
  const incoming = Array.isArray(input) ? input : [];
  const keep: Array<{ partyId: string; note: string }> = [];
  const seen = new Set<string>();
  for (const entry of incoming.slice(0, 100)) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const partyId = requiredUuid(item.partyId, "invalid_supplier");
    if (seen.has(partyId)) continue;
    seen.add(partyId);
    await assertPartyOwned(owner.businessId, partyId);
    keep.push({ partyId, note: trimTo(item.note, 300) });
  }
  await query(`DELETE FROM aec_rfq_suppliers WHERE business_id = $1 AND rfq_id = $2`, [
    owner.businessId,
    rfqId,
  ]);
  for (const supplier of keep) {
    await query(
      `INSERT INTO aec_rfq_suppliers (business_id, rfq_id, party_id, note)
       VALUES ($1, $2, $3, $4)`,
      [owner.businessId, rfqId, supplier.partyId, supplier.note],
    );
  }
}

/** §18's RFQ, numbered `RFQ-001` per project. */
export async function createRfq(
  owner: WorkspaceOwner,
  projectId: string,
  input: RfqInput,
): Promise<RfqDetail> {
  await assertProcurementEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);

  const title = trimTo(input.title, 300);
  if (!title) throw new AecError("rfq_title_required");
  const requestId = optionalUuid(input.requestId);
  if (requestId) {
    const ownerProject = await requestProjectId(owner.businessId, requestId);
    if (ownerProject !== projectId) throw new AecError("request_project_mismatch");
  }

  const rfqId = await withTenantTransaction(owner.businessId, async () => {
    const rfqNumber = await nextAecNumber("aec_rfqs", projectId, RFQ_NUMBER_PREFIX);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_rfqs
         (business_id, project_id, request_id, rfq_number, title, scope, status,
          due_date, response_due, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7::date, $8::date, $9, $10)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        requestId,
        rfqNumber,
        title,
        trimTo(input.scope, 2000),
        optionalDate(input.dueDate),
        optionalDate(input.responseDue),
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const id = rows[0].id;
    if (input.suppliers !== undefined) await replaceRfqSuppliers(owner, id, input.suppliers);
    await recordProcurementEvent(owner, {
      projectId,
      rfqId: id,
      action: "created",
      summary: `استعلام ${rfqNumber} ثبت شد`,
    });
    return id;
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "rfq",
    subjectId: null,
    action: "created",
    summary: `استعلام بها: ${title}`,
  });
  return loadRfq(owner.businessId, rfqId);
}

export async function updateRfq(
  owner: WorkspaceOwner,
  rfqId: string,
  input: RfqInput,
): Promise<RfqDetail> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await rfqProjectId(owner.businessId, rfqId);
  const current = await loadRfq(owner.businessId, rfqId);
  if (!current.isEditable) throw new AecError("rfq_not_editable");

  const title = input.title === undefined ? current.title : trimTo(input.title, 300);
  if (!title) throw new AecError("rfq_title_required");
  const requestId = input.requestId === undefined ? current.requestId : optionalUuid(input.requestId);
  if (requestId) {
    const ownerProject = await requestProjectId(owner.businessId, requestId);
    if (ownerProject !== projectId) throw new AecError("request_project_mismatch");
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_rfqs
          SET request_id = $3, title = $4, scope = $5, due_date = $6::date,
              response_due = $7::date, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        rfqId,
        requestId,
        title,
        input.scope === undefined ? current.scope : trimTo(input.scope, 2000),
        input.dueDate === undefined ? current.dueDate : optionalDate(input.dueDate),
        input.responseDue === undefined ? current.responseDue : optionalDate(input.responseDue),
      ],
    );
    if (input.suppliers !== undefined) await replaceRfqSuppliers(owner, rfqId, input.suppliers);
    await recordProcurementEvent(owner, {
      projectId,
      rfqId,
      action: "updated",
      summary: `استعلام ${current.rfqNumber} ویرایش شد`,
    });
  });
  return loadRfq(owner.businessId, rfqId);
}

export async function deleteRfq(owner: WorkspaceOwner, rfqId: string): Promise<void> {
  await assertProcurementEnabled(owner.businessId);
  const current = await loadRfq(owner.businessId, rfqId);
  if (current.status !== "draft") throw new AecError("rfq_not_editable");
  await query(`DELETE FROM aec_rfqs WHERE business_id = $1 AND id = $2`, [owner.businessId, rfqId]);
  await recordActivity(owner, {
    projectId: current.projectId,
    subjectType: "rfq",
    subjectId: null,
    action: "deleted",
    summary: `استعلام ${current.rfqNumber} حذف شد`,
  });
}

/**
 * Issue, close or cancel an RFQ.
 *
 * Issuing is what §18's flow calls "RFQ": the document goes to the invited
 * suppliers and the register freezes, because they are now quoting *it*. Nothing
 * is committed by asking for prices, which is why the route gates this on
 * `workspace.manage` — the money decision is the award's approval.
 */
export async function applyRfqAction(
  owner: WorkspaceOwner,
  rfqId: string,
  action: RfqAction,
): Promise<RfqDetail> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await rfqProjectId(owner.businessId, rfqId);
  const current = await loadRfq(owner.businessId, rfqId);
  const target = RFQ_ACTION_TARGET[action];
  if (!canTransitionRfq(current.status, target)) throw new AecError("invalid_rfq_transition");
  if (action === "issue" && current.supplierCount === 0) {
    throw new AecError("rfq_supplier_required");
  }

  await withTenantTransaction(owner.businessId, async () => {
    const today = await businessToday(owner.businessId);
    await query(
      `UPDATE aec_rfqs
          SET status = $3,
              issued_date = CASE WHEN $3 = 'issued' THEN COALESCE(issued_date, $4::date) ELSE issued_date END,
              closed_date = CASE WHEN $3 = 'closed' THEN COALESCE(closed_date, $4::date) ELSE closed_date END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [owner.businessId, rfqId, target, today],
    );
    await recordProcurementEvent(owner, {
      projectId,
      rfqId,
      action: RFQ_ACTION_EVENTS[action],
      summary: `استعلام ${current.rfqNumber} ${RFQ_ACTION_PAST_LABELS[action]}`,
    });
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "rfq",
    subjectId: null,
    action: RFQ_ACTION_EVENTS[action],
    summary: `استعلام ${current.rfqNumber} ${RFQ_ACTION_PAST_LABELS[action]}`,
  });
  return loadRfq(owner.businessId, rfqId);
}

/**
 * A quotation arrives.
 *
 * One offer per supplier per RFQ (a UNIQUE index, and the service says so with a
 * code first): a supplier that revises its price does so in a new round, so the
 * comparison sheet always shows one honest figure per supplier.
 */
export async function recordQuotation(
  owner: WorkspaceOwner,
  rfqId: string,
  input: { partyId?: unknown; amountRial?: unknown; leadDays?: unknown; validityDate?: unknown; note?: unknown; receivedDate?: unknown },
): Promise<QuotationSummary> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await rfqProjectId(owner.businessId, rfqId);
  const rfq = await loadRfq(owner.businessId, rfqId);
  if (rfq.status === "closed" || rfq.status === "cancelled") {
    throw new AecError("rfq_not_open");
  }
  const partyId = requiredUuid(input.partyId, "invalid_supplier");
  await assertPartyOwned(owner.businessId, partyId);
  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM aec_supplier_quotations WHERE business_id = $1 AND rfq_id = $2 AND party_id = $3`,
    [owner.businessId, rfqId, partyId],
  );
  if (existing[0]) throw new AecError("quotation_exists");

  const today = await businessToday(owner.businessId);
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO aec_supplier_quotations
       (business_id, rfq_id, party_id, amount_rial, lead_days, validity_date, note, status,
        received_date, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'received', $8::date, $9, $10)
     RETURNING id`,
    [
      owner.businessId,
      rfqId,
      partyId,
      requiredAmount(input.amountRial, "invalid_quotation_amount"),
      optionalCount(input.leadDays, "invalid_lead_days", 3650),
      optionalDate(input.validityDate),
      trimTo(input.note, 1000),
      optionalDate(input.receivedDate) ?? today,
      owner.actorUserId,
      owner.actorName ?? "",
    ],
  );
  await recordProcurementEvent(owner, {
    projectId,
    rfqId,
    action: "quoted",
    summary: `پیشنهاد قیمت برای ${rfq.rfqNumber} ثبت شد`,
  });
  const loaded = await query<Record<string, unknown>>(
    `SELECT ${QUOTATION_SELECT} ${QUOTATION_FROM} WHERE t.business_id = $1 AND t.id = $2`,
    [owner.businessId, rows[0].id],
  );
  return toQuotation(loaded.rows[0]);
}

export async function updateQuotation(
  owner: WorkspaceOwner,
  quotationId: string,
  input: { amountRial?: unknown; leadDays?: unknown; validityDate?: unknown; note?: unknown },
): Promise<QuotationSummary> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await quotationProjectId(owner.businessId, quotationId);
  const { rows: currentRows } = await query<Record<string, unknown>>(
    `SELECT ${QUOTATION_SELECT} ${QUOTATION_FROM} WHERE t.business_id = $1 AND t.id = $2`,
    [owner.businessId, quotationId],
  );
  if (!currentRows[0]) throw new AecError("quotation_not_found");
  const current = toQuotation(currentRows[0]);
  if (isQuotationDecided(current.status)) throw new AecError("quotation_not_editable");

  await query(
    `UPDATE aec_supplier_quotations
        SET amount_rial = $3, lead_days = $4, validity_date = $5::date, note = $6, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      owner.businessId,
      quotationId,
      input.amountRial === undefined
        ? current.amountRial
        : requiredAmount(input.amountRial, "invalid_quotation_amount"),
      input.leadDays === undefined
        ? current.leadDays
        : optionalCount(input.leadDays, "invalid_lead_days", 3650),
      input.validityDate === undefined ? current.validityDate : optionalDate(input.validityDate),
      input.note === undefined ? current.note : trimTo(input.note, 1000),
    ],
  );
  await recordProcurementEvent(owner, {
    projectId,
    rfqId: current.rfqId,
    action: "updated",
    summary: `پیشنهاد ${current.supplierName} ویرایش شد`,
  });
  const loaded = await query<Record<string, unknown>>(
    `SELECT ${QUOTATION_SELECT} ${QUOTATION_FROM} WHERE t.business_id = $1 AND t.id = $2`,
    [owner.businessId, quotationId],
  );
  return toQuotation(loaded.rows[0]);
}

export async function deleteQuotation(owner: WorkspaceOwner, quotationId: string): Promise<void> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await quotationProjectId(owner.businessId, quotationId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${QUOTATION_SELECT} ${QUOTATION_FROM} WHERE t.business_id = $1 AND t.id = $2`,
    [owner.businessId, quotationId],
  );
  if (!rows[0]) throw new AecError("quotation_not_found");
  const current = toQuotation(rows[0]);
  if (isQuotationDecided(current.status)) throw new AecError("quotation_not_editable");
  // An award raised from this offer is a commitment; the quotation is what it
  // was raised from and cannot be removed underneath it.
  const { rows: used } = await query<{ id: string }>(
    `SELECT id FROM aec_commitments WHERE business_id = $1 AND quotation_id = $2 AND status <> 'cancelled'`,
    [owner.businessId, quotationId],
  );
  if (used[0]) throw new AecError("quotation_in_use");

  await query(`DELETE FROM aec_supplier_quotations WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    quotationId,
  ]);
  await recordProcurementEvent(owner, {
    projectId,
    rfqId: current.rfqId,
    action: "deleted",
    summary: `پیشنهاد ${current.supplierName} حذف شد`,
  });
}

/** Shortlist, decline or take a quotation back for consideration. */
export async function applyQuotationAction(
  owner: WorkspaceOwner,
  quotationId: string,
  action: QuotationAction,
): Promise<QuotationSummary> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await quotationProjectId(owner.businessId, quotationId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${QUOTATION_SELECT} ${QUOTATION_FROM} WHERE t.business_id = $1 AND t.id = $2`,
    [owner.businessId, quotationId],
  );
  if (!rows[0]) throw new AecError("quotation_not_found");
  const current = toQuotation(rows[0]);
  const target = QUOTATION_ACTION_TARGET[action];
  if (!canTransitionQuotation(current.status, target)) {
    throw new AecError("invalid_quotation_transition");
  }

  await query(
    `UPDATE aec_supplier_quotations SET status = $3, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, quotationId, target],
  );
  await recordProcurementEvent(owner, {
    projectId,
    rfqId: current.rfqId,
    action: QUOTATION_ACTION_EVENTS[action],
    summary: `پیشنهاد ${current.supplierName} ${QUOTATION_ACTION_PAST_LABELS[action]}`,
  });
  const loaded = await query<Record<string, unknown>>(
    `SELECT ${QUOTATION_SELECT} ${QUOTATION_FROM} WHERE t.business_id = $1 AND t.id = $2`,
    [owner.businessId, quotationId],
  );
  return toQuotation(loaded.rows[0]);
}

/* ===========================================================================
 * §18's commitment — the award
 * ======================================================================== */

export async function listProjectCommitments(
  businessId: string,
  projectId: string,
): Promise<CommitmentSummary[]> {
  await assertProcurementEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${COMMITMENT_SELECT} ${COMMITMENT_FROM}
      WHERE c.business_id = $1 AND c.project_id = $2
      ORDER BY c.created_at DESC, c.commitment_number DESC`,
    [businessId, projectId],
  );
  return rows.map((row) => toCommitment(row, today));
}

export async function loadCommitment(
  businessId: string,
  commitmentId: string,
): Promise<CommitmentDetail> {
  await assertProcurementEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${COMMITMENT_SELECT} ${COMMITMENT_FROM}
      WHERE c.business_id = $1 AND c.id = $2`,
    [businessId, commitmentId],
  );
  if (!rows[0]) throw new AecError("commitment_not_found");
  const { rows: deliveryRows } = await query<Record<string, unknown>>(
    `SELECT id, delivered_on::text AS delivered_on, note, received_by,
            received_by_name, created_at::text AS created_at
       FROM aec_commitment_deliveries
      WHERE business_id = $1 AND commitment_id = $2
      ORDER BY delivered_on, created_at`,
    [businessId, commitmentId],
  );
  return {
    ...toCommitment(rows[0], today),
    deliveries: deliveryRows.map((row) => ({
      id: String(row.id),
      deliveredOn: String(row.delivered_on ?? ""),
      note: String(row.note ?? ""),
      receivedById: (row.received_by as string | null) ?? null,
      receivedByName: String(row.received_by_name ?? ""),
      createdAt: String(row.created_at ?? ""),
    })),
    events: await loadEvents(businessId, "commitment_id", commitmentId),
    attachments: await loadLinkedDocuments(businessId, "commitment_id", commitmentId),
  };
}

/** §18's award, numbered `PO-001` for a purchase and `SC-001` for a subcontract. */
export async function createCommitment(
  owner: WorkspaceOwner,
  projectId: string,
  input: CommitmentInput,
): Promise<CommitmentDetail> {
  await assertProcurementEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);

  const kindRaw = input.kind === undefined ? "purchase" : input.kind;
  if (!isCommitmentKind(String(kindRaw))) throw new AecError("invalid_commitment_kind");
  const kind = String(kindRaw) as CommitmentKind;
  await assertKindEnabled(owner.businessId, kind);

  const title = trimTo(input.title, 300);
  if (!title) throw new AecError("commitment_title_required");
  const supplierPartyId = requiredUuid(input.supplierPartyId, "invalid_supplier");
  await assertPartyOwned(owner.businessId, supplierPartyId);

  const requestId = optionalUuid(input.requestId);
  if (requestId) {
    const ownerProject = await requestProjectId(owner.businessId, requestId);
    if (ownerProject !== projectId) throw new AecError("request_project_mismatch");
  }
  const rfqId = optionalUuid(input.rfqId);
  if (rfqId) {
    const ownerProject = await rfqProjectId(owner.businessId, rfqId);
    if (ownerProject !== projectId) throw new AecError("rfq_project_mismatch");
  }
  const quotationId = optionalUuid(input.quotationId);
  if (quotationId) {
    const ownerProject = await quotationProjectId(owner.businessId, quotationId);
    if (ownerProject !== projectId) throw new AecError("quotation_project_mismatch");
    // §18's integrity rule, repeated here so the caller gets a code rather than a
    // constraint: the offer must be this supplier's, on this RFQ.
    const { rows } = await query<{ party_id: string; rfq_id: string }>(
      `SELECT party_id, rfq_id FROM aec_supplier_quotations WHERE business_id = $1 AND id = $2`,
      [owner.businessId, quotationId],
    );
    if (!rows[0]) throw new AecError("quotation_not_found");
    if (rows[0].party_id !== supplierPartyId) throw new AecError("quotation_supplier_mismatch");
    if (rfqId && rows[0].rfq_id !== rfqId) throw new AecError("quotation_rfq_mismatch");
  }
  const contractId = optionalUuid(input.contractId);
  await assertContractOwned(owner.businessId, contractId, projectId);

  const commitmentId = await withTenantTransaction(owner.businessId, async () => {
    const commitmentNumber = await nextAecNumber(
      "aec_commitments",
      projectId,
      COMMITMENT_NUMBER_PREFIX[kind],
    );
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_commitments
         (business_id, project_id, kind, commitment_number, supplier_party_id, request_id, rfq_id,
          quotation_id, contract_id, title, scope, work_package, value_rial, expected_delivery_date,
          status, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date, 'draft', $15, $16)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        kind,
        commitmentNumber,
        supplierPartyId,
        requestId,
        rfqId,
        quotationId,
        contractId,
        title,
        trimTo(input.scope, 2000),
        trimTo(input.workPackage, 200),
        optionalAmount(input.valueRial, "invalid_commitment_value") ?? 0,
        optionalDate(input.expectedDeliveryDate),
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const id = rows[0].id;
    await replaceLinkedDocuments(
      owner,
      { column: "commitment_id", targetId: id },
      projectId,
      input.attachments,
    );
    // The award is what selects the supplier: the quotation it was raised from
    // is marked selected in the same transaction, so the comparison sheet and
    // the register cannot disagree about who won.
    if (quotationId) {
      await query(
        `UPDATE aec_supplier_quotations SET status = 'selected', updated_at = now()
          WHERE business_id = $1 AND id = $2 AND status <> 'selected'`,
        [owner.businessId, quotationId],
      );
    }
    await recordProcurementEvent(owner, {
      projectId,
      commitmentId: id,
      action: "created",
      summary: `${COMMITMENT_KIND_LABELS[kind]} ${commitmentNumber} ثبت شد`,
    });
    return id;
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "commitment",
    subjectId: commitmentId,
    action: "created",
    summary: `${COMMITMENT_KIND_LABELS[kind]}: ${title}`,
  });
  return loadCommitment(owner.businessId, commitmentId);
}

export async function updateCommitment(
  owner: WorkspaceOwner,
  commitmentId: string,
  input: CommitmentInput,
): Promise<CommitmentDetail> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await commitmentProjectId(owner.businessId, commitmentId);
  const current = await loadCommitment(owner.businessId, commitmentId);
  if (!current.isEditable) throw new AecError("commitment_not_editable");

  const title = input.title === undefined ? current.title : trimTo(input.title, 300);
  if (!title) throw new AecError("commitment_title_required");
  const supplierPartyId =
    input.supplierPartyId === undefined
      ? current.supplierPartyId
      : requiredUuid(input.supplierPartyId, "invalid_supplier");
  await assertPartyOwned(owner.businessId, supplierPartyId);
  const contractId = input.contractId === undefined ? current.contractId : optionalUuid(input.contractId);
  await assertContractOwned(owner.businessId, contractId, projectId);

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_commitments
          SET supplier_party_id = $3, contract_id = $4, title = $5, scope = $6, work_package = $7,
              value_rial = $8, expected_delivery_date = $9::date, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        commitmentId,
        supplierPartyId,
        contractId,
        title,
        input.scope === undefined ? current.scope : trimTo(input.scope, 2000),
        input.workPackage === undefined ? current.workPackage : trimTo(input.workPackage, 200),
        input.valueRial === undefined
          ? current.valueRial
          : optionalAmount(input.valueRial, "invalid_commitment_value") ?? 0,
        input.expectedDeliveryDate === undefined
          ? current.expectedDeliveryDate
          : optionalDate(input.expectedDeliveryDate),
      ],
    );
    if (input.attachments !== undefined) {
      await replaceLinkedDocuments(
        owner,
        { column: "commitment_id", targetId: commitmentId },
        projectId,
        input.attachments,
      );
    }
    await recordProcurementEvent(owner, {
      projectId,
      commitmentId,
      action: "updated",
      summary: `${current.kindLabel} ${current.commitmentNumber} ویرایش شد`,
    });
  });
  return loadCommitment(owner.businessId, commitmentId);
}

export async function deleteCommitment(owner: WorkspaceOwner, commitmentId: string): Promise<void> {
  await assertProcurementEnabled(owner.businessId);
  const current = await loadCommitment(owner.businessId, commitmentId);
  if (current.status !== "draft") throw new AecError("commitment_not_editable");
  await query(`DELETE FROM aec_commitments WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    commitmentId,
  ]);
  await recordActivity(owner, {
    projectId: current.projectId,
    subjectType: "commitment",
    subjectId: null,
    action: "deleted",
    summary: `${current.kindLabel} ${current.commitmentNumber} حذف شد`,
  });
}

/**
 * Walk §18's commitment chain.
 *
 * `approve` is the act that commits money, and it is the one the route gates on
 * `workspace.approve` — together with `reject` and `cancel`, which undo or refuse
 * the same commitment. `deliver` records that the goods arrived (the deliveries
 * themselves are separate rows) and `close` hands the settlement to Accounting.
 */
export async function applyCommitmentAction(
  owner: WorkspaceOwner,
  commitmentId: string,
  action: CommitmentAction,
  input: { note?: unknown; deliveredOn?: unknown } = {},
): Promise<CommitmentDetail> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await commitmentProjectId(owner.businessId, commitmentId);
  const current = await loadCommitment(owner.businessId, commitmentId);
  const target = COMMITMENT_ACTION_TARGET[action];
  if (!canTransitionCommitment(current.status, target)) {
    throw new AecError("invalid_commitment_transition");
  }
  // §18's three facts, checked here as well as by migration 0201's CHECK so the
  // caller gets a code rather than a constraint name: a commitment that is being
  // acted on says how much and when it is expected.
  if (action === "submit") {
    if (current.valueRial <= 0) throw new AecError("commitment_value_required");
    if (!current.expectedDeliveryDate) throw new AecError("commitment_delivery_date_required");
  }

  await withTenantTransaction(owner.businessId, async () => {
    const today = await businessToday(owner.businessId);
    const deliveredOn = action === "deliver" ? optionalDate(input.deliveredOn) ?? today : null;
    await query(
      `UPDATE aec_commitments
          SET status = $3,
              submitted_date = CASE WHEN $3 IN ('submitted', 'approved', 'rejected', 'delivered', 'closed')
                                    THEN COALESCE(submitted_date, $4::date) ELSE submitted_date END,
              approved_date = CASE WHEN $3 IN ('approved', 'delivered', 'closed')
                                   THEN COALESCE(approved_date, $4::date) ELSE approved_date END,
              delivered_date = CASE WHEN $3 IN ('delivered', 'closed')
                                    THEN COALESCE(delivered_date, COALESCE($5::date, $4::date))
                                    ELSE delivered_date END,
              closed_date = CASE WHEN $3 = 'closed'
                                 THEN COALESCE(closed_date, $4::date) ELSE closed_date END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [owner.businessId, commitmentId, target, today, deliveredOn],
    );

    if (action === "submit") {
      await query(
        `INSERT INTO workspace_approvals
           (business_id, subject_type, subject_id, project_id, title, requested_by, note)
         VALUES ($1, 'commitment', $2, $3, $4, $5, $6)`,
        [
          owner.businessId,
          commitmentId,
          projectId,
          `${current.commitmentNumber} — ${current.title.slice(0, 180)}`,
          owner.actorUserId,
          trimTo(input.note, 1000),
        ],
      );
    }

    // Closing an award closes the RFQ it came from: the tender is decided and the
    // comparison no longer needs to accept offers. Only when no sibling award is
    // still open, so a split award keeps its tender alive.
    if (action === "close" && current.rfqId) {
      const { rows } = await query<{ open: number }>(
        `SELECT count(*)::integer AS open FROM aec_commitments
          WHERE business_id = $1 AND rfq_id = $2 AND id <> $3
            AND status IN ('draft', 'submitted', 'approved', 'delivered')`,
        [owner.businessId, current.rfqId, commitmentId],
      );
      if (Number(rows[0]?.open ?? 0) === 0) {
        await query(
          `UPDATE aec_rfqs SET status = 'closed', closed_date = COALESCE(closed_date, $3::date),
                  updated_at = now()
            WHERE business_id = $1 AND id = $2 AND status = 'issued'`,
          [owner.businessId, current.rfqId, today],
        );
      }
    }

    await recordProcurementEvent(owner, {
      projectId,
      commitmentId,
      action: COMMITMENT_ACTION_EVENTS[action],
      summary: `${current.kindLabel} ${current.commitmentNumber} ${COMMITMENT_ACTION_PAST_LABELS[action]}`,
    });
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "commitment",
    subjectId: commitmentId,
    action: COMMITMENT_ACTION_EVENTS[action],
    summary: `${current.kindLabel} ${current.commitmentNumber} ${COMMITMENT_ACTION_PAST_LABELS[action]}`,
  });
  return loadCommitment(owner.businessId, commitmentId);
}

/**
 * The approvals queue's decision, projected onto the award.
 *
 * §18's commitment chain is `draft → submitted → approved | rejected`, with no
 * review step to walk (unlike §15's change order): the queue's approval *is* the
 * approval that commits the money, which is why this function is three lines
 * shorter than its commercial sibling and why `commitmentActionNeedsApproval`
 * puts `approve`, `reject` and `cancel` on `workspace.approve`.
 */
export async function decideCommitmentApproval(
  owner: WorkspaceOwner,
  approvalId: string,
  decision: "approved" | "rejected" | "changes_requested" | "cancelled",
  note = "",
): Promise<{ commitmentId: string | null; applied: boolean }> {
  await assertAecIndustry(owner.businessId);
  const { rows } = await query<{ subject_id: string; status: string }>(
    `SELECT subject_id, status FROM workspace_approvals
      WHERE business_id = $1 AND id = $2 AND subject_type = 'commitment'`,
    [owner.businessId, approvalId],
  );
  const approval = rows[0];
  if (!approval) throw new AecError("approval_not_found");
  if (approval.status !== "pending") return { commitmentId: approval.subject_id, applied: false };

  if (decision !== "cancelled") {
    await applyCommitmentAction(
      owner,
      approval.subject_id,
      decision === "approved" ? "approve" : "reject",
      { note },
    );
  }

  await query(
    `UPDATE workspace_approvals
        SET status = $3, decided_by = $4, decided_at = now(),
            note = COALESCE(NULLIF($5, ''), note), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, approvalId, decision, owner.actorUserId, trimTo(note, 1000)],
  );
  return { commitmentId: approval.subject_id, applied: true };
}

/**
 * §18's delivery tracking: one row per receipt.
 *
 * A delivery is a fact, not a decision — it records what arrived and who signed
 * for it — so it rides `workspace.manage`, and the database refuses one against a
 * commitment that has not been approved (migration 0201's guard), which is what
 * keeps "delivered" from being a status somebody types before the award exists.
 */
export async function recordDelivery(
  owner: WorkspaceOwner,
  commitmentId: string,
  input: { deliveredOn?: unknown; note?: unknown; receivedById?: unknown },
): Promise<CommitmentDetail> {
  await assertProcurementEnabled(owner.businessId);
  const projectId = await commitmentProjectId(owner.businessId, commitmentId);
  const current = await loadCommitment(owner.businessId, commitmentId);
  if (current.status !== "approved" && current.status !== "delivered") {
    throw new AecError("commitment_not_approved");
  }
  const receivedById = optionalUuid(input.receivedById);
  await assertUserOwned(owner.businessId, receivedById);
  const deliveredOn = optionalDate(input.deliveredOn) ?? (await businessToday(owner.businessId));

  await query(
    `INSERT INTO aec_commitment_deliveries
       (business_id, commitment_id, delivered_on, note, received_by, received_by_name)
     VALUES ($1, $2, $3::date, $4, $5, $6)`,
    [
      owner.businessId,
      commitmentId,
      deliveredOn,
      trimTo(input.note, 1000),
      receivedById ?? owner.actorUserId,
      receivedById && receivedById !== owner.actorUserId
        ? (await loadUserName(owner.businessId, receivedById)) || (owner.actorName ?? "")
        : owner.actorName ?? "",
    ],
  );
  await recordProcurementEvent(owner, {
    projectId,
    commitmentId,
    action: "delivered",
    summary: `تحویل برای ${current.commitmentNumber} ثبت شد`,
  });
  return loadCommitment(owner.businessId, commitmentId);
}

async function loadUserName(businessId: string, userId: string): Promise<string> {
  const { rows } = await query<{ full_name: string | null }>(
    `SELECT full_name FROM users WHERE business_id = $1 AND id = $2`,
    [businessId, userId],
  );
  return rows[0]?.full_name ?? "";
}

export async function deleteDelivery(owner: WorkspaceOwner, deliveryId: string): Promise<void> {
  await assertProcurementEnabled(owner.businessId);
  const { rows } = await query<{ commitment_id: string }>(
    `SELECT commitment_id FROM aec_commitment_deliveries WHERE business_id = $1 AND id = $2`,
    [owner.businessId, deliveryId],
  );
  if (!rows[0]) throw new AecError("delivery_not_found");
  const projectId = await commitmentProjectId(owner.businessId, rows[0].commitment_id);
  await query(`DELETE FROM aec_commitment_deliveries WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    deliveryId,
  ]);
  await recordProcurementEvent(owner, {
    projectId,
    commitmentId: rows[0].commitment_id,
    action: "updated",
    summary: "یک ردیف تحویل حذف شد",
  });
}

/* ===========================================================================
 * §20/§22/§23/§29 — the register's summary and the delay queue
 * ======================================================================== */

/**
 * A project's commitments, totalled — **without** the capability gate.
 *
 * The cockpit (§20) must answer for a business that has procurement switched
 * off — an architecture office still has a budget and a contract — and for that
 * business the honest answer is "nothing is committed", which is what an empty
 * register means. The register's own reads, screens and tools go through
 * `projectProcurementSummary` below, which does gate; this one exists so the
 * commercial cockpit does not have to catch an error to find out.
 */
export async function projectCommitmentTotals(
  businessId: string,
  projectId: string,
): Promise<{
  committedRial: number;
  deliveredRial: number;
  delayedCount: number;
  delayedRial: number;
  openCommitmentCount: number;
}> {
  const today = await businessToday(businessId);
  const { rows } = await query<{
    value_rial: string;
    status: string;
    expected_delivery_date: string | null;
  }>(
    `SELECT value_rial, status, expected_delivery_date::text AS expected_delivery_date
       FROM aec_commitments
      WHERE business_id = $1 AND project_id = $2`,
    [businessId, projectId],
  );
  const totals = commitmentTotals(
    rows.map((row) => ({
      status: row.status as CommitmentStatus,
      valueRial: money(row.value_rial),
      expectedDeliveryDate: row.expected_delivery_date,
    })),
    today,
  );
  return {
    ...totals,
    openCommitmentCount: rows.filter((row) =>
      ["draft", "submitted", "approved"].includes(String(row.status)),
    ).length,
  };
}

/** The procurement numbers §20's cockpit and the tab's KPI row report. */
export async function projectProcurementSummary(
  businessId: string,
  projectId: string,
): Promise<ProjectProcurementSummary> {
  await assertProcurementEnabled(businessId);
  const totals = await projectCommitmentTotals(businessId, projectId);

  const { rows: counts } = await query<{
    open_requests: number;
    pending_requests: number;
    issued_rfqs: number;
    quotations: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM aec_material_requests r
         WHERE r.business_id = $1 AND r.project_id = $2 AND r.status IN ('draft', 'submitted', 'approved')) AS open_requests,
       (SELECT count(*)::integer FROM aec_material_requests r
         WHERE r.business_id = $1 AND r.project_id = $2 AND r.status = 'submitted') AS pending_requests,
       (SELECT count(*)::integer FROM aec_rfqs q
         WHERE q.business_id = $1 AND q.project_id = $2 AND q.status = 'issued') AS issued_rfqs,
       (SELECT count(*)::integer FROM aec_supplier_quotations t
          JOIN aec_rfqs q ON q.id = t.rfq_id
         WHERE t.business_id = $1 AND q.project_id = $2) AS quotations`,
    [businessId, projectId],
  );

  return {
    projectId,
    openRequestCount: Number(counts[0]?.open_requests ?? 0),
    pendingRequestCount: Number(counts[0]?.pending_requests ?? 0),
    issuedRfqCount: Number(counts[0]?.issued_rfqs ?? 0),
    quotationCount: Number(counts[0]?.quotations ?? 0),
    committedRial: totals.committedRial,
    deliveredRial: totals.deliveredRial,
    delayedCount: totals.delayedCount,
    delayedRial: totals.delayedRial,
    openCommitmentCount: totals.openCommitmentCount,
  };
}

/**
 * The delayed-delivery queue.
 *
 * One reader for §22's «تأخیر تأمین» widget, §23's `list_procurement_delays` and
 * §29's reminder — "which delivery is late" must have one answer, and it is the
 * same `isCommitmentDelayed` predicate the register and the cockpit use.
 */
export async function delayedCommitments(
  businessId: string,
  options: { projectId?: string | null; afterDays?: number; limit?: number } = {},
): Promise<DelayedCommitmentRow[]> {
  await assertProcurementEnabled(businessId);
  const today = await businessToday(businessId);
  const afterDays = Math.min(Math.max(options.afterDays ?? 0, 0), 365);
  const params: unknown[] = [businessId, afterDays, today];
  let projectClause = "";
  if (options.projectId) {
    params.push(options.projectId);
    projectClause = ` AND c.project_id = $${params.length}`;
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT c.id, c.project_id, p.name AS project_name, c.commitment_number, c.kind, c.title,
            s.name AS supplier_name, c.value_rial,
            c.expected_delivery_date::text AS expected_delivery_date
       FROM aec_commitments c
       JOIN ai_projects p ON p.id = c.project_id
       JOIN parties s ON s.id = c.supplier_party_id
      WHERE c.business_id = $1
        AND c.status = 'approved'
        AND c.expected_delivery_date IS NOT NULL
        AND c.expected_delivery_date + ($2::text || ' days')::interval < $3::date
        ${projectClause}
      ORDER BY c.expected_delivery_date, c.value_rial DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => {
    const kind = isCommitmentKind(String(row.kind))
      ? (String(row.kind) as CommitmentKind)
      : "purchase";
    const expected = String(row.expected_delivery_date ?? "");
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      projectName: String(row.project_name ?? ""),
      commitmentNumber: String(row.commitment_number ?? ""),
      kind,
      kindLabel: COMMITMENT_KIND_LABELS[kind],
      title: String(row.title ?? ""),
      supplierName: String(row.supplier_name ?? ""),
      valueRial: money(row.value_rial),
      expectedDeliveryDate: expected,
      delayDays: commitmentDelayDays(expected, today) ?? 0,
    };
  });
}

/** §18's requirement, waiting on an approver — the same shape as the other queues. */
export async function pendingMaterialRequests(
  businessId: string,
  options: { projectId?: string | null; limit?: number } = {},
): Promise<Array<MaterialRequestSummary & { daysWaiting: number }>> {
  await assertProcurementEnabled(businessId);
  const today = await businessToday(businessId);
  const params: unknown[] = [businessId];
  let projectClause = "";
  if (options.projectId) {
    params.push(options.projectId);
    projectClause = ` AND r.project_id = $${params.length}`;
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${REQUEST_SELECT} ${REQUEST_FROM}
      WHERE r.business_id = $1 AND r.status = 'submitted' ${projectClause}
      ORDER BY r.submitted_date NULLS LAST, r.created_at
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => {
    const request = toRequest(row, today);
    const since = request.submittedDate ?? request.createdAt.slice(0, 10);
    return { ...request, daysWaiting: Math.max(0, daysBetween(since, today)) };
  });
}
