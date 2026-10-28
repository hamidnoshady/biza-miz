/**
 * Issue #1128 §D — the database half of an advertising agency's billing
 * documents: the schedule a client agreed to, the change requests that moved
 * it, and the invoice that turns an approved milestone into money.
 *
 * The rules live in `agency-commercial.ts` (pure) and in migration 0260
 * (constraints and triggers). This file is the third leg: it reads and writes
 * the two registers, and it is where the four things that only a service can do
 * happen.
 *
 *   * **ANOTHER INDUSTRY IS REFUSED, NOT DEFAULTED.** Every entry point calls
 *     `assertAgencyIndustry`, exactly as `aec-commercial-service.ts` does for
 *     its own trade. A café has no billing schedule and must not be served one
 *     that silently means something else.
 *   * **A PERCENTAGE IS RESOLVED AT INVOICE TIME, NEVER AT REST.** A milestone
 *     stores 30% or ۵٬۰۰۰٬۰۰۰ ریال, not both and never a resolved copy of the
 *     percentage. The percentage is taken against the engagement's *revised*
 *     value — the signed value plus every approved change request — at the
 *     moment the invoice is written, because that is the only moment the figure
 *     becomes a fact. Resolving it earlier would freeze a number that the next
 *     approved change is supposed to move.
 *   * **NOTHING HERE POSTS A JOURNAL ENTRY.** Invoicing asks `createRetailInvoice`
 *     for a service invoice, and the existing posting engine writes the entry
 *     (Debit AR or cash · Credit the milestone's own revenue account + VAT
 *     payable). The one thing this file adds to that entry is the project
 *     dimension, which the invoice cannot know for itself. §D's cost side is
 *     read from the same tagged entries and is never stored: a stored cost is a
 *     second, staler answer to a question the ledger already answers.
 *   * **DETERMINATIONS RIDE THE SHARED APPROVAL ENGINE.** Submitting a milestone
 *     or a change request files one `workspace_approvals` row; deciding it goes
 *     through `decideMilestoneApproval` / `decideChangeRequestApproval`, which
 *     the workspace approvals queue already dispatches to. §24's rule is why:
 *     issuing an invoice and agreeing more money must not inherit the
 *     `workspace.manage` right that writes a schedule. Migration 0258's index
 *     keeps one request pending per subject, so a resubmission is only possible
 *     once the previous one has been decided.
 *
 * What is deliberately NOT here: customer advances against a future invoice
 * (2430 is a retail layaway deposit and an agency retainer is a milestone of
 * kind `deposit`, not a liability to draw down), and the vendor quote → PO →
 * payable → settlement chain (§D's supplier side, which is procurement's shape
 * and belongs with it rather than inside a billing register).
 */

import type { PoolClient } from "pg";
import { AGENCY_INDUSTRY } from "./agency";
import {
  AGENCY_CHANGE_REQUEST_ACTIONS,
  AGENCY_MILESTONE_ACTIONS,
  AGENCY_MILESTONE_KIND_LABELS,
  AGENCY_MILESTONE_REVENUE_ACCOUNTS,
  AGENCY_MILESTONE_STATUS_LABELS,
  AGENCY_CHANGE_REQUEST_STATUS_LABELS,
  addMonthsIso,
  canTransitionChangeRequest,
  canTransitionMilestone,
  changeRequestActionsFrom,
  changeRequestMovesContractValue,
  CHANGE_REQUEST_NUMBER_PREFIX,
  commercialMargin,
  draftScheduleForBase,
  isAgencyBillingBase,
  isAgencyChangeRequestAction,
  isAgencyChangeRequestStatus,
  isAgencyMilestoneAction,
  isAgencyMilestoneKind,
  isAgencyMilestoneStatus,
  isEditableChangeRequest,
  isEditableMilestone,
  isSafeRial,
  isSignedRial,
  isValidMilestoneAmount,
  milestoneActionsFrom,
  milestoneAmountRial,
  MILESTONE_NUMBER_PREFIX,
  retainerPeriods,
  revisedContractValueRial,
  scheduleTotals,
  unscheduledValueRial,
  type AgencyBillingBase,
  type AgencyChangeRequestStatus,
  type AgencyCommercialAction,
  type AgencyCommercialBooked,
  type AgencyCommercialPosted,
  type AgencyCommercialReport,
  type AgencyMilestoneKind,
  type AgencyMilestoneStatus,
} from "./agency-commercial";
import { businessToday } from "./business-day-service";
import { query, withTenantTransaction } from "./db";
import { getBusinessIndustry } from "./industry-guard";
import { formatRegisterNumber, nextRegisterNumber } from "./register-numbering";
import {
  createRetailInvoice,
  type CreateRetailInvoiceTenderInput,
} from "./retail-invoice-service";
import { SERVICE_DESCRIPTION_MAX_LENGTH } from "./service-invoice";
import { resolveActiveLocationForUser } from "./setup-state";
import { getBusinessVatPercent } from "./vat-policy-service";
import { approvalDecisionError } from "./workspace-shared";
import {
  recordActivity,
  requireProjectCapability,
  WorkspaceError,
  type WorkspaceOwner,
} from "./workspace";

/* ===========================================================================
 * Errors
 * ======================================================================== */

/**
 * Every way a read or a write can be refused, as codes the route maps to a
 * status. The split is the one every register in this product uses: a record
 * that does not exist is a 404, a malformed field a 400, and anything a record
 * refuses *because of where it is in its life cycle* a 409 — the request was
 * reasonable and the state is what says no.
 */
/**
 * Every refusal this service can make, as a runtime list.
 *
 * The list is the source and the union type is derived from it, so the route
 * layer's status map can be checked against it exhaustively — a code added here
 * without a status would otherwise answer 400 by default, which is the wrong
 * status for a refusal that comes from where a record is in its life cycle
 * rather than from a malformed field.
 */
export const AGENCY_COMMERCIAL_ERROR_CODES = [
  "industry_mismatch",
  "milestone_not_found",
  "change_request_not_found",
  "approval_not_found",
  "title_required",
  "description_required",
  "due_date_required",
  "invalid_milestone_kind",
  "invalid_milestone_amount",
  "invalid_revenue_code",
  "invalid_date",
  "invalid_period",
  "invalid_hours",
  "invalid_billing_base",
  "invalid_schedule_impact",
  "milestone_not_editable",
  "invalid_milestone_action",
  "invalid_milestone_transition",
  "change_request_not_editable",
  "invalid_change_request_action",
  "invalid_change_request_transition",
  "invalid_change_request_amount",
  "change_request_amount_required",
  "approval_already_pending",
  "schedule_empty",
  "schedule_exists",
  "schedule_over_allocated",
  "contract_value_required",
  "customer_required",
  "location_required",
] as const;

export type AgencyCommercialErrorCode = (typeof AGENCY_COMMERCIAL_ERROR_CODES)[number];

export class AgencyCommercialError extends Error {
  constructor(readonly code: AgencyCommercialErrorCode) {
    super(code);
    this.name = "AgencyCommercialError";
  }
}

/* ===========================================================================
 * Coercion
 * ======================================================================== */

function trimTo(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}

/** Postgres `bigint` and `numeric` arrive as strings; money is whole Rial. */
function money(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function moneyOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : money(value);
}

function percentOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function intOrNull(value: unknown, code: AgencyCommercialErrorCode): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed)) throw new AgencyCommercialError(code);
  return parsed;
}

/** An ISO calendar date, or a refusal — never a silent null on garbage. */
function optionalDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new AgencyCommercialError("invalid_date");
  }
  return value.trim();
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/* ===========================================================================
 * Shapes
 * ======================================================================== */

/**
 * The engagement a project's schedule bills against.
 *
 * One contract, chosen rather than asked for: the newest client-side contract
 * of the project, an `active` one preferred. Supplier-side contracts are
 * excluded by both their type and their party's role, because §D's contracted
 * value is what the *client* agreed to pay — including a subcontract would
 * report the agency's own payables as its revenue.
 */
export interface AgencyEngagement {
  contractId: string | null;
  title: string | null;
  /** The signed value, as it was written. A change request never rewrites it. */
  contractedRial: number | null;
  /** What approved change requests have added (signed; a descope is negative). */
  approvedChangeRial: number;
  /** Contracted plus approved changes — the value a percentage is taken of. */
  revisedRial: number | null;
  /** The client, on the one identity table (`parties`, formerly `customers`). */
  customerId: string | null;
  customerName: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
}

export interface AgencyMilestoneRecord {
  id: string;
  projectId: string;
  contractId: string | null;
  milestoneNumber: string;
  kind: AgencyMilestoneKind;
  kindLabel: string;
  title: string;
  description: string;
  percent: number | null;
  amountRial: number | null;
  /**
   * What this milestone would bill now: the fixed amount, or the percentage of
   * the engagement's revised value. Null once invoiced — the row then reports
   * `billedAmountRial`, the invoice's own figure, because a percentage resolved
   * against today's value is not what was billed last month.
   */
  billableAmountRial: number | null;
  /** The invoice's own net (post-discount, pre-VAT), once there is one. */
  billedAmountRial: number | null;
  invoiceOrderId: string | null;
  invoiceNumber: number | null;
  revenueCode: string;
  revenueLabel: string;
  hours: number | null;
  dueDate: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
  status: AgencyMilestoneStatus;
  statusLabel: string;
  submittedDate: string | null;
  approvedDate: string | null;
  invoicedDate: string | null;
  createdByName: string;
  createdAt: string;
  /** The acts this row can take from where it is — the chain, not a guess. */
  actions: AgencyCommercialAction[];
}

export interface AgencyChangeRequestRecord {
  id: string;
  projectId: string;
  contractId: string | null;
  changeRequestNumber: string;
  title: string;
  description: string;
  reason: string;
  amountRial: number | null;
  approvedAmountRial: number | null;
  scheduleImpactDays: number | null;
  status: AgencyChangeRequestStatus;
  statusLabel: string;
  submittedDate: string | null;
  approvedDate: string | null;
  implementedDate: string | null;
  createdByName: string;
  createdAt: string;
  /** True when this row's figure is one the engagement's value now includes. */
  countedInValue: boolean;
  actions: AgencyCommercialAction[];
}

export interface AgencyCommercialSummary {
  projectId: string;
  engagement: AgencyEngagement;
  milestones: AgencyMilestoneRecord[];
  /** What the schedule adds up to, and what it leaves unallocated. */
  schedule: { count: number; unallocatedPercent: number; fixedTotalRial: number };
  changeRequests: AgencyChangeRequestRecord[];
  report: AgencyCommercialReport;
}

/* ===========================================================================
 * Industry and project
 * ======================================================================== */

/** Another industry is refused rather than served an agency default. */
export async function assertAgencyIndustry(businessId: string): Promise<void> {
  if ((await getBusinessIndustry(businessId)) !== AGENCY_INDUSTRY) {
    throw new AgencyCommercialError("industry_mismatch");
  }
}

/** The project a milestone belongs to, so a route can check the role first. */
export async function milestoneProjectId(
  businessId: string,
  milestoneId: string,
): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM agency_billing_milestones WHERE business_id = $1 AND id = $2`,
    [businessId, milestoneId],
  );
  if (!rows[0]) throw new AgencyCommercialError("milestone_not_found");
  return rows[0].project_id;
}

/** The project a change request belongs to. */
export async function changeRequestProjectId(
  businessId: string,
  changeRequestId: string,
): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM agency_change_requests WHERE business_id = $1 AND id = $2`,
    [businessId, changeRequestId],
  );
  if (!rows[0]) throw new AgencyCommercialError("change_request_not_found");
  return rows[0].project_id;
}

/* ===========================================================================
 * Reads
 * ======================================================================== */

/** The amounts of every change request the engagement's value now includes. */
async function approvedChangeAmounts(businessId: string, projectId: string): Promise<number[]> {
  const { rows } = await query<{ amount: string | null }>(
    `SELECT COALESCE(approved_amount_rial, amount_rial) AS amount
       FROM agency_change_requests
      WHERE business_id = $1 AND project_id = $2 AND status IN ('approved', 'implemented')`,
    [businessId, projectId],
  );
  return rows.map((row) => money(row.amount));
}

async function loadEngagement(businessId: string, projectId: string): Promise<AgencyEngagement> {
  const { rows } = await query<{
    id: string;
    title: string;
    value_rial: string | null;
    party_id: string | null;
    customer_name: string | null;
    start_date: string | null;
    end_date: string | null;
    status: string;
  }>(
    `SELECT c.id, c.title, c.value_rial, c.party_id, p.name AS customer_name,
            c.start_date, c.end_date, c.status
       FROM workspace_contracts c
       LEFT JOIN parties p ON p.id = c.party_id
      WHERE c.business_id = $1 AND c.project_id = $2
        AND c.contract_type NOT IN ('supplier', 'vendor', 'subcontractor', 'contractor')
        AND (c.party_id IS NULL OR p.role = 'customer')
      ORDER BY (c.status = 'active') DESC, c.created_at DESC
      LIMIT 1`,
    [businessId, projectId],
  );
  const contract = rows[0];
  const contracted = contract ? moneyOrNull(contract.value_rial) : null;
  const approved = await approvedChangeAmounts(businessId, projectId);
  return {
    contractId: contract?.id ?? null,
    title: contract?.title ?? null,
    contractedRial: contracted,
    approvedChangeRial: approved.reduce((sum, amount) => sum + amount, 0),
    revisedRial: revisedContractValueRial(contracted, approved),
    customerId: contract?.party_id ?? null,
    customerName: contract?.customer_name ?? null,
    startDate: contract?.start_date ?? null,
    endDate: contract?.end_date ?? null,
    status: contract?.status ?? null,
  };
}

/** What the invoices a set of milestones produced actually settled. */
async function loadInvoiceFigures(
  invoiceOrderIds: readonly string[],
): Promise<Map<string, { netRial: number; settledRial: number; onAccountRial: number; orderNumber: number | null }>> {
  const figures = new Map<
    string,
    { netRial: number; settledRial: number; onAccountRial: number; orderNumber: number | null }
  >();
  if (invoiceOrderIds.length === 0) return figures;
  const { rows } = await query<{
    id: string;
    net_rial: string;
    total_rial: string;
    settled_rial: string;
    on_account_rial: string;
    order_number: string;
  }>(
    // `total - tax` is the invoice's own net: the figure the posting rule
    // credited to the revenue account. Read from the document rather than
    // recomputed from `subtotal - discount`, so a line-level breakdown this
    // module does not know about cannot change the answer.
    `SELECT o.id, (o.total - o.tax) AS net_rial, o.total AS total_rial, o.order_number,
            COALESCE(sum(p.amount) FILTER (WHERE p.method <> 'credit'), 0) AS settled_rial,
            COALESCE(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0) AS on_account_rial
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.id = ANY($1::uuid[])
      GROUP BY o.id, o.total, o.tax, o.order_number`,
    [[...invoiceOrderIds]],
  );
  for (const row of rows) {
    figures.set(row.id, {
      netRial: money(row.net_rial),
      settledRial: money(row.settled_rial),
      onAccountRial: money(row.on_account_rial),
      orderNumber: row.order_number === null ? null : Number(row.order_number),
    });
  }
  return figures;
}

/**
 * §D's posted half, read from the ledger and never stored.
 *
 * One query over the entries tagged with this project: revenue is what the
 * revenue accounts were credited, cost is what the expense accounts were
 * debited. Accounts are selected by *type* rather than by a list of codes, so
 * an agency that renamed or added a revenue account is still reported, and the
 * balance-sheet sides of the same entry — the receivable it raised, the cash it
 * took, the VAT it owes — are excluded because they are not profit and loss.
 */
async function loadPostedFigures(
  businessId: string,
  projectId: string,
): Promise<{ revenueRial: number; actualCostRial: number }> {
  const { rows } = await query<{ revenue_rial: string; cost_rial: string }>(
    `SELECT COALESCE(sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE 0 END), 0) AS revenue_rial,
            COALESCE(sum(CASE WHEN a.type = 'expense' THEN l.debit - l.credit ELSE 0 END), 0) AS cost_rial
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.business_id = $1 AND e.project_id = $2`,
    [businessId, projectId],
  );
  return {
    revenueRial: money(rows[0]?.revenue_rial),
    actualCostRial: money(rows[0]?.cost_rial),
  };
}

function revenueLabelFor(code: string): string {
  return (
    AGENCY_MILESTONE_REVENUE_ACCOUNTS.find((account) => account.code === code)?.label ?? code
  );
}

/**
 * The whole commercial picture of one project: the engagement, its schedule,
 * its change requests, and §D's P&L with the booked half kept apart from the
 * posted one.
 */
export async function loadAgencyCommercial(
  owner: WorkspaceOwner,
  projectId: string,
): Promise<AgencyCommercialSummary> {
  await assertAgencyIndustry(owner.businessId);
  await requireProjectCapability(owner, projectId, "view");

  const [engagement, milestoneRows, changeRequestRows] = await Promise.all([
    loadEngagement(owner.businessId, projectId),
    query<{
      id: string;
      project_id: string;
      contract_id: string | null;
      milestone_number: string;
      kind: string;
      title: string;
      description: string;
      percent: string | null;
      amount_rial: string | null;
      revenue_code: string;
      hours: string | null;
      due_date: string | null;
      period_start_date: string | null;
      period_end_date: string | null;
      status: string;
      submitted_date: string | null;
      approved_date: string | null;
      invoiced_date: string | null;
      invoice_order_id: string | null;
      created_by_name: string;
      created_at: string;
    }>(
      `SELECT id, project_id, contract_id, milestone_number, kind, title, description,
              percent, amount_rial, revenue_code, hours, due_date, period_start_date,
              period_end_date, status, submitted_date, approved_date, invoiced_date,
              invoice_order_id, created_by_name, created_at
         FROM agency_billing_milestones
        WHERE business_id = $1 AND project_id = $2
        ORDER BY due_date NULLS LAST, created_at, milestone_number`,
      [owner.businessId, projectId],
    ).then((result) => result.rows),
    query<{
      id: string;
      project_id: string;
      contract_id: string | null;
      change_request_number: string;
      title: string;
      description: string;
      reason: string;
      amount_rial: string | null;
      approved_amount_rial: string | null;
      schedule_impact_days: number | null;
      status: string;
      submitted_date: string | null;
      approved_date: string | null;
      implemented_date: string | null;
      created_by_name: string;
      created_at: string;
    }>(
      `SELECT id, project_id, contract_id, change_request_number, title, description, reason,
              amount_rial, approved_amount_rial, schedule_impact_days, status,
              submitted_date, approved_date, implemented_date, created_by_name, created_at
         FROM agency_change_requests
        WHERE business_id = $1 AND project_id = $2
        ORDER BY created_at, change_request_number`,
      [owner.businessId, projectId],
    ).then((result) => result.rows),
  ]);

  const invoices = await loadInvoiceFigures(
    milestoneRows.map((row) => row.invoice_order_id).filter((id): id is string => id !== null),
  );

  const milestones: AgencyMilestoneRecord[] = milestoneRows.map((row) => {
    const status = row.status as AgencyMilestoneStatus;
    const kind = row.kind as AgencyMilestoneKind;
    const percent = percentOrNull(row.percent);
    const amountRial = moneyOrNull(row.amount_rial);
    const invoice = row.invoice_order_id ? invoices.get(row.invoice_order_id) : undefined;
    const invoiced = status === "invoiced";
    return {
      id: row.id,
      projectId: row.project_id,
      contractId: row.contract_id,
      milestoneNumber: row.milestone_number,
      kind,
      kindLabel: AGENCY_MILESTONE_KIND_LABELS[kind] ?? kind,
      title: row.title,
      description: row.description,
      percent,
      amountRial,
      // An invoiced row reports what it billed; a live one reports what it
      // would bill, which moves if the engagement's value does.
      billableAmountRial: invoiced
        ? null
        : milestoneAmountRial({ percent, amountRial }, engagement.revisedRial),
      billedAmountRial: invoiced ? (invoice?.netRial ?? null) : null,
      invoiceOrderId: row.invoice_order_id,
      invoiceNumber: invoice?.orderNumber ?? null,
      revenueCode: row.revenue_code,
      revenueLabel: revenueLabelFor(row.revenue_code),
      hours: percentOrNull(row.hours),
      dueDate: row.due_date,
      periodStartDate: row.period_start_date,
      periodEndDate: row.period_end_date,
      status,
      statusLabel: AGENCY_MILESTONE_STATUS_LABELS[status] ?? status,
      submittedDate: row.submitted_date,
      approvedDate: row.approved_date,
      invoicedDate: row.invoiced_date,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
      actions: milestoneActionsFrom(status),
    };
  });

  const changeRequests: AgencyChangeRequestRecord[] = changeRequestRows.map((row) => {
    const status = row.status as AgencyChangeRequestStatus;
    return {
      id: row.id,
      projectId: row.project_id,
      contractId: row.contract_id,
      changeRequestNumber: row.change_request_number,
      title: row.title,
      description: row.description,
      reason: row.reason,
      amountRial: moneyOrNull(row.amount_rial),
      approvedAmountRial: moneyOrNull(row.approved_amount_rial),
      scheduleImpactDays: row.schedule_impact_days,
      status,
      statusLabel: AGENCY_CHANGE_REQUEST_STATUS_LABELS[status] ?? status,
      submittedDate: row.submitted_date,
      approvedDate: row.approved_date,
      implementedDate: row.implemented_date,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
      countedInValue: changeRequestMovesContractValue(status),
      actions: changeRequestActionsFrom(status),
    };
  });

  // The schedule's own arithmetic, over the rows that are still live: a
  // cancelled or rejected milestone is not part of a plan anybody will bill.
  const live = milestones.filter(
    (milestone) => milestone.status !== "cancelled" && milestone.status !== "rejected",
  );
  const schedule = scheduleTotals(
    live.map((milestone) => ({
      kind: milestone.kind,
      title: milestone.title,
      percent: milestone.percent,
      amountRial: milestone.amountRial,
      dueOffsetMonths: 0,
    })),
  );

  const billed = live.filter((milestone) => milestone.status === "invoiced");
  const scheduled = live.filter((milestone) => milestone.status !== "invoiced");
  const scheduledRial = scheduled.reduce(
    (sum, milestone) => sum + (milestone.billableAmountRial ?? 0),
    0,
  );
  const invoicedRial = billed.reduce((sum, milestone) => sum + (milestone.billedAmountRial ?? 0), 0);

  const booked: AgencyCommercialBooked = {
    contractedRial: engagement.contractedRial,
    approvedChangeRial: engagement.approvedChangeRial,
    revisedContractRial: engagement.revisedRial,
    scheduledRial,
    invoicedRial,
    unscheduledRial: unscheduledValueRial(engagement.revisedRial, scheduledRial + invoicedRial),
  };

  const postedLedger = await loadPostedFigures(owner.businessId, projectId);
  // Collected and owed are read from the invoices this project's milestones
  // produced, not from the AR subledger: a receipt there is taken against a
  // *customer's* whole balance and carries no order, so it cannot honestly be
  // attributed to one project. What these two figures say is precise — what
  // settled at the invoice, and what the invoice put on account.
  const collectedRial = billed.reduce(
    (sum, milestone) =>
      sum + (milestone.invoiceOrderId ? (invoices.get(milestone.invoiceOrderId)?.settledRial ?? 0) : 0),
    0,
  );
  const receivableRial = billed.reduce(
    (sum, milestone) =>
      sum +
      (milestone.invoiceOrderId ? (invoices.get(milestone.invoiceOrderId)?.onAccountRial ?? 0) : 0),
    0,
  );
  const posted: AgencyCommercialPosted = {
    revenueRial: postedLedger.revenueRial,
    collectedRial,
    receivableRial,
    actualCostRial: postedLedger.actualCostRial,
  };

  const report: AgencyCommercialReport = {
    booked,
    posted,
    ...commercialMargin(posted.revenueRial, posted.actualCostRial),
  };

  return { projectId, engagement, milestones, schedule, changeRequests, report };
}

/* ===========================================================================
 * Writing a schedule
 * ======================================================================== */

export interface AgencyScheduleCreateInput {
  /** One of `AGENCY_BILLING_BASES`; anything else is `invalid_billing_base`. */
  base?: unknown;
  /** Overrides the engagement's revised value, for a schedule priced first. */
  contractValueRial?: unknown;
  periods?: unknown;
  periodAmountRial?: unknown;
  depositPercent?: unknown;
  deliverables?: unknown;
  /** The date the first period or stage is due; defaults to the engagement's start or today. */
  startDate?: unknown;
  revenueCode?: unknown;
}

function revenueCodeOr(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === "") return fallback;
  const code = String(value).trim();
  if (!AGENCY_MILESTONE_REVENUE_ACCOUNTS.some((account) => account.code === code)) {
    throw new AgencyCommercialError("invalid_revenue_code");
  }
  return code;
}

/**
 * Lays a whole schedule out from an engagement's base — §D's "fixed-price
 * engagements, retainers/subscriptions, milestones/deposits" as one act rather
 * than twelve clicks.
 *
 * Refused when the project already has live milestones: a schedule is laid out
 * once, and laying a second one over the first would double-book the same
 * engagement. Adding a single stage afterwards is `createAgencyMilestone`.
 *
 * Hourly work answers `schedule_empty`, because there is nothing to lay out
 * before the time is tracked: an hourly engagement bills a period once that
 * period's hours and pass-through cost are known.
 */
export async function createAgencySchedule(
  owner: WorkspaceOwner,
  projectId: string,
  input: AgencyScheduleCreateInput,
): Promise<AgencyCommercialSummary> {
  await assertAgencyIndustry(owner.businessId);
  await requireProjectCapability(owner, projectId, "manage");
  if (!isAgencyBillingBase(input.base)) throw new AgencyCommercialError("invalid_billing_base");

  const engagement = await loadEngagement(owner.businessId, projectId);
  const { rows: existing } = await query<{ live: string }>(
    `SELECT count(*)::text AS live FROM agency_billing_milestones
      WHERE business_id = $1 AND project_id = $2 AND status NOT IN ('cancelled', 'rejected')`,
    [owner.businessId, projectId],
  );
  if (Number(existing[0]?.live ?? "0") > 0) throw new AgencyCommercialError("schedule_exists");

  const value =
    input.contractValueRial === null || input.contractValueRial === undefined
      ? engagement.revisedRial
      : moneyOrNull(input.contractValueRial);
  const drafts = draftScheduleForBase(input.base, {
    contractValueRial: value,
    periods: typeof input.periods === "number" ? input.periods : undefined,
    periodAmountRial: moneyOrNull(input.periodAmountRial),
    depositPercent: percentOrNull(input.depositPercent),
    deliverables: typeof input.deliverables === "number" ? input.deliverables : undefined,
  });
  if (drafts.length === 0) throw new AgencyCommercialError("schedule_empty");

  const totals = scheduleTotals(drafts);
  if (totals.unallocatedPercent < 0) throw new AgencyCommercialError("schedule_over_allocated");

  const revenueCode = revenueCodeOr(input.revenueCode, AGENCY_MILESTONE_REVENUE_ACCOUNTS[0].code);
  const today = await businessToday(owner.businessId);
  const start = optionalDate(input.startDate) ?? engagement.startDate ?? today;
  const periods = input.base === "retainer" ? retainerPeriods(start, drafts.length) : [];

  await withTenantTransaction(
    owner.businessId,
    async () => {
      // One advisory lock for the whole schedule: `nextRegisterNumber` takes a
      // transaction-scoped lock keyed on the register and the project, so the
      // first call holds it until this transaction commits and the numbers
      // after it are arithmetic nobody else can interleave with.
      const first = await nextRegisterNumber(
        "agency_billing_milestones",
        projectId,
        MILESTONE_NUMBER_PREFIX,
      );
      const seed = Number(first.replace(/^.*-/, "")) || 1;
      // Formatted by the same function every register uses, rather than by a
      // second copy of its padding rule that could drift from the first.
      const numberOf = (offset: number) =>
        formatRegisterNumber(MILESTONE_NUMBER_PREFIX, seed + offset);
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        const period = periods[index];
        await query(
          `INSERT INTO agency_billing_milestones
             (business_id, project_id, contract_id, milestone_number, kind, title, description,
              percent, amount_rial, revenue_code, due_date, period_start_date, period_end_date,
              status, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',$14,$15)`,
          [
            owner.businessId,
            projectId,
            engagement.contractId,
            numberOf(index),
            draft.kind,
            draft.title,
            "",
            draft.percent,
            draft.amountRial,
            revenueCode,
            period ? period.endIso : addMonthsIso(start, draft.dueOffsetMonths),
            period?.startIso ?? null,
            period?.endIso ?? null,
            owner.actorUserId,
            owner.actorName ?? "",
          ],
        );
      }
    },
    { userId: owner.actorUserId },
  );

  await recordActivity(owner, {
    projectId,
    subjectType: "billing_milestone",
    subjectId: null,
    action: "schedule_created",
    summary: `برنامهٔ صورتحساب با ${drafts.length} مرحله ایجاد شد`,
  });
  return loadAgencyCommercial(owner, projectId);
}

/* ===========================================================================
 * Milestones
 * ======================================================================== */

export interface AgencyMilestoneInput {
  title?: unknown;
  description?: unknown;
  kind?: unknown;
  percent?: unknown;
  amountRial?: unknown;
  revenueCode?: unknown;
  hours?: unknown;
  dueDate?: unknown;
  periodStartDate?: unknown;
  periodEndDate?: unknown;
  contractId?: unknown;
}

interface MilestoneFields {
  title: string;
  description: string;
  kind: AgencyMilestoneKind;
  percent: number | null;
  amountRial: number | null;
  revenueCode: string;
  hours: number | null;
  dueDate: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
  contractId: string | null;
}

/** Validates the fields a milestone is written with, as one whole. */
function milestoneFields(
  input: AgencyMilestoneInput,
  fallback: { revenueCode: string; kind: AgencyMilestoneKind },
): MilestoneFields {
  const title = trimTo(input.title, 200);
  if (!title) throw new AgencyCommercialError("title_required");
  const kind =
    input.kind === null || input.kind === undefined || input.kind === ""
      ? fallback.kind
      : isAgencyMilestoneKind(input.kind)
        ? input.kind
        : (() => {
            throw new AgencyCommercialError("invalid_milestone_kind");
          })();
  const percent = percentOrNull(input.percent);
  const amountRial = moneyOrNull(input.amountRial);
  if (!isValidMilestoneAmount({ percent, amountRial })) {
    throw new AgencyCommercialError("invalid_milestone_amount");
  }
  const hours = percentOrNull(input.hours);
  if (hours !== null && hours <= 0) throw new AgencyCommercialError("invalid_hours");
  // Hours record what an amount covers; a percentage of a contract has none.
  if (hours !== null && amountRial === null) throw new AgencyCommercialError("invalid_hours");
  const periodStartDate = optionalDate(input.periodStartDate);
  const periodEndDate = optionalDate(input.periodEndDate);
  if (periodStartDate && periodEndDate && periodEndDate < periodStartDate) {
    throw new AgencyCommercialError("invalid_period");
  }
  return {
    title,
    description: trimTo(input.description, 2000),
    kind,
    percent,
    amountRial,
    revenueCode: revenueCodeOr(input.revenueCode, fallback.revenueCode),
    hours,
    dueDate: optionalDate(input.dueDate),
    periodStartDate,
    periodEndDate,
    contractId:
      typeof input.contractId === "string" && input.contractId.trim() ? input.contractId.trim() : null,
  };
}

/** One milestone, as the register holds it. */
export async function loadAgencyMilestone(
  owner: WorkspaceOwner,
  milestoneId: string,
): Promise<AgencyMilestoneRecord> {
  const projectId = await milestoneProjectId(owner.businessId, milestoneId);
  const summary = await loadAgencyCommercial(owner, projectId);
  const found = summary.milestones.find((milestone) => milestone.id === milestoneId);
  if (!found) throw new AgencyCommercialError("milestone_not_found");
  return found;
}

/** Adds one stage to a project's schedule, as a draft. */
export async function createAgencyMilestone(
  owner: WorkspaceOwner,
  projectId: string,
  input: AgencyMilestoneInput,
): Promise<AgencyMilestoneRecord> {
  await assertAgencyIndustry(owner.businessId);
  await requireProjectCapability(owner, projectId, "manage");
  const engagement = await loadEngagement(owner.businessId, projectId);
  const fields = milestoneFields(input, {
    revenueCode: AGENCY_MILESTONE_REVENUE_ACCOUNTS[0].code,
    kind: "deliverable",
  });

  const id = await withTenantTransaction(
    owner.businessId,
    async () => {
      const milestoneNumber = await nextRegisterNumber(
        "agency_billing_milestones",
        projectId,
        MILESTONE_NUMBER_PREFIX,
      );
      const { rows } = await query<{ id: string }>(
        `INSERT INTO agency_billing_milestones
           (business_id, project_id, contract_id, milestone_number, kind, title, description,
            percent, amount_rial, revenue_code, hours, due_date, period_start_date,
            period_end_date, status, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15,$16)
         RETURNING id`,
        [
          owner.businessId,
          projectId,
          fields.contractId ?? engagement.contractId,
          milestoneNumber,
          fields.kind,
          fields.title,
          fields.description,
          fields.percent,
          fields.amountRial,
          fields.revenueCode,
          fields.hours,
          fields.dueDate,
          fields.periodStartDate,
          fields.periodEndDate,
          owner.actorUserId,
          owner.actorName ?? "",
        ],
      );
      return rows[0].id;
    },
    { userId: owner.actorUserId },
  );

  await recordActivity(owner, {
    projectId,
    subjectType: "billing_milestone",
    subjectId: id,
    action: "created",
    summary: fields.title,
  });
  return loadAgencyMilestone(owner, id);
}

/** Edits a milestone that nobody has decided yet. */
export async function updateAgencyMilestone(
  owner: WorkspaceOwner,
  milestoneId: string,
  input: AgencyMilestoneInput,
): Promise<AgencyMilestoneRecord> {
  await assertAgencyIndustry(owner.businessId);
  const projectId = await milestoneProjectId(owner.businessId, milestoneId);
  await requireProjectCapability(owner, projectId, "manage");

  const { rows: current } = await query<{ status: string; revenue_code: string; kind: string }>(
    `SELECT status, revenue_code, kind FROM agency_billing_milestones
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, milestoneId],
  );
  const row = current[0];
  if (!row) throw new AgencyCommercialError("milestone_not_found");
  const status = row.status as AgencyMilestoneStatus;
  // The chain, not the caller, decides whether this row may still be written.
  if (!isEditableMilestone(status)) throw new AgencyCommercialError("milestone_not_editable");

  const fields = milestoneFields(input, {
    revenueCode: row.revenue_code,
    kind: row.kind as AgencyMilestoneKind,
  });
  await query(
    `UPDATE agency_billing_milestones
        SET title = $3, description = $4, kind = $5, percent = $6, amount_rial = $7,
            revenue_code = $8, hours = $9, due_date = $10, period_start_date = $11,
            period_end_date = $12, contract_id = COALESCE($13, contract_id), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      owner.businessId,
      milestoneId,
      fields.title,
      fields.description,
      fields.kind,
      fields.percent,
      fields.amountRial,
      fields.revenueCode,
      fields.hours,
      fields.dueDate,
      fields.periodStartDate,
      fields.periodEndDate,
      fields.contractId,
    ],
  );
  await recordActivity(owner, {
    projectId,
    subjectType: "billing_milestone",
    subjectId: milestoneId,
    action: "updated",
    summary: fields.title,
  });
  return loadAgencyMilestone(owner, milestoneId);
}

/** Deletes a draft milestone. Anything decided is cancelled, not deleted. */
export async function deleteAgencyMilestone(
  owner: WorkspaceOwner,
  milestoneId: string,
): Promise<boolean> {
  await assertAgencyIndustry(owner.businessId);
  const projectId = await milestoneProjectId(owner.businessId, milestoneId);
  await requireProjectCapability(owner, projectId, "manage");
  const { rowCount } = await query(
    `DELETE FROM agency_billing_milestones
      WHERE business_id = $1 AND id = $2 AND status = 'draft'`,
    [owner.businessId, milestoneId],
  );
  const deleted = (rowCount ?? 0) > 0;
  if (deleted) {
    await recordActivity(owner, {
      projectId,
      subjectType: "billing_milestone",
      subjectId: milestoneId,
      action: "deleted",
      summary: "پیش‌نویس مرحله حذف شد",
    });
  }
  return deleted;
}

export interface AgencyMilestoneActionInput {
  note?: unknown;
  /** Where the invoice is issued; defaults to the actor's own branch. */
  locationId?: string | null;
  /** How the client settles it. Defaults to on account (نسیه), which raises a receivable. */
  tenders?: CreateRetailInvoiceTenderInput[];
}

/**
 * §D's chain, one function — the same shape the AEC registers use, and for the
 * same reason: the transitions belong together, so the chain is one readable
 * list rather than six routes that can drift apart.
 *
 * `invoice` is the only act that touches money, and the only one that leaves
 * this module: it asks the invoice service for a service invoice, which posts
 * through the existing engine. Everything else is a status move with its date.
 */
export async function applyMilestoneAction(
  owner: WorkspaceOwner,
  milestoneId: string,
  action: string,
  input: AgencyMilestoneActionInput = {},
): Promise<AgencyMilestoneRecord> {
  await assertAgencyIndustry(owner.businessId);
  if (!isAgencyMilestoneAction(action)) throw new AgencyCommercialError("invalid_milestone_action");
  const projectId = await milestoneProjectId(owner.businessId, milestoneId);

  const definition = AGENCY_MILESTONE_ACTIONS.find((entry) => entry.action === action);
  const target = definition?.target as AgencyMilestoneStatus;
  // A determination is gated by the *permission* (`workspace.approve`, checked
  // by the route), so the project role it additionally needs is only `view`:
  // an approver is not necessarily a manager of the project they are approving.
  // An edit is the other way round — the role is the gate. This is the AEC
  // registers' split, taken from the catalogue rather than restated here.
  const capability = definition?.determination ? "view" : "manage";
  await requireProjectCapability(owner, projectId, capability);

  const { rows: current } = await query<{
    id: string;
    status: string;
    milestone_number: string;
    title: string;
    kind: string;
    percent: string | null;
    amount_rial: string | null;
    revenue_code: string;
    due_date: string | null;
    period_start_date: string | null;
    period_end_date: string | null;
  }>(
    `SELECT id, status, milestone_number, title, kind, percent, amount_rial, revenue_code,
            due_date, period_start_date, period_end_date
       FROM agency_billing_milestones
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, milestoneId],
  );
  const row = current[0];
  if (!row) throw new AgencyCommercialError("milestone_not_found");
  const from = row.status as AgencyMilestoneStatus;
  if (!canTransitionMilestone(from, target)) {
    throw new AgencyCommercialError("invalid_milestone_transition");
  }

  // A milestone an approver will read has to say when the client is expected to
  // pay: §D's overdue balances are measured from that date, so a row without
  // one could never be reported late. Checked before the transaction opens,
  // with the other preconditions — a refusal discovered halfway through a
  // transaction that has already issued an invoice would roll the invoice back,
  // and a precondition is not something to find out about that late.
  if (action === "submit" && !row.due_date) {
    throw new AgencyCommercialError("due_date_required");
  }

  const today = await businessToday(owner.businessId);
  const engagement = await loadEngagement(owner.businessId, projectId);

  let invoiceOrderId: string | null = null;
  let invoiceNumber: number | null = null;

  await withTenantTransaction(
    owner.businessId,
    async (client) => {
      if (action === "invoice") {
        const issued = await invoiceMilestone(client, {
          owner,
          milestoneId: row.id,
          projectId,
          engagement,
          milestone: {
            number: row.milestone_number,
            title: row.title,
            kind: row.kind as AgencyMilestoneKind,
            percent: percentOrNull(row.percent),
            amountRial: moneyOrNull(row.amount_rial),
            revenueCode: row.revenue_code,
            periodStartDate: row.period_start_date,
            periodEndDate: row.period_end_date,
          },
          locationId: input.locationId ?? null,
          tenders: input.tenders,
        });
        invoiceOrderId = issued.orderId;
        invoiceNumber = issued.orderNumber;
      }

      // A milestone an approver will read has to say when the client is
      // expected to pay: §D's overdue balances are measured from that date, so
      // one without it could never be reported late.
      await query(
        `UPDATE agency_billing_milestones
            SET status = $3,
                submitted_date = CASE WHEN $3 = 'submitted' THEN COALESCE(submitted_date, $4::date) ELSE submitted_date END,
                approved_date = CASE WHEN $3 = 'approved' THEN COALESCE(approved_date, $4::date) ELSE approved_date END,
                invoiced_date = CASE WHEN $3 = 'invoiced' THEN COALESCE(invoiced_date, $4::date) ELSE invoiced_date END,
                invoice_order_id = COALESCE($5, invoice_order_id),
                updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [owner.businessId, milestoneId, target, today, invoiceOrderId],
      );

      if (action === "submit") {
        // §24's rule: the determination is decided where `workspace.approve`
        // already is, so writing a schedule can never issue an invoice.
        try {
          await query(
            `INSERT INTO workspace_approvals
               (business_id, subject_type, subject_id, project_id, title, requested_by, note)
             VALUES ($1, 'billing_milestone', $2, $3, $4, $5, $6)`,
            [
              owner.businessId,
              milestoneId,
              projectId,
              `${row.milestone_number} — ${row.title.slice(0, 180)}`,
              owner.actorUserId,
              trimTo(input.note, 1000),
            ],
          );
        } catch (err) {
          // Migration 0258 keeps one request pending per subject. The chain
          // already refuses a second submission, so this is the backstop
          // turning a race into a sentence rather than a 500.
          if (isUniqueViolation(err)) throw new AgencyCommercialError("approval_already_pending");
          throw err;
        }
      }

      if (action === "invoice") {
        await query(
          `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
           VALUES ($1,$2,$3,'agency.milestone.invoice','agency_billing_milestone',$4,$5::jsonb)`,
          [
            owner.businessId,
            input.locationId ?? null,
            owner.actorUserId,
            milestoneId,
            JSON.stringify({
              milestoneNumber: row.milestone_number,
              invoiceOrderId,
              invoiceNumber,
              projectId,
            }),
          ],
        );
      }
    },
    { locationId: input.locationId ?? undefined, userId: owner.actorUserId },
  );

  await recordActivity(owner, {
    projectId,
    subjectType: "billing_milestone",
    subjectId: milestoneId,
    action,
    summary:
      action === "invoice" && invoiceNumber !== null
        ? `${row.milestone_number} — صورتحساب ${invoiceNumber} صادر شد`
        : `${row.milestone_number} — ${AGENCY_MILESTONE_STATUS_LABELS[target] ?? target}`,
  });
  return loadAgencyMilestone(owner, milestoneId);
}

/**
 * Issues the invoice an approved milestone has earned.
 *
 * The amount is resolved here and only here: a percentage is taken against the
 * engagement's revised value at the moment of billing, so an approved change
 * request that moved the value is reflected in the next invoice rather than in
 * a figure frozen when the schedule was written. A percentage with no value to
 * be taken of is a refusal, not a zero-amount invoice.
 *
 * Settlement defaults to on account (نسیه), which is what an agency invoice
 * means: the posting engine debits Accounts Receivable, so §D's "client
 * receivables and overdue balances" arrive through the existing AR path rather
 * than through a balance this register keeps.
 */
async function invoiceMilestone(
  client: PoolClient,
  params: {
    owner: WorkspaceOwner;
    milestoneId: string;
    projectId: string;
    engagement: AgencyEngagement;
    milestone: {
      number: string;
      title: string;
      kind: AgencyMilestoneKind;
      percent: number | null;
      amountRial: number | null;
      revenueCode: string;
      periodStartDate: string | null;
      periodEndDate: string | null;
    };
    locationId: string | null;
    tenders?: CreateRetailInvoiceTenderInput[];
  },
): Promise<{ orderId: string; orderNumber: number }> {
  const { owner, engagement, milestone, projectId } = params;
  const amountRial = milestoneAmountRial(
    { percent: milestone.percent, amountRial: milestone.amountRial },
    engagement.revisedRial,
  );
  // `null` here means a percentage with no engagement value behind it, which is
  // not "this milestone is free": it is a refusal with a reason.
  if (amountRial === null || !isSafeRial(amountRial) || amountRial <= 0) {
    throw new AgencyCommercialError("contract_value_required");
  }
  if (!engagement.customerId) throw new AgencyCommercialError("customer_required");
  const locationId =
    params.locationId ??
    (await resolveActiveLocationForUser(owner.businessId, owner.actorUserId))?.id ??
    null;
  if (!locationId) throw new AgencyCommercialError("location_required");

  const period =
    milestone.periodStartDate && milestone.periodEndDate
      ? ` (${milestone.periodStartDate} تا ${milestone.periodEndDate})`
      : "";
  const description = `${milestone.title}${period}`.slice(0, SERVICE_DESCRIPTION_MAX_LENGTH);
  const tenders: CreateRetailInvoiceTenderInput[] =
    params.tenders && params.tenders.length > 0 ? params.tenders : [{ method: "credit" }];

  const invoice = await createRetailInvoice(client, {
    businessId: owner.businessId,
    locationId,
    industry: AGENCY_INDUSTRY,
    lines: [
      {
        kind: "service",
        description,
        quantity: "1",
        unitPrice: amountRial,
        vatPercent: await getBusinessVatPercent(owner.businessId),
        revenueCode: milestone.revenueCode,
      },
    ],
    tenders,
    customerId: engagement.customerId,
    note: `${milestone.number} — ${AGENCY_MILESTONE_KIND_LABELS[milestone.kind] ?? milestone.kind}`,
    businessDate: await businessToday(owner.businessId),
    createdBy: owner.actorUserId,
    // §D's project P&L is one read over `journal_entries.project_id`, and this
    // is what puts the invoice's own entry on that read.
    projectId,
  });
  return { orderId: invoice.orderId, orderNumber: invoice.orderNumber };
}

/**
 * One queue row, as the decision rule reads it.
 *
 * A type alias rather than an interface on purpose: `query<T>` constrains `T` to
 * `Record<string, unknown>`, and only an alias (or an inline literal) gets
 * TypeScript's implicit index signature. The same shape written as an interface
 * does not, and fails to compile at every call site.
 */
type ApprovalRow = {
  subject_id: string;
  status: string;
  requested_by: string | null;
  approver_user_id: string | null;
};

/**
 * The engine's own refusal rule, applied here because these registers write
 * their queue row directly instead of going through `requestApproval`.
 *
 * `submit` is deliberately a `workspace.manage` act — the author's own, so the
 * project manager who owns a schedule can send it without holding the right to
 * decide it — and that is only safe because whoever decides cannot be the
 * person who sent it. That promise is `approvalDecisionError`, and a decide path
 * that skipped it would let one manager send and then approve their own
 * invoice: an approval you can grant yourself is decorative.
 *
 * The refusal is a `WorkspaceError`, which the route's map answers through its
 * fall-through to `handleWorkspaceError` — the same statuses the queue's own
 * door gives, so a refusal here reads like a refusal there.
 *
 * `canManageSubject` is resolved the way the engine resolves it: an unassigned
 * request may be decided by somebody who manages the subject's project, and
 * anything else needs the business's own workspace administrator.
 */
async function assertMayDecide(
  owner: WorkspaceOwner,
  projectId: string,
  approval: ApprovalRow,
  decision: "approved" | "rejected" | "changes_requested" | "cancelled",
): Promise<void> {
  let canManageSubject = false;
  if (!approval.approver_user_id && decision !== "cancelled") {
    try {
      await requireProjectCapability(owner, projectId, "manage");
      canManageSubject = true;
    } catch (err) {
      if (!(err instanceof WorkspaceError)) throw err;
    }
  }
  const refusal = approvalDecisionError({
    decision,
    actorUserId: owner.actorUserId,
    requestedBy: approval.requested_by,
    approverUserId: approval.approver_user_id,
    isAdministrator: owner.access?.override === "administer",
    canManageSubject,
  });
  if (refusal) throw new WorkspaceError(refusal);
}

/**
 * Decides a milestone's pending approval from the workspace queue.
 *
 * The queue walks the register's own chain rather than inventing a second one:
 * approving means `approve`, and both `rejected` and `changes_requested` mean
 * `reject` — a queue whose wording cannot say "revise and resubmit" is answered
 * by the one honest move, which returns the milestone to a state it can be
 * edited and sent again from.
 *
 * Issuing the invoice is deliberately NOT what an approval does. Approving says
 * the milestone may be billed; billing is `applyMilestoneAction(…, "invoice")`,
 * which the route gates on the invoice screen's own permissions as well. An
 * approver who cannot take payments must not be able to take them by approving.
 */
export async function decideMilestoneApproval(
  owner: WorkspaceOwner,
  approvalId: string,
  decision: "approved" | "rejected" | "changes_requested" | "cancelled",
  note = "",
): Promise<{ milestoneId: string | null; applied: boolean }> {
  await assertAgencyIndustry(owner.businessId);
  const { rows } = await query<ApprovalRow>(
    `SELECT subject_id, status, requested_by, approver_user_id FROM workspace_approvals
      WHERE business_id = $1 AND id = $2 AND subject_type = 'billing_milestone'`,
    [owner.businessId, approvalId],
  );
  const approval = rows[0];
  if (!approval) throw new AgencyCommercialError("approval_not_found");
  if (approval.status !== "pending") {
    return { milestoneId: approval.subject_id, applied: false };
  }
  await assertMayDecide(
    owner,
    await milestoneProjectId(owner.businessId, approval.subject_id),
    approval,
    decision,
  );

  if (decision !== "cancelled") {
    const action = decision === "approved" ? "approve" : "reject";
    await applyMilestoneAction(owner, approval.subject_id, action, { note });
  } else {
    // Withdrawing is the author taking the request back before anybody decides,
    // so the milestone returns to `draft` where it can be edited and sent
    // again. Without this move the row would stay frozen in `submitted`: the
    // freeze that protects an approver from a changing row also protects it
    // from its own author, and a request nobody will decide must not strand it.
    await applyMilestoneAction(owner, approval.subject_id, "withdraw", { note });
  }

  await query(
    `UPDATE workspace_approvals
        SET status = $3, decided_by = $4, decided_at = now(),
            note = COALESCE(NULLIF($5, ''), note), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, approvalId, decision, owner.actorUserId, trimTo(note, 1000)],
  );
  return { milestoneId: approval.subject_id, applied: true };
}

/* ===========================================================================
 * Change requests
 * ======================================================================== */

export interface AgencyChangeRequestInput {
  title?: unknown;
  description?: unknown;
  reason?: unknown;
  amountRial?: unknown;
  approvedAmountRial?: unknown;
  scheduleImpactDays?: unknown;
  contractId?: unknown;
}

/** Adds one change request, as a draft. */
export async function createAgencyChangeRequest(
  owner: WorkspaceOwner,
  projectId: string,
  input: AgencyChangeRequestInput,
): Promise<AgencyChangeRequestRecord> {
  await assertAgencyIndustry(owner.businessId);
  await requireProjectCapability(owner, projectId, "manage");
  const engagement = await loadEngagement(owner.businessId, projectId);

  const title = trimTo(input.title, 200);
  if (!title) throw new AgencyCommercialError("title_required");
  // Signed and never zero: a descope is a negative figure rather than a second
  // column, so the register cannot hold two amounts that must agree.
  const amountRial =
    input.amountRial === null || input.amountRial === undefined || input.amountRial === ""
      ? null
      : isSignedRial(money(input.amountRial))
        ? money(input.amountRial)
        : (() => {
            throw new AgencyCommercialError("invalid_change_request_amount");
          })();
  const scheduleImpactDays = intOrNull(input.scheduleImpactDays, "invalid_schedule_impact");

  const id = await withTenantTransaction(
    owner.businessId,
    async () => {
      const changeRequestNumber = await nextRegisterNumber(
        "agency_change_requests",
        projectId,
        CHANGE_REQUEST_NUMBER_PREFIX,
      );
      const { rows } = await query<{ id: string }>(
        `INSERT INTO agency_change_requests
           (business_id, project_id, contract_id, change_request_number, title, description,
            reason, amount_rial, schedule_impact_days, status, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11)
         RETURNING id`,
        [
          owner.businessId,
          projectId,
          typeof input.contractId === "string" && input.contractId.trim()
            ? input.contractId.trim()
            : engagement.contractId,
          changeRequestNumber,
          title,
          trimTo(input.description, 2000),
          trimTo(input.reason, 2000),
          amountRial,
          scheduleImpactDays,
          owner.actorUserId,
          owner.actorName ?? "",
        ],
      );
      return rows[0].id;
    },
    { userId: owner.actorUserId },
  );

  await recordActivity(owner, {
    projectId,
    subjectType: "change_request",
    subjectId: id,
    action: "created",
    summary: title,
  });
  return loadAgencyChangeRequest(owner, id);
}

/** One change request, as the register holds it. */
export async function loadAgencyChangeRequest(
  owner: WorkspaceOwner,
  changeRequestId: string,
): Promise<AgencyChangeRequestRecord> {
  const projectId = await changeRequestProjectId(owner.businessId, changeRequestId);
  const summary = await loadAgencyCommercial(owner, projectId);
  const found = summary.changeRequests.find((entry) => entry.id === changeRequestId);
  if (!found) throw new AgencyCommercialError("change_request_not_found");
  return found;
}

/** Edits a change request nobody outside the agency has read yet. */
export async function updateAgencyChangeRequest(
  owner: WorkspaceOwner,
  changeRequestId: string,
  input: AgencyChangeRequestInput,
): Promise<AgencyChangeRequestRecord> {
  await assertAgencyIndustry(owner.businessId);
  const projectId = await changeRequestProjectId(owner.businessId, changeRequestId);
  await requireProjectCapability(owner, projectId, "manage");

  const { rows: current } = await query<{ status: string }>(
    `SELECT status FROM agency_change_requests WHERE business_id = $1 AND id = $2`,
    [owner.businessId, changeRequestId],
  );
  const row = current[0];
  if (!row) throw new AgencyCommercialError("change_request_not_found");
  const status = row.status as AgencyChangeRequestStatus;
  if (!isEditableChangeRequest(status)) {
    throw new AgencyCommercialError("change_request_not_editable");
  }

  const title = trimTo(input.title, 200);
  if (!title) throw new AgencyCommercialError("title_required");
  const amountRial =
    input.amountRial === null || input.amountRial === undefined || input.amountRial === ""
      ? undefined
      : isSignedRial(money(input.amountRial))
        ? money(input.amountRial)
        : (() => {
            throw new AgencyCommercialError("invalid_change_request_amount");
          })();

  await query(
    `UPDATE agency_change_requests
        SET title = $3,
            description = $4,
            reason = $5,
            amount_rial = COALESCE($6, amount_rial),
            approved_amount_rial = $7,
            schedule_impact_days = COALESCE($8, schedule_impact_days),
            contract_id = COALESCE($9, contract_id),
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      owner.businessId,
      changeRequestId,
      title,
      trimTo(input.description, 2000),
      trimTo(input.reason, 2000),
      amountRial,
      // Re-pricing is a new round: the figure the client rejected must not be
      // carried into it, or the next approval would inherit an amount nobody
      // agreed to.
      status === "rejected" ? null : moneyOrNull(input.approvedAmountRial),
      intOrNull(input.scheduleImpactDays, "invalid_schedule_impact"),
      typeof input.contractId === "string" && input.contractId.trim()
        ? input.contractId.trim()
        : null,
    ],
  );
  await recordActivity(owner, {
    projectId,
    subjectType: "change_request",
    subjectId: changeRequestId,
    action: "updated",
    summary: title,
  });
  return loadAgencyChangeRequest(owner, changeRequestId);
}

/** Deletes a draft change request. Anything sent is withdrawn, not deleted. */
export async function deleteAgencyChangeRequest(
  owner: WorkspaceOwner,
  changeRequestId: string,
): Promise<boolean> {
  await assertAgencyIndustry(owner.businessId);
  const projectId = await changeRequestProjectId(owner.businessId, changeRequestId);
  await requireProjectCapability(owner, projectId, "manage");
  const { rowCount } = await query(
    `DELETE FROM agency_change_requests
      WHERE business_id = $1 AND id = $2 AND status = 'draft'`,
    [owner.businessId, changeRequestId],
  );
  const deleted = (rowCount ?? 0) > 0;
  if (deleted) {
    await recordActivity(owner, {
      projectId,
      subjectType: "change_request",
      subjectId: changeRequestId,
      action: "deleted",
      summary: "پیش‌نویس درخواست تغییر حذف شد",
    });
  }
  return deleted;
}

export interface AgencyChangeRequestActionInput {
  note?: unknown;
  /**
   * What this change costs — the figure `price` and `reprice` write.
   *
   * Its own field rather than a shared one: "what the change costs" and "what
   * the client agreed to" are two different figures that can legitimately
   * differ, and one parameter meaning both would let a caller price a request
   * with a field whose name says the client has already approved it.
   */
  amountRial?: unknown;
  /** The figure the client agreed to, when approving at a different amount. */
  approvedAmountRial?: unknown;
}

/**
 * §D's change-request chain, one function.
 *
 * Approving is the only act that moves money: the approved figure joins the
 * engagement's revised value, which is what the next percentage milestone is
 * taken against. The signed value on the contract is never rewritten — it stays
 * what the client signed, and the revision is read rather than stored.
 */
export async function applyChangeRequestAction(
  owner: WorkspaceOwner,
  changeRequestId: string,
  action: string,
  input: AgencyChangeRequestActionInput = {},
): Promise<AgencyChangeRequestRecord> {
  await assertAgencyIndustry(owner.businessId);
  if (!isAgencyChangeRequestAction(action)) {
    throw new AgencyCommercialError("invalid_change_request_action");
  }
  const projectId = await changeRequestProjectId(owner.businessId, changeRequestId);

  const definition = AGENCY_CHANGE_REQUEST_ACTIONS.find((entry) => entry.action === action);
  const target = definition?.target as AgencyChangeRequestStatus;
  // The same split the milestone chain uses, from the same catalogue: the
  // determination is gated by `workspace.approve` at the route and needs only
  // `view` of the project here, because an approver is not necessarily a
  // manager of the project whose change they are agreeing.
  await requireProjectCapability(owner, projectId, definition?.determination ? "view" : "manage");

  const { rows: current } = await query<{
    status: string;
    change_request_number: string;
    title: string;
    description: string;
    amount_rial: string | null;
    approved_amount_rial: string | null;
    schedule_impact_days: number | null;
  }>(
    `SELECT status, change_request_number, title, description, amount_rial,
            approved_amount_rial, schedule_impact_days
       FROM agency_change_requests
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, changeRequestId],
  );
  const row = current[0];
  if (!row) throw new AgencyCommercialError("change_request_not_found");
  const from = row.status as AgencyChangeRequestStatus;
  if (!canTransitionChangeRequest(from, target)) {
    throw new AgencyCommercialError("invalid_change_request_transition");
  }

  // A request sent to a client says what changes and what it does to the
  // schedule; a priced one has a price. These are the chain's own
  // preconditions, checked here so the refusal is a sentence rather than a
  // constraint violation from the database.
  if (action === "price" || action === "reprice") {
    const priced =
      input.amountRial === undefined ? moneyOrNull(row.amount_rial) : money(input.amountRial);
    if (priced === null || !isSignedRial(priced)) {
      throw new AgencyCommercialError("change_request_amount_required");
    }
  }
  if (action === "submit" && (!row.description.trim() || row.schedule_impact_days === null)) {
    throw new AgencyCommercialError("description_required");
  }

  const today = await businessToday(owner.businessId);
  const approvedAmount =
    action === "approve"
      ? (input.approvedAmountRial === undefined
          ? (moneyOrNull(row.approved_amount_rial) ?? moneyOrNull(row.amount_rial))
          : money(input.approvedAmountRial))
      : null;
  if (action === "approve" && (approvedAmount === null || !isSignedRial(approvedAmount))) {
    throw new AgencyCommercialError("change_request_amount_required");
  }

  await withTenantTransaction(
    owner.businessId,
    async () => {
      await query(
        `UPDATE agency_change_requests
            SET status = $3,
                amount_rial = COALESCE($4, amount_rial),
                approved_amount_rial = CASE
                  WHEN $3 IN ('approved', 'implemented') THEN COALESCE($5, approved_amount_rial)
                  WHEN $3 = 'priced' THEN NULL
                  ELSE approved_amount_rial END,
                submitted_date = CASE WHEN $3 = 'submitted' THEN COALESCE(submitted_date, $6::date) ELSE submitted_date END,
                approved_date = CASE WHEN $3 IN ('approved', 'implemented') THEN COALESCE(approved_date, $6::date) ELSE approved_date END,
                implemented_date = CASE WHEN $3 = 'implemented' THEN COALESCE(implemented_date, $6::date) ELSE implemented_date END,
                updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          owner.businessId,
          changeRequestId,
          target,
          action === "price" || action === "reprice"
            ? input.amountRial === undefined
              ? null
              : money(input.amountRial)
            : null,
          approvedAmount,
          today,
        ],
      );

      if (action === "submit") {
        try {
          await query(
            `INSERT INTO workspace_approvals
               (business_id, subject_type, subject_id, project_id, title, requested_by, note)
             VALUES ($1, 'change_request', $2, $3, $4, $5, $6)`,
            [
              owner.businessId,
              changeRequestId,
              projectId,
              `${row.change_request_number} — ${row.title.slice(0, 180)}`,
              owner.actorUserId,
              trimTo(input.note, 1000),
            ],
          );
        } catch (err) {
          if (isUniqueViolation(err)) throw new AgencyCommercialError("approval_already_pending");
          throw err;
        }
      }
    },
    { userId: owner.actorUserId },
  );

  await recordActivity(owner, {
    projectId,
    subjectType: "change_request",
    subjectId: changeRequestId,
    action,
    summary: `${row.change_request_number} — ${AGENCY_CHANGE_REQUEST_STATUS_LABELS[target] ?? target}`,
  });
  return loadAgencyChangeRequest(owner, changeRequestId);
}

/**
 * Decides a change request's pending approval from the workspace queue.
 *
 * Approving agrees the figure the request was sent with, unless the approver
 * names another; that figure is what joins the engagement's revised value.
 * Rejecting and requesting changes are the same honest move — the request goes
 * back where it can be re-priced and sent again.
 */
export async function decideChangeRequestApproval(
  owner: WorkspaceOwner,
  approvalId: string,
  decision: "approved" | "rejected" | "changes_requested" | "cancelled",
  note = "",
): Promise<{ changeRequestId: string | null; applied: boolean }> {
  await assertAgencyIndustry(owner.businessId);
  const { rows } = await query<ApprovalRow>(
    `SELECT subject_id, status, requested_by, approver_user_id FROM workspace_approvals
      WHERE business_id = $1 AND id = $2 AND subject_type = 'change_request'`,
    [owner.businessId, approvalId],
  );
  const approval = rows[0];
  if (!approval) throw new AgencyCommercialError("approval_not_found");
  if (approval.status !== "pending") {
    return { changeRequestId: approval.subject_id, applied: false };
  }
  await assertMayDecide(
    owner,
    await changeRequestProjectId(owner.businessId, approval.subject_id),
    approval,
    decision,
  );

  if (decision === "approved") {
    await applyChangeRequestAction(owner, approval.subject_id, "approve", { note });
  } else if (decision === "cancelled") {
    await applyChangeRequestAction(owner, approval.subject_id, "withdraw", { note });
  } else {
    await applyChangeRequestAction(owner, approval.subject_id, "reject", { note });
  }

  await query(
    `UPDATE workspace_approvals
        SET status = $3, decided_by = $4, decided_at = now(),
            note = COALESCE(NULLIF($5, ''), note), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, approvalId, decision, owner.actorUserId, trimTo(note, 1000)],
  );
  return { changeRequestId: approval.subject_id, applied: true };
}
