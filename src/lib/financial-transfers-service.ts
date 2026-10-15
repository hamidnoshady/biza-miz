/**
 * «انتقال وجه» — the DB-touching half of the internal-transfer document
 * (issue #862).
 *
 * One transfer is one transaction: the document row, its balanced journal entry
 * and its audit row commit together or not at all. Nothing here posts a journal
 * entry through a path of its own — every transfer goes through
 * `postExactJournalEntry`, so it inherits the fiscal-period lock trigger, the
 * voucher numbering, the dimension guard and the multicurrency snapshot rules
 * that every other posting already obeys.
 *
 * WHAT THIS FILE GUARANTEES, AND HOW
 *
 *  - **Atomic.** The entry and the document are written inside one
 *    `BEGIN … COMMIT`; a validation failure or a fee-account problem rolls back
 *    both, so a transfer can never exist without the entry that says what it
 *    did.
 *  - **Idempotent.** A repeated request (same key, or a retry after an
 *    ambiguous failure) returns the first document instead of posting a second
 *    one. Three layers agree on that: the key lookup at the door, the unique
 *    partial index on `(business_id, idempotency_key)`, and the journal's own
 *    idempotency key — so the loser of a race fails at the database and is
 *    answered with the winner's document rather than by posting again.
 *  - **Serialized per business.** Every write takes an advisory xact lock on
 *    `financial-transfers:<businessId>` before it reads the sequence number or
 *    the accounts, so concurrent submissions cannot both take number 12 or both
 *    reverse the same transfer.
 *  - **Exact.** Amounts are BigInt throughout. A foreign-currency transfer is
 *    converted at a rate row that already exists in the business's rate
 *    register — never at an invented one — and the base legs absorb the
 *    residual so the entry balances to the rial.
 *  - **Append-only.** A posted transfer is never edited or deleted. A
 *    correction is a reversal: a second document whose journal mirrors the
 *    original line for line, linked to it by a unique index that makes a double
 *    reversal impossible even under a race.
 *
 * DB-touching, so per repo convention it has no direct unit test: the rules it
 * applies live in the framework-free `financial-transfers.ts` (unit-tested) and
 * its behaviour is covered by `integration/financial-transfers.integration.test.ts`.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { postExactJournalEntry, type ExactJournalLine } from "./ledger-service";
import { rialBigInt, type RialText } from "./inventory-exact";
import { isUuid } from "./uuid";
import { isValidIsoDate } from "./iso-date";
import { businessToday } from "./business-day-service";
import { convertToBaseMinor, ROUNDING_POLICY_VERSION } from "./multicurrency";
import {
  amountToRialText,
  buildTransferLines,
  isTransferFeePayer,
  transferNumberFor,
  transferPostingProblem,
  transferRequestProblem,
  type TransferFeePayer,
  type TransferLine,
  type TransferRequestInput,
  type TransferStatus,
} from "./financial-transfers";
import { previousDay, type FinancialAccountRecord } from "./financial-accounts-service";
import { FINANCIAL_ACCOUNT_KIND_META } from "./financial-accounts";
import { FINANCIAL_ACCOUNT_ERROR_MESSAGES } from "./financial-account-errors";

export class FinancialTransferError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

function sqlState(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

function constraintName(err: unknown): string {
  return typeof err === "object" && err !== null ? String((err as { constraint?: string }).constraint ?? "") : "";
}

/**
 * Serialize transfer writes per business.
 *
 * The sequence number, the idempotency lookup and the reversal check are all
 * read-then-write pairs; without one lock two concurrent submissions can both
 * see "no transfer with this key yet" and both proceed. The lock is per tenant
 * and per document kind, takes no table lock, and is released by the commit.
 */
async function lockTransfers(client: PoolClient, businessId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`financial-transfers:${businessId}`]);
}

/**
 * The hash of everything that makes one request *that* request.
 *
 * Two requests carrying the same idempotency key are only the same request when
 * their payloads match; a key reused for a different amount is a caller's bug
 * and is refused (`idempotency_conflict`) rather than silently answering with
 * the first document.
 */
function requestHash(input: {
  transferDate: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  feeAmount: string;
  feeAccountId: string | null;
  feePayer: TransferFeePayer;
  projectId: string | null;
  attachmentAssetId: string | null;
  reversalOf?: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

interface TransferRow extends Record<string, unknown> {
  id: string;
  reversal_transfer_number?: string | null;
  reversal_reason_of_reversal?: string | null;
  transfer_number: string;
  sequence_no: string;
  transfer_date: string;
  source_account_id: string;
  destination_account_id: string;
  amount: string;
  fee_amount: string;
  fee_account_id: string | null;
  fee_payer: TransferFeePayer;
  currency_code: string;
  reference_number: string | null;
  description: string | null;
  project_id: string | null;
  project_name: string | null;
  attachment_asset_id: string | null;
  status: TransferStatus;
  posting_mode: "transfer" | "reversal";
  journal_entry_id: string;
  reversal_entry_id: string | null;
  reverses_transfer_id: string | null;
  reversal_reason: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  posted_at: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  source_account_name: string | null;
  source_account_kind: string | null;
  source_gl_account_id: string | null;
  destination_account_name: string | null;
  destination_account_kind: string | null;
  destination_gl_account_id: string | null;
  fee_account_code: string | null;
  fee_account_name: string | null;
  location_id: string | null;
  location_name: string | null;
  idempotency_key: string | null;
}

export interface FinancialTransferRecord {
  id: string;
  transferNumber: string;
  sequenceNo: string;
  transferDate: string;
  sourceAccountId: string;
  sourceAccountName: string | null;
  sourceAccountKind: string | null;
  destinationAccountId: string;
  destinationAccountName: string | null;
  destinationAccountKind: string | null;
  amount: string;
  feeAmount: string;
  feeAccountId: string | null;
  feeAccountLabel: string | null;
  feePayer: TransferFeePayer;
  currencyCode: string;
  referenceNumber: string | null;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  attachmentAssetId: string | null;
  status: TransferStatus;
  postingMode: "transfer" | "reversal";
  journalEntryId: string;
  reversalEntryId: string | null;
  reversesTransferId: string | null;
  /** Why this document was reversed — its own reason, or its reversal's. */
  reversalReason: string | null;
  /** The number of the document that reversed this one, when it was reversed. */
  reversalTransferNumber: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  postedAt: string;
  createdBy: string | null;
  createdByName: string | null;
  locationId: string | null;
  locationName: string | null;
  /** The whole outflow from the source account: amount + a fee taken from it. */
  sourceOutflow: string;
  /** What the destination account received: amount − a fee taken from it. */
  destinationInflow: string;
}

function toRecord(row: TransferRow): FinancialTransferRecord {
  const amount = BigInt(row.amount);
  const fee = BigInt(row.fee_amount);
  const feeFromSource = row.fee_payer === "source";
  return {
    id: row.id,
    transferNumber: row.transfer_number,
    sequenceNo: String(row.sequence_no),
    transferDate: row.transfer_date,
    sourceAccountId: row.source_account_id,
    sourceAccountName: row.source_account_name,
    sourceAccountKind: row.source_account_kind,
    destinationAccountId: row.destination_account_id,
    destinationAccountName: row.destination_account_name,
    destinationAccountKind: row.destination_account_kind,
    amount: row.amount,
    feeAmount: row.fee_amount,
    feeAccountId: row.fee_account_id,
    feeAccountLabel: row.fee_account_name
      ? `${row.fee_account_name}${row.fee_account_code ? ` (${row.fee_account_code})` : ""}`
      : null,
    feePayer: row.fee_payer,
    currencyCode: row.currency_code,
    referenceNumber: row.reference_number,
    description: row.description,
    projectId: row.project_id,
    projectName: row.project_name,
    attachmentAssetId: row.attachment_asset_id,
    status: row.status,
    postingMode: row.posting_mode,
    journalEntryId: row.journal_entry_id,
    reversalEntryId: row.reversal_entry_id,
    reversesTransferId: row.reverses_transfer_id,
    // A reversed transfer's reason lives on its reversal (the shape CHECK keeps
    // the original's own fields untouched), so the row answers with its own
    // reason when it has one and with the reversal's otherwise.
    reversalReason: row.reversal_reason ?? row.reversal_reason_of_reversal ?? null,
    reversalTransferNumber: row.reversal_transfer_number ?? null,
    reversedAt: row.reversed_at,
    reversedBy: row.reversed_by,
    postedAt: row.posted_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    locationId: row.location_id,
    locationName: row.location_name,
    sourceOutflow: (amount + (feeFromSource ? fee : 0n)).toString(),
    destinationInflow: (amount - (feeFromSource ? 0n : fee)).toString(),
  };
}

const SELECT_TRANSFER = `
  SELECT t.*,
         t.transfer_date::text AS transfer_date,
         t.posted_at::text AS posted_at,
         t.reversed_at::text AS reversed_at,
         sa.name AS source_account_name, sa.kind::text AS source_account_kind,
         da.name AS destination_account_name, da.kind::text AS destination_account_kind,
         ga.code AS fee_account_code, ga.name AS fee_account_name,
         p.name AS project_name,
         l.name AS location_name,
         u.full_name AS created_by_name,
         -- The document that reversed this one, when it was reversed. A
         -- reversal carries its reason on ITS OWN row (the shape CHECK forbids a
         -- transfer-mode row from holding one), so the pair is joined here: the
         -- register can then say «برگشت با سند TR-000007» on the original
         -- instead of leaving a reader to hunt for the mirror document.
         rev.transfer_number AS reversal_transfer_number,
         rev.reversal_reason AS reversal_reason_of_reversal
    FROM financial_transfers t
    LEFT JOIN financial_accounts sa ON sa.id = t.source_account_id
    LEFT JOIN financial_accounts da ON da.id = t.destination_account_id
    LEFT JOIN accounts ga ON ga.id = t.fee_account_id
    LEFT JOIN ai_projects p ON p.id = t.project_id
    LEFT JOIN locations l ON l.id = t.location_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN financial_transfers rev ON rev.reverses_transfer_id = t.id
`;

export interface TransferFilters {
  from?: string | null;
  to?: string | null;
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
  accountId?: string | null;
  kind?: string | null;
  locationId?: string | null;
  projectId?: string | null;
  status?: TransferStatus | null;
  q?: string | null;
  restrictToLocationIds?: readonly string[] | null;
  limit?: number;
  offset?: number;
}

export interface TransferListResult {
  transfers: FinancialTransferRecord[];
  totalCount: number;
  /** Exact Rial over the whole filtered result, not the page. */
  totalAmount: string;
  totalFee: string;
  /**
   * Movements still in effect, and movements undone.
   *
   * A reversal document is itself `status = 'posted'` — it *was* posted — so
   * counting rows by status alone would report «۲ ثبت‌شده» for one movement and
   * the correction that cancels it. The register's own two figures answer the
   * question a reader has: how many movements stand, and how many were undone.
   */
  postedCount: number;
  reversedCount: number;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** The register: filters, exact totals and a page, all in SQL. */
export async function listFinancialTransfers(
  businessId: string,
  filters: TransferFilters = {},
): Promise<TransferListResult> {
  for (const [field, value] of [
    ["from", filters.from],
    ["to", filters.to],
  ] as const) {
    if (value != null && value !== "" && !isValidIsoDate(value)) throw new FinancialTransferError("invalid_transfer_date");
  }
  for (const [field, value] of [
    ["sourceAccountId", filters.sourceAccountId],
    ["destinationAccountId", filters.destinationAccountId],
    ["accountId", filters.accountId],
    ["locationId", filters.locationId],
    ["projectId", filters.projectId],
  ] as const) {
    if (value != null && value !== "" && !isUuid(value)) throw new FinancialTransferError("bad_request");
    void field;
  }
  if (filters.status != null && filters.status !== "posted" && filters.status !== "reversed") {
    throw new FinancialTransferError("invalid_transfer_status");
  }

  const conditions: string[] = ["t.business_id = $1"];
  const params: unknown[] = [businessId];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.from) conditions.push(`t.transfer_date >= ${push(filters.from)}::date`);
  if (filters.to) conditions.push(`t.transfer_date <= ${push(filters.to)}::date`);
  if (filters.status) conditions.push(`t.status = ${push(filters.status)}`);
  if (filters.sourceAccountId) conditions.push(`t.source_account_id = ${push(filters.sourceAccountId)}`);
  if (filters.destinationAccountId) conditions.push(`t.destination_account_id = ${push(filters.destinationAccountId)}`);
  if (filters.accountId) {
    const id = push(filters.accountId);
    conditions.push(`(t.source_account_id = ${id} OR t.destination_account_id = ${id})`);
  }
  if (filters.kind) {
    const kind = push(filters.kind);
    conditions.push(`(sa.kind = ${kind}::financial_account_kind OR da.kind = ${kind}::financial_account_kind)`);
  }
  if (filters.locationId) conditions.push(`t.location_id = ${push(filters.locationId)}`);
  if (filters.projectId) conditions.push(`t.project_id = ${push(filters.projectId)}`);
  if (filters.restrictToLocationIds) {
    const ids = filters.restrictToLocationIds.filter((id) => isUuid(id));
    conditions.push(
      ids.length > 0
        ? `(t.location_id IS NULL OR t.location_id = ANY(${push(ids)}::uuid[]))`
        : "t.location_id IS NULL",
    );
  }
  const term = filters.q?.trim();
  if (term) {
    const like = push(`%${escapeLikePattern(term)}%`);
    conditions.push(
      `(t.transfer_number ILIKE ${like} OR t.description ILIKE ${like} OR t.reference_number ILIKE ${like}
        OR sa.name ILIKE ${like} OR da.name ILIKE ${like} OR p.name ILIKE ${like})`,
    );
  }
  const where = conditions.join(" AND ");
  const limit = Math.min(Math.max(Number(filters.limit ?? 50), 1), 200);
  const offset = Math.max(Number(filters.offset ?? 0), 0);

  const { rows } = await query<TransferRow>(
    `${SELECT_TRANSFER}
      WHERE ${where}
      ORDER BY t.transfer_date DESC, t.sequence_no DESC
      LIMIT ${push(limit)} OFFSET ${push(offset)}`,
    params,
  );
  const { rows: totals } = await query<{
    count: string;
    amount: string | null;
    fee: string | null;
    posted: string;
    reversed: string;
  }>(
    `SELECT count(*)::text AS count,
            COALESCE(SUM(t.amount), 0)::text AS amount,
            COALESCE(SUM(t.fee_amount), 0)::text AS fee,
            COALESCE(SUM(CASE WHEN t.status = 'posted' AND t.posting_mode = 'transfer' THEN 1 ELSE 0 END), 0)::text AS posted,
            COALESCE(SUM(CASE WHEN t.status = 'reversed' THEN 1 ELSE 0 END), 0)::text AS reversed
       FROM financial_transfers t
       LEFT JOIN financial_accounts sa ON sa.id = t.source_account_id
       LEFT JOIN financial_accounts da ON da.id = t.destination_account_id
       LEFT JOIN ai_projects p ON p.id = t.project_id
      WHERE ${where}`,
    // The count query shares the filter list, so it must share its parameters —
    // minus the two the page added.
    params.slice(0, params.length - 2),
  );

  return {
    transfers: rows.map(toRecord),
    totalCount: Number(totals[0]?.count ?? "0"),
    totalAmount: totals[0]?.amount ?? "0",
    totalFee: totals[0]?.fee ?? "0",
    postedCount: Number(totals[0]?.posted ?? "0"),
    reversedCount: Number(totals[0]?.reversed ?? "0"),
  };
}

export interface TransferDetail extends FinancialTransferRecord {
  /** The journal lines behind the document, exactly as posted. */
  journalLines: { accountId: string; accountCode: string; accountName: string; debit: string; credit: string }[];
}

export async function getFinancialTransfer(
  businessId: string,
  transferId: string,
): Promise<TransferDetail | null> {
  if (!isUuid(transferId)) return null;
  const { rows } = await query<TransferRow>(
    `${SELECT_TRANSFER} WHERE t.business_id = $1 AND t.id = $2`,
    [businessId, transferId],
  );
  const row = rows[0];
  if (!row) return null;
  const { rows: lines } = await query<{
    account_id: string;
    account_code: string;
    account_name: string;
    debit: string;
    credit: string;
  }>(
    `SELECT jl.account_id, a.code AS account_code, a.name AS account_name,
            jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1
      ORDER BY jl.id`,
    [row.journal_entry_id],
  );
  return {
    ...toRecord(row),
    journalLines: lines.map((line) => ({
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      debit: line.debit,
      credit: line.credit,
    })),
  };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

interface ResolvedAccount extends FinancialAccountRecord {
  glAccountCodeValue: string;
}

/** Load one financial account for a write: it must exist, be active and be of this tenant. */
async function loadAccountForWrite(
  client: PoolClient,
  businessId: string,
  accountId: string,
  role: "source" | "destination",
): Promise<FinancialAccountRecord> {
  if (!isUuid(accountId)) {
    throw new FinancialTransferError(
      role === "source" ? "source_account_not_found" : "destination_account_not_found",
      404,
    );
  }
  const { rows } = await client.query<{
    id: string;
    kind: string;
    name: string;
    gl_account_id: string;
    currency_code: string;
    location_id: string | null;
    is_active: boolean;
  }>(
    `SELECT id, kind::text AS kind, name, gl_account_id, currency_code, location_id, is_active
       FROM financial_accounts
      WHERE business_id = $1 AND id = $2
      FOR UPDATE`,
    [businessId, accountId],
  );
  const row = rows[0];
  if (!row) {
    throw new FinancialTransferError(
      role === "source" ? "source_account_not_found" : "destination_account_not_found",
      404,
    );
  }
  if (!row.is_active) {
    throw new FinancialTransferError(role === "source" ? "source_account_archived" : "destination_account_archived", 409);
  }
  return {
    id: row.id,
    kind: row.kind as FinancialAccountRecord["kind"],
    code: null,
    name: row.name,
    glAccountId: row.gl_account_id,
    glAccountCode: "",
    glAccountName: "",
    currencyCode: row.currency_code,
    locationId: row.location_id,
    locationName: null,
    isActive: true,
    isDefault: false,
    description: null,
    notes: null,
    bankName: null,
    bankBranchName: null,
    accountNumber: null,
    cardNumber: null,
    iban: null,
    accountHolder: null,
    settlementReference: null,
    pspProvider: null,
    terminalNumber: null,
    merchantNumber: null,
    settlementAccountId: null,
    settlementAccountName: null,
    settlementDelayDays: null,
    balance: "0",
    transferCount: 0,
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
  };
}

/** Branch scope: a branch-scoped account needs access to that branch; a business-wide one needs none. */
function assertBranchAccess(
  account: FinancialAccountRecord,
  allowedLocationIds: readonly string[] | null | undefined,
  role: "source" | "destination",
): void {
  if (!account.locationId) return;
  if (!allowedLocationIds) return;
  if (allowedLocationIds.includes(account.locationId)) return;
  throw new FinancialTransferError(role === "source" ? "no_source_branch_access" : "no_destination_branch_access", 403);
}

async function assertFeeAccount(
  client: PoolClient,
  businessId: string,
  feeAccountId: string,
): Promise<void> {
  if (!isUuid(feeAccountId)) throw new FinancialTransferError("invalid_gl_account");
  const { rows } = await client.query<{ id: string; type: string; is_active: boolean }>(
    "SELECT id, type::text AS type, is_active FROM accounts WHERE business_id = $1 AND id = $2",
    [businessId, feeAccountId],
  );
  const row = rows[0];
  if (!row) throw new FinancialTransferError("fee_account_not_found", 404);
  if (row.type !== "expense" || !row.is_active) throw new FinancialTransferError("fee_account_invalid", 409);
}

async function assertProject(client: PoolClient, businessId: string, projectId: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM ai_projects WHERE business_id = $1 AND id = $2",
    [businessId, projectId],
  );
  if (!rows[0]) throw new FinancialTransferError("project_not_found", 404);
}

async function assertAttachment(client: PoolClient, businessId: string, assetId: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM media_assets WHERE business_id = $1 AND id = $2",
    [businessId, assetId],
  );
  if (!rows[0]) throw new FinancialTransferError("attachment_not_found", 404);
}

interface ResolvedRate {
  id: string;
  rate: string;
  precision: number;
}

/**
 * The rate a foreign transfer books at: the latest row effective at or before
 * the transfer date, skipping voided rows — the same lookup the multicurrency
 * engine performs for every other foreign document (issue #863).
 *
 * A currency with no rate is `currency_rate_missing`, never a rate the system
 * thought up: converting at an invented figure is exactly what the issue
 * forbids.
 */
async function resolveTransferRate(
  client: PoolClient,
  businessId: string,
  currencyCode: string,
  transferDate: string,
): Promise<ResolvedRate> {
  const { rows: currency } = await client.query<{ precision: number; is_active: boolean }>(
    "SELECT precision, is_active FROM currencies WHERE code = $1",
    [currencyCode],
  );
  if (!currency[0]) throw new FinancialTransferError("invalid_currency");
  const { rows } = await client.query<{ id: string; rate: string }>(
    `SELECT r.id, trim_scale(r.rate)::text AS rate
       FROM exchange_rates r
       LEFT JOIN exchange_rate_voids v ON v.rate_id = r.id
      WHERE r.business_id = $1 AND r.currency_code = $2
        AND r.effective_from <= ($3::date + interval '1 day' - interval '1 second')
        AND v.id IS NULL
      ORDER BY r.effective_from DESC
      LIMIT 1`,
    [businessId, currencyCode, transferDate],
  );
  if (!rows[0]) throw new FinancialTransferError("currency_rate_missing", 409);
  return { id: rows[0].id, rate: rows[0].rate, precision: currency[0].precision };
}

/**
 * Convert a transfer's foreign legs to base Rial, absorbing the residual on the
 * largest credit leg so the entry balances to the rial.
 *
 * The residual is the same one the multicurrency engine documents: each line
 * rounds half-up independently, so a document balanced in the foreign currency
 * can miss by a few Rial once converted. Absorbing it on one leg (rather than
 * refusing) is what keeps the ledger's own invariant — debits = credits — true
 * by construction; the absorbed amount is stamped on the entry as
 * `rounding_delta` so the arithmetic stays auditable.
 */
export function convertTransferLinesToBase(
  lines: readonly TransferLine[],
  rate: string,
  precision: number,
): { lines: ExactJournalLine[]; roundingDelta: string; baseTotal: string } {
  const converted = lines.map((line) => ({
    accountId: line.accountId,
    foreignDebit: line.debit,
    foreignCredit: line.credit,
    baseDebit: BigInt(convertToBaseMinor(BigInt(line.debit), rate, precision).toString()),
    baseCredit: BigInt(convertToBaseMinor(BigInt(line.credit), rate, precision).toString()),
  }));
  const exactDebit = converted.reduce((total, line) => total + line.baseDebit, 0n);
  const exactCredit = converted.reduce((total, line) => total + line.baseCredit, 0n);
  let roundingDelta = 0n;
  if (exactDebit > exactCredit) {
    // The credit side is short: the largest credit leg takes the difference.
    let index = -1;
    for (let i = 0; i < converted.length; i += 1) {
      if (converted[i].baseCredit === 0n) continue;
      if (index === -1 || converted[i].baseCredit > converted[index].baseCredit) index = i;
    }
    roundingDelta = exactDebit - exactCredit;
    if (index >= 0) converted[index].baseCredit += roundingDelta;
  } else if (exactCredit > exactDebit) {
    let index = -1;
    for (let i = 0; i < converted.length; i += 1) {
      if (converted[i].baseDebit === 0n) continue;
      if (index === -1 || converted[i].baseDebit > converted[index].baseDebit) index = i;
    }
    roundingDelta = exactCredit - exactDebit;
    if (index >= 0) converted[index].baseDebit += roundingDelta;
  }
  const baseTotal = converted.reduce((total, line) => total + line.baseDebit, 0n).toString();
  return {
    lines: converted.map((line) => ({
      accountId: line.accountId,
      debit: line.baseDebit.toString() as RialText,
      credit: line.baseCredit.toString() as RialText,
      foreignDebit: line.foreignDebit as RialText,
      foreignCredit: line.foreignCredit as RialText,
    })),
    roundingDelta: roundingDelta.toString(),
    baseTotal,
  };
}

export interface CreateTransferParams {
  businessId: string;
  actorId: string | null;
  locationId: string | null;
  input: TransferRequestInput;
  allowedLocationIds?: readonly string[] | null;
  /** The idempotency key from the `Idempotency-Key` header, when the body has none. */
  headerIdempotencyKey?: string | null;
}

export interface TransferWriteResult {
  transfer: FinancialTransferRecord;
  /** True when this call returned a document that already existed. */
  duplicate: boolean;
}

/** Create and post one transfer. */
export async function createFinancialTransfer(params: CreateTransferParams): Promise<TransferWriteResult> {
  const problem = transferRequestProblem(params.input);
  if (problem) throw new FinancialTransferError(problem.code);
  const idempotencyKey =
    (typeof params.input.idempotencyKey === "string" && params.input.idempotencyKey.trim()
      ? params.input.idempotencyKey.trim()
      : params.headerIdempotencyKey?.trim()) || null;
  const transferDate = String(params.input.transferDate);
  const amount = amountToRialText(params.input.amount, "amount")!;
  const feeAmount =
    params.input.feeAmount === undefined || params.input.feeAmount === null || params.input.feeAmount === ""
      ? "0"
      : amountToRialText(params.input.feeAmount, "feeAmount")!;
  const feePayer: TransferFeePayer = isTransferFeePayer(params.input.feePayer) ? params.input.feePayer : "source";
  const feeAccountId =
    typeof params.input.feeAccountId === "string" && params.input.feeAccountId ? params.input.feeAccountId : null;
  const projectId =
    typeof params.input.projectId === "string" && params.input.projectId ? params.input.projectId : null;
  const attachmentAssetId =
    typeof params.input.attachmentAssetId === "string" && params.input.attachmentAssetId
      ? params.input.attachmentAssetId
      : null;
  const locationId = params.locationId?.trim() ? params.locationId.trim() : null;
  if (locationId && !isUuid(locationId)) throw new FinancialTransferError("invalid_location");
  if (locationId && params.allowedLocationIds && !params.allowedLocationIds.includes(locationId)) {
    throw new FinancialTransferError("no_branch_access", 403);
  }
  const today = await businessToday(params.businessId);
  if (transferDate > today) throw new FinancialTransferError("transfer_date_in_future");

  const hash = requestHash({
    transferDate,
    sourceAccountId: String(params.input.sourceAccountId),
    destinationAccountId: String(params.input.destinationAccountId),
    amount,
    feeAmount,
    feeAccountId,
    feePayer,
    projectId,
    attachmentAssetId,
  });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockTransfers(client, params.businessId);

    if (idempotencyKey) {
      const existing = await findByKey(client, params.businessId, idempotencyKey);
      if (existing) {
        if (existing.idempotency_hash && existing.idempotency_hash !== hash) {
          throw new FinancialTransferError("idempotency_conflict", 409);
        }
        await client.query("COMMIT");
        return { transfer: toRecord(existing), duplicate: true };
      }
    }

    const source = await loadAccountForWrite(client, params.businessId, String(params.input.sourceAccountId), "source");
    const destination = await loadAccountForWrite(
      client,
      params.businessId,
      String(params.input.destinationAccountId),
      "destination",
    );
    assertBranchAccess(source, params.allowedLocationIds, "source");
    assertBranchAccess(destination, params.allowedLocationIds, "destination");
    // The requirement the issue states outright: two accounts that resolve to
    // the same GL identity cannot be transferred between, because the entry
    // would cancel itself out and the register would record a movement that
    // never happened.
    if (source.glAccountId === destination.glAccountId) {
      throw new FinancialTransferError("same_gl_account", 409);
    }
    // Never silently convert: a transfer is denominated in ONE currency, and
    // both accounts must hold it. A cross-currency move is a multicurrency
    // settlement (issue #863), not an internal transfer.
    if (source.currencyCode !== destination.currencyCode) {
      throw new FinancialTransferError("currency_mismatch", 409);
    }
    const currencyCode = source.currencyCode;
    if (feeAccountId) await assertFeeAccount(client, params.businessId, feeAccountId);
    if (projectId) await assertProject(client, params.businessId, projectId);
    if (attachmentAssetId) await assertAttachment(client, params.businessId, attachmentAssetId);

    const postingAccounts = {
      sourceGlAccountId: source.glAccountId,
      destinationGlAccountId: destination.glAccountId,
      feeGlAccountId: feeAccountId,
    };
    const postingInput = { amount, feeAmount, feePayer };
    const postingProblem = transferPostingProblem(postingAccounts, postingInput);
    if (postingProblem) {
      throw new FinancialTransferError(postingProblem);
    }
    const built = buildTransferLines(postingAccounts, postingInput)!;

    const baseCurrency = (
      await client.query<{ base_currency_code: string }>(
        "SELECT base_currency_code FROM businesses WHERE id = $1",
        [params.businessId],
      )
    ).rows[0]?.base_currency_code ?? "IRR";

    const isForeign = currencyCode !== baseCurrency;
    let lines: ExactJournalLine[];
    let currencySnapshot: {
      currencyCode: string | null;
      baseCurrencyCode: string;
      exchangeRateId: string | null;
      exchangeRate: string | null;
      roundingVersion: number | null;
      roundingDelta: string;
    } = {
      currencyCode: null,
      baseCurrencyCode: baseCurrency,
      exchangeRateId: null,
      exchangeRate: null,
      roundingVersion: null,
      roundingDelta: "0",
    };
    if (isForeign) {
      const rate = await resolveTransferRate(client, params.businessId, currencyCode, transferDate);
      const converted = convertTransferLinesToBase(built.lines, rate.rate, rate.precision);
      lines = converted.lines;
      currencySnapshot = {
        currencyCode,
        baseCurrencyCode: baseCurrency,
        exchangeRateId: rate.id,
        exchangeRate: rate.rate,
        roundingVersion: ROUNDING_POLICY_VERSION,
        roundingDelta: converted.roundingDelta,
      };
    } else {
      lines = built.lines.map((line) => ({
        accountId: line.accountId,
        debit: line.debit as RialText,
        credit: line.credit as RialText,
      }));
    }

    const { rows: sequenceRows } = await client.query<{ next: string }>(
      "SELECT (COALESCE(MAX(sequence_no), 0) + 1)::text AS next FROM financial_transfers WHERE business_id = $1",
      [params.businessId],
    );
    const sequenceNo = sequenceRows[0]?.next ?? "1";
    const transferId = randomUUID();
    const entryId = await postExactJournalEntry(client, {
      businessId: params.businessId,
      locationId,
      entryDate: transferDate,
      memo: `انتقال وجه ${transferNumberFor(sequenceNo)}`,
      sourceType: "financial_transfer",
      sourceId: transferId,
      createdBy: params.actorId,
      postingKind: "transfer",
      projectId,
      lines,
      currencyCode: currencySnapshot.currencyCode,
      baseCurrencyCode: currencySnapshot.baseCurrencyCode,
      exchangeRateId: currencySnapshot.exchangeRateId,
      exchangeRate: currencySnapshot.exchangeRate,
      roundingVersion: currencySnapshot.roundingVersion,
      roundingDelta: currencySnapshot.roundingDelta,
      // The journal's own idempotency key: a concurrent retry that slipped past
      // the lookup above collides here and posts one entry, not two.
      journalIdempotencyKey: idempotencyKey ? `financial_transfer:${idempotencyKey}` : null,
    });
    if (!entryId) throw new FinancialTransferError("bad_request");

    try {
      await client.query(
        `INSERT INTO financial_transfers (
            id, business_id, location_id, transfer_number, sequence_no, transfer_date,
            source_account_id, destination_account_id, amount, fee_amount, fee_account_id, fee_payer,
            currency_code, reference_number, description, project_id, attachment_asset_id,
            status, posting_mode, journal_entry_id, idempotency_key, idempotency_hash, created_by
         ) VALUES (
            $1, $2, $3, $4, $5, $6::date,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17,
            'posted', 'transfer', $18, $19, $20, $21
         )`,
        [
          transferId,
          params.businessId,
          locationId,
          transferNumberFor(sequenceNo),
          sequenceNo,
          transferDate,
          source.id,
          destination.id,
          amount,
          feeAmount,
          feeAccountId,
          feePayer,
          currencyCode,
          typeof params.input.referenceNumber === "string" && params.input.referenceNumber.trim()
            ? params.input.referenceNumber.trim()
            : null,
          typeof params.input.description === "string" && params.input.description.trim()
            ? params.input.description.trim()
            : null,
          projectId,
          attachmentAssetId,
          entryId,
          idempotencyKey,
          idempotencyKey ? hash : null,
          params.actorId,
        ],
      );
    } catch (err) {
      if (sqlState(err) === UNIQUE_VIOLATION) {
        const constraint = constraintName(err);
        if (constraint.includes("idempotency")) {
          // The loser of a race: the winner's document is the answer.
          await client.query("ROLLBACK");
          const winner = await findByKey(pool as unknown as Queryable, params.businessId, idempotencyKey!);
          if (winner) return { transfer: toRecord(winner), duplicate: true };
          throw new FinancialTransferError("transfer_reversal_conflict", 409);
        }
        if (constraint.includes("number") || constraint.includes("sequence")) {
          throw new FinancialTransferError("transfer_number_conflict", 409);
        }
      }
      if (sqlState(err) === CHECK_VIOLATION) {
        const message = String((err as { message?: string }).message ?? "");
        if (message.includes("financial_transfer_cross_tenant")) {
          throw new FinancialTransferError("cross_tenant_reference", 403);
        }
        throw new FinancialTransferError("bad_request");
      }
      throw err;
    }

    await auditTransfer(client, {
      businessId: params.businessId,
      locationId,
      actorId: params.actorId,
      action: "financial_transfer.posted",
      transferId,
      payload: {
        transferNumber: transferNumberFor(sequenceNo),
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amount,
        feeAmount,
        feePayer,
        currencyCode,
        journalEntryId: entryId,
      },
    });

    await client.query("COMMIT");
    const transfer = await getFinancialTransfer(params.businessId, transferId);
    if (!transfer) throw new FinancialTransferError("transfer_not_found", 404);
    return { transfer, duplicate: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Minimal query surface: a transaction client or the module-level helper. */
type Queryable = {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
};

async function findByKey(
  source: Queryable,
  businessId: string,
  idempotencyKey: string,
): Promise<TransferRow | null> {
  const { rows } = await source.query<TransferRow>(
    `${SELECT_TRANSFER} WHERE t.business_id = $1 AND t.idempotency_key = $2`,
    [businessId, idempotencyKey],
  );
  return rows[0] ?? null;
}

async function auditTransfer(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string | null;
    actorId: string | null;
    action: string;
    transferId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, 'financial_transfer', $5, $6)`,
    [params.businessId, params.locationId, params.actorId, params.action, params.transferId, JSON.stringify(params.payload)],
  );
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

export interface ReverseTransferParams {
  businessId: string;
  transferId: string;
  actorId: string | null;
  reason: string;
  reversalDate?: string | null;
  idempotencyKey?: string | null;
  allowedLocationIds?: readonly string[] | null;
}

export interface ReverseTransferResult {
  transfer: FinancialTransferRecord;
  reversalEntryId: string;
  duplicate: boolean;
}

/**
 * Reverse a posted transfer.
 *
 * The mirror entry is built from the ORIGINAL entry's own lines — every leg
 * swapped, dimensions and the multicurrency snapshot carried across — rather
 * than by re-running the builder. That is not a stylistic choice: re-deriving
 * the entry from the reversal's fields would recognise the fee a second time as
 * an expense instead of crediting it back, and a foreign transfer would be
 * re-converted at today's rate instead of the one it was booked at (which is
 * how reversing at a later rate quietly rewrites history).
 */
export async function reverseFinancialTransfer(
  params: ReverseTransferParams,
): Promise<ReverseTransferResult> {
  if (!isUuid(params.transferId)) throw new FinancialTransferError("transfer_not_found", 404);
  const reason = (params.reason ?? "").trim();
  if (!reason) throw new FinancialTransferError("reversal_reason_required");
  if (reason.length > 400) throw new FinancialTransferError("invalid_reversal_reason");
  const reversalDateInput = params.reversalDate?.trim() ?? "";
  if (reversalDateInput && !isValidIsoDate(reversalDateInput)) {
    throw new FinancialTransferError("invalid_transfer_date");
  }
  const today = await businessToday(params.businessId);
  const reversalDate = reversalDateInput || today;
  if (reversalDate > today) throw new FinancialTransferError("transfer_date_in_future");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockTransfers(client, params.businessId);

    const { rows } = await client.query<TransferRow>(
      `${SELECT_TRANSFER} WHERE t.business_id = $1 AND t.id = $2 FOR UPDATE OF t`,
      [params.businessId, params.transferId],
    );
    const original = rows[0];
    if (!original) throw new FinancialTransferError("transfer_not_found", 404);
    if (original.posting_mode === "reversal") throw new FinancialTransferError("transfer_not_reversible", 409);

    const idempotencyKey = params.idempotencyKey?.trim() || null;
    if (original.status === "reversed") {
      const { rows: existingRows } = await client.query<TransferRow>(
        `${SELECT_TRANSFER} WHERE t.reverses_transfer_id = $1`,
        [params.transferId],
      );
      const existing = existingRows[0];
      if (existing && idempotencyKey && existing.idempotency_key === idempotencyKey) {
        await client.query("COMMIT");
        return {
          transfer: toRecord(existing),
          reversalEntryId: existing.journal_entry_id,
          duplicate: true,
        };
      }
      throw new FinancialTransferError("transfer_already_reversed", 409);
    }
    assertBranchAccess(
      { locationId: original.location_id } as FinancialAccountRecord,
      params.allowedLocationIds,
      "source",
    );

    const { rows: entryRows } = await client.query<{
      id: string;
      currency_code: string | null;
      base_currency_code: string;
      exchange_rate_id: string | null;
      exchange_rate: string | null;
      rounding_version: number | null;
      project_id: string | null;
      location_id: string | null;
      memo: string | null;
    }>(
      `SELECT id, currency_code, base_currency_code, exchange_rate_id, exchange_rate,
              rounding_version, rounding_delta, project_id, location_id, memo
         FROM journal_entries WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [original.journal_entry_id, params.businessId],
    );
    const originalEntry = entryRows[0];
    if (!originalEntry) throw new FinancialTransferError("transfer_not_found", 404);

    const { rows: originalLines } = await client.query<{
      account_id: string;
      debit: string;
      credit: string;
      foreign_debit: string;
      foreign_credit: string;
      cost_center_id: string | null;
      profit_center_id: string | null;
      department_id: string | null;
      detail_dimension_id: string | null;
    }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit,
              foreign_debit::text AS foreign_debit, foreign_credit::text AS foreign_credit,
              cost_center_id, profit_center_id, department_id, detail_dimension_id
         FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [original.journal_entry_id],
    );
    if (originalLines.length === 0) throw new FinancialTransferError("transfer_not_found", 404);

    const mirrorLines: ExactJournalLine[] = originalLines.map((line) => ({
      accountId: line.account_id,
      debit: line.credit as RialText,
      credit: line.debit as RialText,
      dimensions: {
        cost_center: line.cost_center_id,
        profit_center: line.profit_center_id,
        department: line.department_id,
        detail: line.detail_dimension_id,
      },
      foreignDebit: line.foreign_credit as RialText,
      foreignCredit: line.foreign_debit as RialText,
    }));

    const { rows: sequenceRows } = await client.query<{ next: string }>(
      "SELECT (COALESCE(MAX(sequence_no), 0) + 1)::text AS next FROM financial_transfers WHERE business_id = $1",
      [params.businessId],
    );
    const sequenceNo = sequenceRows[0]?.next ?? "1";
    const reversalId = randomUUID();
    const hash = requestHash({
      transferDate: reversalDate,
      sourceAccountId: original.destination_account_id,
      destinationAccountId: original.source_account_id,
      amount: original.amount,
      feeAmount: original.fee_amount,
      feeAccountId: original.fee_account_id,
      feePayer: original.fee_payer,
      projectId: original.project_id,
      attachmentAssetId: null,
      reversalOf: original.id,
    });

    const reversalEntryId = await postExactJournalEntry(client, {
      businessId: params.businessId,
      locationId: originalEntry.location_id,
      entryDate: reversalDate,
      memo: `برگشت انتقال وجه ${original.transfer_number}`,
      sourceType: "financial_transfer",
      sourceId: reversalId,
      createdBy: params.actorId,
      postingKind: "transfer_reversal",
      projectId: originalEntry.project_id,
      lines: mirrorLines,
      // The mirror copies lines that already exist, so the dimension policy is
      // not re-decided (the same rule a manual-journal reversal follows).
      dimensionMirror: true,
      currencyCode: originalEntry.currency_code,
      baseCurrencyCode: originalEntry.base_currency_code,
      exchangeRateId: originalEntry.exchange_rate_id,
      exchangeRate: originalEntry.exchange_rate,
      roundingVersion: originalEntry.rounding_version,
      roundingDelta: "0",
      journalIdempotencyKey: idempotencyKey ? `financial_transfer_reversal:${idempotencyKey}` : null,
    });
    if (!reversalEntryId) throw new FinancialTransferError("bad_request");

    // The two journals point at each other, exactly as a manual-journal reversal
    // does, so the journal screen shows the pair without a second lookup.
    await client.query("UPDATE journal_entries SET reverses_entry_id = $2 WHERE id = $1", [
      reversalEntryId,
      original.journal_entry_id,
    ]);
    await client.query("UPDATE journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1", [
      original.journal_entry_id,
      params.actorId,
    ]);

    await client.query(
      `INSERT INTO financial_transfers (
          id, business_id, location_id, transfer_number, sequence_no, transfer_date,
          source_account_id, destination_account_id, amount, fee_amount, fee_account_id, fee_payer,
          currency_code, reference_number, description, project_id, attachment_asset_id,
          status, posting_mode, journal_entry_id, reverses_transfer_id, reversal_reason,
          idempotency_key, idempotency_hash, created_by
       ) VALUES (
          $1, $2, $3, $4, $5, $6::date,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, NULL,
          'posted', 'reversal', $17, $18, $19,
          $20, $21, $22
       )`,
      [
        reversalId,
        params.businessId,
        original.location_id,
        transferNumberFor(sequenceNo),
        sequenceNo,
        reversalDate,
        original.destination_account_id,
        original.source_account_id,
        original.amount,
        original.fee_amount,
        original.fee_account_id,
        original.fee_payer,
        original.currency_code,
        original.reference_number,
        `برگشت ${original.transfer_number}: ${reason}`,
        original.project_id,
        reversalEntryId,
        original.id,
        reason,
        idempotencyKey,
        idempotencyKey ? hash : null,
        params.actorId,
      ],
    );
    await client.query(
      `UPDATE financial_transfers
          SET status = 'reversed', reversal_entry_id = $3, reversed_at = now(), reversed_by = $4
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, original.id, reversalEntryId, params.actorId],
    );

    await auditTransfer(client, {
      businessId: params.businessId,
      locationId: original.location_id,
      actorId: params.actorId,
      action: "financial_transfer.reversed",
      transferId: original.id,
      payload: {
        transferNumber: original.transfer_number,
        reversalNumber: transferNumberFor(sequenceNo),
        reversalEntryId,
        reason,
        reversalDate,
      },
    });

    await client.query("COMMIT");
    const reversal = await getFinancialTransfer(params.businessId, reversalId);
    if (!reversal) throw new FinancialTransferError("transfer_not_found", 404);
    return { transfer: reversal, reversalEntryId, duplicate: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (sqlState(err) === UNIQUE_VIOLATION) {
      const constraint = constraintName(err);
      if (constraint.includes("reverses")) throw new FinancialTransferError("transfer_already_reversed", 409);
      if (constraint.includes("idempotency")) throw new FinancialTransferError("transfer_reversal_conflict", 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** The account's movement history, filtered to transfers — the register's own card. */
export async function listAccountTransfers(
  businessId: string,
  accountId: string,
  filters: Omit<TransferFilters, "accountId"> = {},
): Promise<TransferListResult> {
  return listFinancialTransfers(businessId, { ...filters, accountId });
}

/**
 * Every transfer of a filtered register, a page at a time — what an export needs.
 *
 * The register itself must never fetch a business's whole history to draw a
 * screen, so `listFinancialTransfers` caps a page at 200 rows. An *export* is the
 * opposite request: the reader asked for all of it, and a file that silently
 * stops at 200 rows while claiming to be the register is worse than a refusal.
 * So the pages are walked here, in order, with a hard ceiling (`report_too_large`
 * past it) rather than an unbounded loop.
 */
export async function* iterateTransfersForExport(
  businessId: string,
  filters: TransferFilters = {},
  options: { maxRows?: number } = {},
): AsyncGenerator<FinancialTransferRecord> {
  const maxRows = options.maxRows ?? 20_000;
  const pageSize = 200;
  let offset = 0;
  let emitted = 0;
  for (;;) {
    const page = await listFinancialTransfers(businessId, { ...filters, limit: pageSize, offset });
    for (const transfer of page.transfers) {
      if (emitted >= maxRows) throw new FinancialTransferError("report_too_large", 413);
      emitted += 1;
      yield transfer;
    }
    if (page.transfers.length < pageSize) return;
    offset += pageSize;
  }
}

/** Exportable text for a code the API turned into a response. */
export function errorMessageForFinancialTransfer(code: string): string | null {
  return FINANCIAL_ACCOUNT_ERROR_MESSAGES[code] ?? null;
}
