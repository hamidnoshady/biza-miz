import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTenantTransaction } from "./db";
import { listExpenseCategoryAccounts, recordExpense } from "./expense-service";
import { isValidIsoDate, MAX_EXPENSE_AMOUNT_RIAL } from "./expense-input";
import { createFinancialTransfer, lockFinancialTransfers } from "./financial-transfers-service";
import { amountToRialText } from "./financial-transfers";
import { todayIsoDate } from "./jalali";
import { branchScopeSql } from "./location-access";
import { getMediaAsset } from "./media-service";
import { isUuid } from "./uuid";
import {
  PETTY_CASH_APPROVER_ROLES, pettyCashCanDecide, pettyCashMovementProblem,
  type PettyCashFund, type PettyCashOperation,
} from "./petty-cash";

export class PettyCashError extends Error {
  constructor(code: string, readonly status = 400) { super(code); }
}

export interface PettyCashAccess {
  businessId: string;
  actorId: string;
  role: string;
  locationIds: readonly string[];
  canViewLedger: boolean;
  canManage: boolean;
  canApprove: boolean;
}

type FundRow = Omit<PettyCashFund, "canSubmit" | "canDecide"> & { glAccountId: string };
type Body = Record<string, unknown>;

const FUND_SELECT = `
  SELECT f.id, f.account_id AS "accountId", a.name AS "accountName",
         f.location_id AS "locationId", l.name AS "locationName",
         f.custodian_id AS "custodianId", u.full_name AS "custodianName",
         f.funding_account_id AS "fundingAccountId", funding.name AS "fundingAccountName",
         f.ceiling::text, f.policy, f.category_account_ids AS "categoryAccountIds",
         f.approval_roles AS "approvalRoles", f.funded_at::text AS "fundedAt", f.closed_at::text AS "closedAt",
         a.gl_account_id AS "glAccountId", COALESCE(b.balance, 0)::text AS balance
    FROM petty_cash_funds f
    JOIN financial_accounts a ON a.id = f.account_id AND a.business_id = f.business_id
    JOIN financial_accounts funding ON funding.id = f.funding_account_id AND funding.business_id = f.business_id
    JOIN locations l ON l.id = f.location_id AND l.business_id = f.business_id
    JOIN users u ON u.id = f.custodian_id AND u.business_id = f.business_id
    LEFT JOIN LATERAL (
       SELECT SUM(jl.debit - jl.credit) AS balance
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_id = a.gl_account_id AND je.business_id = f.business_id
    ) b ON true`;

const OPERATION_SELECT = `
  SELECT o.id, o.fund_id AS "fundId", o.kind, o.status, o.business_date::text AS "businessDate",
         o.amount::text, o.ledger_balance::text AS "ledgerBalance", o.note,
         o.category_account_id AS "categoryAccountId", category.name AS "categoryName",
         o.receipt_asset_id AS "receiptAssetId", o.receipt_file_name AS "receiptFileName",
         o.transfer_id AS "transferId", o.expense_id AS "expenseId", o.actor_id AS "actorId",
         actor.full_name AS "actorName", o.decided_by AS "decidedBy", o.decided_at::text AS "decidedAt",
         o.decision_note AS "decisionNote", o.created_at::text AS "createdAt"
    FROM petty_cash_operations o
    LEFT JOIN users actor ON actor.id = o.actor_id AND actor.business_id = o.business_id
    LEFT JOIN accounts category ON category.id = o.category_account_id AND category.business_id = o.business_id`;

function visibleFund(access: PettyCashAccess, row: FundRow): PettyCashFund {
  const { glAccountId: _, ...fund } = row;
  return {
    ...fund,
    canSubmit: row.custodianId === access.actorId,
    canDecide: pettyCashCanDecide(access.actorId, row.custodianId, access.role, row.approvalRoles, access.canApprove),
  };
}

function validId(value: unknown, code: string): string {
  if (typeof value !== "string" || !isUuid(value)) throw new PettyCashError(code);
  return value.toLowerCase();
}

function noteOf(value: unknown, code = "petty_cash_note_required"): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) throw new PettyCashError(code);
  return value.trim();
}

function amountOf(value: unknown, allowZero = false): string {
  const amount = amountToRialText(value, "amount");
  if (amount === null || (!allowZero && amount === "0")) throw new PettyCashError("invalid_amount");
  return amount;
}

function requestKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new PettyCashError("petty_cash_idempotency_required");
  }
  return value.trim();
}

function fingerprint(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function hasBranch(access: PettyCashAccess, locationId: string): boolean {
  return access.locationIds.includes(locationId);
}

function ledgerReader(access: PettyCashAccess): boolean {
  return access.canViewLedger || access.canManage || access.canApprove;
}

export async function listPettyCashFunds(access: PettyCashAccess): Promise<PettyCashFund[]> {
  const { rows } = await query<FundRow>(
    `${FUND_SELECT} WHERE f.business_id = $1 AND f.location_id = ANY($2::uuid[])
       AND ($3::boolean OR f.custodian_id = $4) ORDER BY f.closed_at NULLS FIRST, a.name, f.id`,
    [access.businessId, access.locationIds, ledgerReader(access), access.actorId],
  );
  return rows.map((row) => visibleFund(access, row));
}

export async function listPettyCashOperations(
  access: PettyCashAccess, fundIdValue: string, offset = 0,
): Promise<{ operations: PettyCashOperation[]; hasMore: boolean }> {
  const fundId = validId(fundIdValue, "petty_cash_fund_not_found");
  const { rows } = await query<PettyCashOperation>(
    `${OPERATION_SELECT}
     JOIN petty_cash_funds f ON f.id = o.fund_id AND f.business_id = o.business_id
    WHERE o.business_id = $1 AND o.fund_id = $2 AND f.location_id = ANY($3::uuid[])
      AND ($4::boolean OR f.custodian_id = $5)
    ORDER BY (o.status = 'pending') DESC, o.created_at DESC, o.id LIMIT 101 OFFSET $6`,
    [access.businessId, fundId, access.locationIds, ledgerReader(access), access.actorId, offset],
  );
  return { operations: rows.slice(0, 100), hasMore: rows.length > 100 };
}

export async function pettyCashConfigurationOptions(access: PettyCashAccess, funds: PettyCashFund[]) {
  const ownCategories = new Set(funds.filter((fund) => fund.canSubmit).flatMap((fund) => fund.categoryAccountIds));
  const categoryAccounts = access.canManage || ownCategories.size
    ? (await listExpenseCategoryAccounts(access.businessId)).filter((account) => access.canManage || ownCategories.has(account.id))
    : [];
  if (!access.canManage) return { categoryAccounts, custodians: [], accounts: [], locations: [] };
  const [accounts, locations, employees] = await Promise.all([
    query<{ id: string; name: string; kind: string; locationId: string | null }>(
      `SELECT a.id, a.name, a.kind, a.location_id AS "locationId"
         FROM financial_accounts a JOIN businesses b ON b.id = a.business_id
        WHERE a.business_id = $1 AND a.is_active AND a.currency_code = 'IRR' AND b.base_currency_code = 'IRR'
          AND a.kind IN ('petty_cash', 'bank', 'cash')
          AND (a.location_id IS NULL OR a.location_id = ANY($2::uuid[]))
        ORDER BY a.name`, [access.businessId, access.locationIds],
    ),
    query<{ id: string; name: string }>(
      "SELECT id, name FROM locations WHERE business_id = $1 AND is_active AND id = ANY($2::uuid[]) ORDER BY name",
      [access.businessId, access.locationIds],
    ),
    query<{ id: string; name: string; locationIds: string[] }>(
      `SELECT u.id, u.full_name AS name, ARRAY_AGG(branch.id ORDER BY branch.id) AS "locationIds" FROM users u
        JOIN employees e ON e.id = u.id AND e.business_id = u.business_id
        JOIN locations branch ON branch.business_id = u.business_id AND branch.is_active AND branch.id = ANY($2::uuid[])
          AND (u.role = 'owner' OR ${branchScopeSql({ alias: "u", locationParam: "branch.id" })})
        WHERE u.business_id = $1 AND u.is_active AND u.membership_status = 'active'
        GROUP BY u.id, u.full_name ORDER BY u.full_name`, [access.businessId, access.locationIds],
    ),
  ]);
  return { categoryAccounts, custodians: employees.rows, accounts: accounts.rows, locations: locations.rows };
}

interface MoneyAccountRow {
  id: string;
  gl_account_id: string;
  location_id: string | null;
  is_active: boolean;
  kind: string;
  currency_code: string;
  base_currency_code: string;
}

async function movementAccounts(
  client: PoolClient, access: PettyCashAccess, accountId: string, fundingAccountId: string, locationId: string,
): Promise<MoneyAccountRow> {
  const { rows } = await client.query<MoneyAccountRow>(
    `SELECT a.id, a.gl_account_id, a.location_id, a.is_active, a.kind, a.currency_code, b.base_currency_code
       FROM financial_accounts a JOIN businesses b ON b.id = a.business_id
      WHERE a.business_id = $1 AND a.id = ANY($2::uuid[]) ORDER BY a.id FOR UPDATE OF a`,
    [access.businessId, [accountId, fundingAccountId]],
  );
  const petty = rows.find((row) => row.id === accountId);
  const funding = rows.find((row) => row.id === fundingAccountId);
  if (!petty?.is_active || petty.kind !== "petty_cash" || petty.location_id !== locationId) {
    throw new PettyCashError("petty_cash_account_invalid");
  }
  if (!funding?.is_active || !["bank", "cash"].includes(funding.kind)
    || (funding.location_id !== null && funding.location_id !== locationId)) {
    throw new PettyCashError("petty_cash_funding_account_invalid");
  }
  if (petty.currency_code !== "IRR" || petty.base_currency_code !== "IRR" || funding.currency_code !== "IRR") {
    throw new PettyCashError("currency_mismatch", 409);
  }
  return petty;
}

async function audit(
  client: PoolClient, access: PettyCashAccess, fundId: string, action: string, payload: Body,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     SELECT $1, f.location_id, $2, $3, 'petty_cash_fund', f.id, $4::jsonb
       FROM petty_cash_funds f WHERE f.business_id = $1 AND f.id = $5`,
    [access.businessId, access.actorId, `petty_cash.${action}`, JSON.stringify(payload), fundId],
  );
}

export async function configurePettyCashFund(access: PettyCashAccess, body: Body): Promise<PettyCashFund> {
  if (!access.canManage) throw new PettyCashError("forbidden", 403);
  const accountId = validId(body.accountId, "petty_cash_account_invalid");
  const fundingAccountId = validId(body.fundingAccountId, "petty_cash_funding_account_invalid");
  const locationId = validId(body.locationId, "invalid_location");
  if (!hasBranch(access, locationId)) throw new PettyCashError("no_branch_access", 403);
  const custodianId = validId(body.custodianId, "petty_cash_custodian_invalid");
  const ceiling = amountOf(body.ceiling);
  const policy = body.policy;
  if (policy !== "fixed" && policy !== "variable") throw new PettyCashError("petty_cash_policy_invalid");
  if (!Array.isArray(body.categoryAccountIds) || body.categoryAccountIds.length < 1 || body.categoryAccountIds.length > 100) {
    throw new PettyCashError("petty_cash_category_invalid");
  }
  const categoryIds = [...new Set(body.categoryAccountIds.map((value) => validId(value, "petty_cash_category_invalid")))].sort();
  if (!Array.isArray(body.approvalRoles) || body.approvalRoles.length < 1 || body.approvalRoles.length > PETTY_CASH_APPROVER_ROLES.length
    || body.approvalRoles.some((role) => !PETTY_CASH_APPROVER_ROLES.some((allowed) => role === allowed))) {
    throw new PettyCashError("petty_cash_approval_role_invalid");
  }
  const roles = [...new Set(body.approvalRoles as string[])].sort();
  return withTenantTransaction(access.businessId, async (client) => {
    await lockFinancialTransfers(client, access.businessId);
    const account = await movementAccounts(client, access, accountId, fundingAccountId, locationId);
    const existing = await client.query<FundRow>(
      `${FUND_SELECT} WHERE f.business_id = $1 AND f.account_id = $2`, [access.businessId, accountId],
    );
    const fund = existing.rows[0];
    if (fund) {
      if (fund.custodianId === custodianId && fund.fundingAccountId === fundingAccountId && fund.locationId === locationId
        && fund.ceiling === ceiling && fund.policy === policy && fund.categoryAccountIds.join() === categoryIds.join()
        && fund.approvalRoles.join() === roles.join()) return visibleFund(access, fund);
      throw new PettyCashError("petty_cash_already_configured", 409);
    }
    const { rows: custodians } = await client.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN employees e ON e.id = u.id AND e.business_id = u.business_id
        WHERE u.business_id = $1 AND u.id = $2 AND u.is_active AND u.membership_status = 'active'
          AND (u.role = 'owner' OR ${branchScopeSql({ alias: "u", locationParam: "$3" })})`,
      [access.businessId, custodianId, locationId],
    );
    if (!custodians[0]) {
      throw new PettyCashError("petty_cash_custodian_invalid");
    }
    const allowedCategories = new Set((await listExpenseCategoryAccounts(access.businessId)).map(({ id }) => id));
    if (!categoryIds.every((id) => allowedCategories.has(id))) throw new PettyCashError("petty_cash_category_invalid");
    const opening = await balanceAt(client, access.businessId, account.gl_account_id, null);
    if (opening.balance !== "0") throw new PettyCashError("petty_cash_account_nonzero", 409);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO petty_cash_funds
        (business_id, account_id, funding_account_id, location_id, custodian_id, ceiling, policy, category_account_ids, approval_roles, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [access.businessId, accountId, fundingAccountId, locationId, custodianId, ceiling, policy, categoryIds, roles, access.actorId],
    );
    await audit(client, access, rows[0].id, "configure", { accountId, fundingAccountId, custodianId, ceiling, policy, categoryIds, roles });
    return visibleFund(access, (await client.query<FundRow>(`${FUND_SELECT} WHERE f.business_id = $1 AND f.id = $2`, [access.businessId, rows[0].id])).rows[0]);
  }, { locationId, userId: access.actorId });
}

async function balanceAt(
  client: PoolClient, businessId: string, glAccountId: string, date: string | null,
): Promise<{ balance: string; latest: string | null }> {
  const { rows } = await client.query<{ balance: string; latest: string | null }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE $3::date IS NULL OR j.entry_date <= $3::date), 0)::text AS balance,
            MAX(j.entry_date)::text AS latest
       FROM journal_lines jl JOIN journal_entries j ON j.id = jl.entry_id
      WHERE j.business_id = $1 AND jl.account_id = $2`, [businessId, glAccountId, date],
  );
  return rows[0];
}

async function lockFund(client: PoolClient, access: PettyCashAccess, id: string): Promise<FundRow> {
  await lockFinancialTransfers(client, access.businessId);
  const { rows } = await client.query<FundRow>(
    `${FUND_SELECT} WHERE f.business_id = $1 AND f.id = $2 AND f.location_id = ANY($3::uuid[])
      AND ($4::boolean OR f.custodian_id = $5) FOR UPDATE OF f`,
    [access.businessId, id, access.locationIds, ledgerReader(access), access.actorId],
  );
  if (!rows[0]) throw new PettyCashError("petty_cash_fund_not_found", 404);
  return rows[0];
}

async function validateDate(client: PoolClient, businessId: string, value: unknown): Promise<string> {
  if (typeof value !== "string" || !isValidIsoDate(value)) throw new PettyCashError("invalid_expense_date");
  const { rows } = await client.query<{ timezone: string }>("SELECT timezone FROM businesses WHERE id = $1", [businessId]);
  if (value > todayIsoDate(rows[0]?.timezone ?? "Asia/Tehran")) throw new PettyCashError("expense_date_in_future");
  return value;
}

async function getOperation(client: PoolClient, businessId: string, id: string): Promise<PettyCashOperation> {
  return (await client.query<PettyCashOperation>(
    `${OPERATION_SELECT} WHERE o.business_id = $1 AND o.id = $2`, [businessId, id],
  )).rows[0];
}

async function transfer(
  client: PoolClient, access: PettyCashAccess, fund: FundRow, kind: "fund" | "replenish" | "close",
  businessDate: string, amount: string, note: string, key: string,
): Promise<string> {
  await movementAccounts(client, access, fund.accountId, fund.fundingAccountId, fund.locationId);
  const closing = kind === "close";
  const { transfer: posted } = await createFinancialTransfer({
    businessId: access.businessId,
    actorId: access.actorId,
    locationId: fund.locationId,
    allowedLocationIds: access.locationIds,
    input: {
      transferDate: businessDate, amount, description: note,
      sourceAccountId: closing ? fund.accountId : fund.fundingAccountId,
      destinationAccountId: closing ? fund.fundingAccountId : fund.accountId,
      idempotencyKey: `petty-cash:${fingerprint([fund.id, key])}`,
    },
  }, { client, pettyCashAccountId: fund.accountId });
  return posted.id;
}

export async function createPettyCashOperation(access: PettyCashAccess, fundIdValue: string, body: Body, keyValue: unknown) {
  const fundId = validId(fundIdValue, "petty_cash_fund_not_found");
  const kind = body.action;
  if (kind !== "fund" && kind !== "submit" && kind !== "replenish" && kind !== "reconcile" && kind !== "close") {
    throw new PettyCashError("petty_cash_action_invalid");
  }
  const key = requestKey(keyValue);
  const amount = amountOf(body.amount, kind === "reconcile" || kind === "close");
  const note = noteOf(body.note);
  const categoryId = kind === "submit" ? validId(body.categoryAccountId, "petty_cash_category_invalid") : null;
  const receiptId = kind === "submit" ? validId(body.receiptAssetId, "receipt_asset_not_found") : null;
  if (kind === "submit" && BigInt(amount) > BigInt(MAX_EXPENSE_AMOUNT_RIAL)) throw new PettyCashError("invalid_amount");

  return withTenantTransaction(access.businessId, async (client) => {
    const fund = await lockFund(client, access, fundId);
    const isCustodian = fund.custodianId === access.actorId;
    if ((kind === "submit" && !isCustodian) || (kind === "reconcile" && !isCustodian && !access.canManage)
      || (kind !== "submit" && kind !== "reconcile" && !access.canManage)) {
      throw new PettyCashError("forbidden", 403);
    }
    const date = await validateDate(client, access.businessId, body.businessDate);
    const hash = fingerprint([kind, date, amount, note, categoryId, receiptId, access.actorId]);
    const { rows: existing } = await client.query<{ id: string; request_hash: string }>(
      "SELECT id, request_hash FROM petty_cash_operations WHERE business_id = $1 AND fund_id = $2 AND idempotency_key = $3",
      [access.businessId, fundId, key],
    );
    if (existing[0]) {
      if (existing[0].request_hash !== hash) throw new PettyCashError("idempotency_conflict", 409);
      return getOperation(client, access.businessId, existing[0].id);
    }
    if (fund.closedAt) throw new PettyCashError("petty_cash_already_closed", 409);
    if (kind === "fund" ? Boolean(fund.fundedAt) : !fund.fundedAt) {
      throw new PettyCashError(kind === "fund" ? "petty_cash_already_funded" : "petty_cash_not_funded", 409);
    }

    let status: PettyCashOperation["status"] = "posted";
    let ledgerBalance: string | null = null;
    let receiptName: string | null = null;
    let transferId: string | null = null;
    if (kind === "submit") {
      if (!categoryId || !fund.categoryAccountIds.includes(categoryId)) throw new PettyCashError("petty_cash_category_invalid");
      const categories = await listExpenseCategoryAccounts(access.businessId);
      if (!categories.some((category) => category.id === categoryId)) throw new PettyCashError("petty_cash_category_invalid");
      if (BigInt(amount) > BigInt(fund.ceiling)) throw new PettyCashError("float_ceiling_exceeded", 409);
      const asset = receiptId ? await getMediaAsset(access.businessId, receiptId) : null;
      const uploaded = await client.query(
        "SELECT 1 FROM media_assets WHERE business_id = $1 AND id = $2 AND created_by = $3 AND deleted_at IS NULL",
        [access.businessId, receiptId, access.actorId],
      );
      if (!asset || asset.kind !== "image" || !uploaded.rows.length) {
        throw new PettyCashError("receipt_asset_not_found");
      }
      receiptName = asset.fileName.slice(0, 200) || null;
      status = "pending";
    } else {
      const { balance, latest } = await balanceAt(client, access.businessId, fund.glAccountId, date);
      if (kind === "reconcile") {
        ledgerBalance = balance;
        status = amount === balance ? "matched" : "discrepancy";
      } else {
        if (latest && date < latest) throw new PettyCashError("petty_cash_date_before_movement", 409);
        const problem = pettyCashMovementProblem(kind, fund.policy, fund.ceiling, balance, amount);
        if (problem) throw new PettyCashError(problem, 409);
        if (kind === "close") {
          const { rows } = await client.query(
            "SELECT 1 FROM petty_cash_operations WHERE business_id = $1 AND fund_id = $2 AND status = 'pending' LIMIT 1",
            [access.businessId, fundId],
          );
          if (rows.length) throw new PettyCashError("petty_cash_pending_expenses", 409);
          ledgerBalance = balance;
        }
        if (amount !== "0") transferId = await transfer(client, access, fund, kind, date, amount, note, key);
        if (kind === "fund" || kind === "close") {
          const stamp = kind === "fund" ? "funded_at" : "closed_at";
          await client.query(`UPDATE petty_cash_funds SET ${stamp} = now() WHERE business_id = $1 AND id = $2`, [access.businessId, fundId]);
        }
      }
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO petty_cash_operations
        (business_id, fund_id, kind, status, business_date, amount, ledger_balance, note,
         category_account_id, receipt_asset_id, receipt_file_name, transfer_id, actor_id, idempotency_key, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [access.businessId, fundId, kind, status, date, amount, ledgerBalance, note,
        categoryId, receiptId, receiptName, transferId, access.actorId, key, hash],
    );
    await audit(client, access, fundId, kind, { operationId: rows[0].id, status, date, amount, ledgerBalance, transferId });
    return getOperation(client, access.businessId, rows[0].id);
  }, { userId: access.actorId });
}

export async function canReadPettyCashReceipt(access: PettyCashAccess, fundValue: string, assetValue: string): Promise<boolean> {
  const fundId = validId(fundValue, "petty_cash_fund_not_found");
  const assetId = validId(assetValue, "receipt_asset_not_found");
  const { rows } = await query(
    `SELECT 1 FROM petty_cash_operations o JOIN petty_cash_funds f ON f.id = o.fund_id AND f.business_id = o.business_id
      WHERE o.business_id = $1 AND o.fund_id = $2 AND o.receipt_asset_id = $3
        AND f.location_id = ANY($4::uuid[]) AND ($5::boolean OR f.custodian_id = $6) LIMIT 1`,
    [access.businessId, fundId, assetId, access.locationIds, ledgerReader(access), access.actorId],
  );
  return rows.length > 0;
}

export async function assertCanUploadPettyCashReceipt(access: PettyCashAccess, fundValue: string): Promise<void> {
  const fundId = validId(fundValue, "petty_cash_fund_not_found");
  const { rows } = await query(
    `SELECT 1 FROM petty_cash_funds WHERE business_id = $1 AND id = $2 AND custodian_id = $3
      AND location_id = ANY($4::uuid[]) AND funded_at IS NOT NULL AND closed_at IS NULL`,
    [access.businessId, fundId, access.actorId, access.locationIds],
  );
  if (!rows.length) throw new PettyCashError("petty_cash_fund_not_found", 404);
}

export async function decidePettyCashExpense(access: PettyCashAccess, fundIdValue: string, body: Body, keyValue: unknown) {
  const fundId = validId(fundIdValue, "petty_cash_fund_not_found");
  const operationId = validId(body.operationId, "petty_cash_expense_not_found");
  const action = body.action;
  if (action !== "approve" && action !== "reject") throw new PettyCashError("petty_cash_action_invalid");
  const key = requestKey(keyValue);
  const note = action === "reject" ? noteOf(body.note) : null;
  return withTenantTransaction(access.businessId, async (client) => {
    const fund = await lockFund(client, access, fundId);
    if (!pettyCashCanDecide(access.actorId, fund.custodianId, access.role, fund.approvalRoles, access.canApprove)) {
      throw new PettyCashError("forbidden", 403);
    }
    const { rows: existing } = await client.query<{ id: string; decision_hash: string }>(
      "SELECT id, decision_hash FROM petty_cash_operations WHERE business_id = $1 AND fund_id = $2 AND decision_key = $3",
      [access.businessId, fundId, key],
    );
    const date = action === "approve" ? await validateDate(client, access.businessId, body.businessDate) : null;
    const hash = fingerprint([action, operationId, date, note, access.actorId]);
    if (existing[0]) {
      if (existing[0].decision_hash !== hash) throw new PettyCashError("idempotency_conflict", 409);
      return getOperation(client, access.businessId, existing[0].id);
    }
    if (fund.closedAt) throw new PettyCashError("petty_cash_already_closed", 409);
    const { rows } = await client.query<PettyCashOperation>(
      `${OPERATION_SELECT} WHERE o.business_id = $1 AND o.fund_id = $2 AND o.id = $3 AND o.kind = 'submit'`,
      [access.businessId, fundId, operationId],
    );
    const operation = rows[0];
    if (!operation) throw new PettyCashError("petty_cash_expense_not_found", 404);
    if (operation.status !== "pending") throw new PettyCashError("petty_cash_already_decided", 409);
    if (operation.actorId === access.actorId) throw new PettyCashError("forbidden", 403);

    let expenseId: string | null = null;
    const status = action === "approve" ? "approved" : "rejected";
    if (date) {
      if (!operation.receiptAssetId) throw new PettyCashError("receipt_asset_not_found");
      if (!operation.categoryAccountId) throw new PettyCashError("petty_cash_category_invalid");
      const { balance, latest } = await balanceAt(client, access.businessId, fund.glAccountId, date);
      if (date < operation.businessDate || (latest && date < latest)) throw new PettyCashError("petty_cash_date_before_movement", 409);
      const problem = pettyCashMovementProblem("approve", fund.policy, fund.ceiling, balance, operation.amount);
      if (problem) throw new PettyCashError(problem, 409);
      await movementAccounts(client, access, fund.accountId, fund.fundingAccountId, fund.locationId);
      const expense = await recordExpense({
        businessId: access.businessId,
        locationId: fund.locationId,
        accountId: operation.categoryAccountId,
        paymentAccountId: fund.glAccountId,
        amount: Number(operation.amount),
        expenseDate: date,
        memo: operation.note,
        receiptAssetId: operation.receiptAssetId,
        createdBy: access.actorId,
      }, { client, pettyCashAccountId: fund.accountId });
      expenseId = expense.id;
    }
    await client.query(
      `UPDATE petty_cash_operations SET status = $4, decided_by = $5, decided_at = now(), decision_note = $6,
              expense_id = $7, decision_key = $8, decision_hash = $9
        WHERE business_id = $1 AND fund_id = $2 AND id = $3`,
      [access.businessId, fundId, operationId, status, access.actorId, note, expenseId, key, hash],
    );
    await audit(client, access, fundId, action, { operationId, date, note, expenseId });
    return getOperation(client, access.businessId, operationId);
  }, { userId: access.actorId });
}
