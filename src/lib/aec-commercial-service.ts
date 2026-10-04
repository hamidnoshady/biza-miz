/**
 * Issue #799 §15, §16, §17 and §20 — the commercial service: the change-order
 * register, the payment certificates, the AEC block on an execution contract,
 * and the project's commercial cockpit.
 *
 * The shapes and the rules live in `aec-commercial.ts` (pure); this file is the
 * part that talks to PostgreSQL. It follows `aec-boq-service.ts`,
 * `aec-rfi-service.ts` and `aec-site-service.ts`: every write takes a
 * `WorkspaceOwner`, every read takes a `businessId`, every refusal is an
 * `AecError` code the API guard maps to a status, and the migration's triggers
 * are the backstop rather than the first line.
 *
 * ## The five things this file is careful about
 *
 *   * **An approved variation moves the contract value; it never rewrites the
 *     contract.** §15 is explicit — "must not rewrite the original contract
 *     amount, the original approved BOQ, old estimate versions". The original
 *     stays on `workspace_contracts.value_rial`, untouched, and
 *     `aec_contract_commercials.revised_value_rial` is recomputed by migration
 *     0200's trigger from the original plus the approved variations. Nothing
 *     here writes that figure, which is what makes "somebody raised a change
 *     order" impossible to confuse with "somebody edited the contract".
 *   * **A determination is a separate act from an edit.** Submitting a change
 *     order or certifying a claim is `workspace.approve` at the route (the key
 *     no role below manager holds by preset, §24) while writing the register is
 *     `workspace.manage`. The service keeps the two apart by *action*, so the
 *     routes can gate them apart: `applyVariationAction` and
 *     `applyCertificateAction` are the determining half.
 *   * **Accounting keeps the money that moved.** No table here stores a paid or
 *     received balance. The certificate records what was *certified*; receipts,
 *     payments, A/R and A/P are read from the ledger through `projectReport`
 *     (the same function the finance card and the assistant use), and the
 *     cockpit names them as the ledger's rather than inventing a second set.
 *   * **A submitted change order and a certified claim are frozen** — in the
 *     service and in migration 0200's triggers. The way to correct either is the
 *     chain's own reopening (a rejected variation is re-priced; a certificate is
 *     returned to draft), so the record the client saw is never quietly
 *     rewritten.
 *   * **The approvals are the workspace's approvals.** A submitted variation and
 *     a claim awaiting certification each file one `workspace_approvals` row
 *     (`subject_type = 'variation'` / `'payment_certificate'`), exactly as a BOQ
 *     revision and a submittal revision do. §15's "approvals" and §16's
 *     "client/consultant approval" are therefore projections of decisions made
 *     through the queue that already exists — one approval engine, §24's rule,
 *     and no `variation.approve` permission.
 */
import {
  canTransitionCertificate,
  canTransitionVariation,
  certificateTotals,
  CERTIFICATE_ACTION_EVENTS,
  CERTIFICATE_ACTION_PAST_LABELS,
  CERTIFICATE_ACTION_TARGET,
  CERTIFICATE_KIND_LABELS,
  CERTIFICATE_NUMBER_PREFIX,
  CERTIFICATE_STATUS_LABELS,
  isCertificateKind,
  isCertificateStatus,
  isEditableCertificate,
  isEditableVariation,
  isOpenCertificate,
  isOpenVariation,
  isApprovedVariation,
  isVariationSource,
  isVariationStatus,
  outstandingAdvanceRial,
  VARIATION_ACTION_EVENTS,
  VARIATION_ACTION_PAST_LABELS,
  VARIATION_ACTION_TARGET,
  VARIATION_NUMBER_PREFIX,
  VARIATION_SOURCE_LABELS,
  VARIATION_STATUS_LABELS,
  type CertificateAction,
  type CertificateKind,
  type CertificateStatus,
  type VariationAction,
  type VariationSource,
  type VariationStatus,
} from "./aec-commercial";
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

/**
 * A money figure in integer Rial. `null` means "not stated" and is different
 * from zero — §15 keeps an estimate, a cost impact, a claim and an agreement as
 * four separate numbers precisely because they are allowed to differ, and
 * collapsing "we never estimated it" into 0 would hide that.
 */
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

/** §15's "schedule impact" in whole days. Negative is a real answer (acceleration). */
function optionalSignedInteger(value: unknown, code: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) throw new AecError(code);
  return parsed;
}

function optionalPercent(value: unknown, code: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new AecError(code);
  return Math.round(parsed * 100) / 100;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/* ===========================================================================
 * Shapes
 * ======================================================================== */

export interface CommercialEvent {
  id: string;
  action: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

export interface VariationSummary {
  id: string;
  projectId: string;
  contractId: string | null;
  contractTitle: string | null;
  variationNumber: string;
  source: VariationSource;
  sourceLabel: string;
  reason: string;
  description: string;
  responsiblePartyId: string | null;
  responsiblePartyName: string | null;
  rfiId: string | null;
  rfiNumber: string | null;
  rfiSubject: string | null;
  /** §15's four money figures, in the issue's own order. */
  estimatedAmountRial: number | null;
  costImpactRial: number | null;
  submittedAmountRial: number | null;
  approvedAmountRial: number | null;
  scheduleImpactDays: number | null;
  status: VariationStatus;
  statusLabel: string;
  submittedDate: string | null;
  approvedDate: string | null;
  implementedDate: string | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string;
  attachmentCount: number;
  /** The queue row this change order filed, when it has been submitted. */
  approvalId: string | null;
  approvalStatus: string | null;
  isEditable: boolean;
  isOpen: boolean;
  isApproved: boolean;
}

export interface VariationDetail extends VariationSummary {
  events: CommercialEvent[];
  attachments: LinkedDocument[];
}

export interface VariationInput {
  contractId?: unknown;
  source?: unknown;
  reason?: unknown;
  description?: unknown;
  responsiblePartyId?: unknown;
  rfiId?: unknown;
  estimatedAmountRial?: unknown;
  costImpactRial?: unknown;
  submittedAmountRial?: unknown;
  approvedAmountRial?: unknown;
  scheduleImpactDays?: unknown;
  attachments?: unknown;
}

export interface CertificateLine {
  id: string;
  boqItemId: string | null;
  label: string;
  amountRial: number;
  progressPercent: number | null;
  position: number;
}

export interface CertificateSummary {
  id: string;
  projectId: string;
  contractId: string | null;
  contractTitle: string | null;
  certificateNumber: string;
  kind: CertificateKind;
  kindLabel: string;
  periodStart: string;
  periodEnd: string;
  progressPercent: number | null;
  grossRial: number;
  advanceRecoveryRial: number;
  retentionRial: number;
  otherDeductionsRial: number;
  taxRial: number;
  netRial: number;
  approvedAmountRial: number | null;
  status: CertificateStatus;
  statusLabel: string;
  submittedDate: string | null;
  certifiedDate: string | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string;
  lineCount: number;
  attachmentCount: number;
  approvalId: string | null;
  approvalStatus: string | null;
  /** The contract's revised value — original plus approved variations (§15/§17). */
  contractRevisedValueRial: number | null;
  /** §16's "previous certified": the contract's earlier certified claims. */
  previousCertifiedRial: number;
  /** …and this claim's own certified figure, so the two add up on screen. */
  currentCertifiedRial: number;
  /** §16's progress against the money: what the contract still owes after this. */
  contractOutstandingRial: number | null;
  isEditable: boolean;
  isOpen: boolean;
  isCertified: boolean;
}

export interface CertificateDetail extends CertificateSummary {
  lines: CertificateLine[];
  events: CommercialEvent[];
  attachments: LinkedDocument[];
}

export interface CertificateInput {
  contractId?: unknown;
  kind?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  progressPercent?: unknown;
  grossRial?: unknown;
  advanceRecoveryRial?: unknown;
  retentionRial?: unknown;
  otherDeductionsRial?: unknown;
  taxRial?: unknown;
  approvedAmountRial?: unknown;
  lines?: unknown;
  attachments?: unknown;
}

/** §17's AEC block on an execution contract, joined onto the contract itself. */
export interface ContractCommercial {
  contractId: string;
  contractTitle: string;
  contractType: string;
  contractStatus: string;
  projectId: string | null;
  projectName: string | null;
  partyName: string | null;
  /** The original contract amount — never rewritten by a variation (§15). */
  originalValueRial: number | null;
  contractNumber: string;
  scope: string;
  /** Original plus approved variations, materialised by migration 0200's trigger. */
  revisedValueRial: number | null;
  advancePercent: number | null;
  advanceAmountRial: number | null;
  retentionPercent: number | null;
  paymentTerms: string;
  defectsLiabilityMonths: number | null;
  guaranteeType: string;
  guaranteeReference: string;
  guaranteeAmountRial: number | null;
  guaranteeExpiry: string | null;
  insuranceReference: string;
  insuranceExpiry: string | null;
  responsibleUserId: string | null;
  responsibleName: string;
  createdByName: string;
  createdAt: string | null;
  updatedAt: string | null;
  approvedVariationsRial: number;
  certifiedRial: number;
  /** What is left to certify against the revised value. */
  remainingCommitmentRial: number | null;
  daysToGuaranteeExpiry: number | null;
  daysToInsuranceExpiry: number | null;
}

export interface ContractCommercialInput {
  contractNumber?: unknown;
  scope?: unknown;
  advancePercent?: unknown;
  advanceAmountRial?: unknown;
  retentionPercent?: unknown;
  paymentTerms?: unknown;
  defectsLiabilityMonths?: unknown;
  guaranteeType?: unknown;
  guaranteeReference?: unknown;
  guaranteeAmountRial?: unknown;
  guaranteeExpiry?: unknown;
  insuranceReference?: unknown;
  insuranceExpiry?: unknown;
  responsibleUserId?: unknown;
}

/**
 * §20's cockpit. Every figure states its owner in the type:
 *
 *   - the contract, the variations, the certificates and the retention the
 *     *workspace* keeps are numbers here;
 *   - actual cost is the ledger's, which is why it is `null` for an actor
 *     without `ledger.view` (the same rule `projectReport` applies, and the same
 *     reason: "0 ریال هزینه" is a claim, and a wrong one);
 *   - the figures §20 lists that belong to Accounting — receipts, payments,
 *     A/R, A/P — are named in `readInAccounting` rather than recomputed here,
 *     so the cockpit points at the books instead of keeping a balance that can
 *     drift from them;
 *   - the figures no register carries *yet* — committed cost, cost to
 *     complete, forecast final cost and the forecast margin — are named in
 *     `awaitingWaves` with the wave that brings them (procurement, §18).
 *     Silence would read as zero, and a zero margin is a statement about money.
 */
export interface ProjectCommercialSummary {
  projectId: string;
  projectName: string;
  budgetRial: number | null;
  approvedEstimateRial: number | null;
  originalContractRial: number;
  approvedVariationsRial: number;
  revisedContractRial: number;
  variationCount: number;
  openVariationCount: number;
  certifiedRial: number;
  certificateCount: number;
  pendingCertificateCount: number;
  retentionReceivableRial: number;
  retentionPayableRial: number;
  advanceRial: number;
  advanceRecoveredRial: number;
  outstandingAdvanceRial: number;
  remainingCommitmentRial: number;
  /** Accounting's, or `null` without `ledger.view`. */
  actualCostRial: number | null;
  /** Budget against the ledger's actual cost, when both are known. */
  budgetVarianceRial: number | null;
  readInAccounting: string[];
  awaitingWaves: Array<{ label: string; reason: string }>;
}

export interface PendingVariationRow {
  id: string;
  projectId: string;
  variationNumber: string;
  description: string;
  status: VariationStatus;
  statusLabel: string;
  submittedAmountRial: number | null;
  daysWaiting: number;
}

export interface PendingCertificateRow {
  id: string;
  projectId: string;
  certificateNumber: string;
  kind: CertificateKind;
  kindLabel: string;
  status: CertificateStatus;
  statusLabel: string;
  netRial: number;
  periodEnd: string;
  contractTitle: string | null;
  submittedDate: string | null;
  daysWaiting: number;
}

export interface ExpiringGuaranteeRow {
  contractId: string;
  projectId: string | null;
  contractTitle: string;
  guaranteeType: string;
  guaranteeReference: string;
  guaranteeExpiry: string;
  guaranteeAmountRial: number | null;
  daysRemaining: number;
}

export interface CertifiedClaimRow {
  id: string;
  projectId: string;
  certificateNumber: string;
  contractTitle: string | null;
  certifiedDate: string;
  certifiedRial: number;
  daysSinceCertified: number;
}

/* ===========================================================================
 * Selects
 * ======================================================================== */

// Dates are cast to text in SQL, the repo's own convention: node-postgres would
// otherwise hand back `Date` objects and every screen would be formatting
// whatever `String(date)` produced.
const VARIATION_SELECT = `
  v.id, v.project_id, v.contract_id, c.title AS contract_title,
  v.variation_number, v.source, v.reason, v.description,
  v.responsible_party_id, party.name AS responsible_party_name,
  v.rfi_id, r.rfi_number AS rfi_number, r.subject AS rfi_subject,
  v.estimated_amount_rial, v.cost_impact_rial, v.submitted_amount_rial, v.approved_amount_rial,
  v.schedule_impact_days, v.status,
  v.submitted_date::text AS submitted_date, v.approved_date::text AS approved_date,
  v.implemented_date::text AS implemented_date,
  v.created_by, v.created_by_name, v.created_at::text AS created_at,
  (SELECT count(*)::integer FROM workspace_documents wd
    WHERE wd.variation_id = v.id AND wd.business_id = v.business_id) AS attachment_count,
  a.id AS approval_id, a.status AS approval_status`;

const VARIATION_JOINS = `
  FROM aec_variations v
  LEFT JOIN workspace_contracts c ON c.id = v.contract_id
  LEFT JOIN parties party ON party.id = v.responsible_party_id
  LEFT JOIN aec_rfis r ON r.id = v.rfi_id
  LEFT JOIN LATERAL (
    SELECT id, status FROM workspace_approvals
     WHERE business_id = v.business_id AND subject_type = 'variation' AND subject_id = v.id
     ORDER BY created_at DESC
     LIMIT 1
  ) a ON true`;

const CERTIFICATE_SELECT = `
  k.id, k.project_id, k.contract_id, c.title AS contract_title,
  k.certificate_number, k.kind, k.period_start::text AS period_start, k.period_end::text AS period_end,
  k.progress_percent, k.gross_rial, k.advance_recovery_rial, k.retention_rial,
  k.other_deductions_rial, k.tax_rial, k.net_rial, k.approved_amount_rial, k.status,
  k.submitted_date::text AS submitted_date, k.certified_date::text AS certified_date,
  k.created_by, k.created_by_name, k.created_at::text AS created_at,
  (SELECT count(*)::integer FROM aec_payment_certificate_lines ln
    WHERE ln.certificate_id = k.id) AS line_count,
  (SELECT count(*)::integer FROM workspace_documents wd
    WHERE wd.payment_certificate_id = k.id AND wd.business_id = k.business_id) AS attachment_count,
  a.id AS approval_id, a.status AS approval_status`;

const CERTIFICATE_JOINS = `
  FROM aec_payment_certificates k
  LEFT JOIN workspace_contracts c ON c.id = k.contract_id
  LEFT JOIN LATERAL (
    SELECT id, status FROM workspace_approvals
     WHERE business_id = k.business_id AND subject_type = 'payment_certificate' AND subject_id = k.id
     ORDER BY created_at DESC
     LIMIT 1
  ) a ON true`;

/* ===========================================================================
 * Mappers
 * ======================================================================== */

function optionalMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: unknown): number {
  return optionalMoney(value) ?? 0;
}

function toVariation(row: Record<string, unknown>): VariationSummary {
  const status = isVariationStatus(String(row.status)) ? (row.status as VariationStatus) : "draft";
  const source = isVariationSource(String(row.source)) ? (row.source as VariationSource) : "other";
  const schedule = row.schedule_impact_days;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    contractId: (row.contract_id as string | null) ?? null,
    contractTitle: (row.contract_title as string | null) ?? null,
    variationNumber: String(row.variation_number ?? ""),
    source,
    sourceLabel: VARIATION_SOURCE_LABELS[source],
    reason: String(row.reason ?? ""),
    description: String(row.description ?? ""),
    responsiblePartyId: (row.responsible_party_id as string | null) ?? null,
    responsiblePartyName: (row.responsible_party_name as string | null) ?? null,
    rfiId: (row.rfi_id as string | null) ?? null,
    rfiNumber: (row.rfi_number as string | null) ?? null,
    rfiSubject: (row.rfi_subject as string | null) ?? null,
    estimatedAmountRial: optionalMoney(row.estimated_amount_rial),
    costImpactRial: optionalMoney(row.cost_impact_rial),
    submittedAmountRial: optionalMoney(row.submitted_amount_rial),
    approvedAmountRial: optionalMoney(row.approved_amount_rial),
    scheduleImpactDays: schedule === null || schedule === undefined ? null : Number(schedule),
    status,
    statusLabel: VARIATION_STATUS_LABELS[status],
    submittedDate: (row.submitted_date as string | null) ?? null,
    approvedDate: (row.approved_date as string | null) ?? null,
    implementedDate: (row.implemented_date as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    createdById: (row.created_by as string | null) ?? null,
    createdByName: String(row.created_by_name ?? ""),
    attachmentCount: Number(row.attachment_count ?? 0),
    approvalId: (row.approval_id as string | null) ?? null,
    approvalStatus: (row.approval_status as string | null) ?? null,
    isEditable: isEditableVariation(status),
    isOpen: isOpenVariation(status),
    isApproved: isApprovedVariation(status),
  };
}

function toCertificate(row: Record<string, unknown>): CertificateSummary {
  const status = isCertificateStatus(String(row.status))
    ? (row.status as CertificateStatus)
    : "draft";
  const kind = isCertificateKind(String(row.kind)) ? (row.kind as CertificateKind) : "application";
  const current = status === "certified" ? money(row.approved_amount_rial ?? row.net_rial) : 0;
  // The contract's revised value, when the claim is linked to a contract whose
  // commercial block exists. `previous certified` needs the other claims and is
  // filled in by `withRunningTotals` below.
  const revised = optionalMoney(row.revised_value_rial);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    contractId: (row.contract_id as string | null) ?? null,
    contractTitle: (row.contract_title as string | null) ?? null,
    certificateNumber: String(row.certificate_number ?? ""),
    kind,
    kindLabel: CERTIFICATE_KIND_LABELS[kind],
    periodStart: String(row.period_start ?? ""),
    periodEnd: String(row.period_end ?? ""),
    progressPercent: optionalMoney(row.progress_percent),
    grossRial: money(row.gross_rial),
    advanceRecoveryRial: money(row.advance_recovery_rial),
    retentionRial: money(row.retention_rial),
    otherDeductionsRial: money(row.other_deductions_rial),
    taxRial: money(row.tax_rial),
    netRial: money(row.net_rial),
    approvedAmountRial: optionalMoney(row.approved_amount_rial),
    status,
    statusLabel: CERTIFICATE_STATUS_LABELS[status],
    submittedDate: (row.submitted_date as string | null) ?? null,
    certifiedDate: (row.certified_date as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    createdById: (row.created_by as string | null) ?? null,
    createdByName: String(row.created_by_name ?? ""),
    lineCount: Number(row.line_count ?? 0),
    attachmentCount: Number(row.attachment_count ?? 0),
    approvalId: (row.approval_id as string | null) ?? null,
    approvalStatus: (row.approval_status as string | null) ?? null,
    contractRevisedValueRial: revised,
    previousCertifiedRial: 0,
    currentCertifiedRial: current,
    contractOutstandingRial: revised === null ? null : Math.max(0, revised - current),
    isEditable: isEditableCertificate(status),
    isOpen: isOpenCertificate(status),
    isCertified: status === "certified",
  };
}

/**
 * Fill in §16's "previous certified" — the sum of the earlier certified claims
 * of the same contract, and from it the outstanding figure. Derived on read,
 * never stored: two places holding one running total is how one of them goes
 * stale after a claim is cancelled.
 */
async function withRunningTotals(
  businessId: string,
  summary: CertificateSummary,
): Promise<CertificateSummary> {
  const previous = await certificatePreviousCertified(businessId, {
    id: summary.id,
    projectId: summary.projectId,
    contractId: summary.contractId,
    periodEnd: summary.periodEnd,
  });
  return {
    ...summary,
    previousCertifiedRial: previous,
    contractOutstandingRial:
      summary.contractRevisedValueRial === null
        ? null
        : Math.max(
            0,
            summary.contractRevisedValueRial - previous - summary.currentCertifiedRial,
          ),
  };
}

function toLine(row: Record<string, unknown>): CertificateLine {
  return {
    id: String(row.id),
    boqItemId: (row.boq_item_id as string | null) ?? null,
    label: String(row.label ?? ""),
    amountRial: money(row.amount_rial),
    progressPercent: optionalMoney(row.progress_percent),
    position: Number(row.position ?? 0),
  };
}

function toEvent(row: Record<string, unknown>): CommercialEvent {
  return {
    id: String(row.id),
    action: String(row.action ?? ""),
    summary: String(row.summary ?? ""),
    actorName: String(row.actor_name ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

/* ===========================================================================
 * Guards
 * ======================================================================== */

/**
 * §24's three commercial capabilities, kept apart on purpose: a business can
 * run change orders without issuing payment certificates (a subcontractor that
 * never certifies) and can want §20's cockpit with neither register. A single
 * switch would have forced all three together.
 */
async function assertVariationsEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes("variations")) throw new AecError("capability_disabled");
}

async function assertCertificatesEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes("progress_claims")) throw new AecError("capability_disabled");
}

async function assertFinancialsEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes("financials")) throw new AecError("capability_disabled");
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

/** The same predicate the RFI and site registers use, and the one a merge leaves behind. */
async function assertPartyOwned(businessId: string, partyId: string | null): Promise<void> {
  if (!partyId) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM parties
      WHERE business_id = $1 AND id = $2 AND is_active AND merged_into_id IS NULL`,
    [businessId, partyId],
  );
  if (!rows[0]) throw new AecError("party_not_found");
}

/**
 * A contract named by a change order or a certificate must be this business's
 * — and, when it is bound to a project, that project's. A variation priced
 * against another project's contract would move the wrong revised value, which
 * is the single most expensive mistake this module could let through.
 */
async function assertContractOwned(
  businessId: string,
  contractId: string | null,
  projectId: string | null,
): Promise<void> {
  if (!contractId) return;
  const { rows } = await query<{ project_id: string | null }>(
    `SELECT project_id FROM workspace_contracts WHERE business_id = $1 AND id = $2`,
    [businessId, contractId],
  );
  const contract = rows[0];
  if (!contract) throw new AecError("contract_not_found");
  if (projectId && contract.project_id && contract.project_id !== projectId) {
    throw new AecError("contract_project_mismatch");
  }
}

async function assertRfiOwned(
  businessId: string,
  rfiId: string | null,
  projectId: string,
): Promise<void> {
  if (!rfiId) return;
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_rfis WHERE business_id = $1 AND id = $2`,
    [businessId, rfiId],
  );
  if (!rows[0]) throw new AecError("rfi_not_found");
  if (rows[0].project_id !== projectId) throw new AecError("rfi_project_mismatch");
}

async function assertBoqItemOwned(
  businessId: string,
  boqItemId: string,
  projectId: string,
): Promise<void> {
  // The project lives on the estimate, not on its revisions: a version row
  // carries `estimate_id` and nothing else that says whose work it prices.
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

/**
 * The project a contract belongs to, or `null` for a business-level contract
 * (0167 allows a framework agreement that precedes its project, and the
 * workspace's own contract routes treat those as business-level).
 */
export async function contractProjectId(
  businessId: string,
  contractId: string,
): Promise<string | null> {
  const { rows } = await query<{ project_id: string | null }>(
    `SELECT project_id FROM workspace_contracts WHERE business_id = $1 AND id = $2`,
    [businessId, contractId],
  );
  if (!rows[0]) throw new AecError("contract_not_found");
  return rows[0].project_id;
}

export async function variationProjectId(businessId: string, variationId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_variations WHERE business_id = $1 AND id = $2`,
    [businessId, variationId],
  );
  if (!rows[0]) throw new AecError("variation_not_found");
  return rows[0].project_id;
}

export async function certificateProjectId(
  businessId: string,
  certificateId: string,
): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_payment_certificates WHERE business_id = $1 AND id = $2`,
    [businessId, certificateId],
  );
  if (!rows[0]) throw new AecError("certificate_not_found");
  return rows[0].project_id;
}

/* ===========================================================================
 * The trail (§33)
 * ======================================================================== */

/**
 * One line of the commercial trail.
 *
 * §33 asks for immutable history for contract changes, variation
 * status/approval and payment certificate approval. `workspace_activity` gives
 * the project feed its line (through `recordActivity`, best-effort by design),
 * and `aec_commercial_events` gives the *record* its own trail — which is the
 * one that must not be lost, so it is written in the same transaction as the
 * change and is never updated or deleted afterwards.
 */
async function recordCommercialEvent(
  owner: WorkspaceOwner,
  entry: {
    projectId: string;
    variationId?: string | null;
    certificateId?: string | null;
    action: string;
    summary: string;
  },
): Promise<void> {
  await query(
    `INSERT INTO aec_commercial_events
       (business_id, project_id, variation_id, certificate_id, action, summary, actor_id, actor_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      owner.businessId,
      entry.projectId,
      entry.variationId ?? null,
      entry.certificateId ?? null,
      entry.action,
      entry.summary.slice(0, 500),
      owner.actorUserId,
      owner.actorName ?? "",
    ],
  );
}

async function loadEvents(
  businessId: string,
  subject: { variationId: string } | { certificateId: string },
): Promise<CommercialEvent[]> {
  const column = "variationId" in subject ? "variation_id" : "certificate_id";
  const id = "variationId" in subject ? subject.variationId : subject.certificateId;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, action, summary, actor_name, created_at::text AS created_at
       FROM aec_commercial_events
      WHERE business_id = $1 AND ${column} = $2
      ORDER BY created_at, id`,
    [businessId, id],
  );
  return rows.map(toEvent);
}

/* ===========================================================================
 * Numbering
 * ======================================================================== */

/**
 * The next number for a project, under an advisory lock.
 *
 * `VO-004` is unique per project, and two quantity surveyors pricing a change
 * at the same moment must not both be handed `-004` — so the read and the
 * insert happen inside one transaction that first takes a project-scoped
 * advisory lock, the same pattern `aec-site-service.ts` uses. The seed differs
 * from the site register's so the two locks never contend with each other.
 */
async function nextCommercialNumber(
  table: "aec_variations" | "aec_payment_certificates",
  column: "variation_number" | "certificate_number",
  projectId: string,
  prefix: string,
): Promise<string> {
  await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 7998))`, [
    `commercial:${table}:${projectId}`,
  ]);
  const { rows } = await query<{ max: number | null }>(
    `SELECT MAX(NULLIF(regexp_replace(${column}, '^.*-', ''), '')::integer) AS max
       FROM ${table}
      WHERE project_id = $1 AND ${column} LIKE $2`,
    [projectId, `${prefix}-%`],
  );
  const next = (rows[0]?.max ?? 0) + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

/* ===========================================================================
 * Variations (§15)
 * ======================================================================== */

export async function listProjectVariations(
  businessId: string,
  projectId: string,
): Promise<VariationSummary[]> {
  await assertVariationsEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${VARIATION_SELECT} ${VARIATION_JOINS}
      WHERE v.business_id = $1 AND v.project_id = $2
      ORDER BY v.created_at DESC, v.variation_number DESC`,
    [businessId, projectId],
  );
  return rows.map(toVariation);
}

export async function loadVariation(
  businessId: string,
  variationId: string,
): Promise<VariationDetail> {
  await assertVariationsEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${VARIATION_SELECT} ${VARIATION_JOINS}
      WHERE v.business_id = $1 AND v.id = $2`,
    [businessId, variationId],
  );
  if (!rows[0]) throw new AecError("variation_not_found");
  const summary = toVariation(rows[0]);
  const [events, attachments] = await Promise.all([
    loadEvents(businessId, { variationId }),
    loadLinkedDocuments(businessId, "variation_id", variationId),
  ]);
  return { ...summary, events, attachments };
}

/** What a caller may state about a change order, validated once for create and edit. */
interface ResolvedVariationFields {
  contractId: string | null;
  source: VariationSource;
  reason: string;
  description: string;
  responsiblePartyId: string | null;
  rfiId: string | null;
  estimatedAmountRial: number | null;
  costImpactRial: number | null;
  submittedAmountRial: number | null;
  approvedAmountRial: number | null;
  scheduleImpactDays: number | null;
}

async function resolveVariationFields(
  owner: WorkspaceOwner,
  projectId: string,
  input: VariationInput,
  current: VariationSummary | null,
): Promise<ResolvedVariationFields> {
  const sourceRaw = input.source === undefined ? current?.source ?? "other" : input.source;
  if (!isVariationSource(String(sourceRaw))) throw new AecError("invalid_variation_source");

  const contractId =
    input.contractId === undefined ? current?.contractId ?? null : optionalUuid(input.contractId);
  const responsiblePartyId =
    input.responsiblePartyId === undefined
      ? current?.responsiblePartyId ?? null
      : optionalUuid(input.responsiblePartyId);
  const rfiId = input.rfiId === undefined ? current?.rfiId ?? null : optionalUuid(input.rfiId);

  await assertContractOwned(owner.businessId, contractId, projectId);
  await assertRfiOwned(owner.businessId, rfiId, projectId);
  await assertPartyOwned(owner.businessId, responsiblePartyId);

  const description =
    input.description === undefined
      ? current?.description ?? ""
      : trimTo(input.description, 2000);
  if (!description) throw new AecError("variation_description_required");

  return {
    contractId,
    source: String(sourceRaw) as VariationSource,
    reason: input.reason === undefined ? current?.reason ?? "" : trimTo(input.reason, 2000),
    description,
    responsiblePartyId,
    rfiId,
    estimatedAmountRial:
      input.estimatedAmountRial === undefined
        ? current?.estimatedAmountRial ?? null
        : optionalAmount(input.estimatedAmountRial, "invalid_estimate_amount"),
    costImpactRial:
      input.costImpactRial === undefined
        ? current?.costImpactRial ?? null
        : optionalAmount(input.costImpactRial, "invalid_cost_impact"),
    submittedAmountRial:
      input.submittedAmountRial === undefined
        ? current?.submittedAmountRial ?? null
        : optionalAmount(input.submittedAmountRial, "invalid_submitted_amount"),
    approvedAmountRial:
      input.approvedAmountRial === undefined
        ? current?.approvedAmountRial ?? null
        : optionalAmount(input.approvedAmountRial, "invalid_approved_amount"),
    scheduleImpactDays:
      input.scheduleImpactDays === undefined
        ? current?.scheduleImpactDays ?? null
        : optionalSignedInteger(input.scheduleImpactDays, "invalid_schedule_impact"),
  };
}

/** §15's register entry, numbered `VO-001` per project. */
export async function createVariation(
  owner: WorkspaceOwner,
  projectId: string,
  input: VariationInput,
): Promise<VariationDetail> {
  await assertVariationsEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);
  const fields = await resolveVariationFields(owner, projectId, input, null);

  const variationId = await withTenantTransaction(owner.businessId, async () => {
    const variationNumber = await nextCommercialNumber(
      "aec_variations",
      "variation_number",
      projectId,
      VARIATION_NUMBER_PREFIX,
    );
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_variations
         (business_id, project_id, contract_id, variation_number, source, reason, description,
          responsible_party_id, rfi_id, estimated_amount_rial, cost_impact_rial,
          submitted_amount_rial, approved_amount_rial, schedule_impact_days, status,
          created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft', $15, $16)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        fields.contractId,
        variationNumber,
        fields.source,
        fields.reason,
        fields.description,
        fields.responsiblePartyId,
        fields.rfiId,
        fields.estimatedAmountRial,
        fields.costImpactRial,
        fields.submittedAmountRial,
        fields.approvedAmountRial,
        fields.scheduleImpactDays,
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const id = rows[0].id;
    await recordCommercialEvent(owner, {
      projectId,
      variationId: id,
      action: "created",
      summary: `تغییر ${variationNumber} ثبت شد`,
    });
    await replaceLinkedDocuments(owner, { column: "variation_id", targetId: id }, projectId, input.attachments);
    return id;
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "variation",
    subjectId: variationId,
    action: "created",
    summary: "تغییر جدید ثبت شد",
  });
  return loadVariation(owner.businessId, variationId);
}

/** Editing is what §15 calls Draft and Priced; 0200's trigger freezes the rest. */
export async function updateVariation(
  owner: WorkspaceOwner,
  variationId: string,
  input: VariationInput,
): Promise<VariationDetail> {
  await assertVariationsEnabled(owner.businessId);
  const projectId = await variationProjectId(owner.businessId, variationId);
  const current = await loadVariation(owner.businessId, variationId);
  if (!isEditableVariation(current.status)) throw new AecError("variation_not_editable");
  const fields = await resolveVariationFields(owner, projectId, input, current);

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_variations
          SET contract_id = $3, source = $4, reason = $5, description = $6,
              responsible_party_id = $7, rfi_id = $8, estimated_amount_rial = $9,
              cost_impact_rial = $10, submitted_amount_rial = $11, approved_amount_rial = $12,
              schedule_impact_days = $13, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        variationId,
        fields.contractId,
        fields.source,
        fields.reason,
        fields.description,
        fields.responsiblePartyId,
        fields.rfiId,
        fields.estimatedAmountRial,
        fields.costImpactRial,
        fields.submittedAmountRial,
        fields.approvedAmountRial,
        fields.scheduleImpactDays,
      ],
    );
    await recordCommercialEvent(owner, {
      projectId,
      variationId,
      action: "updated",
      summary: `تغییر ${current.variationNumber} ویرایش شد`,
    });
    if (input.attachments !== undefined) {
      await replaceLinkedDocuments(
        owner,
        { column: "variation_id", targetId: variationId },
        projectId,
        input.attachments,
      );
    }
  });
  return loadVariation(owner.businessId, variationId);
}

/** Only a draft: the trail of a change that was priced or sent is the record. */
export async function deleteVariation(owner: WorkspaceOwner, variationId: string): Promise<void> {
  await assertVariationsEnabled(owner.businessId);
  const current = await loadVariation(owner.businessId, variationId);
  if (current.status !== "draft") throw new AecError("variation_not_editable");
  await query(`DELETE FROM aec_variations WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    variationId,
  ]);
  await recordActivity(owner, {
    projectId: current.projectId,
    subjectType: "variation",
    subjectId: null,
    action: "deleted",
    summary: `تغییر ${current.variationNumber} حذف شد`,
  });
}

/**
 * Move a change order along §15's chain.
 *
 * The action split is what §24 needs from the routes: `price`, `submit` and
 * `reopen` are ordinary `workspace.manage` work — somebody still writing the
 * order — while `review`, `approve`, `reject`, `implement` and `cancel` are
 * determinations and are gated on `workspace.approve`. The service validates
 * the transition and the fields the status promises (a change cannot be
 * approved without an agreed amount); the routes decide who may ask.
 */
export async function applyVariationAction(
  owner: WorkspaceOwner,
  variationId: string,
  action: VariationAction,
  input: { approvedAmountRial?: unknown; note?: unknown } = {},
): Promise<VariationDetail> {
  await assertVariationsEnabled(owner.businessId);
  const projectId = await variationProjectId(owner.businessId, variationId);
  const current = await loadVariation(owner.businessId, variationId);
  const target = VARIATION_ACTION_TARGET[action];
  if (!canTransitionVariation(current.status, target)) {
    throw new AecError("invalid_variation_transition");
  }

  // §15's preconditions, checked here as well as by 0200's CHECKs so the caller
  // gets a code rather than a constraint name (and a 409 rather than a 500: a
  // constraint violation has no code the guard can map).
  const submittedAmount = current.submittedAmountRial;
  let approvedAmount = current.approvedAmountRial;
  if (target === "priced" && current.estimatedAmountRial === null) {
    throw new AecError("variation_estimate_required");
  }
  if (target === "submitted" && submittedAmount === null) {
    throw new AecError("variation_submitted_amount_required");
  }
  if (target === "approved") {
    if (input.approvedAmountRial !== undefined) {
      approvedAmount = optionalAmount(input.approvedAmountRial, "invalid_approved_amount");
    }
    if (approvedAmount === null) throw new AecError("variation_approved_amount_required");
  }
  if (target === "priced" && current.status === "rejected") {
    // Re-pricing is a new round: the agreement that was rejected must not be
    // carried into it, or the next approval would inherit a number nobody
    // agreed to.
    approvedAmount = null;
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_variations
          SET status = $3,
              submitted_amount_rial = $4,
              approved_amount_rial = $5,
              submitted_date = CASE WHEN $3 = 'submitted' THEN COALESCE(submitted_date, $6::date) ELSE submitted_date END,
              approved_date = CASE WHEN $3 IN ('approved', 'implemented') THEN COALESCE(approved_date, $6::date) ELSE approved_date END,
              implemented_date = CASE WHEN $3 = 'implemented' THEN COALESCE(implemented_date, $6::date) ELSE implemented_date END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        variationId,
        target,
        submittedAmount,
        approvedAmount,
        await businessToday(owner.businessId),
      ],
    );

    if (action === "submit") {
      // §15's "approvals": one queue row, the workspace's own mechanism (§24).
      await query(
        `INSERT INTO workspace_approvals
           (business_id, subject_type, subject_id, project_id, title, requested_by, note)
         VALUES ($1, 'variation', $2, $3, $4, $5, $6)`,
        [
          owner.businessId,
          variationId,
          projectId,
          `${current.variationNumber} — ${current.description.slice(0, 180)}`,
          owner.actorUserId,
          trimTo(input.note, 1000),
        ],
      );
    }

    await recordCommercialEvent(owner, {
      projectId,
      variationId,
      action: VARIATION_ACTION_EVENTS[action],
      summary: `تغییر ${current.variationNumber} ${VARIATION_ACTION_PAST_LABELS[action]}`,
    });
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "variation",
    subjectId: variationId,
    action: VARIATION_ACTION_EVENTS[action],
    summary: `تغییر ${current.variationNumber} ${VARIATION_ACTION_PAST_LABELS[action]}`,
  });
  return loadVariation(owner.businessId, variationId);
}

/**
 * The queue's decision, projected onto the change order.
 *
 * `approved` is the only decision that moves money: it sets the agreed amount
 * (the submitted figure, which is what the client was asked for and what the
 * queue's approver saw) and, through migration 0200's trigger, the contract's
 * revised value. A rejection returns the order to `rejected`, where it can be
 * re-priced and resubmitted — which is what a change log actually does.
 */
export async function decideVariationApproval(
  owner: WorkspaceOwner,
  approvalId: string,
  decision: "approved" | "rejected" | "changes_requested" | "cancelled",
  note = "",
): Promise<{ variationId: string | null; applied: boolean }> {
  await assertAecIndustry(owner.businessId);
  const { rows } = await query<{ subject_id: string; status: string }>(
    `SELECT subject_id, status FROM workspace_approvals
      WHERE business_id = $1 AND id = $2 AND subject_type = 'variation'`,
    [owner.businessId, approvalId],
  );
  const approval = rows[0];
  if (!approval) throw new AecError("approval_not_found");
  if (approval.status !== "pending") return { variationId: approval.subject_id, applied: false };

  if (decision !== "cancelled") {
    const current = await loadVariation(owner.businessId, approval.subject_id);
    // A decision taken in the queue *is* the review: the approver is the person
    // the order was sent to, and §15's chain has no submission that jumps
    // straight to an agreement. So the queue walks that step itself instead of
    // failing on a move the screen it was opened from never offered.
    if (current.status === "submitted") {
      await applyVariationAction(owner, approval.subject_id, "review");
    }
    if (decision === "approved") {
      await applyVariationAction(owner, approval.subject_id, "approve", {
        // The submitted figure is what the queue's approver is approving; a
        // screen that wants to agree a different number does it on the change
        // order, where the amount is visible next to its estimate.
        approvedAmountRial: current.approvedAmountRial ?? current.submittedAmountRial ?? undefined,
        note,
      });
    } else {
      // `changes_requested` and `rejected` both mean "not as submitted": the
      // order is rejected and can be re-priced, which is the only honest way to
      // express "revise and resubmit" through a queue whose wording cannot.
      await applyVariationAction(owner, approval.subject_id, "reject", { note });
    }
  }

  await query(
    `UPDATE workspace_approvals
        SET status = $3, decided_by = $4, decided_at = now(),
            note = COALESCE(NULLIF($5, ''), note), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, approvalId, decision, owner.actorUserId, trimTo(note, 1000)],
  );
  return { variationId: approval.subject_id, applied: true };
}

/* ===========================================================================
 * Payment certificates (§16)
 * ======================================================================== */

async function certificatePreviousCertified(
  businessId: string,
  certificate: { id: string; projectId: string; contractId: string | null; periodEnd: string },
): Promise<number> {
  // The same predicate in both directions: a claim certified before this one's
  // period end counts as "previous certified". Null contracts fall back to the
  // project, which is what a business that has not linked its claims to a
  // contract means.
  const { rows } = await query<{ total: string }>(
    `SELECT COALESCE(sum(COALESCE(approved_amount_rial, net_rial)), 0) AS total
       FROM aec_payment_certificates k
      WHERE k.business_id = $1 AND k.id <> $2 AND k.status = 'certified'
        AND k.period_end < $3::date
        AND ${certificate.contractId ? "k.contract_id = $4" : "k.project_id = $4"}`,
    [businessId, certificate.id, certificate.periodEnd, certificate.contractId ?? certificate.projectId],
  );
  return money(rows[0]?.total);
}

async function loadCertificateRow(
  businessId: string,
  certificateId: string,
): Promise<CertificateSummary> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${CERTIFICATE_SELECT},
            c.value_rial AS contract_value_rial,
            cc.revised_value_rial
       ${CERTIFICATE_JOINS}
       LEFT JOIN aec_contract_commercials cc ON cc.contract_id = k.contract_id
      WHERE k.business_id = $1 AND k.id = $2`,
    [businessId, certificateId],
  );
  if (!rows[0]) throw new AecError("certificate_not_found");
  return withRunningTotals(businessId, toCertificate(rows[0]));
}

export async function listProjectCertificates(
  businessId: string,
  projectId: string,
): Promise<CertificateSummary[]> {
  await assertCertificatesEnabled(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${CERTIFICATE_SELECT},
            cc.revised_value_rial
       ${CERTIFICATE_JOINS}
       LEFT JOIN aec_contract_commercials cc ON cc.contract_id = k.contract_id
      WHERE k.business_id = $1 AND k.project_id = $2
      ORDER BY k.period_end DESC, k.certificate_number DESC`,
    [businessId, projectId],
  );
  return Promise.all(rows.map((row) => withRunningTotals(businessId, toCertificate(row))));
}

export async function loadCertificate(
  businessId: string,
  certificateId: string,
): Promise<CertificateDetail> {
  await assertCertificatesEnabled(businessId);
  const summary = await loadCertificateRow(businessId, certificateId);
  const [lines, events, attachments] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT id, boq_item_id, label, amount_rial, progress_percent, position
         FROM aec_payment_certificate_lines
        WHERE business_id = $1 AND certificate_id = $2
        ORDER BY position, id`,
      [businessId, certificateId],
    ).then((result) => result.rows.map(toLine)),
    loadEvents(businessId, { certificateId }),
    loadLinkedDocuments(businessId, "payment_certificate_id", certificateId),
  ]);
  return { ...summary, lines, events, attachments };
}

interface ResolvedCertificateFields {
  contractId: string | null;
  kind: CertificateKind;
  periodStart: string;
  periodEnd: string;
  progressPercent: number | null;
  grossRial: number;
  advanceRecoveryRial: number;
  retentionRial: number;
  otherDeductionsRial: number;
  taxRial: number;
  netRial: number;
  approvedAmountRial: number | null;
}

/**
 * §16's arithmetic and its guards, in one place.
 *
 * `net` is always computed here — a caller cannot state it — because it is the
 * expression migration 0200's CHECK enforces, and two implementations of one
 * subtraction is how a preview and a stored row start to disagree. The advance
 * recovery is additionally checked against the advance the contract actually
 * booked: over-recovering an advance is not a rounding error, it is a claim for
 * money the client never paid.
 */
async function resolveCertificateFields(
  owner: WorkspaceOwner,
  projectId: string,
  input: CertificateInput,
  current: CertificateSummary | null,
): Promise<ResolvedCertificateFields> {
  const kindRaw = input.kind === undefined ? current?.kind ?? "application" : input.kind;
  if (!isCertificateKind(String(kindRaw))) throw new AecError("invalid_certificate_kind");

  const contractId =
    input.contractId === undefined ? current?.contractId ?? null : optionalUuid(input.contractId);
  await assertContractOwned(owner.businessId, contractId, projectId);

  const periodStart =
    input.periodStart === undefined ? current?.periodStart ?? "" : requiredDate(input.periodStart);
  const periodEnd =
    input.periodEnd === undefined ? current?.periodEnd ?? "" : requiredDate(input.periodEnd);
  if (!periodStart) throw new AecError("certificate_period_required");
  if (!periodEnd) throw new AecError("certificate_period_required");
  if (periodEnd < periodStart) throw new AecError("invalid_certificate_period");

  const amounts = {
    grossRial:
      input.grossRial === undefined
        ? current?.grossRial ?? 0
        : requiredAmount(input.grossRial, "invalid_gross_amount"),
    advanceRecoveryRial:
      input.advanceRecoveryRial === undefined
        ? current?.advanceRecoveryRial ?? 0
        : requiredAmount(input.advanceRecoveryRial, "invalid_advance_recovery"),
    retentionRial:
      input.retentionRial === undefined
        ? current?.retentionRial ?? 0
        : requiredAmount(input.retentionRial, "invalid_retention"),
    otherDeductionsRial:
      input.otherDeductionsRial === undefined
        ? current?.otherDeductionsRial ?? 0
        : requiredAmount(input.otherDeductionsRial, "invalid_deductions"),
    taxRial:
      input.taxRial === undefined ? current?.taxRial ?? 0 : requiredAmount(input.taxRial, "invalid_tax"),
  };
  const { netRial } = certificateTotals(amounts);
  if (netRial < 0) throw new AecError("certificate_deductions_exceed_gross");

  const approvedAmountRial =
    input.approvedAmountRial === undefined
      ? current?.approvedAmountRial ?? null
      : optionalAmount(input.approvedAmountRial, "invalid_approved_amount");
  if (approvedAmountRial !== null && approvedAmountRial > netRial) {
    throw new AecError("approved_amount_exceeds_net");
  }

  if (contractId && amounts.advanceRecoveryRial > 0) {
    const { rows } = await query<{ advance: string; recovered: string }>(
      `SELECT COALESCE(cc.advance_amount_rial, 0) AS advance,
              COALESCE((SELECT sum(k2.advance_recovery_rial) FROM aec_payment_certificates k2
                         WHERE k2.business_id = $1 AND k2.contract_id = $2 AND k2.status = 'certified'
                           AND ($3::uuid IS NULL OR k2.id <> $3::uuid)), 0) AS recovered
         FROM workspace_contracts c
         LEFT JOIN aec_contract_commercials cc ON cc.contract_id = c.id
        WHERE c.business_id = $1 AND c.id = $2`,
      [owner.businessId, contractId, current?.id ?? null],
    );
    const advance = money(rows[0]?.advance);
    const recovered = money(rows[0]?.recovered);
    const outstanding = outstandingAdvanceRial(advance, recovered);
    if (amounts.advanceRecoveryRial > outstanding) throw new AecError("advance_over_recovery");
  }

  return {
    contractId,
    kind: String(kindRaw) as CertificateKind,
    periodStart,
    periodEnd,
    progressPercent:
      input.progressPercent === undefined
        ? current?.progressPercent ?? null
        : optionalPercent(input.progressPercent, "invalid_progress_percent"),
    ...amounts,
    netRial,
    approvedAmountRial,
  };
}

/**
 * §16's measurement lines.
 *
 * Replacement, like a transmittal's lines and an attachment list: the panel
 * sends what the claim should measure, and migration 0200 refuses a line on a
 * claim that has already been sent. A line is either a BOQ item (priced work) or
 * a free measurement with a label (a provisional sum, a daywork sheet) — §16
 * asks for "linked BOQ/work packages", which is exactly those two.
 */
async function replaceCertificateLines(
  owner: WorkspaceOwner,
  projectId: string,
  certificateId: string,
  input: unknown,
): Promise<void> {
  const incoming = Array.isArray(input) ? input : [];
  const keep: Array<{ boqItemId: string | null; label: string; amountRial: number; progressPercent: number | null; position: number }> = [];
  for (const [index, entry] of incoming.slice(0, 200).entries()) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const label = trimTo(item.label, 300);
    if (!label) throw new AecError("certificate_line_label_required");
    const boqItemId = optionalUuid(item.boqItemId);
    if (boqItemId) await assertBoqItemOwned(owner.businessId, boqItemId, projectId);
    keep.push({
      boqItemId,
      label,
      amountRial: requiredAmount(item.amountRial, "invalid_line_amount"),
      progressPercent: optionalPercent(item.progressPercent, "invalid_progress_percent"),
      position: index,
    });
  }

  await query(`DELETE FROM aec_payment_certificate_lines WHERE business_id = $1 AND certificate_id = $2`, [
    owner.businessId,
    certificateId,
  ]);
  for (const line of keep) {
    await query(
      `INSERT INTO aec_payment_certificate_lines
         (business_id, certificate_id, boq_item_id, label, amount_rial, progress_percent, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        owner.businessId,
        certificateId,
        line.boqItemId,
        line.label,
        line.amountRial,
        line.progressPercent,
        line.position,
      ],
    );
  }
}

/** §16's claim, numbered `PC-001` per project. */
export async function createCertificate(
  owner: WorkspaceOwner,
  projectId: string,
  input: CertificateInput,
): Promise<CertificateDetail> {
  await assertCertificatesEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);
  const fields = await resolveCertificateFields(owner, projectId, input, null);

  const certificateId = await withTenantTransaction(owner.businessId, async () => {
    const certificateNumber = await nextCommercialNumber(
      "aec_payment_certificates",
      "certificate_number",
      projectId,
      CERTIFICATE_NUMBER_PREFIX,
    );
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_payment_certificates
         (business_id, project_id, contract_id, certificate_number, kind, period_start, period_end,
          progress_percent, gross_rial, advance_recovery_rial, retention_rial,
          other_deductions_rial, tax_rial, net_rial, approved_amount_rial, status,
          created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11, $12, $13, $14, $15,
               'draft', $16, $17)
       RETURNING id`,
      [
        owner.businessId,
        projectId,
        fields.contractId,
        certificateNumber,
        fields.kind,
        fields.periodStart,
        fields.periodEnd,
        fields.progressPercent,
        fields.grossRial,
        fields.advanceRecoveryRial,
        fields.retentionRial,
        fields.otherDeductionsRial,
        fields.taxRial,
        fields.netRial,
        fields.approvedAmountRial,
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const id = rows[0].id;
    if (input.lines !== undefined) {
      await replaceCertificateLines(owner, projectId, id, input.lines);
    }
    await replaceLinkedDocuments(
      owner,
      { column: "payment_certificate_id", targetId: id },
      projectId,
      input.attachments,
    );
    await recordCommercialEvent(owner, {
      projectId,
      certificateId: id,
      action: "created",
      summary: `صورت‌وضعیت ${certificateNumber} ثبت شد`,
    });
    return id;
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "payment_certificate",
    subjectId: certificateId,
    action: "created",
    summary: "صورت‌وضعیت جدید ثبت شد",
  });
  return loadCertificate(owner.businessId, certificateId);
}

export async function updateCertificate(
  owner: WorkspaceOwner,
  certificateId: string,
  input: CertificateInput,
): Promise<CertificateDetail> {
  await assertCertificatesEnabled(owner.businessId);
  const projectId = await certificateProjectId(owner.businessId, certificateId);
  const current = await loadCertificate(owner.businessId, certificateId);
  if (!isEditableCertificate(current.status)) throw new AecError("certificate_not_editable");
  const fields = await resolveCertificateFields(owner, projectId, input, current);

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_payment_certificates
          SET contract_id = $3, kind = $4, period_start = $5::date, period_end = $6::date,
              progress_percent = $7, gross_rial = $8, advance_recovery_rial = $9,
              retention_rial = $10, other_deductions_rial = $11, tax_rial = $12, net_rial = $13,
              approved_amount_rial = $14, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        certificateId,
        fields.contractId,
        fields.kind,
        fields.periodStart,
        fields.periodEnd,
        fields.progressPercent,
        fields.grossRial,
        fields.advanceRecoveryRial,
        fields.retentionRial,
        fields.otherDeductionsRial,
        fields.taxRial,
        fields.netRial,
        fields.approvedAmountRial,
      ],
    );
    if (input.lines !== undefined) {
      await replaceCertificateLines(owner, projectId, certificateId, input.lines);
    }
    if (input.attachments !== undefined) {
      await replaceLinkedDocuments(
        owner,
        { column: "payment_certificate_id", targetId: certificateId },
        projectId,
        input.attachments,
      );
    }
    await recordCommercialEvent(owner, {
      projectId,
      certificateId,
      action: "updated",
      summary: `صورت‌وضعیت ${current.certificateNumber} ویرایش شد`,
    });
  });
  return loadCertificate(owner.businessId, certificateId);
}

export async function deleteCertificate(owner: WorkspaceOwner, certificateId: string): Promise<void> {
  await assertCertificatesEnabled(owner.businessId);
  const current = await loadCertificate(owner.businessId, certificateId);
  if (current.status !== "draft") throw new AecError("certificate_not_editable");
  await query(`DELETE FROM aec_payment_certificates WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    certificateId,
  ]);
  await recordActivity(owner, {
    projectId: current.projectId,
    subjectType: "payment_certificate",
    subjectId: null,
    action: "deleted",
    summary: `صورت‌وضعیت ${current.certificateNumber} حذف شد`,
  });
}

/**
 * Move a claim along §16's cycle.
 *
 * `submit` and `reopen` are `workspace.manage`; `review`, `certify`, `reject`
 * and `cancel` are determinations and are gated on `workspace.approve` at the
 * route. Certification is the one that carries money: it fixes the approved
 * figure (the net, unless the certifier approved less) and the date the §29
 * follow-up is measured from. Like every other figure in this module it is a
 * *certified* amount, not a received one — receipts stay in Accounting.
 */
export async function applyCertificateAction(
  owner: WorkspaceOwner,
  certificateId: string,
  action: CertificateAction,
  input: { approvedAmountRial?: unknown; note?: unknown } = {},
): Promise<CertificateDetail> {
  await assertCertificatesEnabled(owner.businessId);
  const projectId = await certificateProjectId(owner.businessId, certificateId);
  const current = await loadCertificate(owner.businessId, certificateId);
  const target = CERTIFICATE_ACTION_TARGET[action];
  if (!canTransitionCertificate(current.status, target)) {
    throw new AecError("invalid_certificate_transition");
  }

  // §16's "the lines are the measurement" rule, checked before the write so the
  // caller gets a code: a claim whose measured lines do not add up to its gross
  // figure is two answers to one question, and 0200's trigger refuses it too.
  if (target !== "draft" && current.lines.length > 0) {
    const total = current.lines.reduce((sum, line) => sum + line.amountRial, 0);
    if (total !== current.grossRial) throw new AecError("certificate_lines_mismatch");
  }

  let approvedAmount = current.approvedAmountRial;
  if (target === "certified") {
    if (input.approvedAmountRial !== undefined) {
      approvedAmount = optionalAmount(input.approvedAmountRial, "invalid_approved_amount");
    }
    // The certifier may approve less than the claim; approving nothing at all
    // means approving the claim as measured, which is the ordinary case.
    if (approvedAmount === null) approvedAmount = current.netRial;
    if (approvedAmount > current.netRial) throw new AecError("approved_amount_exceeds_net");
  }
  if (target === "draft") approvedAmount = null;

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_payment_certificates
          SET status = $3,
              approved_amount_rial = $4,
              submitted_date = CASE WHEN $3 = 'submitted' THEN COALESCE(submitted_date, $5::date) ELSE submitted_date END,
              certified_date = CASE WHEN $3 = 'certified' THEN COALESCE(certified_date, $5::date) ELSE certified_date END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        owner.businessId,
        certificateId,
        target,
        approvedAmount,
        await businessToday(owner.businessId),
      ],
    );

    if (action === "submit") {
      await query(
        `INSERT INTO workspace_approvals
           (business_id, subject_type, subject_id, project_id, title, requested_by, note)
         VALUES ($1, 'payment_certificate', $2, $3, $4, $5, $6)`,
        [
          owner.businessId,
          certificateId,
          projectId,
          `${current.certificateNumber} — ${current.kindLabel} (${current.periodStart} تا ${current.periodEnd})`,
          owner.actorUserId,
          trimTo(input.note, 1000),
        ],
      );
    }

    await recordCommercialEvent(owner, {
      projectId,
      certificateId,
      action: CERTIFICATE_ACTION_EVENTS[action],
      summary: `صورت‌وضعیت ${current.certificateNumber} ${CERTIFICATE_ACTION_PAST_LABELS[action]}`,
    });
  });

  await recordActivity(owner, {
    projectId,
    subjectType: "payment_certificate",
    subjectId: certificateId,
    action: CERTIFICATE_ACTION_EVENTS[action],
    summary: `صورت‌وضعیت ${current.certificateNumber} ${CERTIFICATE_ACTION_PAST_LABELS[action]}`,
  });
  return loadCertificate(owner.businessId, certificateId);
}

/**
 * The queue's decision, projected onto the claim. `approved` certifies it (at
 * its net figure — the queue's approver sees the claim, not a negotiation), and
 * everything else sends it back to draft to be re-measured.
 */
export async function decideCertificateApproval(
  owner: WorkspaceOwner,
  approvalId: string,
  decision: "approved" | "rejected" | "changes_requested" | "cancelled",
  note = "",
): Promise<{ certificateId: string | null; applied: boolean }> {
  await assertAecIndustry(owner.businessId);
  const { rows } = await query<{ subject_id: string; status: string }>(
    `SELECT subject_id, status FROM workspace_approvals
      WHERE business_id = $1 AND id = $2 AND subject_type = 'payment_certificate'`,
    [owner.businessId, approvalId],
  );
  const approval = rows[0];
  if (!approval) throw new AecError("approval_not_found");
  if (approval.status !== "pending") return { certificateId: approval.subject_id, applied: false };

  if (decision !== "cancelled") {
    // The same rule as the change order's queue: certifying straight off a
    // submission is what the approvals screen offers, so §16's review step is
    // taken here rather than surfacing as an invalid transition.
    const current = await loadCertificate(owner.businessId, approval.subject_id);
    if (current.status === "submitted") {
      await applyCertificateAction(owner, approval.subject_id, "review");
    }
    await applyCertificateAction(
      owner,
      approval.subject_id,
      decision === "approved" ? "certify" : "reject",
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
  return { certificateId: approval.subject_id, applied: true };
}

/* ===========================================================================
 * The execution contract's commercial block (§17)
 * ======================================================================== */

const COMMERCIAL_SELECT = `
  c.id AS contract_id, c.title AS contract_title, c.contract_type, c.status AS contract_status,
  c.project_id, p.name AS project_name, party.name AS party_name, c.value_rial AS original_value_rial,
  COALESCE(cc.contract_number, '') AS contract_number, COALESCE(cc.scope, '') AS scope,
  cc.revised_value_rial, cc.advance_percent, cc.advance_amount_rial, cc.retention_percent,
  COALESCE(cc.payment_terms, '') AS payment_terms, cc.defects_liability_months,
  COALESCE(cc.guarantee_type, '') AS guarantee_type,
  COALESCE(cc.guarantee_reference, '') AS guarantee_reference, cc.guarantee_amount_rial,
  cc.guarantee_expiry::text AS guarantee_expiry,
  COALESCE(cc.insurance_reference, '') AS insurance_reference,
  cc.insurance_expiry::text AS insurance_expiry,
  cc.responsible_user_id, COALESCE(cc.responsible_name, '') AS responsible_name,
  COALESCE(cc.created_by_name, '') AS commercial_created_by_name,
  cc.created_at::text AS commercial_created_at, cc.updated_at::text AS commercial_updated_at,
  COALESCE((SELECT sum(v.approved_amount_rial) FROM aec_variations v
             WHERE v.contract_id = c.id AND v.status IN ('approved', 'implemented')), 0) AS approved_variations_rial,
  COALESCE((SELECT sum(COALESCE(k.approved_amount_rial, k.net_rial)) FROM aec_payment_certificates k
             WHERE k.contract_id = c.id AND k.status = 'certified'), 0) AS certified_rial`;

const COMMERCIAL_JOINS = `
  FROM workspace_contracts c
  LEFT JOIN ai_projects p ON p.id = c.project_id
  LEFT JOIN parties party ON party.id = c.party_id
  LEFT JOIN aec_contract_commercials cc ON cc.contract_id = c.id`;

function toContractCommercial(row: Record<string, unknown>, today: string): ContractCommercial {
  const expiry = (row.guarantee_expiry as string | null) ?? null;
  const insurance = (row.insurance_expiry as string | null) ?? null;
  const original = optionalMoney(row.original_value_rial);
  const revised = optionalMoney(row.revised_value_rial);
  const certified = money(row.certified_rial);
  return {
    contractId: String(row.contract_id),
    contractTitle: String(row.contract_title ?? ""),
    contractType: String(row.contract_type ?? "other"),
    contractStatus: String(row.contract_status ?? "draft"),
    projectId: (row.project_id as string | null) ?? null,
    projectName: (row.project_name as string | null) ?? null,
    partyName: (row.party_name as string | null) ?? null,
    originalValueRial: original,
    contractNumber: String(row.contract_number ?? ""),
    scope: String(row.scope ?? ""),
    // Before the commercial block exists the revised value is the original —
    // "revised" is not a second opinion, it is the contract plus its approved
    // changes, and with no changes it is the contract.
    revisedValueRial: revised ?? original,
    advancePercent: optionalMoney(row.advance_percent),
    advanceAmountRial: optionalMoney(row.advance_amount_rial),
    retentionPercent: optionalMoney(row.retention_percent),
    paymentTerms: String(row.payment_terms ?? ""),
    defectsLiabilityMonths:
      row.defects_liability_months === null || row.defects_liability_months === undefined
        ? null
        : Number(row.defects_liability_months),
    guaranteeType: String(row.guarantee_type ?? ""),
    guaranteeReference: String(row.guarantee_reference ?? ""),
    guaranteeAmountRial: optionalMoney(row.guarantee_amount_rial),
    guaranteeExpiry: expiry,
    insuranceReference: String(row.insurance_reference ?? ""),
    insuranceExpiry: insurance,
    responsibleUserId: (row.responsible_user_id as string | null) ?? null,
    responsibleName: String(row.responsible_name ?? ""),
    createdByName: String(row.commercial_created_by_name ?? ""),
    createdAt: (row.commercial_created_at as string | null) ?? null,
    updatedAt: (row.commercial_updated_at as string | null) ?? null,
    approvedVariationsRial: money(row.approved_variations_rial),
    certifiedRial: certified,
    remainingCommitmentRial:
      (revised ?? original) === null ? null : Math.max(0, (revised ?? original)! - certified),
    daysToGuaranteeExpiry: expiry ? daysBetween(today, expiry) : null,
    daysToInsuranceExpiry: insurance ? daysBetween(today, insurance) : null,
  };
}

export async function loadContractCommercial(
  businessId: string,
  contractId: string,
): Promise<ContractCommercial> {
  await assertFinancialsEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${COMMERCIAL_SELECT} ${COMMERCIAL_JOINS}
      WHERE c.business_id = $1 AND c.id = $2`,
    [businessId, contractId],
  );
  if (!rows[0]) throw new AecError("contract_not_found");
  return toContractCommercial(rows[0], today);
}

export async function listProjectContractCommercials(
  businessId: string,
  projectId: string,
): Promise<ContractCommercial[]> {
  await assertFinancialsEnabled(businessId);
  const today = await businessToday(businessId);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${COMMERCIAL_SELECT} ${COMMERCIAL_JOINS}
      WHERE c.business_id = $1 AND c.project_id = $2
      ORDER BY c.created_at DESC`,
    [businessId, projectId],
  );
  return rows.map((row) => toContractCommercial(row, today));
}

/**
 * Create or amend the AEC block of a contract.
 *
 * Upsert rather than two functions: the block is an extension of the contract
 * row (one per contract, `UNIQUE (contract_id)`), not a history of its own —
 * §33's history is the activity trail and the approval queue, and a second
 * version chain of a mask of fields would be a third place to look for "what was
 * agreed". `revised_value_rial` is deliberately not writable here: migration
 * 0200's trigger computes it from the contract and its approved variations.
 */
export async function saveContractCommercial(
  owner: WorkspaceOwner,
  contractId: string,
  input: ContractCommercialInput,
): Promise<ContractCommercial> {
  await assertFinancialsEnabled(owner.businessId);
  const { rows: contractRows } = await query<{ project_id: string | null }>(
    `SELECT project_id FROM workspace_contracts WHERE business_id = $1 AND id = $2`,
    [owner.businessId, contractId],
  );
  if (!contractRows[0]) throw new AecError("contract_not_found");

  const responsibleUserId = optionalUuid(input.responsibleUserId);
  await assertUserOwned(owner.businessId, responsibleUserId);
  let responsibleName = "";
  if (responsibleUserId) {
    const { rows } = await query<{ full_name: string | null }>(
      `SELECT full_name FROM users WHERE business_id = $1 AND id = $2`,
      [owner.businessId, responsibleUserId],
    );
    responsibleName = rows[0]?.full_name ?? "";
  }

  const defectsMonths = optionalSignedInteger(input.defectsLiabilityMonths, "invalid_defects_period");
  if (defectsMonths !== null && (defectsMonths < 0 || defectsMonths > 240)) {
    throw new AecError("invalid_defects_period");
  }

  await query(
    `INSERT INTO aec_contract_commercials
       (business_id, contract_id, contract_number, scope, advance_percent, advance_amount_rial,
        retention_percent, payment_terms, defects_liability_months, guarantee_type,
        guarantee_reference, guarantee_amount_rial, guarantee_expiry, insurance_reference,
        insurance_expiry, responsible_user_id, responsible_name, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $14, $15::date, $16, $17, $18, $19)
     ON CONFLICT (contract_id) DO UPDATE
       SET contract_number = EXCLUDED.contract_number,
           scope = EXCLUDED.scope,
           advance_percent = EXCLUDED.advance_percent,
           advance_amount_rial = EXCLUDED.advance_amount_rial,
           retention_percent = EXCLUDED.retention_percent,
           payment_terms = EXCLUDED.payment_terms,
           defects_liability_months = EXCLUDED.defects_liability_months,
           guarantee_type = EXCLUDED.guarantee_type,
           guarantee_reference = EXCLUDED.guarantee_reference,
           guarantee_amount_rial = EXCLUDED.guarantee_amount_rial,
           guarantee_expiry = EXCLUDED.guarantee_expiry,
           insurance_reference = EXCLUDED.insurance_reference,
           insurance_expiry = EXCLUDED.insurance_expiry,
           responsible_user_id = EXCLUDED.responsible_user_id,
           responsible_name = EXCLUDED.responsible_name,
           updated_at = now()`,
    [
      owner.businessId,
      contractId,
      trimTo(input.contractNumber, 100),
      trimTo(input.scope, 4000),
      optionalPercent(input.advancePercent, "invalid_advance_percent"),
      optionalAmount(input.advanceAmountRial, "invalid_advance_amount"),
      optionalPercent(input.retentionPercent, "invalid_retention_percent"),
      trimTo(input.paymentTerms, 2000),
      defectsMonths,
      trimTo(input.guaranteeType, 200),
      trimTo(input.guaranteeReference, 200),
      optionalAmount(input.guaranteeAmountRial, "invalid_guarantee_amount"),
      optionalDate(input.guaranteeExpiry),
      trimTo(input.insuranceReference, 200),
      optionalDate(input.insuranceExpiry),
      responsibleUserId,
      responsibleName,
      owner.actorUserId,
      owner.actorName ?? "",
    ],
  );

  const commercial = await loadContractCommercial(owner.businessId, contractId);
  await recordActivity(owner, {
    projectId: contractRows[0].project_id,
    subjectType: "contract",
    subjectId: contractId,
    action: "commercial_updated",
    summary: `اطلاعات تجاری قرارداد «${commercial.contractTitle}» به‌روزرسانی شد`,
  });
  return commercial;
}

/* ===========================================================================
 * §20 — the project's commercial cockpit
 * ======================================================================== */

/**
 * §20's figures that belong to the books.
 *
 * Exported as data rather than as an empty field per number: the cockpit prints
 * these with a link to Accounting, which is how a screen "shows" a figure it
 * must not keep a copy of. §20's own source-of-truth table is what this list
 * enacts — "actual cost, posted payments, A/R, A/P → Accounting".
 */
export const COMMERCIAL_ACCOUNTING_FIGURES = [
  "دریافتی‌های ثبت‌شده و ماندهٔ صورت‌وضعیت‌های تسویه‌نشده",
  "پرداختی‌ها و ماندهٔ بستانکاران",
  "حساب‌های دریافتنی و پرداختنی",
] as const;

/** §20's figures that need a register this build does not have yet. */
export const COMMERCIAL_AWAITING_WAVES: ReadonlyArray<{ label: string; reason: string }> = [
  {
    label: "هزینهٔ تعهدشده و تأخیر تأمین",
    reason: "با ثبت سفارش خرید و پیمان‌های جزء (موج ۹ — تأمین و خرید) محاسبه می‌شود.",
  },
  {
    label: "هزینه تا تکمیل و هزینهٔ نهایی پیش‌بینی‌شده",
    reason: "به تعهدات باز و پیش‌بینی هزینهٔ جاری نیاز دارد؛ تا آن زمان صفر گزارش نمی‌شود.",
  },
  {
    label: "حاشیهٔ برآوردی پروژه",
    reason: "بدون هزینهٔ نهایی پیش‌بینی‌شده معنا ندارد؛ حاشیه در حسابداری بر پایهٔ درآمد شناسایی‌شده خوانده می‌شود.",
  },
];

export async function getProjectCommercialSummary(
  owner: WorkspaceOwner,
  projectId: string,
): Promise<ProjectCommercialSummary> {
  await assertFinancialsEnabled(owner.businessId);
  const { rows: projectRows } = await query<{ id: string; name: string; budget_rial: string | null }>(
    `SELECT id, name, budget_rial FROM ai_projects
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [owner.businessId, projectId],
  );
  const project = projectRows[0];
  if (!project) throw new AecError("project_not_found");

  const { rows: contractRows } = await query<{ original: string; revised: string }>(
    `SELECT COALESCE(sum(c.value_rial), 0) AS original,
            COALESCE(sum(COALESCE(cc.revised_value_rial, c.value_rial)), 0) AS revised
       FROM workspace_contracts c
       LEFT JOIN aec_contract_commercials cc ON cc.contract_id = c.id
      WHERE c.business_id = $1 AND c.project_id = $2
        AND c.status IN ('active', 'completed', 'pending_approval')`,
    [owner.businessId, projectId],
  );

  const { rows: variationRows } = await query<{
    approved: string;
    total: number;
    open: number;
  }>(
    `SELECT COALESCE(sum(approved_amount_rial) FILTER (WHERE status IN ('approved', 'implemented')), 0) AS approved,
            count(*)::integer AS total,
            count(*) FILTER (WHERE status NOT IN ('implemented', 'cancelled'))::integer AS open
       FROM aec_variations
      WHERE business_id = $1 AND project_id = $2`,
    [owner.businessId, projectId],
  );

  const { rows: certificateRows } = await query<{
    certified: string;
    total: number;
    pending: number;
    retention_receivable: string;
    retention_payable: string;
    advance_recovered: string;
  }>(
    `SELECT COALESCE(sum(COALESCE(approved_amount_rial, net_rial))
                       FILTER (WHERE status = 'certified'), 0) AS certified,
            count(*)::integer AS total,
            count(*) FILTER (WHERE status IN ('submitted', 'under_review'))::integer AS pending,
            COALESCE(sum(retention_rial) FILTER (WHERE status = 'certified' AND kind = 'application'), 0) AS retention_receivable,
            COALESCE(sum(retention_rial) FILTER (WHERE status = 'certified' AND kind = 'certificate'), 0) AS retention_payable,
            COALESCE(sum(advance_recovery_rial) FILTER (WHERE status = 'certified'), 0) AS advance_recovered
       FROM aec_payment_certificates
      WHERE business_id = $1 AND project_id = $2`,
    [owner.businessId, projectId],
  );

  const { rows: advanceRows } = await query<{ advance: string }>(
    `SELECT COALESCE(sum(cc.advance_amount_rial), 0) AS advance
       FROM workspace_contracts c
       JOIN aec_contract_commercials cc ON cc.contract_id = c.id
      WHERE c.business_id = $1 AND c.project_id = $2`,
    [owner.businessId, projectId],
  );

  const { rows: estimateRows } = await query<{ total_rial: string | null }>(
    `SELECT v.total_rial
       FROM aec_estimate_versions v
       JOIN aec_estimates e ON e.id = v.estimate_id
      WHERE v.business_id = $1 AND e.project_id = $2 AND v.status = 'approved'
      ORDER BY v.approved_at DESC NULLS LAST, v.version_no DESC
      LIMIT 1`,
    [owner.businessId, projectId],
  );

  const originalContractRial = money(contractRows[0]?.original);
  const revisedFromContracts = money(contractRows[0]?.revised);
  const approvedVariationsRial = money(variationRows[0]?.approved);
  // The project's revised value: the contracts' own revised figures (each of
  // which the trigger derives from its original plus its approved variations),
  // falling back to the variations register for a project whose changes are not
  // linked to a contract yet.
  const revisedContractRial =
    revisedFromContracts > 0 ? revisedFromContracts : originalContractRial + approvedVariationsRial;

  const certifiedRial = money(certificateRows[0]?.certified);
  const advanceRial = money(advanceRows[0]?.advance);
  const advanceRecoveredRial = money(certificateRows[0]?.advance_recovered);
  const budgetRial = project.budget_rial === null ? null : Number(project.budget_rial);

  // Accounting's actual cost, read the same way the finance card and the
  // assistant read it (`projectReport` → `journal_lines` through the project
  // dimension), and `null` for a caller without `ledger.view` — the same rule
  // and the same reason.
  const { projectReport } = await import("./workspace");
  const report = await projectReport(owner, { projectId });
  const actualCostRial = report[0]?.spentRial ?? null;
  const budgetVarianceRial =
    budgetRial === null || actualCostRial === null ? null : budgetRial - actualCostRial;

  return {
    projectId: project.id,
    projectName: project.name,
    budgetRial,
    approvedEstimateRial: estimateRows[0]?.total_rial === undefined
      ? null
      : optionalMoney(estimateRows[0]?.total_rial),
    originalContractRial,
    approvedVariationsRial,
    revisedContractRial,
    variationCount: Number(variationRows[0]?.total ?? 0),
    openVariationCount: Number(variationRows[0]?.open ?? 0),
    certifiedRial,
    certificateCount: Number(certificateRows[0]?.total ?? 0),
    pendingCertificateCount: Number(certificateRows[0]?.pending ?? 0),
    retentionReceivableRial: money(certificateRows[0]?.retention_receivable),
    retentionPayableRial: money(certificateRows[0]?.retention_payable),
    advanceRial,
    advanceRecoveredRial,
    outstandingAdvanceRial: outstandingAdvanceRial(advanceRial, advanceRecoveredRial),
    remainingCommitmentRial: Math.max(0, revisedContractRial - certifiedRial),
    actualCostRial,
    budgetVarianceRial,
    readInAccounting: [...COMMERCIAL_ACCOUNTING_FIGURES],
    awaitingWaves: [...COMMERCIAL_AWAITING_WAVES],
  };
}

/* ===========================================================================
 * §22/§23/§29 — the queues
 * ======================================================================== */

/**
 * Change orders waiting on somebody, oldest first.
 *
 * `daysWaiting` is measured from the submission date rather than the row's
 * creation: §15's chain can sit in Draft for a month without anything being
 * late, and the clock that matters starts when the client was asked.
 */
export async function pendingVariations(
  businessId: string,
  options: { projectId?: string | null; limit?: number } = {},
): Promise<PendingVariationRow[]> {
  await assertVariationsEnabled(businessId);
  const today = await businessToday(businessId);
  const params: unknown[] = [businessId];
  const where = ["v.business_id = $1", "v.status IN ('submitted', 'under_review')"];
  if (options.projectId) {
    params.push(options.projectId);
    where.push(`v.project_id = $${params.length}`);
  }
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT v.id, v.project_id, v.variation_number, v.description, v.status,
            v.submitted_amount_rial,
            COALESCE(v.submitted_date, v.created_at::date)::text AS waiting_since
       FROM aec_variations v
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(v.submitted_date, v.created_at::date), v.variation_number
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => {
    const status = isVariationStatus(String(row.status))
      ? (row.status as VariationStatus)
      : "draft";
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      variationNumber: String(row.variation_number ?? ""),
      description: String(row.description ?? ""),
      status,
      statusLabel: VARIATION_STATUS_LABELS[status],
      submittedAmountRial: optionalMoney(row.submitted_amount_rial),
      daysWaiting: Math.max(0, daysBetween(String(row.waiting_since).slice(0, 10), today)),
    };
  });
}

/** Claims submitted and not yet certified — §16's queue, §22's widget, §29's reminder. */
export async function pendingCertificates(
  businessId: string,
  options: { projectId?: string | null; limit?: number } = {},
): Promise<PendingCertificateRow[]> {
  await assertCertificatesEnabled(businessId);
  const today = await businessToday(businessId);
  const params: unknown[] = [businessId];
  const where = ["k.business_id = $1", "k.status IN ('submitted', 'under_review')"];
  if (options.projectId) {
    params.push(options.projectId);
    where.push(`k.project_id = $${params.length}`);
  }
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT k.id, k.project_id, k.certificate_number, k.kind, k.status, k.net_rial,
            k.period_end::text AS period_end, k.submitted_date::text AS submitted_date,
            k.created_at::text AS created_at, c.title AS contract_title
       FROM aec_payment_certificates k
       LEFT JOIN workspace_contracts c ON c.id = k.contract_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(k.submitted_date, k.created_at::date), k.certificate_number
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => {
    const status = isCertificateStatus(String(row.status))
      ? (row.status as CertificateStatus)
      : "draft";
    const kind = isCertificateKind(String(row.kind)) ? (row.kind as CertificateKind) : "application";
    const submittedDate = (row.submitted_date as string | null) ?? null;
    const waitingSince = (submittedDate ?? String(row.created_at).slice(0, 10)) || today;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      certificateNumber: String(row.certificate_number ?? ""),
      kind,
      kindLabel: CERTIFICATE_KIND_LABELS[kind],
      status,
      statusLabel: CERTIFICATE_STATUS_LABELS[status],
      netRial: money(row.net_rial),
      periodEnd: String(row.period_end),
      contractTitle: (row.contract_title as string | null) ?? null,
      submittedDate,
      daysWaiting: Math.max(0, daysBetween(waitingSince, today)),
    };
  });
}

/**
 * Guarantees and insurance approaching their expiry.
 *
 * §29 names both as reminders and §22 lists «Guarantee/Bond Expiry» as a
 * widget; one reader serves both, because "which bond is about to lapse" must
 * have one answer.
 */
export async function expiringSecurities(
  businessId: string,
  options: { withinDays?: number; projectId?: string | null; limit?: number } = {},
): Promise<Array<ExpiringGuaranteeRow & { kind: "guarantee" | "insurance"; reference: string }>> {
  await assertFinancialsEnabled(businessId);
  const today = await businessToday(businessId);
  const within = Math.min(Math.max(options.withinDays ?? 60, 1), 365);
  // `$2` is the window in days and `$3` the business's today; the project — when
  // one is asked for — is appended after them, so its placeholder is read off
  // the parameter list rather than counted by hand.
  const params: unknown[] = [businessId, within, today];
  let projectClause = "";
  if (options.projectId) {
    params.push(options.projectId);
    projectClause = ` AND c.project_id = $${params.length}`;
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT c.id AS contract_id, c.project_id, c.title AS contract_title,
            cc.guarantee_type, cc.guarantee_reference, cc.guarantee_amount_rial,
            cc.guarantee_expiry::text AS guarantee_expiry,
            cc.insurance_reference, cc.insurance_expiry::text AS insurance_expiry
       FROM workspace_contracts c
       JOIN aec_contract_commercials cc ON cc.contract_id = c.id
      WHERE c.business_id = $1
        AND (cc.guarantee_expiry IS NOT NULL OR cc.insurance_expiry IS NOT NULL)
        AND (cc.guarantee_expiry <= ($2::text || ' days')::interval + $3::date
             OR cc.insurance_expiry <= ($2::text || ' days')::interval + $3::date)
        ${projectClause}
      ORDER BY LEAST(COALESCE(cc.guarantee_expiry, cc.insurance_expiry),
                     COALESCE(cc.insurance_expiry, cc.guarantee_expiry))
      LIMIT ${limit}`,
    params,
  );

  const out: Array<ExpiringGuaranteeRow & { kind: "guarantee" | "insurance"; reference: string }> = [];
  for (const row of rows) {
    const projectId = (row.project_id as string | null) ?? null;
    const contractTitle = String(row.contract_title ?? "");
    const contractId = String(row.contract_id);
    const guaranteeExpiry = (row.guarantee_expiry as string | null) ?? null;
    const insuranceExpiry = (row.insurance_expiry as string | null) ?? null;
    if (guaranteeExpiry) {
      const remaining = daysBetween(today, guaranteeExpiry);
      if (remaining <= within) {
        out.push({
          contractId,
          projectId,
          contractTitle,
          guaranteeType: String(row.guarantee_type ?? ""),
          guaranteeReference: String(row.guarantee_reference ?? ""),
          guaranteeExpiry,
          guaranteeAmountRial: optionalMoney(row.guarantee_amount_rial),
          daysRemaining: remaining,
          kind: "guarantee",
          reference: String(row.guarantee_reference ?? "") || String(row.guarantee_type ?? "") || "—",
        });
      }
    }
    if (insuranceExpiry) {
      const remaining = daysBetween(today, insuranceExpiry);
      if (remaining <= within) {
        out.push({
          contractId,
          projectId,
          contractTitle,
          guaranteeType: "",
          guaranteeReference: "",
          guaranteeExpiry: insuranceExpiry,
          guaranteeAmountRial: null,
          daysRemaining: remaining,
          kind: "insurance",
          reference: String(row.insurance_reference ?? "") || "—",
        });
      }
    }
  }
  return out.sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * Claims certified a while ago — §29's «client payment overdue».
 *
 * Compiled from the certificates, not from the ledger, and it says so: the
 * workspace knows the claim was *certified* on a date, not whether the money
 * arrived, and inventing a received amount to subtract from would be exactly
 * the duplicated balance §16 forbids. So this is a *follow-up list* — "certified
 * N days ago, check the receipt in Accounting" — which is what a site
 * accountant actually needs to see first thing in the morning.
 */
export async function certifiedClaimsAwaitingPayment(
  businessId: string,
  options: { afterDays?: number; projectId?: string | null; limit?: number } = {},
): Promise<CertifiedClaimRow[]> {
  await assertCertificatesEnabled(businessId);
  const today = await businessToday(businessId);
  const after = Math.min(Math.max(options.afterDays ?? 30, 1), 365);
  const params: unknown[] = [businessId, after, today];
  let projectClause = "";
  if (options.projectId) {
    params.push(options.projectId);
    projectClause = ` AND k.project_id = $${params.length}`;
  }
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT k.id, k.project_id, k.certificate_number, k.certified_date::text AS certified_date,
            COALESCE(k.approved_amount_rial, k.net_rial) AS certified_rial,
            c.title AS contract_title
       FROM aec_payment_certificates k
       LEFT JOIN workspace_contracts c ON c.id = k.contract_id
      WHERE k.business_id = $1 AND k.status = 'certified' AND k.certified_date IS NOT NULL
        AND k.certified_date + ($2::text || ' days')::interval <= $3::date
        ${projectClause}
      ORDER BY k.certified_date
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    certificateNumber: String(row.certificate_number ?? ""),
    contractTitle: (row.contract_title as string | null) ?? null,
    certifiedDate: String(row.certified_date),
    certifiedRial: money(row.certified_rial),
    daysSinceCertified: Math.max(0, daysBetween(String(row.certified_date), today)),
  }));
}
