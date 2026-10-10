/**
 * Commission run approval, settlement and payout (issue #869).
 *
 * A settlement run groups unclaimed commission accruals into an immutable
 * snapshot, takes it through review and approval, and pays it out in one or
 * more payouts against the same 2300 liability payroll already uses (#835).
 * Commission is paid either inside a payroll run or here, never both: the
 * claim column on the accrual (`settlement_run_id` / `payroll_run_id`) and its
 * CHECK make that a database fact.
 *
 * The rules that carry the weight, each enforced in the transaction that
 * changes the data:
 *
 *  - An accrual is claimed by at most one run, ever. Claims are taken under the
 *    business's payroll lock, with the rows locked `FOR UPDATE`, and a claim
 *    that finds a row already taken is refused rather than partly applied.
 *  - A run's lines are a snapshot. A later rule edit, a rename or a deleted
 *    user changes nothing a run already recorded.
 *  - A payout can never exceed what the run still owes each member. Outstanding
 *    is derived from lines and allocations, so it cannot drift.
 *  - Money is posted once. A payout is keyed by an idempotency key whose request
 *    fingerprint must match on retry; a reversal is unique per payout.
 *  - The creator of a run may not approve it.
 *  - Every money-moving step writes its audit row and its event, in the same
 *    transaction as the change it records.
 *
 * Reads take a `Runner`, so the screen and the transitions share one set of
 * queries and cannot describe the same run two different ways.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Role } from "./auth";
import { businessToday } from "./business-day-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { CommissionSettlementError } from "./commission-settlement-errors";
import {
  availableRunActions,
  actionAllowedInStatus,
  COMMISSION_RUN_OPEN_STATUSES,
  mayApproveRun,
  requiredPermissionFor,
  statusForPaidTotal,
  type CommissionRunAction,
  type CommissionRunStatus,
} from "./commission-settlement-lifecycle";
import { planAllocations, payoutRequestHash } from "./commission-settlement-payout";
import {
  planSettlement,
  type PlanAccrual,
  type PlanCarry,
  type PlanLine,
  type PlanPerson,
  type PayrollClaim,
  type PlanWarning,
  type UnmappedSeller,
} from "./commission-settlement-plan";
import { isUuid, type CreateRunInput, type PayoutInput } from "./commission-settlement-input";
import type { LineExportRow, RunExportRow } from "./commission-settlement-csv";
import { query } from "./db";
import { PERMISSIONS } from "./permissions";
import { appendBusinessSyncOutboxEvent } from "./sync-outbox";
import { accountIdsByCode, postExactJournalEntry, postExactMirrorEntry } from "./ledger-service";
import { listPaymentAccounts, resolvePayoutAccount } from "./payroll-accounts";
import { clientRunner, inTransaction, lockPayroll, poolRunner, asRial, type Runner } from "./payroll-db";
import type { PayrollPaymentAccount } from "./payroll-types";
import type { RialText } from "./inventory-exact";

export interface CommissionActor {
  userId: string;
  /** The current database role of the acting membership (recorded on a business sync event). */
  role: Role;
  /** The effective permissions of the person acting (the membership's set, not the token's). */
  permissions: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Shapes returned to the routes and the screen
// ---------------------------------------------------------------------------

export interface CommissionRunSummary {
  id: string;
  runNumber: number;
  title: string | null;
  periodFrom: string;
  periodTo: string;
  locationId: string | null;
  status: CommissionRunStatus;
  lineCount: number;
  employeeCount: number;
  /** Integer Rial, as text. */
  commissionTotal: string;
  paidTotal: string;
  /** A payout document was ever posted for this run, reversed or not. Once true, the run can no longer be rejected or voided. */
  hasPayouts: boolean;
  /** What is still owed under this run. Zero once the run is closed (the balance moved to carry-forwards) or voided. */
  outstandingTotal: string;
  warnings: PlanWarning[];
  createdAt: string;
  calculatedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  closedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface CommissionRunEmployee {
  employeeId: string;
  employeeName: string;
  employeeCode: string | null;
  employeeActive: boolean;
  lineCount: number;
  owed: string;
  paid: string;
  outstanding: string;
}

export interface CommissionPayoutAllocation {
  employeeId: string;
  employeeName: string;
  amount: string;
}

export interface CommissionPayout {
  id: string;
  kind: "payout" | "reversal";
  reversesPayoutId: string | null;
  amount: string;
  paymentMethod: "cash" | "bank";
  paymentAccountId: string;
  paidDate: string;
  memo: string | null;
  entryId: string | null;
  createdAt: string;
  allocations: CommissionPayoutAllocation[];
}

export interface CommissionRunEvent {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  payoutId: string | null;
  actorName: string | null;
  note: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CommissionRunDetail extends CommissionRunSummary {
  employees: CommissionRunEmployee[];
  payouts: CommissionPayout[];
  events: CommissionRunEvent[];
  /** The actions this person may take on the run now, in lifecycle order. */
  actions: CommissionRunAction[];
  /** The business's today, for defaulting a payout's paid date. */
  today: string;
}

export interface CommissionRunLine {
  id: string;
  ordinal: number;
  runId: string;
  runNumber: number;
  lineKind: "accrual" | "carry_forward";
  employeeId: string;
  employeeName: string;
  employeeCode: string | null;
  employeeActive: boolean;
  sourceType: string;
  sourceId: string | null;
  sourceLabel: string;
  orderNumber: string | null;
  itemName: string | null;
  locationId: string | null;
  saleDate: string | null;
  entryId: string | null;
  ruleId: string | null;
  ruleVersion: string | null;
  ruleTerms: Record<string, unknown> | null;
  carriedFromRunId: string | null;
  basisAmount: string;
  amount: string;
}

export interface CommissionTieOut {
  /** Credits − debits on 2300 over the whole ledger. */
  ledgerBalance: string;
  /** Commission accrued to members over the business's life, net of reversals. */
  accruedTotal: string;
  /** Commission paid, through payroll or through a settlement run, net of reversals. */
  paidTotal: string;
  /** Unpaid commission, by where it sits. Their sum is what members are still owed. */
  unclaimed: string;
  payrollAwaitingCommission: string;
  settlementOutstanding: string;
  carriedForward: string;
  unpaidCommission: string;
  /** Zero when the accrual sub-ledger agrees with the paid and unpaid positions. */
  subledgerDifference: string;
  /** Payroll's own tie-out, extended with the standalone position. Zero when 2300 reconciles. */
  difference: string;
}

export interface CommissionStatement {
  employee: { id: string; fullName: string; employeeCode: string | null; role: string | null; isActive: boolean };
  totals: { accrued: string; paidThroughPayroll: string; paidThroughRuns: string; unpaid: string };
  accruals: {
    id: string;
    saleDate: string | null;
    sourceLabel: string;
    orderNumber: string | null;
    amount: string;
    settledBy: "run" | "payroll" | null;
    settledRef: string | null;
  }[];
  payouts: {
    payoutId: string;
    runId: string;
    runNumber: number;
    kind: "payout" | "reversal";
    amount: string;
    paidDate: string;
    entryId: string | null;
  }[];
  runs: { runId: string; runNumber: number; status: string; owed: string; paid: string; outstanding: string }[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// SQL fragments and row shapes
// ---------------------------------------------------------------------------

/** The most lines one export returns: a run that large is split by member rather than exported whole. */
const EXPORT_LINE_CAP = 20000;

const isoTs = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Every run column, with dates as text and amounts as integer text. No table alias: callers query one table. */
const RUN_COLUMNS = `
  id, business_id, run_number, title,
  period_from::text AS period_from, period_to::text AS period_to,
  location_id, employee_filter::text[] AS employee_filter,
  status, line_count, employee_count,
  commission_total::text AS commission_total, paid_total::text AS paid_total,
  EXISTS (
    SELECT 1 FROM commission_settlement_payouts p
     WHERE p.run_id = commission_settlement_runs.id AND p.kind = 'payout'
  ) AS has_payouts,
  warnings, idempotency_key, created_by, calculated_by,
  ${isoTs("created_at")} AS created_at,
  ${isoTs("calculated_at")} AS calculated_at,
  ${isoTs("approved_at")} AS approved_at,
  ${isoTs("paid_at")} AS paid_at,
  ${isoTs("closed_at")} AS closed_at,
  ${isoTs("voided_at")} AS voided_at,
  void_reason`;

type RunRow = {
  id: string;
  business_id: string;
  run_number: number;
  title: string | null;
  period_from: string;
  period_to: string;
  location_id: string | null;
  employee_filter: string[];
  status: CommissionRunStatus;
  line_count: number;
  employee_count: number;
  commission_total: string;
  paid_total: string;
  /** A payout document was ever posted for the run (reversed or not). Drives reject/void. */
  has_payouts: boolean;
  warnings: unknown;
  idempotency_key: string | null;
  created_by: string | null;
  calculated_by: string | null;
  created_at: string;
  calculated_at: string | null;
  approved_at: string | null;
  paid_at: string | null;
  closed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
};

type PayoutRowDb = {
  id: string;
  run_id: string;
  kind: "payout" | "reversal";
  reverses_payout_id: string | null;
  amount: string;
  payment_account_id: string;
  payment_method: "cash" | "bank";
  paid_date: string;
  memo: string | null;
  entry_id: string | null;
  created_at: string;
  request_hash?: string | null;
};

type AccrualRowDb = {
  id: string;
  employee_id: string;
  amount: string;
  basis_amount: string;
  rule_id: string | null;
  rule_kind: "percent" | "fixed" | null;
  rule_basis: "net" | "margin" | null;
  rule_value: string | null;
  rule_priority: number | null;
  rule_item_ids: string[] | null;
  rule_brand_ids: string[] | null;
  rule_category_ids: string[] | null;
  rule_active_from: string | null;
  rule_active_to: string | null;
  rule_is_active: boolean | null;
  source_type: string;
  source_id: string | null;
  order_number: string | null;
  item_name: string | null;
  location_id: string | null;
  sale_date: string;
  entry_id: string | null;
  created_at: string;
};

/**
 * The eligible-accrual query. A row is eligible when it is unclaimed by both
 * processes, non-zero, dated on or before the run's end, in the run's branch
 * (when it has one) and for its members (when it has any).
 */
const ELIGIBLE_ACCRUALS_SQL = `
  SELECT a.id, a.employee_id, a.amount::text AS amount, a.basis_amount::text AS basis_amount,
         a.rule_id, r.kind AS rule_kind, r.basis AS rule_basis, r.value::text AS rule_value,
         r.priority AS rule_priority, r.item_ids::text[] AS rule_item_ids, r.brand_ids::text[] AS rule_brand_ids,
         r.category_ids::text[] AS rule_category_ids, r.active_from::text AS rule_active_from,
         r.active_to::text AS rule_active_to, r.is_active AS rule_is_active,
         a.source_type, a.source_id, o.order_number::text AS order_number, oi.name_snapshot AS item_name,
         je.location_id, COALESCE(je.entry_date, a.created_at::date)::text AS sale_date, a.entry_id,
         ${isoTs("a.created_at")} AS created_at
    FROM commission_accruals a
    LEFT JOIN journal_entries je ON je.id = a.entry_id
    LEFT JOIN commission_rules r ON r.id = a.rule_id
    LEFT JOIN order_items oi ON a.source_type = 'order_item' AND oi.id = a.source_id
    LEFT JOIN orders o ON o.id = oi.order_id
   WHERE a.business_id = $1
     AND a.payroll_run_id IS NULL AND a.settlement_run_id IS NULL
     AND a.amount <> 0
     AND COALESCE(je.entry_date, a.created_at::date) <= $2::date
     AND ($3::uuid IS NULL OR je.location_id = $3::uuid)
     AND (cardinality($4::uuid[]) = 0 OR a.employee_id = ANY($4::uuid[]))`;

function toPlanAccrual(row: AccrualRowDb): PlanAccrual {
  const rule =
    row.rule_id && row.rule_kind
      ? {
          kind: row.rule_kind,
          basis: row.rule_basis ?? "net",
          value: row.rule_value ?? "0",
          priority: row.rule_priority ?? 0,
          itemIds: row.rule_item_ids ?? [],
          brandIds: row.rule_brand_ids ?? [],
          categoryIds: row.rule_category_ids ?? [],
          activeFrom: row.rule_active_from,
          activeTo: row.rule_active_to,
          isActive: row.rule_is_active ?? true,
        }
      : null;
  return {
    id: row.id,
    employeeId: row.employee_id,
    amount: BigInt(row.amount),
    basisAmount: BigInt(row.basis_amount),
    ruleId: row.rule_id,
    rule,
    sourceType: row.source_type,
    sourceId: row.source_id,
    orderNumber: row.order_number,
    itemName: row.item_name,
    locationId: row.location_id,
    saleDate: row.sale_date,
    entryId: row.entry_id,
    createdAt: row.created_at,
  };
}

function toRunSummary(row: RunRow): CommissionRunSummary {
  const open = (COMMISSION_RUN_OPEN_STATUSES as readonly string[]).includes(row.status);
  const outstanding = open ? BigInt(row.commission_total) - BigInt(row.paid_total) : 0n;
  return {
    id: row.id,
    runNumber: row.run_number,
    title: row.title,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    locationId: row.location_id,
    status: row.status,
    lineCount: row.line_count,
    employeeCount: row.employee_count,
    commissionTotal: row.commission_total,
    paidTotal: row.paid_total,
    hasPayouts: row.has_payouts,
    outstandingTotal: outstanding.toString(),
    warnings: Array.isArray(row.warnings) ? (row.warnings as PlanWarning[]) : [],
    createdAt: row.created_at,
    calculatedAt: row.calculated_at,
    approvedAt: row.approved_at,
    paidAt: row.paid_at,
    closedAt: row.closed_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requirePermission(actor: CommissionActor, permission: string): void {
  if (!actor.permissions.has(permission)) {
    throw new CommissionSettlementError("permission_required", 403, { permission });
  }
}

async function lockRun(client: PoolClient, businessId: string, runId: string): Promise<RunRow> {
  if (!isUuid(runId)) throw new CommissionSettlementError("run_not_found", 404);
  const { rows } = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM commission_settlement_runs WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [businessId, runId],
  );
  if (!rows[0]) throw new CommissionSettlementError("run_not_found", 404);
  return rows[0];
}

/**
 * Refuse an action the run's status or the actor's permissions do not allow.
 * The status code is specific (`run_not_calculated`, `run_has_payouts`, …) so
 * the screen can say what is wrong rather than only that something is.
 */
function assertAction(run: RunRow, action: CommissionRunAction, actor: CommissionActor): void {
  const money = { paidTotal: BigInt(run.paid_total), hasPayouts: run.has_payouts };
  requirePermission(actor, requiredPermissionFor(action, run.status));
  if (actionAllowedInStatus(action, run.status, money)) return;
  const hasPayouts = run.has_payouts;
  const codes: Record<CommissionRunAction, string> = {
    calculate: "run_not_draft",
    review: "run_not_calculated",
    approve: "run_not_reviewed",
    reject: hasPayouts ? "run_has_payouts" : "run_not_rejectable",
    release: "run_not_approved",
    void: hasPayouts ? "run_has_payouts" : "run_not_voidable",
    pay: "run_not_payable",
    reverse_payout: "payout_not_reversible",
    close: "run_not_closable",
  };
  throw new CommissionSettlementError(codes[action], 409, { status: run.status });
}

async function actorName(client: PoolClient, businessId: string, userId: string): Promise<string | null> {
  const { rows } = await client.query<{ full_name: string }>(
    "SELECT full_name FROM users WHERE business_id = $1 AND id = $2",
    [businessId, userId],
  );
  return rows[0]?.full_name ?? null;
}

async function recordEvent(
  client: PoolClient,
  input: {
    businessId: string;
    runId: string;
    action: string;
    fromStatus: string | null;
    toStatus: string;
    payoutId?: string | null;
    actor: CommissionActor;
    actorName: string | null;
    note?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO commission_settlement_events
       (business_id, run_id, action, from_status, to_status, payout_id, actor_id, actor_name, note, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      input.businessId,
      input.runId,
      input.action,
      input.fromStatus,
      input.toStatus,
      input.payoutId ?? null,
      input.actor.userId,
      input.actorName,
      input.note ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
}

async function writeAudit(
  client: PoolClient,
  input: { businessId: string; userId: string; action: string; entity: string; entityId: string; payload: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.businessId, input.userId, input.action, input.entity, input.entityId, JSON.stringify(input.payload)],
  );
}

async function loadRunDetail(
  run: Runner,
  businessId: string,
  runId: string,
  permissions: ReadonlySet<string>,
): Promise<CommissionRunDetail> {
  const { rows } = await run<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM commission_settlement_runs WHERE business_id = $1 AND id = $2`,
    [businessId, runId],
  );
  if (!rows[0]) throw new CommissionSettlementError("run_not_found", 404);
  const summary = toRunSummary(rows[0]);

  const { rows: employeeRows } = await run<{
    employee_id: string;
    employee_name: string;
    employee_code: string | null;
    employee_active: boolean;
    line_count: number;
    owed: string;
    paid: string;
  }>(
    `SELECT l.employee_id, MAX(l.employee_name) AS employee_name, MAX(l.employee_code) AS employee_code,
            BOOL_AND(l.employee_active) AS employee_active, COUNT(*)::int AS line_count,
            SUM(l.amount)::text AS owed,
            COALESCE((SELECT SUM(al.amount) FROM commission_settlement_allocations al
                       WHERE al.business_id = $1 AND al.run_id = $2 AND al.employee_id = l.employee_id), 0)::text AS paid
       FROM commission_settlement_lines l
      WHERE l.business_id = $1 AND l.run_id = $2
      GROUP BY l.employee_id
      ORDER BY MAX(l.employee_name), l.employee_id`,
    [businessId, runId],
  );

  const { rows: payoutRows } = await run<PayoutRowDb>(
    `SELECT id, run_id, kind, reverses_payout_id, amount::text AS amount, payment_account_id, payment_method,
            paid_date::text AS paid_date, memo, entry_id, ${isoTs("created_at")} AS created_at
       FROM commission_settlement_payouts
      WHERE business_id = $1 AND run_id = $2
      ORDER BY created_at, id`,
    [businessId, runId],
  );
  const { rows: allocationRows } = await run<{ payout_id: string; employee_id: string; employee_name: string; amount: string }>(
    `SELECT payout_id, employee_id, employee_name, amount::text AS amount
       FROM commission_settlement_allocations
      WHERE business_id = $1 AND run_id = $2
      ORDER BY employee_name, employee_id`,
    [businessId, runId],
  );
  const allocationsByPayout = new Map<string, CommissionPayoutAllocation[]>();
  for (const row of allocationRows) {
    const list = allocationsByPayout.get(row.payout_id) ?? [];
    list.push({ employeeId: row.employee_id, employeeName: row.employee_name, amount: row.amount });
    allocationsByPayout.set(row.payout_id, list);
  }

  const { rows: eventRows } = await run<{
    id: string;
    action: string;
    from_status: string | null;
    to_status: string;
    payout_id: string | null;
    actor_name: string | null;
    note: string | null;
    details: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, action, from_status, to_status, payout_id, actor_name, note, details, ${isoTs("created_at")} AS created_at
       FROM commission_settlement_events
      WHERE business_id = $1 AND run_id = $2
      ORDER BY created_at, id`,
    [businessId, runId],
  );

  const employees: CommissionRunEmployee[] = employeeRows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    employeeActive: row.employee_active,
    lineCount: row.line_count,
    owed: row.owed,
    paid: row.paid,
    outstanding: (BigInt(row.owed) - BigInt(row.paid)).toString(),
  }));

  return {
    ...summary,
    employees,
    payouts: payoutRows.map((row) => toPayout(row, allocationsByPayout.get(row.id) ?? [])),
    events: eventRows.map((row) => ({
      id: row.id,
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      payoutId: row.payout_id,
      actorName: row.actor_name,
      note: row.note,
      details: row.details ?? {},
      createdAt: row.created_at,
    })),
    actions: availableRunActions(
      summary.status,
      { paidTotal: BigInt(summary.paidTotal), hasPayouts: summary.hasPayouts },
      (permission) => permissions.has(permission),
    ),
    today: await businessToday(businessId),
  };
}

function toPayout(row: PayoutRowDb, allocations: CommissionPayoutAllocation[]): CommissionPayout {
  return {
    id: row.id,
    kind: row.kind,
    reversesPayoutId: row.reverses_payout_id,
    amount: row.amount,
    paymentMethod: row.payment_method,
    paymentAccountId: row.payment_account_id,
    paidDate: row.paid_date,
    memo: row.memo,
    entryId: row.entry_id,
    createdAt: row.created_at,
    allocations,
  };
}

async function loadPayout(run: Runner, businessId: string, payoutId: string): Promise<CommissionPayout> {
  const { rows } = await run<PayoutRowDb>(
    `SELECT id, run_id, kind, reverses_payout_id, amount::text AS amount, payment_account_id, payment_method,
            paid_date::text AS paid_date, memo, entry_id, ${isoTs("created_at")} AS created_at
       FROM commission_settlement_payouts WHERE business_id = $1 AND id = $2`,
    [businessId, payoutId],
  );
  if (!rows[0]) throw new CommissionSettlementError("payout_not_found", 404);
  const { rows: allocations } = await run<{ employee_id: string; employee_name: string; amount: string }>(
    `SELECT employee_id, employee_name, amount::text AS amount FROM commission_settlement_allocations
      WHERE business_id = $1 AND payout_id = $2 ORDER BY employee_name, employee_id`,
    [businessId, payoutId],
  );
  return toPayout(
    rows[0],
    allocations.map((row) => ({ employeeId: row.employee_id, employeeName: row.employee_name, amount: row.amount })),
  );
}

/** What each member is still owed under one run: lines less the net allocations. */
async function outstandingByEmployee(
  client: PoolClient,
  businessId: string,
  runId: string,
): Promise<Map<string, { name: string; outstanding: bigint }>> {
  const { rows } = await client.query<{ employee_id: string; employee_name: string; outstanding: string }>(
    `SELECT l.employee_id, MAX(l.employee_name) AS employee_name,
            (SUM(l.amount) - COALESCE((SELECT SUM(al.amount) FROM commission_settlement_allocations al
                                        WHERE al.business_id = $1 AND al.run_id = $2 AND al.employee_id = l.employee_id), 0))::text AS outstanding
       FROM commission_settlement_lines l
      WHERE l.business_id = $1 AND l.run_id = $2
      GROUP BY l.employee_id`,
    [businessId, runId],
  );
  return new Map(
    rows.map((row) => [row.employee_id, { name: row.employee_name, outstanding: BigInt(row.outstanding) }]),
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCommissionRuns(
  businessId: string,
  options: { status: CommissionRunStatus | null; limit: number; offset: number },
): Promise<{ runs: CommissionRunSummary[]; total: number }> {
  const { rows } = await query<RunRow & { total: string }>(
    `SELECT ${RUN_COLUMNS}, (COUNT(*) OVER())::text AS total
       FROM commission_settlement_runs
      WHERE business_id = $1 AND ($2::text IS NULL OR status = $2::text)
      ORDER BY run_number DESC
      LIMIT $3 OFFSET $4`,
    [businessId, options.status, options.limit, options.offset],
  );
  const total = rows.length > 0 ? Number(rows[0].total) : await countRuns(businessId, options.status);
  return { runs: rows.map(toRunSummary), total };
}

async function countRuns(businessId: string, status: CommissionRunStatus | null): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM commission_settlement_runs
      WHERE business_id = $1 AND ($2::text IS NULL OR status = $2::text)`,
    [businessId, status],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function getCommissionRun(
  businessId: string,
  runId: string,
  permissions: ReadonlySet<string>,
): Promise<CommissionRunDetail> {
  if (!isUuid(runId)) throw new CommissionSettlementError("run_not_found", 404);
  return loadRunDetail(poolRunner, businessId, runId, permissions);
}

export async function listCommissionRunLines(
  businessId: string,
  runId: string,
  options: { employeeId: string | null; limit: number; offset: number },
): Promise<{ lines: CommissionRunLine[]; total: number }> {
  if (!isUuid(runId)) throw new CommissionSettlementError("run_not_found", 404);
  const { rows } = await query<LineDbRow & { total: string }>(
    `${LINE_SELECT}
      WHERE l.business_id = $1 AND l.run_id = $2 AND ($3::uuid IS NULL OR l.employee_id = $3::uuid)
      ORDER BY l.ordinal
      LIMIT $4 OFFSET $5`,
    [businessId, runId, options.employeeId, options.limit, options.offset],
  );
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  return { lines: rows.map(toLine), total };
}

export async function exportCommissionRunLines(
  businessId: string,
  runId: string,
  employeeId: string | null,
): Promise<LineExportRow[]> {
  if (!isUuid(runId)) throw new CommissionSettlementError("run_not_found", 404);
  const { rows } = await query<LineDbRow>(
    `${LINE_SELECT}
      WHERE l.business_id = $1 AND l.run_id = $2 AND ($3::uuid IS NULL OR l.employee_id = $3::uuid)
      ORDER BY l.ordinal
      LIMIT $4`,
    [businessId, runId, employeeId, EXPORT_LINE_CAP],
  );
  return rows.map((row) => ({
    runNumber: row.run_number,
    lineKind: row.line_kind,
    saleDate: row.sale_date,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    sourceLabel: row.source_label,
    orderNumber: row.source_order_number,
    itemName: row.source_item_name,
    basisAmount: row.basis_amount,
    amount: row.amount,
    ruleVersion: row.rule_version,
    entryId: row.entry_id,
  }));
}

export async function exportCommissionRuns(
  businessId: string,
  status: CommissionRunStatus | null,
): Promise<RunExportRow[]> {
  const { rows } = await query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM commission_settlement_runs
      WHERE business_id = $1 AND ($2::text IS NULL OR status = $2::text)
      ORDER BY run_number DESC
      LIMIT 5000`,
    [businessId, status],
  );
  return rows.map((row) => {
    const summary = toRunSummary(row);
    return {
      runNumber: summary.runNumber,
      title: summary.title,
      periodFrom: summary.periodFrom,
      periodTo: summary.periodTo,
      status: summary.status,
      lineCount: summary.lineCount,
      employeeCount: summary.employeeCount,
      commissionTotal: summary.commissionTotal,
      paidTotal: summary.paidTotal,
      outstandingTotal: summary.outstandingTotal,
      warningCount: summary.warnings.length,
      createdAt: summary.createdAt,
    };
  });
}

type LineDbRow = {
  id: string;
  ordinal: number;
  run_id: string;
  run_number: number;
  line_kind: "accrual" | "carry_forward";
  employee_id: string;
  employee_name: string;
  employee_code: string | null;
  employee_active: boolean;
  source_type: string;
  source_id: string | null;
  source_label: string;
  source_order_number: string | null;
  source_item_name: string | null;
  location_id: string | null;
  sale_date: string | null;
  entry_id: string | null;
  rule_id: string | null;
  rule_version: string | null;
  rule_terms: Record<string, unknown> | null;
  carried_from_run_id: string | null;
  basis_amount: string;
  amount: string;
};

const LINE_SELECT = `
  SELECT l.id, l.ordinal, l.run_id, r.run_number, l.line_kind, l.employee_id, l.employee_name, l.employee_code,
         l.employee_active, l.source_type, l.source_id, l.source_label, l.source_order_number, l.source_item_name,
         l.location_id, l.sale_date::text AS sale_date, l.entry_id, l.rule_id, l.rule_version, l.rule_terms,
         l.carried_from_run_id, l.basis_amount::text AS basis_amount, l.amount::text AS amount,
         (COUNT(*) OVER())::text AS total
    FROM commission_settlement_lines l
    JOIN commission_settlement_runs r ON r.id = l.run_id`;

function toLine(row: LineDbRow): CommissionRunLine {
  return {
    id: row.id,
    ordinal: row.ordinal,
    runId: row.run_id,
    runNumber: row.run_number,
    lineKind: row.line_kind,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    employeeActive: row.employee_active,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    orderNumber: row.source_order_number,
    itemName: row.source_item_name,
    locationId: row.location_id,
    saleDate: row.sale_date,
    entryId: row.entry_id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    ruleTerms: row.rule_terms,
    carriedFromRunId: row.carried_from_run_id,
    basisAmount: row.basis_amount,
    amount: row.amount,
  };
}

/** The money a payout can still pay out of this run — what each member is owed. Used by the screen and the routes. */
export async function listCommissionPaymentAccounts(businessId: string): Promise<PayrollPaymentAccount[]> {
  return listPaymentAccounts(businessId);
}

/**
 * The commission still owed by runs that are not closed or voided, plus the
 * balances closed runs carried forward and nobody has claimed yet. Payroll adds
 * this to its own unsettled figure, so 2300 reconciles either way.
 */
export async function standaloneCommissionOutstanding(businessId: string): Promise<bigint> {
  const [runs, carries] = await Promise.all([
    query<{ total: string }>(
      `SELECT COALESCE(SUM(commission_total - paid_total), 0)::text AS total
         FROM commission_settlement_runs
        WHERE business_id = $1 AND status = ANY($2::text[])`,
      [businessId, [...COMMISSION_RUN_OPEN_STATUSES]],
    ),
    query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM commission_settlement_carries
        WHERE business_id = $1 AND claimed_by_run_id IS NULL`,
      [businessId],
    ),
  ]);
  return BigInt(runs.rows[0].total) + BigInt(carries.rows[0].total);
}

/**
 * The 2300 tie-out, in both directions. The accrual sub-ledger must agree with
 * the paid and unpaid positions (`subledgerDifference`), and the ledger must
 * agree with what is still owed (`difference`). Both are zero on a healthy
 * business, and a non-zero figure names the place the books disagree.
 */
export async function getCommissionLiability(businessId: string): Promise<CommissionTieOut> {
  const [ledger, accruals, payroll, runs, carries] = await Promise.all([
    query<{ balance: string }>(
      `SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS balance
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND a.business_id = $1 AND a.code = $2`,
      [businessId, WELL_KNOWN_CODES.salariesPayable],
    ),
    query<{ accrued: string; unclaimed: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS accrued,
              COALESCE(SUM(amount) FILTER (WHERE payroll_run_id IS NULL AND settlement_run_id IS NULL), 0)::text AS unclaimed
         FROM commission_accruals WHERE business_id = $1`,
      [businessId],
    ),
    query<{ awaiting_net_and_commission: string; awaiting_commission: string; paid_commission: string }>(
      `SELECT COALESCE(SUM(COALESCE(net_amount, total_amount) + commission_total) FILTER (WHERE status = 'accrued'), 0)::text AS awaiting_net_and_commission,
              COALESCE(SUM(commission_total) FILTER (WHERE status = 'accrued'), 0)::text AS awaiting_commission,
              COALESCE(SUM(commission_total) FILTER (WHERE status = 'paid'), 0)::text AS paid_commission
         FROM payroll_runs WHERE business_id = $1`,
      [businessId],
    ),
    query<{ outstanding: string; paid: string }>(
      `SELECT COALESCE(SUM(commission_total - paid_total) FILTER (WHERE status = ANY($2::text[])), 0)::text AS outstanding,
              COALESCE(SUM(paid_total) FILTER (WHERE status <> 'voided'), 0)::text AS paid
         FROM commission_settlement_runs WHERE business_id = $1`,
      [businessId, [...COMMISSION_RUN_OPEN_STATUSES]],
    ),
    query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM commission_settlement_carries
        WHERE business_id = $1 AND claimed_by_run_id IS NULL`,
      [businessId],
    ),
  ]);

  const ledgerBalance = BigInt(ledger.rows[0].balance);
  const accruedTotal = BigInt(accruals.rows[0].accrued);
  const unclaimed = BigInt(accruals.rows[0].unclaimed);
  const awaitingNetAndCommission = BigInt(payroll.rows[0].awaiting_net_and_commission);
  const awaitingCommission = BigInt(payroll.rows[0].awaiting_commission);
  const paidCommission = BigInt(payroll.rows[0].paid_commission);
  const settlementOutstanding = BigInt(runs.rows[0].outstanding);
  const standalonePaid = BigInt(runs.rows[0].paid);
  const carriedForward = BigInt(carries.rows[0].total);

  const paidTotal = paidCommission + standalonePaid;
  const unpaidCommission = unclaimed + awaitingCommission + settlementOutstanding + carriedForward;
  return {
    ledgerBalance: ledgerBalance.toString(),
    accruedTotal: accruedTotal.toString(),
    paidTotal: paidTotal.toString(),
    unclaimed: unclaimed.toString(),
    payrollAwaitingCommission: awaitingCommission.toString(),
    settlementOutstanding: settlementOutstanding.toString(),
    carriedForward: carriedForward.toString(),
    unpaidCommission: unpaidCommission.toString(),
    subledgerDifference: (accruedTotal - paidTotal - unpaidCommission).toString(),
    difference: (ledgerBalance - awaitingNetAndCommission - unclaimed - settlementOutstanding - carriedForward).toString(),
  };
}

export async function getCommissionStatement(businessId: string, employeeId: string): Promise<CommissionStatement> {
  if (!isUuid(employeeId)) throw new CommissionSettlementError("employee_not_found", 404);
  const { rows: people } = await query<{
    id: string;
    full_name: string;
    employee_code: string | null;
    role: string | null;
    is_active: boolean;
  }>(
    `SELECT u.id, u.full_name, e.employee_code, u.role::text AS role, u.is_active
       FROM users u LEFT JOIN employees e ON e.id = u.id
      WHERE u.business_id = $1 AND u.id = $2`,
    [businessId, employeeId],
  );
  if (!people[0]) throw new CommissionSettlementError("employee_not_found", 404);

  const LIMIT = 500;
  const [accrualRows, accrualTotals, payrollPaid, payoutRows, runRows] = await Promise.all([
    query<{
      id: string;
      sale_date: string | null;
      source_type: string;
      order_number: string | null;
      amount: string;
      settlement_run_number: number | null;
      payroll_period: string | null;
    }>(
      `SELECT a.id, COALESCE(je.entry_date, a.created_at::date)::text AS sale_date, a.source_type,
              o.order_number::text AS order_number, a.amount::text AS amount,
              sr.run_number AS settlement_run_number, pr.period_label AS payroll_period
         FROM commission_accruals a
         LEFT JOIN journal_entries je ON je.id = a.entry_id
         LEFT JOIN order_items oi ON a.source_type = 'order_item' AND oi.id = a.source_id
         LEFT JOIN orders o ON o.id = oi.order_id
         LEFT JOIN commission_settlement_runs sr ON sr.id = a.settlement_run_id
         LEFT JOIN payroll_runs pr ON pr.id = a.payroll_run_id
        WHERE a.business_id = $1 AND a.employee_id = $2 AND a.amount <> 0
        ORDER BY COALESCE(je.entry_date, a.created_at::date) DESC, a.created_at DESC, a.id
        LIMIT ${LIMIT + 1}`,
      [businessId, employeeId],
    ),
    query<{ accrued: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS accrued
         FROM commission_accruals WHERE business_id = $1 AND employee_id = $2`,
      [businessId, employeeId],
    ),
    query<{ paid: string }>(
      `SELECT COALESCE(SUM(l.commission_amount), 0)::text AS paid
         FROM payroll_run_lines l JOIN payroll_runs pr ON pr.id = l.run_id
        WHERE pr.business_id = $1 AND l.user_id = $2 AND pr.status = 'paid'`,
      [businessId, employeeId],
    ),
    query<{
      payout_id: string;
      run_id: string;
      run_number: number;
      kind: "payout" | "reversal";
      amount: string;
      paid_date: string;
      entry_id: string | null;
    }>(
      `SELECT p.id AS payout_id, p.run_id, r.run_number, p.kind, al.amount::text AS amount,
              p.paid_date::text AS paid_date, p.entry_id
         FROM commission_settlement_allocations al
         JOIN commission_settlement_payouts p ON p.id = al.payout_id
         JOIN commission_settlement_runs r ON r.id = p.run_id
        WHERE al.business_id = $1 AND al.employee_id = $2
        ORDER BY p.created_at DESC, p.id
        LIMIT ${LIMIT + 1}`,
      [businessId, employeeId],
    ),
    query<{ run_id: string; run_number: number; status: string; owed: string; paid: string }>(
      `SELECT r.id AS run_id, r.run_number, r.status,
              SUM(l.amount)::text AS owed,
              COALESCE((SELECT SUM(al.amount) FROM commission_settlement_allocations al
                         WHERE al.business_id = $1 AND al.run_id = r.id AND al.employee_id = $2), 0)::text AS paid
         FROM commission_settlement_lines l
         JOIN commission_settlement_runs r ON r.id = l.run_id
        WHERE l.business_id = $1 AND l.employee_id = $2
        GROUP BY r.id, r.run_number, r.status
        ORDER BY r.run_number DESC`,
      [businessId, employeeId],
    ),
  ]);

  const accrued = BigInt(accrualTotals.rows[0].accrued);
  const paidThroughPayroll = BigInt(payrollPaid.rows[0].paid);
  const paidThroughRuns = payoutRows.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const person = people[0];
  return {
    employee: {
      id: person.id,
      fullName: person.full_name,
      employeeCode: person.employee_code,
      role: person.role,
      isActive: person.is_active,
    },
    totals: {
      accrued: accrued.toString(),
      paidThroughPayroll: paidThroughPayroll.toString(),
      paidThroughRuns: paidThroughRuns.toString(),
      unpaid: (accrued - paidThroughPayroll - paidThroughRuns).toString(),
    },
    accruals: accrualRows.rows.slice(0, LIMIT).map((row) => ({
      id: row.id,
      saleDate: row.sale_date,
      sourceLabel: row.source_type === "order_item" ? (row.order_number ? `سفارش ${row.order_number}` : "فروش")
        : row.source_type === "serial_return" ? "برگشت کالا"
        : row.source_type === "order_amendment" ? "ابطال یا اصلاح فاکتور"
        : row.source_type,
      orderNumber: row.order_number,
      amount: row.amount,
      settledBy: row.settlement_run_number !== null ? "run" : row.payroll_period !== null ? "payroll" : null,
      settledRef:
        row.settlement_run_number !== null
          ? `دورهٔ شماره ${row.settlement_run_number}`
          : row.payroll_period !== null
            ? `حقوق ${row.payroll_period}`
            : null,
    })),
    payouts: payoutRows.rows.slice(0, LIMIT).map((row) => ({
      payoutId: row.payout_id,
      runId: row.run_id,
      runNumber: row.run_number,
      kind: row.kind,
      amount: row.amount,
      paidDate: row.paid_date,
      entryId: row.entry_id,
    })),
    runs: runRows.rows.map((row) => ({
      runId: row.run_id,
      runNumber: row.run_number,
      status: row.status,
      owed: row.owed,
      paid: row.paid,
      outstanding: (BigInt(row.owed) - BigInt(row.paid)).toString(),
    })),
    truncated: accrualRows.rows.length > LIMIT || payoutRows.rows.length > LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Create and calculate
// ---------------------------------------------------------------------------

function sameRunRequest(run: RunRow, input: CreateRunInput): boolean {
  const employees = [...run.employee_filter].sort();
  return (
    run.period_from === input.periodFrom &&
    run.period_to === input.periodTo &&
    (run.location_id ?? null) === input.locationId &&
    employees.length === input.employeeIds.length &&
    employees.every((id, index) => id === input.employeeIds[index]) &&
    (run.title ?? null) === input.title
  );
}

/**
 * Open a new draft run. Business-wide sequence number under the payroll lock,
 * and a retry with the same Idempotency-Key returns the run it created when the
 * request is the same, or refuses when it is not.
 */
export async function createCommissionRun(
  businessId: string,
  actor: CommissionActor,
  input: CreateRunInput,
  idempotencyKey: string | null,
): Promise<{ run: CommissionRunDetail; replayed: boolean }> {
  requirePermission(actor, PERMISSIONS.commissionCalculate);
  return inTransaction(async (client) => {
    await lockPayroll(client, businessId);

    if (idempotencyKey) {
      const { rows } = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM commission_settlement_runs WHERE business_id = $1 AND idempotency_key = $2`,
        [businessId, idempotencyKey],
      );
      if (rows[0]) {
        if (!sameRunRequest(rows[0], input)) throw new CommissionSettlementError("idempotency_key_conflict", 409);
        return { run: await loadRunDetail(clientRunner(client), businessId, rows[0].id, actor.permissions), replayed: true };
      }
    }

    if (input.locationId) {
      const { rows } = await client.query(
        "SELECT 1 FROM locations WHERE business_id = $1 AND id = $2",
        [businessId, input.locationId],
      );
      if (rows.length === 0) throw new CommissionSettlementError("location_not_found", 400);
    }
    if (input.employeeIds.length > 0) {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE business_id = $1 AND id = ANY($2::uuid[])",
        [businessId, input.employeeIds],
      );
      const known = new Set(rows.map((row) => row.id));
      const missing = input.employeeIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw new CommissionSettlementError("employee_not_found", 400, { employeeIds: missing });
      }
    }

    const today = await businessToday(businessId);
    if (input.periodTo > today) throw new CommissionSettlementError("period_in_future", 400);

    const { rows: next } = await client.query<{ next: number }>(
      "SELECT (COALESCE(MAX(run_number), 0) + 1)::int AS next FROM commission_settlement_runs WHERE business_id = $1",
      [businessId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO commission_settlement_runs
         (business_id, run_number, title, period_from, period_to, location_id, employee_filter, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7::uuid[], $8, $9)
       RETURNING id`,
      [
        businessId,
        next[0].next,
        input.title,
        input.periodFrom,
        input.periodTo,
        input.locationId,
        input.employeeIds,
        idempotencyKey,
        actor.userId,
      ],
    );
    const runId = rows[0].id;
    const name = await actorName(client, businessId, actor.userId);
    await recordEvent(client, {
      businessId,
      runId,
      action: "create",
      fromStatus: null,
      toStatus: "draft",
      actor,
      actorName: name,
      details: { periodFrom: input.periodFrom, periodTo: input.periodTo, locationId: input.locationId },
    });
    await writeAudit(client, {
      businessId,
      userId: actor.userId,
      action: "commission.run.created",
      entity: "commission_run",
      entityId: runId,
      payload: { runNumber: next[0].next, periodFrom: input.periodFrom, periodTo: input.periodTo },
    });
    return { run: await loadRunDetail(clientRunner(client), businessId, runId, actor.permissions), replayed: false };
  });
}

interface CandidateSet {
  accruals: PlanAccrual[];
  carries: PlanCarry[];
  people: PlanPerson[];
  payrollClaims: PayrollClaim[];
  unmappedSellers: UnmappedSeller[];
}

async function loadCandidates(client: PoolClient, businessId: string, run: RunRow): Promise<CandidateSet> {
  const { rows: accrualRows } = await client.query<AccrualRowDb>(
    `${ELIGIBLE_ACCRUALS_SQL}
     ORDER BY COALESCE(je.entry_date, a.created_at::date), a.created_at, a.id
     FOR UPDATE OF a`,
    [businessId, run.period_to, run.location_id, run.employee_filter],
  );
  const { rows: carryRows } = await client.query<{
    id: string;
    from_run_id: string;
    run_number: number;
    employee_id: string;
    employee_name: string;
    amount: string;
  }>(
    `SELECT c.id, c.from_run_id, r.run_number, c.employee_id, c.employee_name, c.amount::text AS amount
       FROM commission_settlement_carries c
       JOIN commission_settlement_runs r ON r.id = c.from_run_id
      WHERE c.business_id = $1 AND c.claimed_by_run_id IS NULL
        AND (cardinality($2::uuid[]) = 0 OR c.employee_id = ANY($2::uuid[]))
      ORDER BY r.run_number, c.id
      FOR UPDATE OF c`,
    [businessId, run.employee_filter],
  );
  const memberIds = [...new Set([...accrualRows.map((r) => r.employee_id), ...carryRows.map((r) => r.employee_id)])];
  type PersonRow = {
    id: string;
    full_name: string;
    is_active: boolean;
    role: string | null;
    employee_code: string | null;
  };
  let people: PersonRow[] = [];
  if (memberIds.length > 0) {
    const result = await client.query<PersonRow>(
      `SELECT u.id, u.full_name, u.is_active, u.role::text AS role, e.employee_code
         FROM users u LEFT JOIN employees e ON e.id = u.id
        WHERE u.business_id = $1 AND u.id = ANY($2::uuid[])`,
      [businessId, memberIds],
    );
    people = result.rows;
  }
  // Rows a payroll run already paid, grouped by that payroll run so the warning
  // can name it. Same window and filters as the rows this run would take.
  const { rows: claimed } = await client.query<{ payroll_run_id: string; period_label: string; n: number }>(
    `SELECT a.payroll_run_id, pr.period_label, COUNT(*)::int AS n
       FROM commission_accruals a
       JOIN payroll_runs pr ON pr.id = a.payroll_run_id
       LEFT JOIN journal_entries je ON je.id = a.entry_id
      WHERE a.business_id = $1 AND a.payroll_run_id IS NOT NULL AND a.amount <> 0
        AND COALESCE(je.entry_date, a.created_at::date) <= $2::date
        AND ($3::uuid IS NULL OR je.location_id = $3::uuid)
        AND (cardinality($4::uuid[]) = 0 OR a.employee_id = ANY($4::uuid[]))
      GROUP BY a.payroll_run_id, pr.period_label, pr.created_at
      ORDER BY pr.created_at, a.payroll_run_id`,
    [businessId, run.period_to, run.location_id, run.employee_filter],
  );
  // Retail sales in the period whose seller has no commission rule in force
  // today (the same `is_active` + effective-window test the accrual path applies
  // to a rule). The sale's business day is the day the period is measured on.
  const { rows: unmapped } = await client.query<{
    employee_id: string;
    full_name: string;
    lines: number;
    sales_value: string;
  }>(
    `SELECT o.opened_by AS employee_id, COALESCE(u.full_name, '') AS full_name,
            COUNT(oi.id)::int AS lines,
            COALESCE(SUM(oi.unit_price * oi.quantity), 0)::text AS sales_value
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN locations l ON l.id = o.location_id AND l.business_id = $1
       LEFT JOIN users u ON u.id = o.opened_by AND u.business_id = $1
      WHERE o.type = 'retail' AND o.status = 'completed' AND oi.status <> 'voided'
        AND o.opened_by IS NOT NULL
        AND app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)
            BETWEEN $2::date AND $3::date
        AND ($4::uuid IS NULL OR o.location_id = $4::uuid)
        AND (cardinality($5::uuid[]) = 0 OR o.opened_by = ANY($5::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM commission_rules r
           WHERE r.business_id = $1 AND r.employee_id = o.opened_by AND r.is_active
             AND (r.active_from IS NULL OR r.active_from <= CURRENT_DATE)
             AND (r.active_to IS NULL OR r.active_to >= CURRENT_DATE)
        )
      GROUP BY o.opened_by, u.full_name
      ORDER BY u.full_name NULLS LAST, o.opened_by`,
    [businessId, run.period_from, run.period_to, run.location_id, run.employee_filter],
  );

  return {
    accruals: accrualRows.map(toPlanAccrual),
    carries: carryRows.map((row) => ({
      id: row.id,
      fromRunId: row.from_run_id,
      fromRunNumber: row.run_number,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      amount: BigInt(row.amount),
    })),
    people: people.map((person) => ({
      id: person.id,
      fullName: person.full_name,
      employeeCode: person.employee_code,
      role: person.role,
      isActive: person.is_active,
    })),
    payrollClaims: claimed.map((row) => ({
      payrollRunId: row.payroll_run_id,
      periodLabel: row.period_label,
      rows: row.n,
    })),
    unmappedSellers: unmapped.map((row) => ({
      employeeId: row.employee_id,
      fullName: row.full_name,
      lines: row.lines,
      salesValue: BigInt(row.sales_value),
    })),
  };
}

/**
 * Calculate a draft: snapshot every eligible row into lines, claim the rows,
 * and move the run to `calculated`. Refuses a run that would pay nothing.
 */
export async function calculateCommissionRun(
  businessId: string,
  actor: CommissionActor,
  runId: string,
): Promise<CommissionRunDetail> {
  return inTransaction(async (client) => {
    await lockPayroll(client, businessId);
    const run = await lockRun(client, businessId, runId);
    assertAction(run, "calculate", actor);

    const candidates = await loadCandidates(client, businessId, run);
    const plan = planSettlement({
      accruals: candidates.accruals,
      carries: candidates.carries,
      people: candidates.people,
      periodFrom: run.period_from,
      periodTo: run.period_to,
      payrollClaims: candidates.payrollClaims,
      unmappedSellers: candidates.unmappedSellers,
    });
    if (plan.members.length === 0) {
      throw new CommissionSettlementError("nothing_to_settle", 409, { warnings: plan.warnings });
    }

    for (const line of plan.lines) {
      await insertLine(client, businessId, runId, line);
    }

    // The rows are locked above, so every one should still be free; a shortfall
    // means something outside this lock changed them, and the whole run rolls back.
    if (plan.accrualIds.length > 0) {
      const claimed = await client.query(
        `UPDATE commission_accruals SET settlement_run_id = $1
          WHERE business_id = $2 AND id = ANY($3::uuid[])
            AND payroll_run_id IS NULL AND settlement_run_id IS NULL`,
        [runId, businessId, plan.accrualIds],
      );
      if (claimed.rowCount !== plan.accrualIds.length) {
        throw new CommissionSettlementError("commission_already_settled", 409);
      }
    }
    if (plan.carryIds.length > 0) {
      const claimed = await client.query(
        `UPDATE commission_settlement_carries SET claimed_by_run_id = $1
          WHERE business_id = $2 AND id = ANY($3::uuid[]) AND claimed_by_run_id IS NULL`,
        [runId, businessId, plan.carryIds],
      );
      if (claimed.rowCount !== plan.carryIds.length) {
        throw new CommissionSettlementError("commission_already_settled", 409);
      }
    }

    await client.query(
      `UPDATE commission_settlement_runs
          SET status = 'calculated', line_count = $2, employee_count = $3, commission_total = $4,
              warnings = $5::jsonb, calculated_by = $6, calculated_at = now(), updated_at = now()
        WHERE id = $1`,
      [
        runId,
        plan.lines.length,
        plan.members.length,
        plan.total.toString(),
        JSON.stringify(plan.warnings),
        actor.userId,
      ],
    );
    const name = await actorName(client, businessId, actor.userId);
    await recordEvent(client, {
      businessId,
      runId,
      action: "calculate",
      fromStatus: "draft",
      toStatus: "calculated",
      actor,
      actorName: name,
      details: {
        lines: plan.lines.length,
        employees: plan.members.length,
        accruals: plan.accrualIds.length,
        carries: plan.carryIds.length,
        total: plan.total.toString(),
        warnings: plan.warnings.map((warning) => warning.code),
      },
    });
    await writeAudit(client, {
      businessId,
      userId: actor.userId,
      action: "commission.run.calculated",
      entity: "commission_run",
      entityId: runId,
      payload: { runNumber: run.run_number, lines: plan.lines.length, employees: plan.members.length },
    });
    return loadRunDetail(clientRunner(client), businessId, runId, actor.permissions);
  });
}

async function insertLine(client: PoolClient, businessId: string, runId: string, line: PlanLine): Promise<void> {
  await client.query(
    `INSERT INTO commission_settlement_lines
       (business_id, run_id, ordinal, line_kind, accrual_id, carry_id, carried_from_run_id,
        employee_id, employee_name, employee_code, employee_role, employee_active,
        rule_id, rule_version, rule_terms, source_type, source_id, source_label,
        source_order_number, source_item_name, location_id, sale_date, entry_id, basis_amount, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18,
             $19, $20, $21, $22::date, $23, $24, $25)`,
    [
      businessId,
      runId,
      line.ordinal,
      line.lineKind,
      line.accrualId,
      line.carryId,
      line.carriedFromRunId,
      line.employeeId,
      line.employeeName,
      line.employeeCode,
      line.employeeRole,
      line.employeeActive,
      line.ruleId,
      line.ruleVersion,
      line.ruleTerms ? JSON.stringify(line.ruleTerms) : null,
      line.sourceType,
      line.sourceId,
      line.sourceLabel,
      line.sourceOrderNumber,
      line.sourceItemName,
      line.locationId,
      line.saleDate,
      line.entryId,
      line.basisAmount.toString(),
      line.amount.toString(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Review, approval, rejection, release, void, close
// ---------------------------------------------------------------------------

async function plainTransition(
  businessId: string,
  actor: CommissionActor,
  runId: string,
  input: {
    action: "review" | "approve" | "release";
    from: CommissionRunStatus;
    to: CommissionRunStatus;
    note: string | null;
    column: "reviewed" | "approved" | "released";
    auditAction: string;
    beforeWrite?: (run: RunRow, client: PoolClient) => Promise<void>;
  },
): Promise<CommissionRunDetail> {
  return inTransaction(async (client) => {
    const run = await lockRun(client, businessId, runId);
    assertAction(run, input.action, actor);
    if (input.beforeWrite) await input.beforeWrite(run, client);
    await client.query(
      `UPDATE commission_settlement_runs
          SET status = $2, ${input.column}_by = $3, ${input.column}_at = now(), updated_at = now()
        WHERE id = $1`,
      [runId, input.to, actor.userId],
    );
    const name = await actorName(client, businessId, actor.userId);
    await recordEvent(client, {
      businessId,
      runId,
      action: input.action,
      fromStatus: run.status,
      toStatus: input.to,
      actor,
      actorName: name,
      note: input.note,
    });
    await writeAudit(client, {
      businessId,
      userId: actor.userId,
      action: input.auditAction,
      entity: "commission_run",
      entityId: runId,
      payload: { runNumber: run.run_number, from: run.status, to: input.to },
    });
    return loadRunDetail(clientRunner(client), businessId, runId, actor.permissions);
  });
}

export function reviewCommissionRun(businessId: string, actor: CommissionActor, runId: string, note: string | null) {
  return plainTransition(businessId, actor, runId, {
    action: "review",
    from: "calculated",
    to: "reviewed",
    note,
    column: "reviewed",
    auditAction: "commission.run.reviewed",
  });
}

/** Approval is separate from calculation: the person who calculated a run cannot approve it. */
export function approveCommissionRun(businessId: string, actor: CommissionActor, runId: string, note: string | null) {
  return plainTransition(businessId, actor, runId, {
    action: "approve",
    from: "reviewed",
    to: "approved",
    note,
    column: "approved",
    auditAction: "commission.run.approved",
    beforeWrite: async (run) => {
      if (!mayApproveRun(run.calculated_by, actor.userId)) {
        throw new CommissionSettlementError("approver_is_calculator", 403);
      }
    },
  });
}

/** Release an approved run for payment. From here it can be paid, not edited. */
export function releaseCommissionRun(businessId: string, actor: CommissionActor, runId: string, note: string | null) {
  return plainTransition(businessId, actor, runId, {
    action: "release",
    from: "approved",
    to: "payable",
    note,
    column: "released",
    auditAction: "commission.run.released",
  });
}

/**
 * Return a run to draft before any money has left: its lines are purged, its
 * accruals and carry-forwards released, and it can be calculated again.
 */
export async function rejectCommissionRun(
  businessId: string,
  actor: CommissionActor,
  runId: string,
  note: string | null,
): Promise<CommissionRunDetail> {
  return inTransaction(async (client) => {
    await lockPayroll(client, businessId);
    const run = await lockRun(client, businessId, runId);
    assertAction(run, "reject", actor);

    // The snapshot is purged only because nothing was posted (the guards refuse
    // otherwise). What it held is recorded on the reject event, so the history
    // of what was released survives the purge.
    const { rows: purged } = await client.query<{ accrual_id: string | null; carry_id: string | null }>(
      "SELECT accrual_id, carry_id FROM commission_settlement_lines WHERE business_id = $1 AND run_id = $2 ORDER BY ordinal",
      [businessId, runId],
    );
    await client.query("SELECT set_config('app.commission_settlement_reset', 'on', true)");
    await client.query(
      "UPDATE commission_accruals SET settlement_run_id = NULL WHERE business_id = $1 AND settlement_run_id = $2",
      [businessId, runId],
    );
    await client.query(
      "UPDATE commission_settlement_carries SET claimed_by_run_id = NULL WHERE business_id = $1 AND claimed_by_run_id = $2",
      [businessId, runId],
    );
    await client.query("DELETE FROM commission_settlement_lines WHERE business_id = $1 AND run_id = $2", [businessId, runId]);
    await client.query(
      `UPDATE commission_settlement_runs
          SET status = 'draft', line_count = 0, employee_count = 0, commission_total = 0, warnings = '[]'::jsonb,
              calculated_by = NULL, calculated_at = NULL, reviewed_by = NULL, reviewed_at = NULL,
              approved_by = NULL, approved_at = NULL, released_by = NULL, released_at = NULL, updated_at = now()
        WHERE id = $1`,
      [runId],
    );
    const name = await actorName(client, businessId, actor.userId);
    await recordEvent(client, {
      businessId,
      runId,
      action: "reject",
      fromStatus: run.status,
      toStatus: "draft",
      actor,
      actorName: name,
      note,
      details: {
        previousLines: run.line_count,
        previousTotal: run.commission_total,
        releasedAccrualIds: purged.flatMap((row) => (row.accrual_id ? [row.accrual_id] : [])),
        releasedCarryIds: purged.flatMap((row) => (row.carry_id ? [row.carry_id] : [])),
      },
    });
    await writeAudit(client, {
      businessId,
      userId: actor.userId,
      action: "commission.run.rejected",
      entity: "commission_run",
      entityId: runId,
      payload: { runNumber: run.run_number, from: run.status },
    });
    return loadRunDetail(clientRunner(client), businessId, runId, actor.permissions);
  });
}

/**
 * Void a run before any money has left. Its accruals and carry-forwards are
 * released; its lines stay as the record of what was voided.
 */
export async function voidCommissionRun(
  businessId: string,
  actor: CommissionActor,
  runId: string,
  reason: string,
): Promise<CommissionRunDetail> {
  return inTransaction(async (client) => {
    await lockPayroll(client, businessId);
    const run = await lockRun(client, businessId, runId);
    assertAction(run, "void", actor);

    await client.query(
      "UPDATE commission_accruals SET settlement_run_id = NULL WHERE business_id = $1 AND settlement_run_id = $2",
      [businessId, runId],
    );
    await client.query(
      "UPDATE commission_settlement_carries SET claimed_by_run_id = NULL WHERE business_id = $1 AND claimed_by_run_id = $2",
      [businessId, runId],
    );
    await client.query(
      `UPDATE commission_settlement_runs
          SET status = 'voided', voided_by = $2, voided_at = now(), void_reason = $3, updated_at = now()
        WHERE id = $1`,
      [runId, actor.userId, reason],
    );
    const name = await actorName(client, businessId, actor.userId);
    await recordEvent(client, {
      businessId,
      runId,
      action: "void",
      fromStatus: run.status,
      toStatus: "voided",
      actor,
      actorName: name,
      note: reason,
      details: { lines: run.line_count, total: run.commission_total },
    });
    await writeAudit(client, {
      businessId,
      userId: actor.userId,
      action: "commission.run.voided",
      entity: "commission_run",
      entityId: runId,
      payload: { runNumber: run.run_number, from: run.status },
    });
    return loadRunDetail(clientRunner(client), businessId, runId, actor.permissions);
  });
}

/**
 * Close a run that has finished paying. A run closed part-paid carries what each
 * member is still owed forward, to be claimed by the next run that calculates
 * for them, so nothing is lost and nothing is paid twice.
 */
export async function closeCommissionRun(
  businessId: string,
  actor: CommissionActor,
  runId: string,
  note: string | null,
): Promise<CommissionRunDetail> {
  return inTransaction(async (client) => {
    await lockPayroll(client, businessId);
    const run = await lockRun(client, businessId, runId);
    assertAction(run, "close", actor);

    const owed = await outstandingByEmployee(client, businessId, runId);
    let carriedCount = 0;
    let carriedTotal = 0n;
    for (const [employeeId, entry] of owed) {
      if (entry.outstanding <= 0n) continue;
      await client.query(
        `INSERT INTO commission_settlement_carries (business_id, from_run_id, employee_id, employee_name, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [businessId, runId, employeeId, entry.name, entry.outstanding.toString()],
      );
      carriedCount += 1;
      carriedTotal += entry.outstanding;
    }

    await client.query(
      `UPDATE commission_settlement_runs
          SET status = 'closed', closed_by = $2, closed_at = now(), updated_at = now()
        WHERE id = $1`,
      [runId, actor.userId],
    );
    const name = await actorName(client, businessId, actor.userId);
    await recordEvent(client, {
      businessId,
      runId,
      action: "close",
      fromStatus: run.status,
      toStatus: "closed",
      actor,
      actorName: name,
      note,
      details: { carriedEmployees: carriedCount, carriedTotal: carriedTotal.toString() },
    });
    await writeAudit(client, {
      businessId,
      userId: actor.userId,
      action: "commission.run.closed",
      entity: "commission_run",
      entityId: runId,
      payload: { runNumber: run.run_number, carriedEmployees: carriedCount, carriedTotal: carriedTotal.toString() },
    });
    return loadRunDetail(clientRunner(client), businessId, runId, actor.permissions);
  });
}

// ---------------------------------------------------------------------------
// Payouts and their reversals
// ---------------------------------------------------------------------------

/**
 * Pay some or all of what a payable run owes, member by member. The journal
 * entry (Dr 2300, Cr the chosen cash or bank account) and the payout document
 * are written together. Idempotent on `idempotencyKey`: a retry returns the
 * payout it made, and a retry with a different request is refused.
 */
export async function recordCommissionPayout(
  businessId: string,
  actor: CommissionActor,
  runId: string,
  input: PayoutInput,
  idempotencyKey: string | null,
): Promise<{ run: CommissionRunDetail; payout: CommissionPayout; replayed: boolean }> {
  return inTransaction(async (client) => {
    const run = await lockRun(client, businessId, runId);
    const requestHash = payoutRequestHash({
      runId,
      allocations: input.allocations,
      paymentAccountId: input.paymentAccountId,
      method: input.method,
      paidDate: input.paidDate,
      memo: input.memo,
    });

    if (idempotencyKey) {
      const { rows } = await client.query<PayoutRowDb>(
        `SELECT id, run_id, request_hash FROM commission_settlement_payouts
          WHERE business_id = $1 AND idempotency_key = $2`,
        [businessId, idempotencyKey],
      );
      if (rows[0]) {
        if (rows[0].run_id !== runId || rows[0].request_hash !== requestHash) {
          throw new CommissionSettlementError("idempotency_key_conflict", 409);
        }
        return {
          run: await loadRunDetail(clientRunner(client), businessId, runId, actor.permissions),
          payout: await loadPayout(clientRunner(client), businessId, rows[0].id),
          replayed: true,
        };
      }
    }

    assertAction(run, "pay", actor);
    const today = await businessToday(businessId);
    const paidDate = input.paidDate ?? today;
    if (paidDate > today) throw new CommissionSettlementError("paid_date_in_future", 400);

    const account = await resolvePayoutAccount(client, businessId, {
      method: input.method ?? "bank",
      paymentAccountId: input.paymentAccountId,
    });
    const owed = await outstandingByEmployee(client, businessId, runId);
    const plan = planAllocations(
      new Map([...owed].map(([id, entry]) => [id, entry.outstanding])),
      input.allocations,
    );

    const payoutId = randomUUID();
    const accounts = await accountIdsByCode(client, businessId, [WELL_KNOWN_CODES.salariesPayable]);
    const entryId = await postExactJournalEntry(client, {
      businessId,
      locationId: null,
      entryDate: paidDate,
      memo: `پرداخت پورسانت — دورهٔ شماره ${run.run_number}`,
      sourceType: "commission_payout",
      sourceId: payoutId,
      createdBy: actor.userId,
      postingKind: "commission_payout",
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.salariesPayable)!, debit: asRial(plan.total), credit: "0" as RialText },
        { accountId: account.accountId, debit: "0" as RialText, credit: asRial(plan.total) },
      ],
    });

    await client.query(
      `INSERT INTO commission_settlement_payouts
         (id, business_id, run_id, kind, amount, payment_account_id, payment_method, paid_date, memo,
          idempotency_key, request_hash, entry_id, created_by)
       VALUES ($1, $2, $3, 'payout', $4, $5, $6, $7::date, $8, $9, $10, $11, $12)`,
      [
        payoutId,
        businessId,
        runId,
        plan.total.toString(),
        account.accountId,
        account.method,
        paidDate,
        input.memo,
        idempotencyKey,
        requestHash,
        entryId,
        actor.userId,
      ],
    );
    for (const item of plan.items) {
      await client.query(
        `INSERT INTO commission_settlement_allocations
           (business_id, payout_id, run_id, employee_id, employee_name, amount)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [businessId, payoutId, runId, item.employeeId, owed.get(item.employeeId)!.name, item.amount.toString()],
      );
    }

    const paidTotal = BigInt(run.paid_total) + plan.total;
    const status = statusForPaidTotal(paidTotal, BigInt(run.commission_total));
    await client.query(
      `UPDATE commission_settlement_runs
          SET paid_total = $2, status = $3,
              paid_at = CASE WHEN $3::text = 'paid' THEN now() ELSE paid_at END,
              updated_at = now()
        WHERE id = $1`,
      [runId, paidTotal.toString(), status],
    );
    const name = await actorName(client, businessId, actor.userId);
    await recordEvent(client, {
      businessId,
      runId,
      action: "payout",
      fromStatus: run.status,
      toStatus: status,
      payoutId,
      actor,
      actorName: name,
      note: input.memo,
      details: { amount: plan.total.toString(), employees: plan.items.length, method: account.method },
    });
    // #869: the business-wide sync event, in this transaction. It is written before the
    // audit row so that a failure after it rolls the event back with the payout.
    await appendBusinessSyncOutboxEvent(client, {
      businessId,
      clientEventId: `commission.payout:${payoutId}`,
      eventType: "commission.payout.recorded",
      payload: {
        payoutId,
        runId,
        runNumber: run.run_number,
        amount: plan.total.toString(),
        paidDate,
        method: account.method,
        entryId,
        allocations: plan.items.map((item) => ({ employeeId: item.employeeId, amount: item.amount.toString() })),
      },
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    await writeAudit(client, {
      businessId,
      userId: actor.userId,
      action: "commission.payout.recorded",
      entity: "commission_payout",
      entityId: payoutId,
      payload: { runId, runNumber: run.run_number, amount: plan.total.toString(), employees: plan.items.length },
    });
    return {
      run: await loadRunDetail(clientRunner(client), businessId, runId, actor.permissions),
      payout: await loadPayout(clientRunner(client), businessId, payoutId),
      replayed: false,
    };
  });
}

/**
 * Undo a payout with a mirror journal entry and a reversal document. The
 * allocations are negated, so each member's outstanding goes back up by exactly
 * what was paid to them. A payout can be reversed once; the run must still be
 * open (not closed).
 */
export async function reverseCommissionPayout(
  businessId: string,
  actor: CommissionActor,
  payoutId: string,
  note: string | null,
): Promise<{ run: CommissionRunDetail; reversal: CommissionPayout; replayed: boolean }> {
  if (!isUuid(payoutId)) throw new CommissionSettlementError("payout_not_found", 404);
  return inTransaction(async (client) => {
    const { rows } = await client.query<PayoutRowDb>(
      `SELECT id, run_id, kind, reverses_payout_id, amount::text AS amount, payment_account_id, payment_method,
              paid_date::text AS paid_date, memo, entry_id, ${isoTs("created_at")} AS created_at
         FROM commission_settlement_payouts WHERE business_id = $1 AND id = $2`,
      [businessId, payoutId],
    );
    const payout = rows[0];
    if (!payout) throw new CommissionSettlementError("payout_not_found", 404);
    if (payout.kind !== "payout") throw new CommissionSettlementError("payout_not_reversible", 409);

    const run = await lockRun(client, businessId, payout.run_id);
    const { rows: existing } = await client.query<{ id: string }>(
      "SELECT id FROM commission_settlement_payouts WHERE business_id = $1 AND reverses_payout_id = $2",
      [businessId, payoutId],
    );
    if (existing[0]) {
      return {
        run: await loadRunDetail(clientRunner(client), businessId, run.id, actor.permissions),
        reversal: await loadPayout(clientRunner(client), businessId, existing[0].id),
        replayed: true,
      };
    }

    assertAction(run, "reverse_payout", actor);
    if (!payout.entry_id) throw new CommissionSettlementError("payout_not_reversible", 409);
    const today = await businessToday(businessId);
    const reversalId = randomUUID();
    const entryId = await postExactMirrorEntry(client, {
      businessId,
      locationId: null,
      originalEntryId: payout.entry_id,
      sourceType: "commission_payout_reversal",
      sourceId: reversalId,
      postingKind: "commission_payout_reversal",
      memo: `ابطال پرداخت پورسانت — دورهٔ شماره ${run.run_number}`,
      createdBy: actor.userId,
      entryDate: today,
    });

    await client.query(
      `INSERT INTO commission_settlement_payouts
         (id, business_id, run_id, kind, reverses_payout_id, amount, payment_account_id, payment_method, paid_date,
          memo, entry_id, created_by)
       VALUES ($1, $2, $3, 'reversal', $4, $5, $6, $7, $8::date, $9, $10, $11)`,
      [
        reversalId,
        businessId,
        run.id,
        payoutId,
        payout.amount,
        payout.payment_account_id,
        payout.payment_method,
        today,
        note,
        entryId,
        actor.userId,
      ],
    );
    await client.query(
      `INSERT INTO commission_settlement_allocations
         (business_id, payout_id, run_id, employee_id, employee_name, amount)
       SELECT business_id, $2, run_id, employee_id, employee_name, -amount
         FROM commission_settlement_allocations
        WHERE business_id = $1 AND payout_id = $3`,
      [businessId, reversalId, payoutId],
    );

    const paidTotal = BigInt(run.paid_total) - BigInt(payout.amount);
    const status = statusForPaidTotal(paidTotal, BigInt(run.commission_total));
    await client.query(
      `UPDATE commission_settlement_runs
          SET paid_total = $2, status = $3,
              paid_at = CASE WHEN $3::text = 'paid' THEN paid_at ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [run.id, paidTotal.toString(), status],
    );
    const name = await actorName(client, businessId, actor.userId);
    await recordEvent(client, {
      businessId,
      runId: run.id,
      action: "payout_reversal",
      fromStatus: run.status,
      toStatus: status,
      payoutId: reversalId,
      actor,
      actorName: name,
      note,
      details: { reversedPayoutId: payoutId, amount: payout.amount },
    });
    await appendBusinessSyncOutboxEvent(client, {
      businessId,
      clientEventId: `commission.payout.reversed:${reversalId}`,
      eventType: "commission.payout.reversed",
      payload: {
        reversalId,
        reversedPayoutId: payoutId,
        runId: run.id,
        runNumber: run.run_number,
        amount: payout.amount,
        entryId,
      },
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    await writeAudit(client, {
      businessId,
      userId: actor.userId,
      action: "commission.payout.reversed",
      entity: "commission_payout",
      entityId: reversalId,
      payload: { reversedPayoutId: payoutId, runId: run.id, amount: payout.amount },
    });
    return {
      run: await loadRunDetail(clientRunner(client), businessId, run.id, actor.permissions),
      reversal: await loadPayout(clientRunner(client), businessId, reversalId),
      replayed: false,
    };
  });
}
