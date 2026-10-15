/**
 * «حساب‌های مالی» — the DB-touching half (issue #862).
 *
 * The register of the business's own money containers (bank, cash, petty cash,
 * POS/PSP), each linked to exactly one postable GL account. Everything a screen
 * shows as a *balance* is summed here from `journal_lines` — this module has no
 * balance column, no cache and no running total anywhere, so an account card
 * and the trial balance cannot disagree.
 *
 * Shaped like `accounts-service.ts` beside it, and for the same reasons:
 *
 *  - **An id that cannot exist is a 404, never a 500.** Every id arrives from a
 *    URL or a body; `WHERE id = $1` against a `uuid` column raises
 *    `invalid input syntax` for anything else (see `uuid.ts`).
 *  - **The database's own constraints are error codes, not surprises.** The
 *    unique index on `(business_id, gl_account_id)` and the archive-state CHECK
 *    are the real guards against a concurrent writer; the SELECTs before them
 *    only make the common case report nicely, so a lost race still comes back
 *    as `financial_account_already_linked` rather than «خطای غیرمنتظره».
 *  - **One edit is one transaction**, with its audit row, so a half-applied
 *    update cannot leave the screen showing an error beside a change that
 *    actually happened.
 *  - **Writes are serialized per business** with an advisory xact lock, so two
 *    concurrent "make this the default" requests cannot both pass the check and
 *    both commit.
 *
 * DB-touching, so per repo convention it has no direct unit test: the rules it
 * enforces live in the framework-free `financial-accounts.ts` (unit-tested),
 * and its behaviour is covered by
 * `integration/financial-accounts.integration.test.ts`.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { isUuid } from "./uuid";
import { isValidIsoDate } from "./iso-date";
import { toLatinDigits } from "./digits";
import { classifyAccounts } from "./account-classification";
import {
  FINANCIAL_ACCOUNT_KIND_META,
  classifyGlAccountForKind,
  eligibleGlAccountsForKind,
  financialAccountInputProblem,
  isFinancialAccountKind,
  isZeroBalance,
  normalizeIdentifier,
  type FinancialAccountFieldsInput,
  type FinancialAccountKind,
} from "./financial-accounts";
import { balanceFromLines, type AccountCardMovement } from "./financial-accounts";
import { accountCardFromMovements, type AccountCard } from "./financial-accounts";

export class FinancialAccountError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** Postgres SQLSTATEs this file translates into its own error codes. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

function sqlState(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

function constraintName(err: unknown): string | undefined {
  return typeof err === "object" && err !== null
    ? (err as { constraint?: string }).constraint
    : undefined;
}

/** A raw unique-index violation, named for the caller. */
function uniqueViolationCode(err: unknown): string {
  const constraint = constraintName(err) ?? "";
  if (constraint.includes("gl_account")) return "financial_account_already_linked";
  if (constraint.includes("code")) return "financial_account_code_in_use";
  if (constraint.includes("default")) return "financial_account_default_conflict";
  return "financial_account_conflict";
}

/** Escapes a user term for `ILIKE`, so `%` and `_` are searched literally. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Serialize hierarchy/register writes per business.
 *
 * `accounts-service.ts` takes `chart-of-accounts:<businessId>` for its own
 * writes; this is a separate key because the two locks protect different
 * invariants and must not deadlock against each other (a financial account's
 * create reads the chart, but never holds the chart's lock).
 */
async function lockRegister(client: PoolClient, businessId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`financial-accounts:${businessId}`]);
}

export interface FinancialAccountRecord {
  id: string;
  kind: FinancialAccountKind;
  code: string | null;
  name: string;
  glAccountId: string;
  glAccountCode: string;
  glAccountName: string;
  currencyCode: string;
  locationId: string | null;
  locationName: string | null;
  isActive: boolean;
  isDefault: boolean;
  description: string | null;
  notes: string | null;
  bankName: string | null;
  bankBranchName: string | null;
  accountNumber: string | null;
  cardNumber: string | null;
  iban: string | null;
  accountHolder: string | null;
  settlementReference: string | null;
  pspProvider: string | null;
  terminalNumber: string | null;
  merchantNumber: string | null;
  settlementAccountId: string | null;
  settlementAccountName: string | null;
  settlementDelayDays: number | null;
  /** Exact Rial, as decimal text, read from the ledger (debit − credit). */
  balance: string;
  transferCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface FinancialAccountRow extends Record<string, unknown> {
  id: string;
  kind: FinancialAccountKind;
  code: string | null;
  name: string;
  gl_account_id: string;
  gl_account_code: string;
  gl_account_name: string;
  currency_code: string;
  location_id: string | null;
  location_name: string | null;
  is_active: boolean;
  is_default: boolean;
  description: string | null;
  notes: string | null;
  bank_name: string | null;
  bank_branch_name: string | null;
  account_number: string | null;
  card_number: string | null;
  iban: string | null;
  account_holder: string | null;
  settlement_reference: string | null;
  psp_provider: string | null;
  terminal_number: string | null;
  merchant_number: string | null;
  settlement_account_id: string | null;
  settlement_account_name: string | null;
  settlement_delay_days: number | null;
  balance: string | null;
  transfer_count: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toRecord(row: FinancialAccountRow): FinancialAccountRecord {
  return {
    id: row.id,
    kind: row.kind,
    code: row.code,
    name: row.name,
    glAccountId: row.gl_account_id,
    glAccountCode: row.gl_account_code,
    glAccountName: row.gl_account_name,
    currencyCode: row.currency_code,
    locationId: row.location_id,
    locationName: row.location_name,
    isActive: row.is_active,
    isDefault: row.is_default,
    description: row.description,
    notes: row.notes,
    bankName: row.bank_name,
    bankBranchName: row.bank_branch_name,
    accountNumber: row.account_number,
    cardNumber: row.card_number,
    iban: row.iban,
    accountHolder: row.account_holder,
    settlementReference: row.settlement_reference,
    pspProvider: row.psp_provider,
    terminalNumber: row.terminal_number,
    merchantNumber: row.merchant_number,
    settlementAccountId: row.settlement_account_id,
    settlementAccountName: row.settlement_account_name,
    settlementDelayDays: row.settlement_delay_days,
    balance: row.balance ?? "0",
    transferCount: Number(row.transfer_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/**
 * The register's columns, with the balance summed from the ledger for every
 * account in one statement.
 *
 * `SUM(bigint)::text` rather than a number: a busy till's lifetime movement is
 * exact integer Rial, and the driver hands a `numeric` back as text anyway —
 * printing it back as text keeps the whole path lossless from the database to
 * the screen.
 */
const SELECT_COLUMNS = `
  fa.id, fa.kind, fa.code, fa.name, fa.gl_account_id, fa.currency_code, fa.location_id,
  fa.is_active, fa.is_default, fa.description, fa.notes,
  fa.bank_name, fa.bank_branch_name, fa.account_number, fa.card_number, fa.iban,
  fa.account_holder, fa.settlement_reference,
  fa.psp_provider, fa.terminal_number, fa.merchant_number, fa.settlement_account_id,
  fa.settlement_delay_days, fa.created_at, fa.updated_at, fa.archived_at,
  a.code AS gl_account_code, a.name AS gl_account_name,
  l.name AS location_name,
  sa.name AS settlement_account_name,
  COALESCE(bal.balance, 0)::text AS balance,
  COALESCE(tc.transfer_count, 0)::text AS transfer_count
`;

const SELECT_JOINS = `
  JOIN accounts a ON a.id = fa.gl_account_id
  LEFT JOIN locations l ON l.id = fa.location_id
  LEFT JOIN financial_accounts sa ON sa.id = fa.settlement_account_id
  LEFT JOIN (
    SELECT jl.account_id, SUM(jl.debit - jl.credit) AS balance
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
     WHERE e.business_id = $1
     GROUP BY jl.account_id
  ) bal ON bal.account_id = fa.gl_account_id
  LEFT JOIN (
    SELECT account_id, count(*) AS transfer_count
      FROM (
        SELECT source_account_id AS account_id FROM financial_transfers WHERE business_id = $1
        UNION ALL
        SELECT destination_account_id AS account_id FROM financial_transfers WHERE business_id = $1
      ) movements
     GROUP BY account_id
  ) tc ON tc.account_id = fa.id
`;

export interface FinancialAccountFilters {
  kind?: FinancialAccountKind;
  /** `active` (default), `archived`, or `all`. */
  status?: "active" | "archived" | "all";
  locationId?: string | null;
  /** Free text over name, code, bank name and terminal number. */
  q?: string;
  /** Only the default account of each kind/scope. */
  defaultOnly?: boolean;
  /** Only accounts of these branches plus the business-wide ones. */
  restrictToLocationIds?: readonly string[];
}

export interface FinancialAccountListResult {
  accounts: FinancialAccountRecord[];
  /** Exact Rial per kind, as decimal text. */
  totalsByKind: Record<FinancialAccountKind, string>;
  totalBalance: string;
  activeCount: number;
  archivedCount: number;
}

/** The register: every account with its ledger-derived balance, plus the per-kind totals. */
export async function listFinancialAccounts(
  businessId: string,
  filters: FinancialAccountFilters = {},
): Promise<FinancialAccountListResult> {
  if (filters.kind && !isFinancialAccountKind(filters.kind)) {
    throw new FinancialAccountError("invalid_kind");
  }
  if (filters.locationId != null && filters.locationId !== "" && !isUuid(filters.locationId)) {
    throw new FinancialAccountError("invalid_location");
  }
  const conditions: string[] = ["fa.business_id = $1"];
  const params: unknown[] = [businessId];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.kind) conditions.push(`fa.kind = ${push(filters.kind)}::financial_account_kind`);
  const status = filters.status ?? "active";
  if (status === "active") conditions.push("fa.is_active");
  else if (status === "archived") conditions.push("NOT fa.is_active");
  if (filters.locationId) conditions.push(`fa.location_id = ${push(filters.locationId)}`);
  if (filters.defaultOnly) conditions.push("fa.is_default");
  if (filters.restrictToLocationIds) {
    const ids = filters.restrictToLocationIds.filter((id) => isUuid(id));
    // A member assigned to branches sees those branches' accounts plus the
    // business-wide ones (location_id IS NULL), which belong to nobody's branch.
    conditions.push(
      ids.length > 0
        ? `(fa.location_id IS NULL OR fa.location_id = ANY(${push(ids)}::uuid[]))`
        : "fa.location_id IS NULL",
    );
  }
  const term = filters.q?.trim();
  if (term) {
    const pattern = `%${escapeLikePattern(term)}%`;
    const like = push(pattern);
    const digits = normalizeIdentifier(term);
    conditions.push(
      `(fa.name ILIKE ${like} OR fa.code ILIKE ${like} OR fa.bank_name ILIKE ${like}
        OR fa.terminal_number ILIKE ${like} OR a.code ILIKE ${like} OR a.name ILIKE ${like}
        ${digits ? `OR fa.account_number LIKE ${push(`%${digits}%`)} OR fa.card_number LIKE ${push(`%${digits}%`)} OR fa.iban ILIKE ${push(`%${digits.toUpperCase()}%`)} OR fa.merchant_number ILIKE ${push(`%${digits}%`)}` : ""})`,
    );
  }

  const { rows } = await query<FinancialAccountRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM financial_accounts fa
       ${SELECT_JOINS}
      WHERE ${conditions.join(" AND ")}
      ORDER BY fa.kind, a.code, fa.name`,
    params,
  );
  const accounts = rows.map(toRecord);

  // The totals come from the same rows the list shows, so the summary line can
  // never disagree with the table under it. (A per-kind SQL aggregate would be a
  // second answer to one question.)
  const totalsByKind = Object.fromEntries(
    (Object.keys(FINANCIAL_ACCOUNT_KIND_META) as FinancialAccountKind[]).map((kind) => [kind, "0"]),
  ) as Record<FinancialAccountKind, string>;
  let total = 0n;
  for (const account of accounts) {
    const value = BigInt(account.balance);
    total += value;
    if (account.isActive) totalsByKind[account.kind] = (BigInt(totalsByKind[account.kind]) + value).toString();
  }
  return {
    accounts,
    totalsByKind,
    totalBalance: total.toString(),
    activeCount: accounts.filter((account) => account.isActive).length,
    archivedCount: accounts.filter((account) => !account.isActive).length,
  };
}

export async function getFinancialAccount(
  businessId: string,
  accountId: string,
): Promise<FinancialAccountRecord | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await query<FinancialAccountRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM financial_accounts fa
       ${SELECT_JOINS}
      WHERE fa.business_id = $1 AND fa.id = $2`,
    [businessId, accountId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The GL accounts eligible to back a financial account of `kind`. */
export async function eligibleGlAccounts(
  businessId: string,
  kind: FinancialAccountKind,
  options: { excludeAccountId?: string | null } = {},
): Promise<{ id: string; code: string; name: string; currencyCode: string | null }[]> {
  if (!isFinancialAccountKind(kind)) throw new FinancialAccountError("invalid_kind");
  const { rows } = await query<{
    id: string;
    code: string;
    name: string;
    parent_id: string | null;
    type: "asset" | "liability" | "equity" | "revenue" | "expense";
    currency_code: string | null;
    child_count: string;
    linked: boolean;
  }>(
    `SELECT a.id, a.code, a.name, a.parent_id, a.type, a.currency_code,
            (SELECT count(*) FROM accounts c WHERE c.parent_id = a.id)::text AS child_count,
            EXISTS (
              SELECT 1 FROM financial_accounts fa
               WHERE fa.business_id = a.business_id AND fa.gl_account_id = a.id
                 AND ($2::uuid IS NULL OR fa.id <> $2::uuid)
            ) AS linked
       FROM accounts a
      WHERE a.business_id = $1 AND a.is_active
      ORDER BY a.code`,
    [businessId, options.excludeAccountId ?? null],
  );
  const linked = new Set(rows.filter((row) => row.linked).map((row) => row.id));
  const parents = new Set(rows.filter((row) => Number(row.child_count) > 0).map((row) => row.id));
  return eligibleGlAccountsForKind(
    rows.map((row) => ({
      id: row.id,
      code: row.code,
      parentId: row.parent_id,
      type: row.type,
      name: row.name,
      currencyCode: row.currency_code,
      isActive: true,
    })),
    kind,
    { linkedAccountIds: linked, parentAccountIds: parents },
  ).map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    currencyCode: account.currencyCode ?? null,
  }));
}

/**
 * Resolve and validate one GL account for a financial account of `kind` —
 * tenant ownership, active, postable (a leaf), and the *right role*.
 *
 * This is the issue's "GL account eligibility" and "ownership checks on
 * referenced GL accounts" in one function, and it is the only place the check
 * exists: the create path, the update path, the transfer path and the payment
 * source lookup all come through here.
 */
export async function assertGlAccountForKind(
  client: Pick<PoolClient, "query">,
  businessId: string,
  glAccountId: string,
  kind: FinancialAccountKind,
  options: { allowLinkedAccountId?: string | null } = {},
): Promise<{ id: string; code: string; name: string; currencyCode: string | null }> {
  if (!isUuid(glAccountId)) throw new FinancialAccountError("invalid_gl_account");
  const { rows } = await client.query<{
    id: string;
    code: string;
    name: string;
    parent_id: string | null;
    type: "asset" | "liability" | "equity" | "revenue" | "expense";
    currency_code: string | null;
    child_count: string;
    linked_to: string | null;
  }>(
    `SELECT a.id, a.code, a.name, a.parent_id, a.type, a.currency_code,
            (SELECT count(*) FROM accounts c WHERE c.parent_id = a.id)::text AS child_count,
            (SELECT fa.id FROM financial_accounts fa
              WHERE fa.business_id = a.business_id AND fa.gl_account_id = a.id
                AND ($3::uuid IS NULL OR fa.id <> $3::uuid)
              LIMIT 1) AS linked_to
       FROM accounts a
      WHERE a.business_id = $1 AND a.id = $2`,
    [businessId, glAccountId, options.allowLinkedAccountId ?? null],
  );
  const account = rows[0];
  if (!account) throw new FinancialAccountError("gl_account_unavailable");
  const eligibility = classifyGlAccountForKind(
    {
      id: account.id,
      code: account.code,
      parentId: account.parent_id,
      type: account.type,
      isActive: true,
    },
    kind,
    {
      linkedAccountIds: account.linked_to ? new Set([account.id]) : new Set<string>(),
      parentAccountIds: Number(account.child_count) > 0 ? new Set([account.id]) : new Set<string>(),
    },
  );
  if (!eligibility.eligible) {
    if (eligibility.reason === "already_linked") throw new FinancialAccountError("financial_account_already_linked", 409);
    if (eligibility.reason === "inactive") throw new FinancialAccountError("gl_account_unavailable", 409);
    if (eligibility.reason === "not_asset") throw new FinancialAccountError("gl_account_not_postable", 409);
    if (eligibility.reason === "has_children") throw new FinancialAccountError("gl_account_is_parent", 409);
    // Either the account itself, or its kind, is unrecognised.
    throw new FinancialAccountError(
      account.type !== "asset" ? "gl_account_not_postable" : "gl_account_unclassified",
      409,
    );
  }
  return { id: account.id, code: account.code, name: account.name, currencyCode: account.currency_code };
}

/**
 * A container's currency must be one this business actually holds money in.
 *
 * This is deliberately *not* `assertCurrencyAvailable`, which answers a
 * different question: that function checks whether a currency may be used as a
 * **transaction** currency, and by design refuses the base currency
 * (`base_currency_not_a_transaction_currency`). A financial account is the
 * opposite case — the business's own bank account is almost always in its base
 * currency — so the rule here is: the currency must exist and be active in the
 * catalogue, and it must be either the base currency or one the business enabled
 * in «ارز و تسعیر». A container in a currency the business cannot post is how an
 * account card ends up reporting money the ledger never held.
 *
 * It reads through the caller's transaction client, so the check and the write
 * it guards see the same snapshot.
 */
export async function assertAccountCurrency(
  client: Pick<PoolClient, "query">,
  businessId: string,
  currencyCode: string,
): Promise<void> {
  const { rows } = await client.query<{
    is_active: boolean;
    base_currency_code: string;
    allowed: boolean;
  }>(
    `SELECT c.is_active,
            b.base_currency_code,
            (bc.currency_code IS NOT NULL AND bc.is_active) AS allowed
       FROM businesses b
       JOIN currencies c ON c.code = $2
       LEFT JOIN business_currencies bc ON bc.business_id = b.id AND bc.currency_code = $2
      WHERE b.id = $1`,
    [businessId, currencyCode],
  );
  const row = rows[0];
  if (!row) throw new FinancialAccountError("invalid_currency");
  if (!row.is_active) throw new FinancialAccountError("currency_not_available", 409);
  if (row.base_currency_code === currencyCode) return;
  if (!row.allowed) throw new FinancialAccountError("currency_not_available", 409);
}

/** The business's base currency — the default for a new financial account. */
export async function baseCurrencyOf(
  businessId: string,
  client: Pick<PoolClient, "query"> = getPool(),
): Promise<string> {
  const { rows } = await client.query<{ base_currency_code: string }>(
    "SELECT base_currency_code FROM businesses WHERE id = $1",
    [businessId],
  );
  return rows[0]?.base_currency_code ?? "IRR";
}

/** Write one audit row in the caller's transaction — created/updated/archived/default. */
async function audit(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string | null;
    userId: string | null;
    action: string;
    accountId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, 'financial_account', $5, $6)`,
    [params.businessId, params.locationId, params.userId, params.action, params.accountId, JSON.stringify(params.payload)],
  );
}

export interface CreateFinancialAccountParams {
  businessId: string;
  actorId: string | null;
  locationId: string | null;
  input: FinancialAccountFieldsInput;
  /**
   * Branches this caller may write to. `null` = every branch of the business;
   * a list restricts the write to those branches (or to a business-wide row).
   */
  allowedLocationIds?: readonly string[] | null;
}

export interface FinancialAccountWriteResult {
  id: string;
  /** The whole record as the register shows it, after the write. */
  account: FinancialAccountRecord;
}

/** Create one financial account, with its audit row, in one transaction. */
export async function createFinancialAccount(
  params: CreateFinancialAccountParams,
): Promise<FinancialAccountWriteResult> {
  const problem = financialAccountInputProblem(params.input);
  if (problem) throw new FinancialAccountError(problem.code);
  const kind = params.input.kind as FinancialAccountKind;
  const locationId = params.locationId?.trim() ? params.locationId.trim() : null;
  if (locationId && !isUuid(locationId)) throw new FinancialAccountError("invalid_location");
  if (locationId && params.allowedLocationIds && !params.allowedLocationIds.includes(locationId)) {
    throw new FinancialAccountError("no_branch_access", 403);
  }
  const currencyCode =
    typeof params.input.currencyCode === "string" && params.input.currencyCode.trim()
      ? params.input.currencyCode.trim().toUpperCase()
      : null;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRegister(client, params.businessId);
    const glAccountId = String(params.input.glAccountId);
    const glAccount = await assertGlAccountForKind(client, params.businessId, glAccountId, kind);
    const resolvedCurrency = currencyCode ?? (await baseCurrencyOf(params.businessId, client));
    await assertAccountCurrency(client, params.businessId, resolvedCurrency);
    // The GL account's own currency flag (issue #863) must agree with the
    // container's currency, or an account card would report dollars that the
    // ledger booked as Rial.
    if (glAccount.currencyCode && glAccount.currencyCode !== resolvedCurrency) {
      throw new FinancialAccountError("currency_not_available", 409);
    }

    const settlementAccountId = await resolveSettlementAccount(client, {
      businessId: params.businessId,
      kind,
      settlementAccountId: params.input.settlementAccountId,
      selfId: null,
    });

    const isDefault = params.input.isDefault === true;
    if (isDefault) {
      await clearDefault(client, { businessId: params.businessId, kind, locationId, exceptId: null });
    }

    let id: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO financial_accounts (
            business_id, location_id, kind, code, name, gl_account_id, currency_code,
            is_active, is_default, description, notes,
            bank_name, bank_branch_name, account_number, card_number, iban, account_holder, settlement_reference,
            psp_provider, terminal_number, merchant_number, settlement_account_id, settlement_delay_days,
            created_by, updated_by
         ) VALUES (
            $1, $2, $3::financial_account_kind, $4, $5, $6, $7,
            true, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20, $21, $22,
            $23, $23
         ) RETURNING id`,
        [
          params.businessId,
          locationId,
          kind,
          normalizeText(params.input.code),
          String(params.input.name).trim(),
          glAccountId,
          resolvedCurrency,
          isDefault,
          normalizeText(params.input.description),
          normalizeText(params.input.notes),
          normalizeText(params.input.bankName),
          normalizeText(params.input.bankBranchName),
          normalizeIdentifier(params.input.accountNumber),
          normalizeIdentifier(params.input.cardNumber),
          (normalizeIdentifier(params.input.iban) ?? "").toUpperCase() || null,
          normalizeText(params.input.accountHolder),
          normalizeText(params.input.settlementReference),
          normalizeText(params.input.pspProvider),
          normalizeIdentifier(params.input.terminalNumber),
          normalizeIdentifier(params.input.merchantNumber),
          settlementAccountId,
          normalizeSettlementDelay(params.input.settlementDelayDays),
          params.actorId,
        ],
      );
      id = rows[0].id;
    } catch (err) {
      if (sqlState(err) === UNIQUE_VIOLATION) throw new FinancialAccountError(uniqueViolationCode(err), 409);
      if (sqlState(err) === CHECK_VIOLATION) throw new FinancialAccountError(checkViolationCode(err));
      throw err;
    }

    await audit(client, {
      businessId: params.businessId,
      locationId,
      userId: params.actorId,
      action: "financial_account.created",
      accountId: id,
      payload: { kind, name: params.input.name, glAccountId, currencyCode: resolvedCurrency, isDefault },
    });
    await client.query("COMMIT");
    const account = await getFinancialAccount(params.businessId, id);
    if (!account) throw new FinancialAccountError("financial_account_not_found", 404);
    return { id, account };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function checkViolationCode(err: unknown): string {
  const message = String((err as { message?: string }).message ?? "");
  if (message.includes("financial_accounts_bank_metadata")) return "bankName_required";
  if (message.includes("financial_accounts_psp_metadata")) return "pspProvider_required";
  if (message.includes("financial_accounts_settlement_not_self")) return "settlement_account_is_self";
  if (message.includes("financial_accounts_settlement_kind")) return "settlement_account_wrong_kind";
  if (message.includes("financial_account_identity_locked")) return "financial_account_identity_locked";
  if (message.includes("financial_account_delete_forbidden")) return "financial_account_delete_forbidden";
  return "bad_request";
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeSettlementDelay(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const days = typeof value === "number" ? value : Number(toLatinDigits(String(value)));
  if (!Number.isInteger(days) || days < 0 || days > 90) return null;
  return days;
}

/**
 * The bank account a terminal settles into: must exist, belong to this tenant,
 * be a *bank* financial account, be active, and not be the terminal itself.
 */
async function resolveSettlementAccount(
  client: PoolClient,
  params: {
    businessId: string;
    kind: FinancialAccountKind;
    settlementAccountId: unknown;
    selfId: string | null;
  },
): Promise<string | null> {
  if (params.settlementAccountId === undefined || params.settlementAccountId === null || params.settlementAccountId === "") {
    return null;
  }
  if (params.kind !== "pos_psp") throw new FinancialAccountError("settlement_account_wrong_kind");
  const value = String(params.settlementAccountId);
  if (!isUuid(value)) throw new FinancialAccountError("invalid_settlement_account");
  if (params.selfId && value === params.selfId) throw new FinancialAccountError("settlement_account_is_self");
  const { rows } = await client.query<{ kind: FinancialAccountKind; is_active: boolean }>(
    "SELECT kind, is_active FROM financial_accounts WHERE business_id = $1 AND id = $2",
    [params.businessId, value],
  );
  const row = rows[0];
  if (!row) throw new FinancialAccountError("settlement_account_not_found", 404);
  if (row.kind !== "bank") throw new FinancialAccountError("settlement_account_wrong_kind");
  if (!row.is_active) throw new FinancialAccountError("settlement_account_not_active");
  return value;
}

/**
 * Clear the default flag on the other accounts of the same kind and scope.
 *
 * Runs inside the caller's transaction, after the per-business advisory lock, so
 * two concurrent "make this the default" requests serialize here rather than
 * both observing an empty set and both committing.
 */
async function clearDefault(
  client: PoolClient,
  params: { businessId: string; kind: FinancialAccountKind; locationId: string | null; exceptId: string | null },
): Promise<void> {
  await client.query(
    `UPDATE financial_accounts
        SET is_default = false, updated_at = now()
      WHERE business_id = $1 AND kind = $2::financial_account_kind AND is_default
        AND COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [params.businessId, params.kind, params.locationId, params.exceptId],
  );
}

export interface UpdateFinancialAccountParams {
  businessId: string;
  accountId: string;
  actorId: string | null;
  input: FinancialAccountFieldsInput & {
    locationId?: unknown;
    isDefault?: unknown;
    isActive?: unknown;
  };
  allowedLocationIds?: readonly string[] | null;
}

/**
 * One edit is one transaction.
 *
 * The identity fields (GL account, kind, currency) are only writable while the
 * account has no transfer history: after that they are what its card *means*,
 * and the database trigger refuses the change even if this code were bypassed.
 * Archiving goes through `archiveFinancialAccount`, never through this path, so
 * a PATCH can never quietly take money out of every list.
 */
export async function updateFinancialAccount(
  params: UpdateFinancialAccountParams,
): Promise<FinancialAccountWriteResult> {
  if (!isUuid(params.accountId)) throw new FinancialAccountError("financial_account_not_found", 404);
  const problem = financialAccountInputProblem(params.input, { partial: true });
  if (problem) throw new FinancialAccountError(problem.code);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRegister(client, params.businessId);
    const { rows } = await client.query<{
      id: string;
      kind: FinancialAccountKind;
      location_id: string | null;
      gl_account_id: string;
      currency_code: string;
      is_active: boolean;
      is_default: boolean;
      has_transfers: boolean;
    }>(
      `SELECT fa.id, fa.kind, fa.location_id, fa.gl_account_id, fa.currency_code, fa.is_active, fa.is_default,
              EXISTS (SELECT 1 FROM financial_transfers t WHERE t.source_account_id = fa.id OR t.destination_account_id = fa.id) AS has_transfers
         FROM financial_accounts fa
        WHERE fa.business_id = $1 AND fa.id = $2
        FOR UPDATE`,
      [params.businessId, params.accountId],
    );
    const existing = rows[0];
    if (!existing) throw new FinancialAccountError("financial_account_not_found", 404);
    if (existing.location_id && params.allowedLocationIds && !params.allowedLocationIds.includes(existing.location_id)) {
      throw new FinancialAccountError("no_branch_access", 403);
    }
    if (params.input.locationId !== undefined && params.input.isDefault === undefined && existing.is_default) {
      // Moving a default account to another scope without re-declaring the
      // default flag would leave the old scope with no default and the new one
      // with a stale one; the caller must say what it wants.
      throw new FinancialAccountError("default_scope_change_requires_flag");
    }

    const kind: FinancialAccountKind = isFinancialAccountKind(params.input.kind)
      ? (params.input.kind as FinancialAccountKind)
      : existing.kind;
    const glAccountId =
      typeof params.input.glAccountId === "string" && params.input.glAccountId
        ? params.input.glAccountId
        : existing.gl_account_id;
    const currencyCode =
      typeof params.input.currencyCode === "string" && params.input.currencyCode.trim()
        ? params.input.currencyCode.trim().toUpperCase()
        : existing.currency_code;

    const identityChanged =
      glAccountId !== existing.gl_account_id || kind !== existing.kind || currencyCode !== existing.currency_code;
    if (identityChanged && existing.has_transfers) {
      throw new FinancialAccountError("financial_account_identity_locked", 409);
    }
    if (identityChanged) {
      await assertGlAccountForKind(client, params.businessId, glAccountId, kind, {
        allowLinkedAccountId: params.accountId,
      });
      await assertAccountCurrency(client, params.businessId, currencyCode);
    }

    const locationId =
      params.input.locationId === undefined
        ? existing.location_id
        : normalizeText(params.input.locationId);
    if (locationId && !isUuid(locationId)) throw new FinancialAccountError("invalid_location");
    if (locationId && params.allowedLocationIds && !params.allowedLocationIds.includes(locationId)) {
      throw new FinancialAccountError("no_branch_access", 403);
    }

    const settlementAccountId =
      params.input.settlementAccountId === undefined
        ? undefined
        : await resolveSettlementAccount(client, {
            businessId: params.businessId,
            kind,
            settlementAccountId: params.input.settlementAccountId,
            selfId: params.accountId,
          });

    const isDefault = params.input.isDefault === undefined ? existing.is_default : params.input.isDefault === true;
    if (isDefault && !existing.is_active) {
      throw new FinancialAccountError("financial_account_not_active", 409);
    }
    if (isDefault) {
      await clearDefault(client, {
        businessId: params.businessId,
        kind,
        locationId,
        exceptId: params.accountId,
      });
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (params.input.name !== undefined) set("name", String(params.input.name).trim());
    if (params.input.code !== undefined) set("code", normalizeText(params.input.code));
    if (params.input.description !== undefined) set("description", normalizeText(params.input.description));
    if (params.input.notes !== undefined) set("notes", normalizeText(params.input.notes));
    if (identityChanged) {
      set("kind", kind);
      set("gl_account_id", glAccountId);
      set("currency_code", currencyCode);
    }
    set("location_id", locationId);
    set("is_default", isDefault);
    if (params.input.isActive !== undefined && params.input.isActive !== existing.is_active) {
      throw new FinancialAccountError("financial_account_archive_via_endpoint");
    }
    const setIfPresent = (column: string, value: unknown, transform: (input: unknown) => string | null = normalizeText): void => {
      if (value !== undefined) set(column, transform(value));
    };
    setIfPresent("bank_name", params.input.bankName);
    setIfPresent("bank_branch_name", params.input.bankBranchName);
    setIfPresent("account_number", params.input.accountNumber, normalizeIdentifier);
    setIfPresent("card_number", params.input.cardNumber, normalizeIdentifier);
    setIfPresent("iban", params.input.iban, (value) => (normalizeIdentifier(value) ?? "").toUpperCase() || null);
    setIfPresent("account_holder", params.input.accountHolder);
    setIfPresent("settlement_reference", params.input.settlementReference);
    setIfPresent("psp_provider", params.input.pspProvider);
    setIfPresent("terminal_number", params.input.terminalNumber, normalizeIdentifier);
    setIfPresent("merchant_number", params.input.merchantNumber, normalizeIdentifier);
    if (settlementAccountId !== undefined) set("settlement_account_id", settlementAccountId);
    if (params.input.settlementDelayDays !== undefined) {
      set("settlement_delay_days", normalizeSettlementDelay(params.input.settlementDelayDays));
    }
    values.push(params.actorId);
    assignments.push(`updated_by = $${values.length}`);
    values.push(params.businessId, params.accountId);
    const where = `business_id = $${values.length - 1} AND id = $${values.length}`;

    try {
      await client.query(`UPDATE financial_accounts SET ${assignments.join(", ")} WHERE ${where}`, values);
    } catch (err) {
      if (sqlState(err) === UNIQUE_VIOLATION) throw new FinancialAccountError(uniqueViolationCode(err), 409);
      if (sqlState(err) === CHECK_VIOLATION) throw new FinancialAccountError(checkViolationCode(err));
      throw err;
    }

    await audit(client, {
      businessId: params.businessId,
      locationId,
      userId: params.actorId,
      action: "financial_account.updated",
      accountId: params.accountId,
      payload: {
        fields: assignments.map((assignment) => assignment.split(" = ")[0]),
        identityChanged,
        isDefault,
      },
    });
    await client.query("COMMIT");
    const account = await getFinancialAccount(params.businessId, params.accountId);
    if (!account) throw new FinancialAccountError("financial_account_not_found", 404);
    return { id: params.accountId, account };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface ArchiveFinancialAccountParams {
  businessId: string;
  accountId: string;
  actorId: string | null;
  reason?: string | null;
}

/**
 * Archive (بایگانی) a financial account — the only way to retire one.
 *
 * Refused while the account holds money: a container with a non-zero
 * ledger-derived balance that disappears from every list is money nobody is
 * watching, and the issue's whole point is that balances come from the ledger
 * and are always visible. The message tells the operator what to do instead
 * (move the balance out with a transfer, or post the correcting entry).
 */
export async function archiveFinancialAccount(
  params: ArchiveFinancialAccountParams,
): Promise<{ id: string; balance: string }> {
  if (!isUuid(params.accountId)) throw new FinancialAccountError("financial_account_not_found", 404);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRegister(client, params.businessId);
    const { rows } = await client.query<{
      id: string;
      is_active: boolean;
      location_id: string | null;
      gl_account_id: string;
      kind: FinancialAccountKind;
      balance: string;
    }>(
      `SELECT fa.id, fa.is_active, fa.location_id, fa.gl_account_id, fa.kind,
              COALESCE((
                SELECT SUM(jl.debit - jl.credit)
                  FROM journal_lines jl
                  JOIN journal_entries e ON e.id = jl.entry_id
                 WHERE jl.account_id = fa.gl_account_id AND e.business_id = fa.business_id
              ), 0)::text AS balance
         FROM financial_accounts fa
        WHERE fa.business_id = $1 AND fa.id = $2
        FOR UPDATE`,
      [params.businessId, params.accountId],
    );
    const account = rows[0];
    if (!account) throw new FinancialAccountError("financial_account_not_found", 404);
    if (!account.is_active) throw new FinancialAccountError("financial_account_not_active", 409);
    if (!isZeroBalance(account.balance)) throw new FinancialAccountError("financial_account_has_balance", 409);

    // A terminal pointing at an archived bank account would keep settling into
    // nothing; refusing here keeps `settlement_account_id` meaningful.
    const { rows: terminals } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM financial_accounts
        WHERE business_id = $1 AND settlement_account_id = $2 AND is_active`,
      [params.businessId, params.accountId],
    );
    if (terminals.length > 0) throw new FinancialAccountError("financial_account_is_settlement_target", 409);

    await client.query(
      `UPDATE financial_accounts
          SET is_active = false, is_default = false, archived_at = now(), archived_by = $3, updated_by = $3
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.accountId, params.actorId],
    );
    await audit(client, {
      businessId: params.businessId,
      locationId: account.location_id,
      userId: params.actorId,
      action: "financial_account.archived",
      accountId: params.accountId,
      payload: { kind: account.kind, reason: params.reason ?? null, balance: account.balance },
    });
    await client.query("COMMIT");
    return { id: params.accountId, balance: account.balance };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bring an archived account back into the register (بازگردانی از بایگانی).
 *
 * Archiving is not deletion, and the issue asks for archive *instead of*
 * deletion — which only works if the act is reversible. A business that archives
 * the petty-cash box at the end of a project, then restarts the project, must not
 * have to invent a second GL account to get its container back.
 *
 * Two things stay as they were:
 *
 *  - the account comes back **not default**. Its scope may have acquired a new
 *    default while it was away, and silently displacing that row would be a
 *    change nobody asked for; the operator marks the default again if they want
 *    it back (one click, and the unique index keeps the scope's single default
 *    true either way).
 *  - nothing about its history changes. The card, the archive stamp and the
 *    ledger are untouched; only `is_active`, the archive columns and the audit
 *    row move.
 */
export async function reactivateFinancialAccount(params: {
  businessId: string;
  accountId: string;
  actorId: string | null;
  allowedLocationIds?: readonly string[] | null;
}): Promise<{ id: string; account: FinancialAccountRecord }> {
  if (!isUuid(params.accountId)) throw new FinancialAccountError("financial_account_not_found", 404);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRegister(client, params.businessId);
    const { rows } = await client.query<{
      id: string;
      is_active: boolean;
      location_id: string | null;
      kind: FinancialAccountKind;
      archived_at: string | null;
    }>(
      `SELECT id, is_active, location_id, kind, archived_at::text AS archived_at
         FROM financial_accounts
        WHERE business_id = $1 AND id = $2
        FOR UPDATE`,
      [params.businessId, params.accountId],
    );
    const existing = rows[0];
    if (!existing) throw new FinancialAccountError("financial_account_not_found", 404);
    if (existing.location_id && params.allowedLocationIds && !params.allowedLocationIds.includes(existing.location_id)) {
      throw new FinancialAccountError("no_branch_access", 403);
    }
    // A row that was never archived needs nothing done to it; answering with the
    // account it already is keeps a retry (or a double click) idempotent instead
    // of flipping state that was never flipped.
    if (!existing.is_active) {
      await client.query(
        `UPDATE financial_accounts
            SET is_active = true, archived_at = NULL, archived_by = NULL, updated_by = $3
          WHERE business_id = $1 AND id = $2`,
        [params.businessId, params.accountId, params.actorId],
      );
      await audit(client, {
        businessId: params.businessId,
        locationId: existing.location_id,
        userId: params.actorId,
        action: "financial_account.reactivated",
        accountId: params.accountId,
        payload: { kind: existing.kind, archivedAt: existing.archived_at },
      });
    }
    await client.query("COMMIT");
    const account = await getFinancialAccount(params.businessId, params.accountId);
    if (!account) throw new FinancialAccountError("financial_account_not_found", 404);
    return { id: params.accountId, account };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deleting a financial account is never allowed, and says why.
 *
 * This exists so the answer is a named, translated refusal rather than a 405 or
 * a cascading delete: the register's history — which GL account held which
 * money, under which bank, in which branch — is accounting evidence.
 */
export function refuseFinancialAccountDelete(): never {
  throw new FinancialAccountError("financial_account_delete_forbidden", 409);
}

// ---------------------------------------------------------------------------
// Balances and cards — every figure read off the ledger
// ---------------------------------------------------------------------------

/** The account's balance as of a date (default: everything posted so far). */
export async function financialAccountBalanceAsOf(
  businessId: string,
  glAccountId: string,
  asOf: string | null = null,
): Promise<string> {
  if (!isUuid(glAccountId)) throw new FinancialAccountError("invalid_gl_account");
  if (asOf !== null && !isValidIsoDate(asOf)) throw new FinancialAccountError("invalid_transfer_date");
  const { rows } = await query<{ balance: string | null }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS balance
       FROM journal_lines jl
       JOIN journal_entries e ON e.id = jl.entry_id
      WHERE e.business_id = $1 AND jl.account_id = $2
        AND ($3::date IS NULL OR e.entry_date <= $3::date)`,
    [businessId, glAccountId, asOf],
  );
  return rows[0]?.balance ?? "0";
}

export interface FinancialAccountMovementRow extends AccountCardMovement {
  /** The account code/name on the other side of the entry, for the card's own column. */
  counterparty: string;
}

export interface FinancialAccountCardResult {
  account: FinancialAccountRecord;
  from: string | null;
  to: string | null;
  opening: string;
  rows: FinancialAccountMovementRow[];
  totalDebit: string;
  totalCredit: string;
  closing: string;
  reconciliationDifference: string;
  /** The ledger's own all-time balance for the account, for the card's header. */
  ledgerBalance: string;
}

export interface FinancialAccountCardFilters {
  from?: string | null;
  to?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  /** Include entries that were later reversed (default true — they are history). */
  includeReversed?: boolean;
  limit?: number;
}

/**
 * The account card (صورت حساب): opening balance, every movement, closing.
 *
 * Every figure is a BigInt sum of `journal_lines` for the linked GL account over
 * the requested window, and the closing balance is checked against the ledger's
 * own figure for the same window — `reconciliationDifference` is what the screen
 * shows if the two ever disagree. There is no stored balance to disagree *with*,
 * which is the point.
 */
export async function financialAccountCard(
  businessId: string,
  accountId: string,
  filters: FinancialAccountCardFilters = {},
): Promise<FinancialAccountCardResult> {
  const account = await getFinancialAccount(businessId, accountId);
  if (!account) throw new FinancialAccountError("financial_account_not_found", 404);
  const from = filters.from ?? null;
  const to = filters.to ?? null;
  for (const value of [from, to]) {
    if (value !== null && value !== "" && !isValidIsoDate(value)) throw new FinancialAccountError("invalid_transfer_date");
  }
  if (filters.projectId != null && filters.projectId !== "" && !isUuid(filters.projectId)) {
    throw new FinancialAccountError("invalid_project");
  }
  if (filters.locationId != null && filters.locationId !== "" && !isUuid(filters.locationId)) {
    throw new FinancialAccountError("invalid_location");
  }
  const limit = Math.min(Math.max(Number(filters.limit ?? 500), 1), 2000);

  // 1. Opening: everything strictly before the window's first day.
  const opening = from
    ? await financialAccountBalanceAsOf(businessId, account.glAccountId, previousDay(from))
    : "0";

  // 2. The entries of the window that touch this account, with all their lines,
  //    so the card can name the counterpart of each movement (a transfer's other
  //    side, the expense it paid, the sale it collected) instead of showing a
  //    bare debit.
  const { rows: entryRows } = await query<{
    entry_id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    source_id: string | null;
    reversed_at: string | null;
    line_id: string;
    account_id: string;
    account_code: string;
    account_name: string;
    debit: string;
    credit: string;
  }>(
    `SELECT e.id AS entry_id, e.entry_date::text AS entry_date, e.memo, e.source_type, e.source_id::text AS source_id,
            e.reversed_at::text AS reversed_at,
            jl.id::text AS line_id, jl.account_id, a.code AS account_code, a.name AS account_name,
            jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl
       JOIN journal_entries e ON e.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE e.business_id = $1
        AND e.id IN (
          SELECT e2.id FROM journal_entries e2
            JOIN journal_lines l2 ON l2.entry_id = e2.id
           WHERE e2.business_id = $1 AND l2.account_id = $2
             AND ($3::date IS NULL OR e2.entry_date >= $3::date)
             AND ($4::date IS NULL OR e2.entry_date <= $4::date)
             AND ($5::uuid IS NULL OR e2.project_id = $5::uuid)
             AND ($6::uuid IS NULL OR e2.location_id = $6::uuid)
             AND ($7::boolean OR e2.reversed_at IS NULL)
           ORDER BY e2.entry_date DESC, e2.posted_at DESC
           LIMIT $8
        )
      ORDER BY e.entry_date, e.posted_at, jl.id`,
    [
      businessId,
      account.glAccountId,
      from,
      to,
      filters.projectId ?? null,
      filters.locationId ?? null,
      filters.includeReversed === false ? false : true,
      limit,
    ],
  );

  interface EntryBucket {
    entryId: string;
    entryDate: string;
    memo: string | null;
    sourceType: string | null;
    sourceId: string | null;
    reversedAt: string | null;
    own: { debit: string; credit: string } | null;
    counterparties: Set<string>;
    sortKey: string;
  }
  const buckets = new Map<string, EntryBucket>();
  for (const row of entryRows) {
    let bucket = buckets.get(row.entry_id);
    if (!bucket) {
      bucket = {
        entryId: row.entry_id,
        entryDate: row.entry_date,
        memo: row.memo,
        sourceType: row.source_type,
        sourceId: row.source_id,
        reversedAt: row.reversed_at,
        own: null,
        counterparties: new Set<string>(),
        sortKey: row.entry_date,
      };
      buckets.set(row.entry_id, bucket);
    }
    if (row.account_id === account.glAccountId) {
      bucket.own = { debit: row.debit, credit: row.credit };
    } else {
      bucket.counterparties.add(`${row.account_name} (${row.account_code})`);
    }
  }

  const movements = [...buckets.values()]
    .filter((bucket) => bucket.own !== null)
    .map((bucket) => ({
      entryId: bucket.entryId,
      entryDate: bucket.entryDate,
      memo: bucket.memo,
      sourceType: bucket.sourceType,
      journalSourceId: bucket.sourceId,
      debit: bucket.own!.debit,
      credit: bucket.own!.credit,
      counterparty: [...bucket.counterparties].join("، "),
      reversedAt: bucket.reversedAt,
    }));

  const card = accountCardFromMovements(opening, movements);
  const rows: FinancialAccountMovementRow[] = card.rows.map((row, index) => ({
    ...row,
    counterparty: movements[index].counterparty,
  }));
  const ledgerBalance = await financialAccountBalanceAsOf(businessId, account.glAccountId, null);

  return {
    account,
    from,
    to,
    opening: card.opening,
    rows,
    totalDebit: card.totalDebit,
    totalCredit: card.totalCredit,
    closing: card.closing,
    reconciliationDifference: card.reconciliationDifference,
    ledgerBalance,
  };
}

/** The ISO day before a date, without a timezone in the path. */
export function previousDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Balance rows for the reports screen — exact text per account, per kind. */
export async function financialAccountBalanceSummary(
  businessId: string,
  filters: FinancialAccountFilters = {},
): Promise<FinancialAccountListResult> {
  return listFinancialAccounts(businessId, filters);
}

/** Used by the payment-source contract and the transfer form's selectors. */
export async function loadFinancialAccountsForPayments(
  businessId: string,
): Promise<{ accounts: FinancialAccountRecord[]; roles: Map<string, string> }> {
  const list = await listFinancialAccounts(businessId, { status: "active" });
  const { rows } = await query<{ id: string; code: string; parent_id: string | null; type: "asset" | "liability" | "equity" | "revenue" | "expense" }>(
    `SELECT id, code, parent_id, type FROM accounts WHERE business_id = $1`,
    [businessId],
  );
  const roles = classifyAccounts(
    rows.map((row) => ({ id: row.id, code: row.code, parentId: row.parent_id, type: row.type })),
  );
  const mapped = new Map<string, string>();
  for (const account of list.accounts) {
    mapped.set(account.id, roles.get(account.glAccountId) ?? "unknown");
  }
  return { accounts: list.accounts, roles: mapped };
}

export { balanceFromLines };
