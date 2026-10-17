/**
 * Accounting-owned shareholder register, capital movements and distribution
 * workflow (issue #864).
 *
 * Parties remain canonical identity; this module records dated ownership facts
 * and source documents only. All cash/equity balances and GL reconciliation are
 * projections of attributed journal lines. Financial rows are immutable and a
 * correction always creates a new mirror journal entry.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Role } from "./auth";
import { businessToday } from "./business-day-service";
import { deploymentRole } from "./deployment-role";
import { isValidIsoDate } from "./jalali";
import { appendBusinessSyncOutboxEvent } from "./sync-outbox";
import { accountIdsByCode, postExactJournalEntry, postExactMirrorEntry } from "./ledger-service";
import { inSnapshot, inTransaction } from "./payroll-db";
import { PERMISSIONS } from "./permissions";
import { toLatinDigits } from "./digits";
import type { RialText } from "./inventory-exact";
import {
  allocateRialByWeight,
  closingEntryProfitRial,
  formatOwnershipPercent,
  ownershipSnapshotIsComplete,
  parseNonNegativeRial,
  parseOwnershipPercent,
  parsePositiveRial,
  SHAREHOLDER_ACCOUNT_CODES,
  validateOwnershipTimeline,
  projectDistributionFinancials,
  projectFiscalYearDistributions,
  summarizeDistributionFinancials,
  type DistributionFinancialFact,
  type DistributionFinancialSummary,
  type OwnershipEventType,
  type OwnershipTimelineEvent,
  type OwnershipTotalPolicy,
} from "./shareholder-accounting";

export class ShareholderError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ShareholderError";
  }
}

export interface ShareholderActor {
  userId: string;
  role: Role;
  permissions: ReadonlySet<string>;
}

export interface OwnershipChangeInput {
  partyId: string;
  eventType: OwnershipEventType;
  effectiveOn: string;
  ownershipPercent: string;
  shareUnits?: string | null;
  transferPercent?: string | null;
  transferGroupId?: string | null;
  reason: string;
  sourceReference?: string | null;
  notes?: string | null;
}

export interface CapitalMovementInput {
  partyId: string;
  eventType: "capital_contribution" | "capital_withdrawal";
  capitalClass: "equity" | "additional_paid_in_capital" | "shareholder_loan";
  amountRial: string;
  paymentAccountId: string;
  effectiveOn: string;
  sourceReference?: string | null;
  reason: string;
  notes?: string | null;
}

export interface CreateDistributionInput {
  fiscalYearId: string;
  snapshotOn: string;
  taxAdjustmentRial: string;
  reserveAdjustmentRial: string;
  manualAdjustmentRial: string;
  adjustmentReason?: string | null;
  sourceReference?: string | null;
}

export interface DistributionPaymentInput {
  shareholderId: string;
  amountRial: string;
  paidOn: string;
  paymentAccountId: string;
  note?: string | null;
}

export interface ShareholderRegisterRow {
  shareholderId: string;
  partyId: string;
  partyName: string;
  partyRole: string | null;
  active: boolean;
  ownershipPercent: string;
  shareUnits: string | null;
  effectiveFrom: string | null;
  createdAt: string;
}

export interface ShareholderEventRow {
  id: string;
  shareholderId: string;
  partyId: string;
  partyName: string;
  eventType: string;
  effectiveOn: string;
  ownershipPercent: string | null;
  shareUnits: string | null;
  transferPercent: string | null;
  transferGroupId: string | null;
  capitalClass: string | null;
  amountRial: string | null;
  paymentAccountId: string | null;
  paymentAccountName: string | null;
  journalEntryId: string | null;
  journalVoucher: string | null;
  reversesEventId: string | null;
  isReversed: boolean;
  reason: string | null;
  sourceReference: string | null;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ShareholderDistributionRow {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  closingEntryId: string;
  snapshotOn: string;
  sourceProfitRial: string;
  taxAdjustmentRial: string;
  reserveAdjustmentRial: string;
  manualAdjustmentRial: string;
  adjustmentReason: string | null;
  distributableRial: string;
  status: string;
  postingEntryId: string | null;
  reversalEntryId: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  approvedByName: string | null;
  approvedAt: string | null;
  postedByName: string | null;
  postedAt: string | null;
  reversedByName: string | null;
  reversedAt: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  paidRial: string;
  outstandingRial: string;
}

export interface ShareholderDistributionLineRow {
  distributionId: string;
  shareholderId: string;
  partyId: string;
  partyName: string;
  ownershipPercent: string;
  shareUnits: string | null;
  allocatedRial: string;
  paidRial: string;
  outstandingRial: string;
}

export interface ShareholderPaymentRow {
  id: string;
  distributionId: string;
  shareholderId: string;
  partyId: string;
  partyName: string;
  paymentType: "payment" | "reversal";
  paidOn: string;
  amountRial: string;
  paymentAccountId: string;
  paymentAccountName: string;
  journalEntryId: string;
  journalVoucher: string | null;
  reversesPaymentId: string | null;
  isReversed: boolean;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ShareholderGlReconciliationRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  isContra: boolean;
  debitRial: string;
  creditRial: string;
  ledgerBalanceRial: string;
  attributedBalanceRial: string;
  unattributedBalanceRial: string;
}

export interface ShareholderBalanceRow {
  shareholderId: string;
  partyId: string;
  partyName: string;
  capitalRial: string;
  additionalPaidInCapitalRial: string;
  withdrawalsRial: string;
  shareholderLoanRial: string;
  distributionsPayableRial: string;
}

export interface ClosedFiscalYearOption {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  closedAt: string | null;
  closingEntryId: string | null;
  closingProfitRial: string;
}

export interface ShareholderFiscalYearReconciliationRow extends DistributionFinancialSummary {
  fiscalYearId: string;
  fiscalYearLabel: string;
  closingEntryId: string;
  sourceProfitRial: string;
  glDistributedRial: string;
  undistributedRetainedProfitRial: string;
  availableToAllocateRial: string;
  glUnpaidRial: string;
  distributionVarianceRial: string;
  payableVarianceRial: string;
}

export interface ShareholderWorkspace {
  today: string;
  asOf: string;
  totalPolicy: OwnershipTotalPolicy;
  register: ShareholderRegisterRow[];
  fiscalYears: ClosedFiscalYearOption[];
  distributionSummary: DistributionFinancialSummary;
  fiscalYearReconciliation: ShareholderFiscalYearReconciliationRow[];
  glReconciliation: ShareholderGlReconciliationRow[];
  shareholderBalances: ShareholderBalanceRow[];
}

export interface ShareholderEventFilters {
  dateFrom?: unknown;
  dateTo?: unknown;
  partyId?: unknown;
  eventType?: unknown;
  category?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export interface ShareholderDistributionFilters {
  fiscalYearId?: unknown;
  status?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export interface ShareholderOffsetPageOptions {
  limit?: unknown;
  offset?: unknown;
}

export interface ShareholderPaymentFilters extends ShareholderEventFilters {
  distributionId?: unknown;
  paymentType?: unknown;
}

export interface ShareholderEventPage {
  events: ShareholderEventRow[];
  totalCount: number;
  netCapitalMovementRial: string;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ShareholderDistributionPage {
  distributions: ShareholderDistributionRow[];
  totalCount: number;
  summary: DistributionFinancialSummary;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ShareholderDistributionLinePage {
  lines: ShareholderDistributionLineRow[];
  totalCount: number;
  totalAllocatedRial: string;
  totalPaidRial: string;
  totalOutstandingRial: string;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export interface ShareholderPaymentPage {
  payments: ShareholderPaymentRow[];
  totalCount: number;
  netPaidRial: string;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ShareholderAccountStatementLine {
  entryId: string;
  voucherNumber: string | null;
  date: string;
  memo: string | null;
  sourceType: string | null;
  partyId: string | null;
  partyName: string | null;
  debitRial: string;
  creditRial: string;
  balanceRial: string;
}

export interface ShareholderAccountStatement {
  accountId: string;
  accountCode: string;
  accountName: string;
  normalBalance: "debit" | "credit";
  partyId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  openingBalanceRial: string;
  lines: ShareholderAccountStatementLine[];
  totalDebitRial: string;
  totalCreditRial: string;
  closingBalanceRial: string;
  totalCount: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

const OWNERSHIP_EVENT_TYPES = new Set<OwnershipEventType>([
  "shareholder_added", "ownership_changed", "shareholder_removed", "ownership_transfer_out", "ownership_transfer_in",
]);
const RECONCILIATION_CODES = [
  SHAREHOLDER_ACCOUNT_CODES.capital,
  SHAREHOLDER_ACCOUNT_CODES.additionalPaidInCapital,
  SHAREHOLDER_ACCOUNT_CODES.withdrawals,
  SHAREHOLDER_ACCOUNT_CODES.shareholderLoans,
  SHAREHOLDER_ACCOUNT_CODES.distributionsPayable,
  SHAREHOLDER_ACCOUNT_CODES.retainedEarnings,
];
const MAX_OWNERSHIP_BATCH = 100;
const MAX_IDEMPOTENCY_KEY = 180;
const ZERO = "0" as RialText;

function requirePermission(actor: ShareholderActor, permission: string): void {
  if (!actor.permissions.has(permission)) {
    throw new ShareholderError("permission_required", 403, { permission });
  }
}

function requireCloudAuthority(): void {
  if (deploymentRole() === "site") throw new ShareholderError("cloud_authoritative_data", 409);
}

function requireDate(value: unknown, field: string): string {
  if (!isValidIsoDate(value)) throw new ShareholderError(`invalid_${field}`, 400);
  return value;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ShareholderError(`invalid_${field}`, 400);
  }
  return value;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ShareholderError(`invalid_${field}`, 400);
  const text = value.trim();
  if (text.length > maximum) throw new ShareholderError(`invalid_${field}`, 400);
  return text || null;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const text = optionalText(value, field, maximum);
  if (!text) throw new ShareholderError(`${field}_required`, 400);
  return text;
}

function normalizeIdempotencyKey(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ShareholderError("idempotency_key_required", 400);
    return null;
  }
  if (typeof value !== "string") throw new ShareholderError("invalid_idempotency_key", 400);
  const key = value.trim();
  if (!key || key.length > MAX_IDEMPOTENCY_KEY || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ShareholderError("invalid_idempotency_key", 400);
  }
  return key;
}

function normalizedShareUnits(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new ShareholderError("invalid_share_units", 400);
  }
  const raw = toLatinDigits(String(value)).trim().replace(/[٬,\s]/g, "");
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(raw)) throw new ShareholderError("invalid_share_units", 400);
  const [whole, fraction] = raw.split(".");
  return fraction ? `${whole}.${fraction.padEnd(6, "0").replace(/0+$/, "") || "0"}` : whole;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function lockShareholderBusiness(client: PoolClient, businessId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`shareholder-accounting:${businessId}`]);
}

async function writeAudit(
  client: PoolClient,
  input: { businessId: string; actorId: string; action: string; entity: string; entityId: string; payload: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.businessId, input.actorId, input.action, input.entity, input.entityId, JSON.stringify(input.payload)],
  );
}

async function writeDistributionEvent(
  client: PoolClient,
  input: { businessId: string; distributionId: string; type: string; actorId: string; payload?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `INSERT INTO shareholder_distribution_events (business_id, distribution_id, event_type, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [input.businessId, input.distributionId, input.type, input.actorId, JSON.stringify(input.payload ?? {})],
  );
}

async function ensureOwnershipPolicy(client: PoolClient, businessId: string): Promise<OwnershipTotalPolicy> {
  const { rows } = await client.query<{ total_policy: OwnershipTotalPolicy }>(
    "SELECT total_policy FROM shareholder_ownership_policies WHERE business_id = $1",
    [businessId],
  );
  return rows[0]?.total_policy ?? "at_most_100";
}

async function readOwnershipEvents(client: PoolClient, businessId: string): Promise<OwnershipTimelineEvent[]> {
  const { rows } = await client.query<{
    party_id: string;
    event_type: OwnershipEventType;
    effective_on: string;
    ownership_percent: string;
    transfer_percent: string | null;
    transfer_group_id: string | null;
  }>(
    `SELECT sa.party_id, e.event_type, e.effective_on::text AS effective_on,
            e.ownership_percent::text AS ownership_percent,
            e.transfer_percent::text AS transfer_percent, e.transfer_group_id
       FROM shareholder_events e
       JOIN shareholder_accounts sa ON sa.business_id = e.business_id AND sa.id = e.shareholder_id
      WHERE e.business_id = $1 AND e.ownership_percent IS NOT NULL
      ORDER BY e.effective_on, e.created_at, e.id`,
    [businessId],
  );
  return rows.map((row) => ({
    partyId: row.party_id,
    eventType: row.event_type,
    effectiveOn: row.effective_on,
    ownershipPercent: row.ownership_percent,
    transferPercent: row.transfer_percent,
    transferGroupId: row.transfer_group_id,
  }));
}

function assertTimelineValid(events: readonly OwnershipTimelineEvent[], policy: OwnershipTotalPolicy): void {
  const failure = validateOwnershipTimeline(events, policy);
  if (failure) throw new ShareholderError(failure.code, 409, failure as unknown as Record<string, unknown>);
}

async function ensureShareholderAccount(
  client: PoolClient,
  input: { businessId: string; partyId: string; actorId: string },
): Promise<{ shareholderId: string; partyName: string }> {
  const existing = await client.query<{ id: string; name: string }>(
    `SELECT sa.id, p.name
       FROM shareholder_accounts sa
       JOIN parties p ON p.id = sa.party_id AND p.business_id = sa.business_id
      WHERE sa.business_id = $1 AND sa.party_id = $2 AND p.merged_into_id IS NULL`,
    [input.businessId, input.partyId],
  );
  if (existing.rows[0]) return { shareholderId: existing.rows[0].id, partyName: existing.rows[0].name };

  const party = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM parties
      WHERE business_id = $1 AND id = $2 AND is_active AND merged_into_id IS NULL`,
    [input.businessId, input.partyId],
  );
  if (!party.rows[0]) throw new ShareholderError("active_party_not_found", 404);
  await client.query(
    `INSERT INTO shareholder_accounts (business_id, party_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, party_id) DO NOTHING`,
    [input.businessId, input.partyId, input.actorId],
  );
  const account = await client.query<{ id: string }>(
    "SELECT id FROM shareholder_accounts WHERE business_id = $1 AND party_id = $2",
    [input.businessId, input.partyId],
  );
  if (!account.rows[0]) throw new ShareholderError("shareholder_register_write_failed", 409);
  return { shareholderId: account.rows[0].id, partyName: party.rows[0].name };
}

interface IdempotencyDbRow {
  id: string;
  idempotency_payload_hash: string | null;
  related_entry_id: string | null;
}

async function existingIdempotencyRow(
  client: PoolClient,
  table: "shareholder_events" | "shareholder_distributions" | "shareholder_distribution_payments",
  businessId: string,
  key: string,
  hash: string,
): Promise<IdempotencyDbRow | null> {
  const { rows } = await client.query<IdempotencyDbRow>(
    `SELECT id, idempotency_payload_hash, ${table === "shareholder_events" ? "journal_entry_id" : table === "shareholder_distributions" ? "posting_entry_id" : "journal_entry_id"} AS related_entry_id
       FROM ${table}
      WHERE business_id = $1 AND idempotency_key = $2
      FOR UPDATE`,
    [businessId, key],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.idempotency_payload_hash !== hash) throw new ShareholderError("idempotency_key_conflict", 409);
  return row;
}

async function assertRetroactiveDate(
  actor: ShareholderActor,
  effectiveOn: string,
  today: string,
  entity: string,
): Promise<void> {
  if (effectiveOn >= today) return;
  if (!actor.permissions.has(PERMISSIONS.shareholdersRetroactive)) {
    throw new ShareholderError("retroactive_permission_required", 403, { permission: PERMISSIONS.shareholdersRetroactive });
  }
  if (!entity.trim()) throw new ShareholderError("retroactive_reason_required", 400);
}

function eventBefore(events: readonly OwnershipTimelineEvent[], partyId: string, effectiveOn: string): string {
  const previous = events
    .filter((event) => event.partyId === partyId && event.effectiveOn < effectiveOn)
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn))[0];
  return previous ? String(previous.ownershipPercent) : "0";
}

async function loadOwnershipSnapshot(
  client: PoolClient,
  businessId: string,
  asOf: string,
): Promise<Array<{ shareholderId: string; partyId: string; partyName: string; partyRole: string | null; ownershipPercent: string; shareUnits: string | null; effectiveOn: string | null; createdAt: string }>> {
  const { rows } = await client.query<{
    shareholder_id: string;
    party_id: string;
    party_name: string;
    party_role: string | null;
    ownership_percent: string;
    share_units: string | null;
    effective_on: string | null;
    created_at: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (e.shareholder_id)
              e.shareholder_id, e.ownership_percent::text AS ownership_percent,
              e.share_units::text AS share_units, e.effective_on::text AS effective_on
         FROM shareholder_events e
        WHERE e.business_id = $1 AND e.ownership_percent IS NOT NULL AND e.effective_on <= $2::date
        ORDER BY e.shareholder_id, e.effective_on DESC, e.created_at DESC, e.id DESC
     )
     SELECT sa.id AS shareholder_id, sa.party_id, p.name AS party_name, p.role AS party_role,
            COALESCE(latest.ownership_percent, '0') AS ownership_percent,
            latest.share_units, latest.effective_on, sa.created_at::text AS created_at
       FROM shareholder_accounts sa
       JOIN parties p ON p.id = sa.party_id AND p.business_id = sa.business_id
       LEFT JOIN latest ON latest.shareholder_id = sa.id
      WHERE sa.business_id = $1
      ORDER BY p.name, sa.party_id`,
    [businessId, asOf],
  );
  return rows.map((row) => ({
    shareholderId: row.shareholder_id,
    partyId: row.party_id,
    partyName: row.party_name,
    partyRole: row.party_role,
    ownershipPercent: row.ownership_percent,
    shareUnits: row.share_units,
    effectiveOn: row.effective_on,
    createdAt: row.created_at,
  }));
}

function normalBalance(type: string, contra: boolean): "debit" | "credit" {
  if (contra) return type === "asset" || type === "expense" ? "credit" : "debit";
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

function accountBalance(debit: bigint, credit: bigint, normal: "debit" | "credit"): bigint {
  return normal === "debit" ? debit - credit : credit - debit;
}

async function loadReconciliation(client: PoolClient, businessId: string): Promise<{
  glReconciliation: ShareholderGlReconciliationRow[];
  shareholderBalances: ShareholderBalanceRow[];
}> {
  const { rows } = await client.query<{
    account_id: string;
    code: string;
    name: string;
    type: string;
    is_contra: boolean;
    debit_rial: string;
    credit_rial: string;
    attributed_debit_rial: string;
    attributed_credit_rial: string;
  }>(
    `SELECT a.id AS account_id, a.code, a.name, a.type::text AS type, a.is_contra,
            COALESCE(SUM(jl.debit), 0)::text AS debit_rial,
            COALESCE(SUM(jl.credit), 0)::text AS credit_rial,
            COALESCE(SUM(jl.debit) FILTER (WHERE sa.id IS NOT NULL), 0)::text AS attributed_debit_rial,
            COALESCE(SUM(jl.credit) FILTER (WHERE sa.id IS NOT NULL), 0)::text AS attributed_credit_rial
       FROM accounts a
       LEFT JOIN journal_entries je ON je.business_id = a.business_id
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id AND jl.account_id = a.id
       LEFT JOIN shareholder_accounts sa ON sa.business_id = a.business_id AND sa.party_id = jl.party_id
      WHERE a.business_id = $1 AND a.code = ANY($2::text[])
      GROUP BY a.id, a.code, a.name, a.type, a.is_contra
      ORDER BY a.code`,
    [businessId, RECONCILIATION_CODES],
  );
  const glReconciliation = rows.map((row) => {
    const debit = BigInt(row.debit_rial);
    const credit = BigInt(row.credit_rial);
    const attributedDebit = BigInt(row.attributed_debit_rial);
    const attributedCredit = BigInt(row.attributed_credit_rial);
    const normal = normalBalance(row.type, row.is_contra);
    const ledger = accountBalance(debit, credit, normal);
    const attributed = accountBalance(attributedDebit, attributedCredit, normal);
    return {
      accountId: row.account_id,
      accountCode: row.code,
      accountName: row.name,
      accountType: row.type,
      isContra: row.is_contra,
      debitRial: debit.toString(),
      creditRial: credit.toString(),
      ledgerBalanceRial: ledger.toString(),
      attributedBalanceRial: attributed.toString(),
      unattributedBalanceRial: (ledger - attributed).toString(),
    };
  });

  const { rows: partyRows } = await client.query<{
    shareholder_id: string;
    party_id: string;
    party_name: string;
    account_code: string;
    debit_rial: string;
    credit_rial: string;
  }>(
    `SELECT sa.id AS shareholder_id, sa.party_id, p.name AS party_name,
            a.code AS account_code, SUM(jl.debit)::text AS debit_rial, SUM(jl.credit)::text AS credit_rial
       FROM shareholder_accounts sa
       JOIN parties p ON p.id = sa.party_id AND p.business_id = sa.business_id
       JOIN journal_entries je ON je.business_id = sa.business_id
       JOIN journal_lines jl ON jl.entry_id = je.id AND jl.party_id = sa.party_id
       JOIN accounts a ON a.id = jl.account_id AND a.business_id = sa.business_id
      WHERE sa.business_id = $1 AND a.code = ANY($2::text[])
      GROUP BY sa.id, sa.party_id, p.name, a.code`,
    [businessId, RECONCILIATION_CODES],
  );
  const byShareholder = new Map<string, ShareholderBalanceRow>();
  for (const row of partyRows) {
    const holder = byShareholder.get(row.shareholder_id) ?? {
      shareholderId: row.shareholder_id,
      partyId: row.party_id,
      partyName: row.party_name,
      capitalRial: "0",
      additionalPaidInCapitalRial: "0",
      withdrawalsRial: "0",
      shareholderLoanRial: "0",
      distributionsPayableRial: "0",
    };
    const debit = BigInt(row.debit_rial);
    const credit = BigInt(row.credit_rial);
    const balance = row.account_code === SHAREHOLDER_ACCOUNT_CODES.withdrawals ? debit - credit : credit - debit;
    if (row.account_code === SHAREHOLDER_ACCOUNT_CODES.capital) holder.capitalRial = balance.toString();
    if (row.account_code === SHAREHOLDER_ACCOUNT_CODES.additionalPaidInCapital) holder.additionalPaidInCapitalRial = balance.toString();
    if (row.account_code === SHAREHOLDER_ACCOUNT_CODES.withdrawals) holder.withdrawalsRial = balance.toString();
    if (row.account_code === SHAREHOLDER_ACCOUNT_CODES.shareholderLoans) holder.shareholderLoanRial = balance.toString();
    if (row.account_code === SHAREHOLDER_ACCOUNT_CODES.distributionsPayable) holder.distributionsPayableRial = balance.toString();
    byShareholder.set(row.shareholder_id, holder);
  }
  return { glReconciliation, shareholderBalances: [...byShareholder.values()].sort((a, b) => a.partyName.localeCompare(b.partyName)) };
}

export async function loadDistributionDetail(
  client: PoolClient,
  businessId: string,
  distributionId: string,
): Promise<ShareholderDistributionRow | null> {
  const { rows } = await client.query<ShareholderDistributionRow>(
    `SELECT d.id, d.fiscal_year_id AS "fiscalYearId", fy.label AS "fiscalYearLabel",
            d.closing_entry_id AS "closingEntryId", d.snapshot_on::text AS "snapshotOn",
            d.source_profit_rial::text AS "sourceProfitRial",
            d.tax_adjustment_rial::text AS "taxAdjustmentRial",
            d.reserve_adjustment_rial::text AS "reserveAdjustmentRial",
            d.manual_adjustment_rial::text AS "manualAdjustmentRial",
            d.adjustment_reason AS "adjustmentReason", d.distributable_rial::text AS "distributableRial",
            d.status, d.posting_entry_id AS "postingEntryId", d.reversal_entry_id AS "reversalEntryId",
            d.created_by AS "createdById", creator.full_name AS "createdByName", d.created_at::text AS "createdAt",
            approver.full_name AS "approvedByName", d.approved_at::text AS "approvedAt",
            poster.full_name AS "postedByName", d.posted_at::text AS "postedAt",
            reverser.full_name AS "reversedByName", d.reversed_at::text AS "reversedAt",
            canceller.full_name AS "cancelledByName", d.cancelled_at::text AS "cancelledAt",
            d.cancel_reason AS "cancelReason",
            COALESCE(payments.paid_rial, '0') AS "paidRial",
            '0'::text AS "outstandingRial"
       FROM shareholder_distributions d
       JOIN fiscal_years fy ON fy.id = d.fiscal_year_id AND fy.business_id = d.business_id
       LEFT JOIN users creator ON creator.id = d.created_by
       LEFT JOIN users approver ON approver.id = d.approved_by
       LEFT JOIN users poster ON poster.id = d.posted_by
       LEFT JOIN users reverser ON reverser.id = d.reversed_by
       LEFT JOIN users canceller ON canceller.id = d.cancelled_by
       LEFT JOIN LATERAL (
         SELECT SUM(CASE WHEN payment_type = 'payment' THEN amount_rial ELSE -amount_rial END)::text AS paid_rial
           FROM shareholder_distribution_payments
          WHERE distribution_id = d.id AND business_id = d.business_id
       ) payments ON true
      WHERE d.business_id = $1 AND d.id = $2`,
    [businessId, distributionId],
  );
  const row = rows[0];
  if (!row) return null;
  const projection = projectDistributionFinancials(row.status, row.distributableRial, row.paidRial);
  return { ...row, paidRial: projection.paidRial, outstandingRial: projection.outstandingRial };
}

interface DistributionPostingLine {
  shareholderId: string;
  partyId: string;
  allocatedRial: string;
}

/**
 * Posting consumes every frozen allocation fact. Presentation pages have their
 * own bounded reader; this financial path deliberately has no row cap.
 */
async function loadAllDistributionLinesForPosting(
  client: PoolClient,
  businessId: string,
  distributionId: string,
): Promise<DistributionPostingLine[]> {
  const { rows } = await client.query<DistributionPostingLine>(
    `SELECT dl.shareholder_id AS "shareholderId", dl.party_id AS "partyId",
            dl.allocated_rial::text AS "allocatedRial"
       FROM shareholder_distribution_lines dl
      WHERE dl.business_id = $1 AND dl.distribution_id = $2
      ORDER BY dl.shareholder_id`,
    [businessId, distributionId],
  );
  return rows;
}

async function loadDistributionStatusFacts(
  client: PoolClient,
  businessId: string,
  fiscalYearId?: string,
): Promise<DistributionFinancialFact[]> {
  const { rows } = await client.query<{
    status: string;
    distribution_count: string;
    distributable_rial: string;
    net_paid_rial: string;
  }>(
    `SELECT d.status, COUNT(*)::text AS distribution_count,
            COALESCE(SUM(d.distributable_rial), 0)::text AS distributable_rial,
            COALESCE(SUM(payments.net_paid_rial::numeric), 0)::text AS net_paid_rial
       FROM shareholder_distributions d
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN pmt.payment_type = 'payment' THEN pmt.amount_rial ELSE -pmt.amount_rial END), 0)::text AS net_paid_rial
           FROM shareholder_distribution_payments pmt
          WHERE pmt.business_id = d.business_id AND pmt.distribution_id = d.id
       ) payments ON true
      WHERE d.business_id = $1 AND ($2::uuid IS NULL OR d.fiscal_year_id = $2)
      GROUP BY d.status`,
    [businessId, fiscalYearId ?? null],
  );
  return rows.map((row) => ({
    status: row.status,
    count: Number(row.distribution_count),
    distributableRial: row.distributable_rial,
    netPaidRial: row.net_paid_rial,
  }));
}

async function loadFiscalYearReconciliation(
  client: PoolClient,
  businessId: string,
  fiscalYears: readonly ClosedFiscalYearOption[],
): Promise<ShareholderFiscalYearReconciliationRow[]> {
  const closedYears = fiscalYears.filter((year) => year.closedAt && year.closingEntryId);
  if (closedYears.length === 0) return [];
  const [factsResult, glResult] = await Promise.all([
    client.query<{
      fiscal_year_id: string;
      status: string;
      distribution_count: string;
      distributable_rial: string;
      net_paid_rial: string;
    }>(
      `SELECT d.fiscal_year_id, d.status, COUNT(*)::text AS distribution_count,
              COALESCE(SUM(d.distributable_rial), 0)::text AS distributable_rial,
              COALESCE(SUM(payments.net_paid_rial::numeric), 0)::text AS net_paid_rial
         FROM shareholder_distributions d
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(CASE WHEN pmt.payment_type = 'payment' THEN pmt.amount_rial ELSE -pmt.amount_rial END), 0)::text AS net_paid_rial
             FROM shareholder_distribution_payments pmt
            WHERE pmt.business_id = d.business_id AND pmt.distribution_id = d.id
         ) payments ON true
        WHERE d.business_id = $1
        GROUP BY d.fiscal_year_id, d.status`,
      [businessId],
    ),
    client.query<{
      fiscal_year_id: string;
      gl_distributed_rial: string;
      gl_unpaid_rial: string;
    }>(
      `WITH distribution_entries AS (
         SELECT d.fiscal_year_id, d.id AS distribution_id, d.posting_entry_id AS entry_id, 'distribution'::text AS entry_kind
           FROM shareholder_distributions d
          WHERE d.business_id = $1 AND d.posting_entry_id IS NOT NULL
         UNION ALL
         SELECT d.fiscal_year_id, d.id AS distribution_id, d.reversal_entry_id AS entry_id, 'distribution'::text AS entry_kind
           FROM shareholder_distributions d
          WHERE d.business_id = $1 AND d.reversal_entry_id IS NOT NULL
         UNION ALL
         SELECT d.fiscal_year_id, d.id AS distribution_id, pmt.journal_entry_id AS entry_id, 'payment'::text AS entry_kind
           FROM shareholder_distributions d
           JOIN shareholder_distribution_payments pmt
             ON pmt.business_id = d.business_id AND pmt.distribution_id = d.id
          WHERE d.business_id = $1
       )
       SELECT de.fiscal_year_id,
              COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE de.entry_kind = 'distribution' AND a.code = $2), 0)::text AS gl_distributed_rial,
              COALESCE(SUM(jl.credit - jl.debit) FILTER (WHERE a.code = $3), 0)::text AS gl_unpaid_rial
         FROM distribution_entries de
         JOIN journal_entries je ON je.id = de.entry_id AND je.business_id = $1
         JOIN journal_lines jl ON jl.entry_id = je.id
         JOIN accounts a ON a.id = jl.account_id AND a.business_id = je.business_id
        GROUP BY de.fiscal_year_id`,
      [businessId, SHAREHOLDER_ACCOUNT_CODES.retainedEarnings, SHAREHOLDER_ACCOUNT_CODES.distributionsPayable],
    ),
  ]);
  const factsByYear = new Map<string, DistributionFinancialFact[]>();
  for (const row of factsResult.rows) {
    const facts = factsByYear.get(row.fiscal_year_id) ?? [];
    facts.push({
      status: row.status,
      count: Number(row.distribution_count),
      distributableRial: row.distributable_rial,
      netPaidRial: row.net_paid_rial,
    });
    factsByYear.set(row.fiscal_year_id, facts);
  }
  const glByYear = new Map(glResult.rows.map((row) => [row.fiscal_year_id, row]));
  return closedYears.map((year) => {
    const gl = glByYear.get(year.id);
    return {
      fiscalYearId: year.id,
      fiscalYearLabel: year.label,
      closingEntryId: year.closingEntryId!,
      ...projectFiscalYearDistributions({
        sourceProfitRial: year.closingProfitRial,
        glDistributedRial: gl?.gl_distributed_rial ?? "0",
        glUnpaidRial: gl?.gl_unpaid_rial ?? "0",
        facts: factsByYear.get(year.id) ?? [],
      }),
    };
  });
}

export async function loadShareholderWorkspace(
  businessId: string,
  requestedAsOf?: string | null,
): Promise<ShareholderWorkspace> {
  const today = await businessToday(businessId);
  const asOf = requestedAsOf ? requireDate(requestedAsOf, "as_of") : today;
  return inSnapshot(async (client) => {
    const policy = await ensureOwnershipPolicy(client, businessId);
    const snapshot = await loadOwnershipSnapshot(client, businessId, asOf);
    const fiscalYearsResult = await client.query<ClosedFiscalYearOption>(
      `SELECT fy.id, fy.label, fy.starts_on::text AS "startsOn", fy.ends_on::text AS "endsOn",
              fy.closed_at::text AS "closedAt", close_entry.id AS "closingEntryId",
              GREATEST(COALESCE(close_entry.credit_rial, '0')::numeric - COALESCE(close_entry.debit_rial, '0')::numeric, 0)::text AS "closingProfitRial"
         FROM fiscal_years fy
         LEFT JOIN LATERAL (
           SELECT je.id, COALESCE(SUM(jl.credit) FILTER (WHERE a.code = $2), 0)::text AS credit_rial,
                  COALESCE(SUM(jl.debit) FILTER (WHERE a.code = $2), 0)::text AS debit_rial
             FROM journal_entries je
             LEFT JOIN journal_lines jl ON jl.entry_id = je.id
             LEFT JOIN accounts a ON a.id = jl.account_id AND a.business_id = je.business_id
            WHERE je.business_id = fy.business_id AND je.source_type = 'closing' AND je.source_id = fy.id
            GROUP BY je.id
            ORDER BY je.entry_date DESC, je.posted_at DESC
            LIMIT 1
         ) close_entry ON true
        WHERE fy.business_id = $1
        ORDER BY fy.starts_on DESC`,
      [businessId, SHAREHOLDER_ACCOUNT_CODES.retainedEarnings],
    );
    const distributionFacts = await loadDistributionStatusFacts(client, businessId);
    const fiscalYearReconciliation = await loadFiscalYearReconciliation(client, businessId, fiscalYearsResult.rows);
    const reconciliation = await loadReconciliation(client, businessId);

    return {
      today,
      asOf,
      totalPolicy: policy,
      register: snapshot.map((row) => ({
        shareholderId: row.shareholderId,
        partyId: row.partyId,
        partyName: row.partyName,
        partyRole: row.partyRole,
        active: (parseOwnershipPercent(row.ownershipPercent) ?? 0n) > 0n,
        ownershipPercent: row.ownershipPercent,
        shareUnits: row.shareUnits,
        effectiveFrom: row.effectiveOn,
        createdAt: row.createdAt,
      })),
      fiscalYears: fiscalYearsResult.rows,
      distributionSummary: summarizeDistributionFinancials(distributionFacts),
      fiscalYearReconciliation,
      glReconciliation: reconciliation.glReconciliation,
      shareholderBalances: reconciliation.shareholderBalances,
    };
  });
}

export async function updateOwnershipTotalPolicy(
  businessId: string,
  actor: ShareholderActor,
  policy: OwnershipTotalPolicy,
): Promise<void> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersManage);
  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const events = await readOwnershipEvents(client, businessId);
    // An empty register holds 0%, so "exactly 100%" would be violated the
    // moment it was saved; the timeline check alone has no date to fail on.
    if (policy === "exactly_100" && events.length === 0) {
      throw new ShareholderError("ownership_total_must_equal_100", 409);
    }
    assertTimelineValid(events, policy);
    await client.query(
      `INSERT INTO shareholder_ownership_policies (business_id, total_policy, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (business_id) DO UPDATE
         SET total_policy = EXCLUDED.total_policy, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [businessId, policy, actor.userId],
    );
    await writeAudit(client, {
      businessId, actorId: actor.userId, action: "shareholder.ownership_policy.updated",
      entity: "shareholder_ownership_policy", entityId: businessId,
      payload: { totalPolicy: policy },
    });
  });
}

export async function recordOwnershipEvents(
  businessId: string,
  actor: ShareholderActor,
  inputs: readonly OwnershipChangeInput[],
  rawIdempotencyKey?: unknown,
): Promise<{ eventIds: string[]; replayed: boolean }> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersManage);
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_OWNERSHIP_BATCH) {
    throw new ShareholderError("invalid_ownership_events", 400);
  }
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey, false);
  if (idempotencyKey && idempotencyKey.length + 4 > 200) throw new ShareholderError("invalid_idempotency_key", 400);
  const today = await businessToday(businessId);
  const normalized = inputs.map((input, index) => {
    if (!OWNERSHIP_EVENT_TYPES.has(input.eventType)) throw new ShareholderError("invalid_ownership_event_type", 400);
    const partyId = requireUuid(input.partyId, `events.${index}.party_id`);
    const effectiveOn = requireDate(input.effectiveOn, `events.${index}.effective_on`);
    const percentUnits = parseOwnershipPercent(input.ownershipPercent);
    if (percentUnits === null) throw new ShareholderError("invalid_ownership_percent", 400, { index });
    const transferPercent = input.transferPercent ? parseOwnershipPercent(input.transferPercent) : null;
    if (input.eventType.startsWith("ownership_transfer_") && (transferPercent === null || transferPercent <= 0n)) {
      throw new ShareholderError("invalid_transfer_percent", 400, { index });
    }
    if (!input.eventType.startsWith("ownership_transfer_") && input.transferPercent) {
      throw new ShareholderError("unexpected_transfer_percent", 400, { index });
    }
    const transferGroupId = input.transferGroupId ? requireUuid(input.transferGroupId, `events.${index}.transfer_group_id`) : null;
    if (input.eventType.startsWith("ownership_transfer_") !== Boolean(transferGroupId)) {
      throw new ShareholderError("invalid_transfer_group", 400, { index });
    }
    const reason = requiredText(input.reason, `events.${index}.reason`, 500);
    const sourceReference = optionalText(input.sourceReference, `events.${index}.source_reference`, 120);
    const notes = optionalText(input.notes, `events.${index}.notes`, 2000);
    const shareUnits = normalizedShareUnits(input.shareUnits);
    return {
      partyId, eventType: input.eventType, effectiveOn, ownershipPercent: formatOwnershipPercent(percentUnits),
      transferPercent: transferPercent === null ? null : formatOwnershipPercent(transferPercent),
      transferGroupId, reason, sourceReference, notes, shareUnits,
      request: { partyId, eventType: input.eventType, effectiveOn, ownershipPercent: formatOwnershipPercent(percentUnits), transferPercent: transferPercent === null ? null : formatOwnershipPercent(transferPercent), transferGroupId, reason, sourceReference, notes, shareUnits },
      index,
    };
  });
  for (const row of normalized) await assertRetroactiveDate(actor, row.effectiveOn, today, row.reason);

  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    if (idempotencyKey) {
      const keys = normalized.map((_, index) => `${idempotencyKey}:${index}`);
      const { rows } = await client.query<{ id: string; idempotency_key: string; idempotency_payload_hash: string | null }>(
        `SELECT id, idempotency_key, idempotency_payload_hash FROM shareholder_events
          WHERE business_id = $1 AND idempotency_key = ANY($2::text[]) FOR UPDATE`,
        [businessId, keys],
      );
      if (rows.length > 0) {
        if (rows.length !== normalized.length) throw new ShareholderError("idempotency_key_conflict", 409);
        const byKey = new Map(rows.map((row) => [row.idempotency_key, row]));
        const ids = normalized.map((row, index) => {
          const stored = byKey.get(`${idempotencyKey}:${index}`);
          if (!stored || stored.idempotency_payload_hash !== payloadHash(row.request)) throw new ShareholderError("idempotency_key_conflict", 409);
          return stored.id;
        });
        return { eventIds: ids, replayed: true };
      }
    }

    const policy = await ensureOwnershipPolicy(client, businessId);
    const before = await readOwnershipEvents(client, businessId);
    const newEvents: OwnershipTimelineEvent[] = [];
    const accountsByParty = new Map<string, { shareholderId: string; partyName: string }>();
    for (const row of normalized) {
      let account = accountsByParty.get(row.partyId);
      if (!account) {
        account = await ensureShareholderAccount(client, { businessId, partyId: row.partyId, actorId: actor.userId });
        accountsByParty.set(row.partyId, account);
      }
      newEvents.push({
        partyId: row.partyId, eventType: row.eventType, effectiveOn: row.effectiveOn,
        ownershipPercent: row.ownershipPercent, transferPercent: row.transferPercent, transferGroupId: row.transferGroupId,
      });
    }
    assertTimelineValid([...before, ...newEvents], policy);

    const eventIds: string[] = [];
    for (const row of normalized) {
      const account = accountsByParty.get(row.partyId)!;
      const id = randomUUID();
      const key = idempotencyKey ? `${idempotencyKey}:${row.index}` : null;
      const hash = idempotencyKey ? payloadHash(row.request) : null;
      await client.query(
        `INSERT INTO shareholder_events
           (id, business_id, shareholder_id, event_type, effective_on, ownership_percent,
            share_units, transfer_percent, transfer_group_id, source_reference, reason, notes,
            idempotency_key, idempotency_payload_hash, created_by)
         VALUES ($1, $2, $3, $4, $5::date, $6::numeric, $7::numeric, $8::numeric, $9,
                 $10, $11, $12, $13, $14, $15)`,
        [id, businessId, account.shareholderId, row.eventType, row.effectiveOn, row.ownershipPercent,
          row.shareUnits, row.transferPercent, row.transferGroupId, row.sourceReference, row.reason, row.notes,
          key, hash, actor.userId],
      );
      await writeAudit(client, {
        businessId, actorId: actor.userId, action: "shareholder.ownership_event.recorded",
        entity: "shareholder_event", entityId: id,
        payload: {
          partyId: row.partyId, partyName: account.partyName, eventType: row.eventType,
          effectiveOn: row.effectiveOn, // Earlier rows of this same batch count: an add on date A followed by a
          // change on date B must record A's percentage as B's prior ownership.
          ownershipBefore: eventBefore([...before, ...newEvents], row.partyId, row.effectiveOn),
          ownershipAfter: row.ownershipPercent, transferPercent: row.transferPercent,
          transferGroupId: row.transferGroupId, reason: row.reason, sourceReference: row.sourceReference,
        },
      });
      eventIds.push(id);
    }
    return { eventIds, replayed: false };
  });
}

async function ensureAssetPaymentAccount(
  client: PoolClient,
  businessId: string,
  paymentAccountId: string,
): Promise<{ id: string; code: string; name: string }> {
  const { rows } = await client.query<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM accounts
      WHERE business_id = $1 AND id = $2 AND is_active AND type = 'asset' AND currency_code IS NULL`,
    [businessId, paymentAccountId],
  );
  if (!rows[0]) throw new ShareholderError("invalid_payment_account", 400);
  return rows[0];
}

async function verifyAccountTypes(
  client: PoolClient,
  businessId: string,
  accountsByCode: ReadonlyMap<string, string>,
  expected: Readonly<Record<string, string>>,
): Promise<void> {
  const codes = [...accountsByCode.keys()];
  const { rows } = await client.query<{ code: string; type: string; is_active: boolean }>(
    "SELECT code, type::text AS type, is_active FROM accounts WHERE business_id = $1 AND code = ANY($2::text[])",
    [businessId, codes],
  );
  const found = new Map(rows.map((row) => [row.code, row]));
  for (const [code, type] of Object.entries(expected)) {
    const row = found.get(code);
    if (!row || !row.is_active) throw new ShareholderError("ledger_account_missing", 409, { code });
    if (row.type !== type) throw new ShareholderError("ledger_account_type_mismatch", 409, { code, expected: type, actual: row.type });
  }
}

export async function recordCapitalMovement(
  businessId: string,
  actor: ShareholderActor,
  input: CapitalMovementInput,
  rawIdempotencyKey?: unknown,
): Promise<{ eventId: string; journalEntryId: string; replayed: boolean }> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersCapitalPost);
  requirePermission(actor, PERMISSIONS.ledgerPost);
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey, true)!;
  const partyId = requireUuid(input.partyId, "party_id");
  const eventType = input.eventType;
  if (eventType !== "capital_contribution" && eventType !== "capital_withdrawal") {
    throw new ShareholderError("invalid_capital_event_type", 400);
  }
  const capitalClass = input.capitalClass;
  if (!new Set(["equity", "additional_paid_in_capital", "shareholder_loan"]).has(capitalClass)) {
    throw new ShareholderError("invalid_capital_class", 400);
  }
  const amount = parsePositiveRial(input.amountRial);
  if (amount === null) throw new ShareholderError("invalid_amount_rial", 400);
  const paymentAccountId = requireUuid(input.paymentAccountId, "payment_account_id");
  const effectiveOn = requireDate(input.effectiveOn, "effective_on");
  const reason = requiredText(input.reason, "reason", 500);
  const sourceReference = optionalText(input.sourceReference, "source_reference", 120);
  const notes = optionalText(input.notes, "notes", 2000);
  const today = await businessToday(businessId);
  await assertRetroactiveDate(actor, effectiveOn, today, reason);
  if (effectiveOn > today) throw new ShareholderError("capital_event_date_in_future", 400);
  const normalizedRequest = { partyId, eventType, capitalClass, amountRial: amount.toString(), paymentAccountId, effectiveOn, sourceReference, reason, notes };
  const hash = payloadHash(normalizedRequest);

  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const existing = await existingIdempotencyRow(client, "shareholder_events", businessId, idempotencyKey, hash);
    if (existing) {
      if (!existing.related_entry_id) throw new ShareholderError("idempotency_key_conflict", 409);
      return { eventId: existing.id, journalEntryId: existing.related_entry_id, replayed: true };
    }
    const shareholder = await ensureShareholderAccount(client, { businessId, partyId, actorId: actor.userId });
    const paymentAccount = await ensureAssetPaymentAccount(client, businessId, paymentAccountId);
    let postingCode: string;
    if (capitalClass === "equity") postingCode = SHAREHOLDER_ACCOUNT_CODES.capital;
    else if (capitalClass === "additional_paid_in_capital") postingCode = SHAREHOLDER_ACCOUNT_CODES.additionalPaidInCapital;
    else postingCode = SHAREHOLDER_ACCOUNT_CODES.shareholderLoans;
    const withdrawalCode = capitalClass === "shareholder_loan" ? SHAREHOLDER_ACCOUNT_CODES.shareholderLoans : SHAREHOLDER_ACCOUNT_CODES.withdrawals;
    const ledgerCodes = [...new Set([paymentAccount.code, postingCode, withdrawalCode])];
    const accounts = await accountIdsByCode(client, businessId, ledgerCodes);
    await verifyAccountTypes(client, businessId, accounts, {
      [paymentAccount.code]: "asset",
      [postingCode]: capitalClass === "shareholder_loan" ? "liability" : "equity",
      [withdrawalCode]: capitalClass === "shareholder_loan" ? "liability" : "equity",
    });

    const eventId = randomUUID();
    const amountText = amount.toString() as RialText;
    const memberAccountId = accounts.get(eventType === "capital_contribution" ? postingCode : withdrawalCode)!;
    const cashAccountId = accounts.get(paymentAccount.code)!;
    const journalEntryId = await postExactJournalEntry(client, {
      businessId,
      locationId: null,
      entryDate: effectiveOn,
      memo: reason,
      sourceType: "shareholder_event",
      sourceId: eventId,
      createdBy: actor.userId,
      postingKind: "shareholder_capital",
      idempotencyKey: `shareholder:capital:${idempotencyKey}`,
      lines: eventType === "capital_contribution"
        ? [
            { accountId: cashAccountId, debit: amountText, credit: ZERO },
            { accountId: memberAccountId, debit: ZERO, credit: amountText, partyId },
          ]
        : [
            { accountId: memberAccountId, debit: amountText, credit: ZERO, partyId },
            { accountId: cashAccountId, debit: ZERO, credit: amountText },
          ],
    });
    if (!journalEntryId) throw new ShareholderError("capital_posting_failed", 409);
    await client.query(
      `INSERT INTO shareholder_events
         (id, business_id, shareholder_id, event_type, effective_on, capital_class, amount_rial,
          payment_account_id, journal_entry_id, source_reference, reason, notes,
          idempotency_key, idempotency_payload_hash, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [eventId, businessId, shareholder.shareholderId, eventType, effectiveOn, capitalClass, amount.toString(),
        paymentAccountId, journalEntryId, sourceReference, reason, notes, idempotencyKey, hash, actor.userId],
    );
    await appendBusinessSyncOutboxEvent(client, {
      businessId,
      clientEventId: `shareholder.capital:${eventId}`,
      eventType: "shareholder.capital.recorded",
      payload: { eventId, partyId, eventType, capitalClass, amountRial: amount.toString(), effectiveOn, journalEntryId },
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    await writeAudit(client, {
      businessId, actorId: actor.userId, action: "shareholder.capital.recorded", entity: "shareholder_event", entityId: eventId,
      payload: { partyId, partyName: shareholder.partyName, eventType, capitalClass, amountRial: amount.toString(), paymentAccountId, paymentAccountName: paymentAccount.name, effectiveOn, journalEntryId, reason, sourceReference },
    });
    return { eventId, journalEntryId, replayed: false };
  });
}

export async function reverseCapitalMovement(
  businessId: string,
  actor: ShareholderActor,
  eventIdValue: string,
  rawIdempotencyKey?: unknown,
): Promise<{ eventId: string; journalEntryId: string; replayed: boolean }> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersCapitalReverse);
  requirePermission(actor, PERMISSIONS.ledgerApprove);
  const originalEventId = requireUuid(eventIdValue, "event_id");
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey, true)!;
  const hash = payloadHash({ originalEventId });
  const today = await businessToday(businessId);
  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const existing = await existingIdempotencyRow(client, "shareholder_events", businessId, idempotencyKey, hash);
    if (existing) {
      if (!existing.related_entry_id) throw new ShareholderError("idempotency_key_conflict", 409);
      return { eventId: existing.id, journalEntryId: existing.related_entry_id, replayed: true };
    }
    const { rows } = await client.query<{
      id: string; shareholder_id: string; party_id: string; party_name: string; event_type: string;
      capital_class: string; amount_rial: string; payment_account_id: string; journal_entry_id: string;
      entry_reversed_at: string | null;
    }>(
      `SELECT e.id, e.shareholder_id, sa.party_id, p.name AS party_name, e.event_type,
              e.capital_class, e.amount_rial::text AS amount_rial, e.payment_account_id,
              e.journal_entry_id, je.reversed_at::text AS entry_reversed_at
         FROM shareholder_events e
         JOIN shareholder_accounts sa ON sa.id = e.shareholder_id AND sa.business_id = e.business_id
         JOIN parties p ON p.id = sa.party_id AND p.business_id = e.business_id
         JOIN journal_entries je ON je.id = e.journal_entry_id AND je.business_id = e.business_id
        WHERE e.business_id = $1 AND e.id = $2 AND e.amount_rial IS NOT NULL
          AND e.event_type IN ('capital_contribution', 'capital_withdrawal')
        FOR UPDATE OF e, je`,
      [businessId, originalEventId],
    );
    const original = rows[0];
    if (!original) throw new ShareholderError("capital_event_not_found", 404);
    if (original.entry_reversed_at) throw new ShareholderError("capital_event_already_reversed", 409);
    const priorReversal = await client.query("SELECT 1 FROM shareholder_events WHERE business_id=$1 AND reverses_event_id=$2", [businessId, originalEventId]);
    if (priorReversal.rows.length) throw new ShareholderError("capital_event_already_reversed", 409);
    const reversalId = randomUUID();
    const journalEntryId = await postExactMirrorEntry(client, {
      businessId,
      locationId: null,
      originalEntryId: original.journal_entry_id,
      sourceType: "shareholder_event_reversal",
      sourceId: reversalId,
      postingKind: "shareholder_capital_reversal",
      memo: `برگشت رویداد سرمایه: ${original.party_name}`,
      createdBy: actor.userId,
      entryDate: today,
      idempotencyKey: `shareholder:capital-reversal:${idempotencyKey}`,
    });
    if (!journalEntryId) throw new ShareholderError("capital_reversal_failed", 409);
    await client.query(
      `INSERT INTO shareholder_events
         (id, business_id, shareholder_id, event_type, effective_on, capital_class, amount_rial,
          payment_account_id, journal_entry_id, reverses_event_id, reason,
          idempotency_key, idempotency_payload_hash, created_by)
       VALUES ($1, $2, $3, 'capital_reversal', $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [reversalId, businessId, original.shareholder_id, today, original.capital_class, original.amount_rial,
        original.payment_account_id, journalEntryId, originalEventId, `برگشت رویداد سرمایه ${originalEventId}`, idempotencyKey, hash, actor.userId],
    );
    await appendBusinessSyncOutboxEvent(client, {
      businessId,
      clientEventId: `shareholder.capital-reversal:${reversalId}`,
      eventType: "shareholder.capital.reversed",
      payload: { reversalId, reversedEventId: originalEventId, partyId: original.party_id, amountRial: original.amount_rial, journalEntryId },
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    await writeAudit(client, {
      businessId, actorId: actor.userId, action: "shareholder.capital.reversed", entity: "shareholder_event", entityId: reversalId,
      payload: { reversedEventId: originalEventId, partyId: original.party_id, partyName: original.party_name, amountRial: original.amount_rial, journalEntryId },
    });
    return { eventId: reversalId, journalEntryId, replayed: false };
  });
}

async function closedFiscalYearSource(
  client: PoolClient,
  businessId: string,
  fiscalYearId: string,
): Promise<{ label: string; startsOn: string; endsOn: string; closingEntryId: string; sourceProfit: bigint }> {
  const { rows } = await client.query<{
    label: string; starts_on: string; ends_on: string; closed_at: string | null;
    closing_entry_id: string | null; credit_rial: string; debit_rial: string;
  }>(
    `SELECT fy.label, fy.starts_on::text AS starts_on, fy.ends_on::text AS ends_on, fy.closed_at::text AS closed_at,
            closing.id AS closing_entry_id, COALESCE(closing.credit_rial, '0') AS credit_rial,
            COALESCE(closing.debit_rial, '0') AS debit_rial
       FROM fiscal_years fy
       LEFT JOIN LATERAL (
         SELECT je.id, COALESCE(SUM(jl.credit) FILTER (WHERE a.code = $3), 0)::text AS credit_rial,
                COALESCE(SUM(jl.debit) FILTER (WHERE a.code = $3), 0)::text AS debit_rial
           FROM journal_entries je
           LEFT JOIN journal_lines jl ON jl.entry_id = je.id
           LEFT JOIN accounts a ON a.id = jl.account_id AND a.business_id = je.business_id
          WHERE je.business_id = fy.business_id AND je.source_type = 'closing' AND je.source_id = fy.id
          GROUP BY je.id ORDER BY je.entry_date DESC, je.posted_at DESC LIMIT 1
       ) closing ON true
      WHERE fy.business_id = $1 AND fy.id = $2`,
    [businessId, fiscalYearId, SHAREHOLDER_ACCOUNT_CODES.retainedEarnings],
  );
  const year = rows[0];
  if (!year) throw new ShareholderError("fiscal_year_not_found", 404);
  if (!year.closed_at) throw new ShareholderError("fiscal_year_not_closed", 409);
  if (!year.closing_entry_id) throw new ShareholderError("closing_entry_not_found", 409);
  const sourceProfit = closingEntryProfitRial({ debit: BigInt(year.debit_rial), credit: BigInt(year.credit_rial) });
  if (sourceProfit <= 0n) throw new ShareholderError("no_closed_year_profit", 409);
  if (sourceProfit > 9_223_372_036_854_775_807n) throw new ShareholderError("closed_year_profit_out_of_range", 409);
  return { label: year.label, startsOn: year.starts_on, endsOn: year.ends_on, closingEntryId: year.closing_entry_id, sourceProfit };
}

async function allocationSnapshot(
  client: PoolClient,
  businessId: string,
  snapshotOn: string,
): Promise<Array<{ shareholderId: string; partyId: string; partyName: string; ownershipPercent: string; weight: bigint; shareUnits: string | null }>> {
  const eventStream = await readOwnershipEvents(client, businessId);
  const policy = await ensureOwnershipPolicy(client, businessId);
  assertTimelineValid(eventStream, policy);
  const rows = await loadOwnershipSnapshot(client, businessId, snapshotOn);
  const active = rows.filter((row) => (parseOwnershipPercent(row.ownershipPercent) ?? 0n) > 0n).map((row) => {
    const weight = parseOwnershipPercent(row.ownershipPercent);
    if (weight === null) throw new ShareholderError("invalid_ownership_snapshot", 409);
    return { ...row, weight };
  });
  if (!ownershipSnapshotIsComplete(active)) throw new ShareholderError("distribution_requires_100_percent_ownership", 409, { snapshotOn });
  if (active.some((row) => !row.effectiveOn)) throw new ShareholderError("distribution_requires_ownership_history", 409);
  return active;
}

async function assertDistributionCapacity(
  client: PoolClient,
  input: { businessId: string; fiscalYearId: string; sourceProfit: bigint; amount: bigint; excludeId?: string },
): Promise<void> {
  const { rows } = await client.query<{ reserved: string }>(
    `SELECT COALESCE(SUM(distributable_rial), 0)::text AS reserved
       FROM shareholder_distributions
      WHERE business_id = $1 AND fiscal_year_id = $2
        AND status NOT IN ('cancelled', 'reversed')
        AND ($3::uuid IS NULL OR id <> $3)`,
    [input.businessId, input.fiscalYearId, input.excludeId ?? null],
  );
  const reserved = BigInt(rows[0]?.reserved ?? "0");
  const available = input.sourceProfit - reserved;
  if (input.amount > available) {
    throw new ShareholderError("distribution_exceeds_closed_year_profit", 409, {
      availableRial: (available > 0n ? available : 0n).toString(),
      reservedRial: reserved.toString(),
    });
  }
}

export async function createShareholderDistribution(
  businessId: string,
  actor: ShareholderActor,
  input: CreateDistributionInput,
  rawIdempotencyKey?: unknown,
): Promise<{ distribution: ShareholderDistributionRow; replayed: boolean }> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersDistributionsManage);
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey, true)!;
  const fiscalYearId = requireUuid(input.fiscalYearId, "fiscal_year_id");
  const snapshotOn = requireDate(input.snapshotOn, "snapshot_on");
  const tax = parseNonNegativeRial(input.taxAdjustmentRial);
  const reserve = parseNonNegativeRial(input.reserveAdjustmentRial);
  if (tax === null || reserve === null) throw new ShareholderError("invalid_distribution_adjustment", 400);
  const manualText = toLatinDigits(String(input.manualAdjustmentRial ?? "0")).replace(/[٬,\s]/g, "").trim();
  if (!/^-?(?:0|[1-9]\d*)$/.test(manualText)) throw new ShareholderError("invalid_manual_adjustment", 400);
  const manual = BigInt(manualText);
  if (manual > 9_223_372_036_854_775_807n || manual < -9_223_372_036_854_775_808n) throw new ShareholderError("invalid_manual_adjustment", 400);
  const adjustmentReason = optionalText(input.adjustmentReason, "adjustment_reason", 500);
  if ((tax !== 0n || reserve !== 0n || manual !== 0n) && !adjustmentReason) {
    throw new ShareholderError("adjustment_reason_required", 400);
  }
  if (tax !== 0n || reserve !== 0n || manual !== 0n) {
    requirePermission(actor, PERMISSIONS.shareholdersDistributionsAdjust);
  }
  const sourceReference = optionalText(input.sourceReference, "source_reference", 120);
  const hash = payloadHash({ fiscalYearId, snapshotOn, tax: tax.toString(), reserve: reserve.toString(), manual: manual.toString(), adjustmentReason, sourceReference });

  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const existing = await existingIdempotencyRow(client, "shareholder_distributions", businessId, idempotencyKey, hash);
    if (existing) {
      const distribution = await loadDistributionDetail(client, businessId, existing.id);
      if (!distribution) throw new ShareholderError("distribution_not_found", 404);
      return { distribution, replayed: true };
    }
    const year = await closedFiscalYearSource(client, businessId, fiscalYearId);
    if (snapshotOn < year.startsOn || snapshotOn > year.endsOn) throw new ShareholderError("snapshot_outside_fiscal_year", 400);
    const owners = await allocationSnapshot(client, businessId, snapshotOn);
    const distributable = year.sourceProfit - tax - reserve + manual;
    if (distributable <= 0n || distributable > year.sourceProfit) {
      throw new ShareholderError("invalid_distributable_profit", 409, { sourceProfitRial: year.sourceProfit.toString() });
    }
    await assertDistributionCapacity(client, {
      businessId,
      fiscalYearId,
      sourceProfit: year.sourceProfit,
      amount: distributable,
    });
    const allocations = allocateRialByWeight(distributable, owners.map((owner) => ({ key: owner.partyId, weight: owner.weight })));
    const allocationByParty = new Map(allocations.map((row) => [row.key, row.amountRial]));
    const distributionId = randomUUID();
    await client.query(
      `INSERT INTO shareholder_distributions
         (id, business_id, fiscal_year_id, closing_entry_id, snapshot_on, source_profit_rial,
          tax_adjustment_rial, reserve_adjustment_rial, manual_adjustment_rial, adjustment_reason,
          distributable_rial, source_reference, created_by, idempotency_key, idempotency_payload_hash)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [distributionId, businessId, fiscalYearId, year.closingEntryId, snapshotOn, year.sourceProfit.toString(),
        tax.toString(), reserve.toString(), manual.toString(), adjustmentReason, distributable.toString(), sourceReference,
        actor.userId, idempotencyKey, hash],
    );
    for (const owner of owners) {
      await client.query(
        `INSERT INTO shareholder_distribution_lines
           (business_id, distribution_id, shareholder_id, party_id, ownership_percent, share_units, allocated_rial)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7)`,
        [businessId, distributionId, owner.shareholderId, owner.partyId, owner.ownershipPercent, owner.shareUnits, allocationByParty.get(owner.partyId)!.toString()],
      );
    }
    await writeDistributionEvent(client, {
      businessId, distributionId, type: "created", actorId: actor.userId,
      payload: { fiscalYearId, closingEntryId: year.closingEntryId, snapshotOn, sourceProfitRial: year.sourceProfit.toString(), distributableRial: distributable.toString(), shareholderCount: owners.length },
    });
    await writeAudit(client, {
      businessId, actorId: actor.userId, action: "shareholder.distribution.created", entity: "shareholder_distribution", entityId: distributionId,
      payload: { fiscalYearId, fiscalYearLabel: year.label, closingEntryId: year.closingEntryId, snapshotOn, sourceProfitRial: year.sourceProfit.toString(), taxAdjustmentRial: tax.toString(), reserveAdjustmentRial: reserve.toString(), manualAdjustmentRial: manual.toString(), distributableRial: distributable.toString(), reason: adjustmentReason, shareCount: owners.length },
    });
    const distribution = await loadDistributionDetail(client, businessId, distributionId);
    if (!distribution) throw new ShareholderError("distribution_not_found", 404);
    return { distribution, replayed: false };
  });
}

export async function approveShareholderDistribution(
  businessId: string,
  actor: ShareholderActor,
  distributionIdValue: string,
): Promise<ShareholderDistributionRow> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersDistributionsApprove);
  const distributionId = requireUuid(distributionIdValue, "distribution_id");
  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const { rows } = await client.query<{
      status: string;
      created_by: string | null;
      fiscal_year_id: string;
      closing_entry_id: string;
      source_profit_rial: string;
      distributable_rial: string;
    }>(
      `SELECT status, created_by, fiscal_year_id, closing_entry_id,
              source_profit_rial::text AS source_profit_rial, distributable_rial::text AS distributable_rial
         FROM shareholder_distributions WHERE business_id=$1 AND id=$2 FOR UPDATE`,
      [businessId, distributionId],
    );
    const row = rows[0];
    if (!row) throw new ShareholderError("distribution_not_found", 404);
    if (row.status !== "draft") throw new ShareholderError("distribution_not_approvable", 409, { status: row.status });
    if (row.created_by === actor.userId) throw new ShareholderError("distribution_creator_cannot_approve", 403);
    const year = await closedFiscalYearSource(client, businessId, row.fiscal_year_id);
    if (year.closingEntryId !== row.closing_entry_id || year.sourceProfit.toString() !== row.source_profit_rial) {
      throw new ShareholderError("closed_year_result_changed", 409);
    }
    await assertDistributionCapacity(client, {
      businessId,
      fiscalYearId: row.fiscal_year_id,
      sourceProfit: year.sourceProfit,
      amount: BigInt(row.distributable_rial),
      excludeId: distributionId,
    });
    await client.query(
      `UPDATE shareholder_distributions SET status='approved', approved_by=$3, approved_at=now()
        WHERE business_id=$1 AND id=$2`,
      [businessId, distributionId, actor.userId],
    );
    await writeDistributionEvent(client, { businessId, distributionId, type: "approved", actorId: actor.userId });
    await writeAudit(client, { businessId, actorId: actor.userId, action: "shareholder.distribution.approved", entity: "shareholder_distribution", entityId: distributionId, payload: { createdBy: row.created_by } });
    const detail = await loadDistributionDetail(client, businessId, distributionId);
    if (!detail) throw new ShareholderError("distribution_not_found", 404);
    return detail;
  });
}

export async function cancelShareholderDistribution(
  businessId: string,
  actor: ShareholderActor,
  distributionIdValue: string,
  reasonValue: unknown,
): Promise<ShareholderDistributionRow> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersDistributionsManage);
  const distributionId = requireUuid(distributionIdValue, "distribution_id");
  const reason = requiredText(reasonValue, "reason", 500);
  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const { rows } = await client.query<{ status: string }>(
      "SELECT status FROM shareholder_distributions WHERE business_id=$1 AND id=$2 FOR UPDATE",
      [businessId, distributionId],
    );
    if (!rows[0]) throw new ShareholderError("distribution_not_found", 404);
    if (rows[0].status !== "draft" && rows[0].status !== "approved") {
      throw new ShareholderError("distribution_not_cancellable", 409, { status: rows[0].status });
    }
    await client.query(
      `UPDATE shareholder_distributions
          SET status='cancelled', cancelled_by=$3, cancelled_at=now(), cancel_reason=$4
        WHERE business_id=$1 AND id=$2`,
      [businessId, distributionId, actor.userId, reason],
    );
    await writeDistributionEvent(client, { businessId, distributionId, type: "cancelled", actorId: actor.userId, payload: { reason } });
    await writeAudit(client, { businessId, actorId: actor.userId, action: "shareholder.distribution.cancelled", entity: "shareholder_distribution", entityId: distributionId, payload: { reason } });
    const detail = await loadDistributionDetail(client, businessId, distributionId);
    if (!detail) throw new ShareholderError("distribution_not_found", 404);
    return detail;
  });
}

export async function postShareholderDistribution(
  businessId: string,
  actor: ShareholderActor,
  distributionIdValue: string,
): Promise<{ distribution: ShareholderDistributionRow; journalEntryId: string; replayed: boolean }> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.ledgerPost);
  const distributionId = requireUuid(distributionIdValue, "distribution_id");
  const entryDate = await businessToday(businessId);
  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const { rows } = await client.query<{
      status: string; fiscal_year_id: string; source_profit_rial: string; distributable_rial: string;
      posting_entry_id: string | null; created_by: string | null; closing_entry_id: string; snapshot_on: string;
    }>(
      `SELECT status, fiscal_year_id, source_profit_rial::text AS source_profit_rial,
              distributable_rial::text AS distributable_rial, posting_entry_id, created_by, closing_entry_id,
              snapshot_on::text AS snapshot_on
         FROM shareholder_distributions WHERE business_id=$1 AND id=$2 FOR UPDATE`,
      [businessId, distributionId],
    );
    const distribution = rows[0];
    if (!distribution) throw new ShareholderError("distribution_not_found", 404);
    if (["posted", "partially_paid", "paid"].includes(distribution.status) && distribution.posting_entry_id) {
      const detail = await loadDistributionDetail(client, businessId, distributionId);
      if (!detail) throw new ShareholderError("distribution_not_found", 404);
      return { distribution: detail, journalEntryId: distribution.posting_entry_id, replayed: true };
    }
    if (distribution.status !== "approved") throw new ShareholderError("distribution_not_approved", 409, { status: distribution.status });
    const year = await closedFiscalYearSource(client, businessId, distribution.fiscal_year_id);
    if (year.closingEntryId !== distribution.closing_entry_id || year.sourceProfit.toString() !== distribution.source_profit_rial) {
      throw new ShareholderError("closed_year_result_changed", 409);
    }
    const amount = BigInt(distribution.distributable_rial);
    await assertDistributionCapacity(client, {
      businessId,
      fiscalYearId: distribution.fiscal_year_id,
      sourceProfit: year.sourceProfit,
      amount,
      excludeId: distributionId,
    });
    const accountMap = await accountIdsByCode(client, businessId, [SHAREHOLDER_ACCOUNT_CODES.retainedEarnings, SHAREHOLDER_ACCOUNT_CODES.distributionsPayable]);
    await verifyAccountTypes(client, businessId, accountMap, {
      [SHAREHOLDER_ACCOUNT_CODES.retainedEarnings]: "equity",
      [SHAREHOLDER_ACCOUNT_CODES.distributionsPayable]: "liability",
    });
    const retainedBalance = await client.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(jl.debit),0)::text AS debit, COALESCE(SUM(jl.credit),0)::text AS credit
         FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
         JOIN accounts a ON a.id=jl.account_id
        WHERE je.business_id=$1 AND a.business_id=$1 AND a.code=$2`,
      [businessId, SHAREHOLDER_ACCOUNT_CODES.retainedEarnings],
    );
    const retainedAvailable = BigInt(retainedBalance.rows[0]?.credit ?? "0") - BigInt(retainedBalance.rows[0]?.debit ?? "0");
    if (retainedAvailable < amount) throw new ShareholderError("retained_earnings_insufficient", 409, { availableRial: retainedAvailable.toString() });

    const lines = await loadAllDistributionLinesForPosting(client, businessId, distributionId);
    if (lines.length === 0 || lines.reduce((sum, line) => sum + BigInt(line.allocatedRial), 0n) !== amount) {
      throw new ShareholderError("distribution_lines_unbalanced", 409);
    }
    const zero = ZERO;
    const retainedEarningsId = accountMap.get(SHAREHOLDER_ACCOUNT_CODES.retainedEarnings)!;
    const distributionsPayableId = accountMap.get(SHAREHOLDER_ACCOUNT_CODES.distributionsPayable)!;
    // Keep both sides of the allocation attributed to the frozen shareholder
    // snapshot. The retained-earnings total is still one exact GL amount, but
    // per-party tags make the posting and its mirror reversal reconcilable.
    const journalLines = lines.flatMap((line) => [
      {
        accountId: retainedEarningsId,
        debit: line.allocatedRial as RialText,
        credit: zero,
        partyId: line.partyId,
      },
      {
        accountId: distributionsPayableId,
        debit: zero,
        credit: line.allocatedRial as RialText,
        partyId: line.partyId,
      },
    ]);
    const journalEntryId = await postExactJournalEntry(client, {
      businessId,
      locationId: null,
      entryDate,
      memo: `تخصیص سود سال مالی ${distribution.fiscal_year_id}`,
      sourceType: "shareholder_distribution",
      sourceId: distributionId,
      createdBy: actor.userId,
      postingKind: "shareholder_distribution",
      idempotencyKey: `shareholder:distribution:${distributionId}:post`,
      lines: journalLines,
    });
    if (!journalEntryId) throw new ShareholderError("distribution_posting_failed", 409);
    await client.query(
      `UPDATE shareholder_distributions
          SET status='posted', posting_entry_id=$3, posted_by=$4, posted_at=now()
        WHERE business_id=$1 AND id=$2`,
      [businessId, distributionId, journalEntryId, actor.userId],
    );
    await writeDistributionEvent(client, { businessId, distributionId, type: "posted", actorId: actor.userId, payload: { journalEntryId, entryDate } });
    await appendBusinessSyncOutboxEvent(client, {
      businessId,
      clientEventId: `shareholder.distribution.posted:${distributionId}`,
      eventType: "shareholder.distribution.posted",
      payload: { distributionId, fiscalYearId: distribution.fiscal_year_id, amountRial: amount.toString(), snapshotOn: distribution.snapshot_on, journalEntryId },
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    await writeAudit(client, { businessId, actorId: actor.userId, action: "shareholder.distribution.posted", entity: "shareholder_distribution", entityId: distributionId, payload: { fiscalYearId: distribution.fiscal_year_id, amountRial: amount.toString(), journalEntryId } });
    const detail = await loadDistributionDetail(client, businessId, distributionId);
    if (!detail) throw new ShareholderError("distribution_not_found", 404);
    return { distribution: detail, journalEntryId, replayed: false };
  });
}

async function netPaidForLine(client: PoolClient, businessId: string, lineId: string): Promise<bigint> {
  const { rows } = await client.query<{ amount: string }>(
    `SELECT COALESCE(SUM(CASE WHEN payment_type='payment' THEN amount_rial ELSE -amount_rial END),0)::text AS amount
       FROM shareholder_distribution_payments WHERE business_id=$1 AND distribution_line_id=$2`,
    [businessId, lineId],
  );
  return BigInt(rows[0]?.amount ?? "0");
}

async function refreshDistributionPaidStatus(client: PoolClient, businessId: string, distributionId: string): Promise<void> {
  const { rows } = await client.query<{ total_allocated: string; total_paid: string; line_count: string }>(
    `SELECT COALESCE(SUM(dl.allocated_rial),0)::text AS total_allocated,
            COALESCE(SUM(paid.paid_rial::numeric),0)::text AS total_paid,
            COUNT(*)::text AS line_count
       FROM shareholder_distribution_lines dl
       LEFT JOIN LATERAL (
         SELECT SUM(CASE WHEN payment_type='payment' THEN amount_rial ELSE -amount_rial END)::text AS paid_rial
           FROM shareholder_distribution_payments pmt WHERE pmt.business_id=dl.business_id AND pmt.distribution_line_id=dl.id
       ) paid ON true
      WHERE dl.business_id=$1 AND dl.distribution_id=$2`,
    [businessId, distributionId],
  );
  const lineCount = Number(rows[0]?.line_count ?? "0");
  const allocated = BigInt(rows[0]?.total_allocated ?? "0");
  const paid = BigInt(rows[0]?.total_paid ?? "0");
  const status = paid <= 0n ? "posted" : paid >= allocated && lineCount > 0 ? "paid" : "partially_paid";
  await client.query(
    "UPDATE shareholder_distributions SET status=$3 WHERE business_id=$1 AND id=$2 AND status IN ('posted','partially_paid','paid')",
    [businessId, distributionId, status],
  );
}

export async function payShareholderDistribution(
  businessId: string,
  actor: ShareholderActor,
  distributionIdValue: string,
  input: DistributionPaymentInput,
  rawIdempotencyKey?: unknown,
): Promise<{ paymentId: string; journalEntryId: string; replayed: boolean }> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersDistributionsPay);
  requirePermission(actor, PERMISSIONS.ledgerPost);
  const distributionId = requireUuid(distributionIdValue, "distribution_id");
  const shareholderId = requireUuid(input.shareholderId, "shareholder_id");
  const amount = parsePositiveRial(input.amountRial);
  if (amount === null) throw new ShareholderError("invalid_amount_rial", 400);
  const paidOn = requireDate(input.paidOn, "paid_on");
  const paymentAccountId = requireUuid(input.paymentAccountId, "payment_account_id");
  const note = optionalText(input.note, "note", 500);
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey, true)!;
  const today = await businessToday(businessId);
  if (paidOn > today) throw new ShareholderError("payment_date_in_future", 400);
  await assertRetroactiveDate(actor, paidOn, today, note ?? "پرداخت سود سهام");
  const hash = payloadHash({ distributionId, shareholderId, amount: amount.toString(), paidOn, paymentAccountId, note });

  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const existing = await existingIdempotencyRow(client, "shareholder_distribution_payments", businessId, idempotencyKey, hash);
    if (existing) {
      if (!existing.related_entry_id) throw new ShareholderError("idempotency_key_conflict", 409);
      return { paymentId: existing.id, journalEntryId: existing.related_entry_id, replayed: true };
    }
    const { rows: distributionRows } = await client.query<{ status: string }>(
      "SELECT status FROM shareholder_distributions WHERE business_id=$1 AND id=$2 FOR UPDATE",
      [businessId, distributionId],
    );
    if (!distributionRows[0]) throw new ShareholderError("distribution_not_found", 404);
    if (!new Set(["posted", "partially_paid"]).has(distributionRows[0].status)) {
      throw new ShareholderError("distribution_not_payable", 409, { status: distributionRows[0].status });
    }
    const { rows: lineRows } = await client.query<{ id: string; party_id: string; allocated_rial: string }>(
      `SELECT id, party_id, allocated_rial::text AS allocated_rial
         FROM shareholder_distribution_lines
        WHERE business_id=$1 AND distribution_id=$2 AND shareholder_id=$3 FOR UPDATE`,
      [businessId, distributionId, shareholderId],
    );
    const line = lineRows[0];
    if (!line) throw new ShareholderError("distribution_shareholder_not_found", 404);
    const paid = await netPaidForLine(client, businessId, line.id);
    const outstanding = BigInt(line.allocated_rial) - paid;
    if (amount > outstanding) throw new ShareholderError("payment_exceeds_shareholder_outstanding", 409, { outstandingRial: outstanding.toString() });
    const paymentAccount = await ensureAssetPaymentAccount(client, businessId, paymentAccountId);
    const accounts = await accountIdsByCode(client, businessId, [SHAREHOLDER_ACCOUNT_CODES.distributionsPayable, paymentAccount.code]);
    await verifyAccountTypes(client, businessId, accounts, { [SHAREHOLDER_ACCOUNT_CODES.distributionsPayable]: "liability", [paymentAccount.code]: "asset" });
    const paymentId = randomUUID();
    const amountText = amount.toString() as RialText;
    const journalEntryId = await postExactJournalEntry(client, {
      businessId, locationId: null, entryDate: paidOn, memo: note ?? "پرداخت سود سهام‌دار",
      sourceType: "shareholder_distribution_payment", sourceId: paymentId, createdBy: actor.userId,
      postingKind: "shareholder_distribution_payment", idempotencyKey: `shareholder:distribution-payment:${idempotencyKey}`,
      lines: [
        { accountId: accounts.get(SHAREHOLDER_ACCOUNT_CODES.distributionsPayable)!, debit: amountText, credit: ZERO, partyId: line.party_id },
        { accountId: accounts.get(paymentAccount.code)!, debit: ZERO, credit: amountText },
      ],
    });
    if (!journalEntryId) throw new ShareholderError("distribution_payment_failed", 409);
    await client.query(
      `INSERT INTO shareholder_distribution_payments
         (id, business_id, distribution_id, distribution_line_id, shareholder_id, party_id,
          payment_type, paid_on, amount_rial, payment_account_id, journal_entry_id,
          idempotency_key, idempotency_payload_hash, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'payment', $7::date, $8, $9, $10, $11, $12, $13, $14)`,
      [paymentId, businessId, distributionId, line.id, shareholderId, line.party_id, paidOn, amount.toString(), paymentAccountId, journalEntryId, idempotencyKey, hash, note, actor.userId],
    );
    await refreshDistributionPaidStatus(client, businessId, distributionId);
    await writeDistributionEvent(client, { businessId, distributionId, type: "payment", actorId: actor.userId, payload: { paymentId, shareholderId, amountRial: amount.toString(), paidOn, journalEntryId } });
    await appendBusinessSyncOutboxEvent(client, {
      businessId, clientEventId: `shareholder.distribution-payment:${paymentId}`,
      eventType: "shareholder.distribution.payment.recorded",
      payload: { paymentId, distributionId, shareholderId, partyId: line.party_id, amountRial: amount.toString(), paidOn, journalEntryId },
      actorUserId: actor.userId, actorRole: actor.role,
    });
    await writeAudit(client, { businessId, actorId: actor.userId, action: "shareholder.distribution.payment.recorded", entity: "shareholder_distribution_payment", entityId: paymentId, payload: { distributionId, shareholderId, partyId: line.party_id, amountRial: amount.toString(), paidOn, paymentAccountId, journalEntryId } });
    return { paymentId, journalEntryId, replayed: false };
  });
}

export async function reverseShareholderDistributionPayment(
  businessId: string,
  actor: ShareholderActor,
  paymentIdValue: string,
  rawIdempotencyKey?: unknown,
): Promise<{ paymentId: string; journalEntryId: string; replayed: boolean }> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersDistributionsReverse);
  requirePermission(actor, PERMISSIONS.ledgerApprove);
  const originalPaymentId = requireUuid(paymentIdValue, "payment_id");
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey, true)!;
  const hash = payloadHash({ originalPaymentId });
  const today = await businessToday(businessId);
  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const existing = await existingIdempotencyRow(client, "shareholder_distribution_payments", businessId, idempotencyKey, hash);
    if (existing) {
      if (!existing.related_entry_id) throw new ShareholderError("idempotency_key_conflict", 409);
      return { paymentId: existing.id, journalEntryId: existing.related_entry_id, replayed: true };
    }
    const { rows } = await client.query<{
      id: string; distribution_id: string; distribution_line_id: string; shareholder_id: string;
      party_id: string; amount_rial: string; journal_entry_id: string; payment_type: string;
    }>(
      `SELECT id, distribution_id, distribution_line_id, shareholder_id, party_id,
              amount_rial::text AS amount_rial, journal_entry_id, payment_type
         FROM shareholder_distribution_payments WHERE business_id=$1 AND id=$2 FOR UPDATE`,
      [businessId, originalPaymentId],
    );
    const original = rows[0];
    if (!original || original.payment_type !== "payment") throw new ShareholderError("payment_not_found", 404);
    const { rows: prior } = await client.query("SELECT 1 FROM shareholder_distribution_payments WHERE business_id=$1 AND reverses_payment_id=$2", [businessId, originalPaymentId]);
    if (prior.length) throw new ShareholderError("payment_already_reversed", 409);
    const { rows: distributionRows } = await client.query<{ status: string }>(
      "SELECT status FROM shareholder_distributions WHERE business_id=$1 AND id=$2 FOR UPDATE",
      [businessId, original.distribution_id],
    );
    if (!distributionRows[0] || distributionRows[0].status === "reversed" || distributionRows[0].status === "cancelled") {
      throw new ShareholderError("distribution_not_reversible", 409);
    }
    const reversalId = randomUUID();
    const journalEntryId = await postExactMirrorEntry(client, {
      businessId, locationId: null, originalEntryId: original.journal_entry_id,
      sourceType: "shareholder_distribution_payment_reversal", sourceId: reversalId,
      postingKind: "shareholder_distribution_payment_reversal", memo: "برگشت پرداخت سود سهام‌دار",
      createdBy: actor.userId, entryDate: today,
      idempotencyKey: `shareholder:distribution-payment-reversal:${idempotencyKey}`,
    });
    if (!journalEntryId) throw new ShareholderError("payment_reversal_failed", 409);
    const { rows: originalLine } = await client.query<{ payment_account_id: string; paid_on: string; note: string | null }>(
      "SELECT payment_account_id, paid_on::text AS paid_on, note FROM shareholder_distribution_payments WHERE business_id=$1 AND id=$2",
      [businessId, originalPaymentId],
    );
    await client.query(
      `INSERT INTO shareholder_distribution_payments
         (id, business_id, distribution_id, distribution_line_id, shareholder_id, party_id,
          payment_type, paid_on, amount_rial, payment_account_id, journal_entry_id,
          reverses_payment_id, idempotency_key, idempotency_payload_hash, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'reversal', $7::date, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [reversalId, businessId, original.distribution_id, original.distribution_line_id, original.shareholder_id, original.party_id,
        today, original.amount_rial, originalLine[0].payment_account_id, journalEntryId, originalPaymentId, idempotencyKey, hash, "برگشت پرداخت", actor.userId],
    );
    await refreshDistributionPaidStatus(client, businessId, original.distribution_id);
    await writeDistributionEvent(client, { businessId, distributionId: original.distribution_id, type: "payment_reversed", actorId: actor.userId, payload: { reversalId, reversedPaymentId: originalPaymentId, amountRial: original.amount_rial, journalEntryId } });
    await appendBusinessSyncOutboxEvent(client, {
      businessId, clientEventId: `shareholder.distribution-payment-reversal:${reversalId}`,
      eventType: "shareholder.distribution.payment.reversed",
      payload: { reversalId, reversedPaymentId: originalPaymentId, distributionId: original.distribution_id, shareholderId: original.shareholder_id, amountRial: original.amount_rial, journalEntryId },
      actorUserId: actor.userId, actorRole: actor.role,
    });
    await writeAudit(client, { businessId, actorId: actor.userId, action: "shareholder.distribution.payment.reversed", entity: "shareholder_distribution_payment", entityId: reversalId, payload: { reversedPaymentId: originalPaymentId, distributionId: original.distribution_id, amountRial: original.amount_rial, journalEntryId } });
    return { paymentId: reversalId, journalEntryId, replayed: false };
  });
}

export async function reverseShareholderDistribution(
  businessId: string,
  actor: ShareholderActor,
  distributionIdValue: string,
  rawIdempotencyKey?: unknown,
): Promise<{ distribution: ShareholderDistributionRow; journalEntryId: string; replayed: boolean }> {
  requireCloudAuthority();
  requirePermission(actor, PERMISSIONS.shareholdersDistributionsReverse);
  requirePermission(actor, PERMISSIONS.ledgerApprove);
  const distributionId = requireUuid(distributionIdValue, "distribution_id");
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey, true)!;
  const today = await businessToday(businessId);
  return inTransaction(async (client) => {
    await lockShareholderBusiness(client, businessId);
    const { rows } = await client.query<{ status: string; posting_entry_id: string | null; reversal_entry_id: string | null }>(
      "SELECT status, posting_entry_id, reversal_entry_id FROM shareholder_distributions WHERE business_id=$1 AND id=$2 FOR UPDATE",
      [businessId, distributionId],
    );
    const distribution = rows[0];
    if (!distribution) throw new ShareholderError("distribution_not_found", 404);
    if (distribution.status === "reversed" && distribution.reversal_entry_id) {
      const detail = await loadDistributionDetail(client, businessId, distributionId);
      return { distribution: detail!, journalEntryId: distribution.reversal_entry_id, replayed: true };
    }
    if (!["posted", "partially_paid", "paid"].includes(distribution.status) || !distribution.posting_entry_id) {
      throw new ShareholderError("distribution_not_reversible", 409, { status: distribution.status });
    }
    const { rows: paidRows } = await client.query<{ amount: string }>(
      `SELECT COALESCE(SUM(CASE WHEN payment_type='payment' THEN amount_rial ELSE -amount_rial END),0)::text AS amount
         FROM shareholder_distribution_payments WHERE business_id=$1 AND distribution_id=$2`,
      [businessId, distributionId],
    );
    if (BigInt(paidRows[0]?.amount ?? "0") !== 0n) throw new ShareholderError("reverse_payments_before_distribution", 409);
    const reversalEntryId = await postExactMirrorEntry(client, {
      businessId, locationId: null, originalEntryId: distribution.posting_entry_id,
      sourceType: "shareholder_distribution_reversal", sourceId: distributionId,
      postingKind: "shareholder_distribution_reversal", memo: "برگشت تخصیص سود سهام‌داران",
      createdBy: actor.userId, entryDate: today,
      idempotencyKey: `shareholder:distribution:${distributionId}:reverse:${idempotencyKey}`,
    });
    if (!reversalEntryId) throw new ShareholderError("distribution_reversal_failed", 409);
    await client.query(
      `UPDATE shareholder_distributions
          SET status='reversed', reversal_entry_id=$3, reversed_by=$4, reversed_at=now()
        WHERE business_id=$1 AND id=$2`,
      [businessId, distributionId, reversalEntryId, actor.userId],
    );
    await writeDistributionEvent(client, { businessId, distributionId, type: "reversed", actorId: actor.userId, payload: { reversalEntryId } });
    await appendBusinessSyncOutboxEvent(client, {
      businessId, clientEventId: `shareholder.distribution.reversal:${distributionId}`,
      eventType: "shareholder.distribution.reversed",
      payload: { distributionId, reversalEntryId },
      actorUserId: actor.userId, actorRole: actor.role,
    });
    await writeAudit(client, { businessId, actorId: actor.userId, action: "shareholder.distribution.reversed", entity: "shareholder_distribution", entityId: distributionId, payload: { reversalEntryId } });
    const detail = await loadDistributionDetail(client, businessId, distributionId);
    if (!detail) throw new ShareholderError("distribution_not_found", 404);
    return { distribution: detail, journalEntryId: reversalEntryId, replayed: false };
  });
}
