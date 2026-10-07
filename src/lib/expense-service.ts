/**
 * Phase 16 — expense management, the DB-touching part.
 *
 * Categorised operating expenses recorded as paid, not owed — the AP
 * subledger already models a bill owed to a specific supplier; genericising
 * that to cover "money spent on rent" would blur two different things.
 * "Categorised" needs no new taxonomy: the expense account chosen (any
 * active type='expense' account — 5200-5900 in the default chart, or
 * whatever a business has customised it to via chart-of-accounts
 * management) is the category. Every expense posts a real, immediate
 * journal entry (Debit the expense account / Credit the payment account)
 * through the same postJournalEntry() every other posting path uses, so it
 * is subject to the fiscal-period lock exactly like everything else.
 *
 * Audit F11 — «پرداخت بعدی». An expense can also be *owed*: it then credits
 * Accounts Payable (2100) for a named supplier instead of a cash/bank
 * account, which is exactly the shape a credit purchase posts. That puts it in
 * the A/P subledger (`ap-service.ts` attributes an expense's A/P line to its
 * supplier), so it ages, appears on the supplier's statement and is settled by
 * the ordinary A/P payment (`payBill`) — no second payable and no second
 * settlement path. `payment_account_id` stores the account actually credited
 * (2100 for a credit expense), so every read that joins it keeps working.
 *
 * DB-touching, so per repo convention it has no direct unit test. Covered by
 * integration/expense.integration.test.ts and
 * integration/f11-payables.integration.test.ts.
 */
import { getPool, query } from "./db";
import {
  isValidIsoDate,
  MAX_EXPENSE_AMOUNT_RIAL,
  type ExpenseListFilters,
} from "./expense-input";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { getMediaAsset } from "./media-service";
import { parseExpenseSettlement, PayablesInputError, type ExpenseSettlement, type ExpenseSettlementInput } from "./payables-input";
import { isUuid } from "./uuid";

export { MissingLedgerAccountError };

export class ExpenseError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function assertAccount(businessId: string, accountId: string, expectedType: "expense" | "asset"): Promise<void> {
  const { rows } = await query<{ type: string }>(
    `SELECT type FROM accounts WHERE business_id = $1 AND id = $2 AND is_active`,
    [businessId, accountId],
  );
  if (!rows[0]) throw new ExpenseError("unknown_account");
  if (rows[0].type !== expectedType) {
    throw new ExpenseError(expectedType === "expense" ? "invalid_expense_account" : "invalid_payment_account");
  }
}

export interface Expense {
  id: string;
  expenseDate: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  paymentAccountId: string;
  paymentAccountCode: string;
  paymentAccountName: string;
  amount: number;
  vendor: string | null;
  memo: string;
  createdByName: string | null;
  createdAt: string;
  /** Migration 0177 — the canonical Media Library asset for the receipt
   * photo this expense was recorded from, when one was attached (e.g. via
   * the receipt-OCR upload flow). Null for an expense entered by hand. */
  receiptAssetId: string | null;
  /** Audit F11 — `paid` (cash/bank credited) or `credit` (owed: A/P credited). */
  settlement: ExpenseSettlement;
  /** The supplier a credit expense is owed to (branch alias id + its party's name). */
  supplierId: string | null;
  supplierName: string | null;
  dueDate: string | null;
}

interface ExpenseRow extends Record<string, unknown> {
  id: string;
  expense_date: string;
  account_id: string;
  account_code: string;
  account_name: string;
  payment_account_id: string;
  payment_account_code: string;
  payment_account_name: string;
  amount: string;
  vendor: string | null;
  memo: string;
  created_by_name: string | null;
  created_at: string;
  receipt_asset_id: string | null;
  settlement: ExpenseSettlement;
  supplier_id: string | null;
  supplier_name: string | null;
  due_date: string | null;
}

function toExpense(r: ExpenseRow): Expense {
  return {
    id: r.id,
    expenseDate: r.expense_date,
    accountId: r.account_id,
    accountCode: r.account_code,
    accountName: r.account_name,
    paymentAccountId: r.payment_account_id,
    paymentAccountCode: r.payment_account_code,
    paymentAccountName: r.payment_account_name,
    amount: Number(r.amount),
    vendor: r.vendor,
    memo: r.memo,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    receiptAssetId: r.receipt_asset_id,
    settlement: r.settlement,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    dueDate: r.due_date,
  };
}

const SELECT_EXPENSE = `
  SELECT e.id, e.expense_date::text AS expense_date, e.amount::text AS amount, e.vendor, e.memo, e.created_at::text AS created_at,
         e.account_id, a.code AS account_code, a.name AS account_name,
         e.payment_account_id, p.code AS payment_account_code, p.name AS payment_account_name,
         e.receipt_asset_id,
         e.settlement, e.supplier_id, COALESCE(sp.name, s.name) AS supplier_name, e.due_date::text AS due_date,
         u.full_name AS created_by_name
    FROM expenses e
    JOIN accounts a ON a.id = e.account_id
    JOIN accounts p ON p.id = e.payment_account_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    LEFT JOIN parties sp ON sp.id = s.party_id
    LEFT JOIN users u ON u.id = e.created_by`;

export interface ExpenseListResult {
  expenses: Expense[];
  /** Whether the window is cutting rows off, so the screen can say so. */
  hasMore: boolean;
  /** Sum over *every* matching row, not just the returned window. */
  totalAmount: number;
  /** How many rows match the filters in total. */
  totalCount: number;
}

/**
 * The filtered list plus the true totals.
 *
 * It used to be an unfiltered `LIMIT 200` whose caller then summed the rows it
 * happened to receive and labelled the result «جمع هزینه‌ها» — a number that
 * silently stopped being the truth on the 201st expense, with nothing on the
 * screen saying so. The sum and the count are computed in SQL over the whole
 * matching set now, and `hasMore` reports the truncation.
 */
export async function listExpenses(
  businessId: string,
  filters: Partial<ExpenseListFilters> = {},
): Promise<ExpenseListResult> {
  const where: string[] = ["e.business_id = $1"];
  const values: unknown[] = [businessId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("$n", `$${values.length}`));
  };

  if (filters.dateFrom) add("e.expense_date >= $n::date", filters.dateFrom);
  if (filters.dateTo) add("e.expense_date <= $n::date", filters.dateTo);
  if (filters.accountId) add("e.account_id = $n", filters.accountId);
  if (filters.paymentAccountId) add("e.payment_account_id = $n", filters.paymentAccountId);
  if (filters.q) {
    values.push(`%${filters.q}%`);
    const i = values.length;
    where.push(
      `(e.memo ILIKE $${i} OR e.vendor ILIKE $${i} OR a.code ILIKE $${i} OR a.name ILIKE $${i} OR p.code ILIKE $${i} OR p.name ILIKE $${i})`,
    );
  }

  const clause = where.join(" AND ");
  const limit = Math.max(1, Math.trunc(filters.limit ?? 100));

  const { rows: totals } = await query<{ total: string; count: string }>(
    `SELECT COALESCE(SUM(e.amount), 0)::text AS total, COUNT(*)::text AS count
       FROM expenses e
       JOIN accounts a ON a.id = e.account_id
       JOIN accounts p ON p.id = e.payment_account_id
      WHERE ${clause}`,
    values,
  );

  // One extra row is the cheapest possible "is there more?" probe.
  const { rows } = await query<ExpenseRow>(
    `${SELECT_EXPENSE} WHERE ${clause} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $${values.length + 1}`,
    [...values, limit + 1],
  );

  const hasMore = rows.length > limit;
  return {
    expenses: rows.slice(0, limit).map(toExpense),
    hasMore,
    totalAmount: Number(totals[0]?.total ?? 0),
    totalCount: Number(totals[0]?.count ?? 0),
  };
}

export async function recordExpense(params: {
  businessId: string;
  locationId: string | null;
  accountId: string;
  paymentAccountId: string;
  amount: number;
  expenseDate?: string | null;
  vendor?: string | null;
  memo: string;
  createdBy: string | null;
  /** Migration 0177 — a Media Library asset (the receipt photo) to attach,
   * typically the one `/api/ai/receipt-ocr` just stored. Re-validated
   * server-side against this business so a stale or cross-tenant id from the
   * client can never be linked onto someone else's financial record. */
  receiptAssetId?: string | null;
  /** Audit F11 — `credit` records the expense as owed to `supplierId` (Credit A/P) instead of paid. */
  settlement?: ExpenseSettlement | null;
  supplierId?: string | null;
  dueDate?: string | null;
}): Promise<Expense> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0 || params.amount > MAX_EXPENSE_AMOUNT_RIAL) {
    throw new ExpenseError("invalid_amount");
  }
  if (!params.memo.trim()) throw new ExpenseError("memo_required");
  let settlement: ExpenseSettlementInput;
  try {
    settlement = parseExpenseSettlement({ settlement: params.settlement, supplierId: params.supplierId, dueDate: params.dueDate });
  } catch (err) {
    if (err instanceof PayablesInputError) throw new ExpenseError(err.code);
    throw err;
  }
  const onCredit = settlement.settlement === "credit";
  if (!params.accountId || (!onCredit && !params.paymentAccountId)) throw new ExpenseError("unknown_account");
  if (!onCredit && params.accountId === params.paymentAccountId) throw new ExpenseError("same_account");
  /*
   * An unparsable date used to be handed straight to Postgres as `text`, which
   * answered with a 22007 the route did not catch — a 500 and a generic
   * «خطای غیرمنتظره» for what is a user input mistake. Validate it here so the
   * form gets a named error instead. The journal entry gets the same value, so
   * an expense and its posting can never disagree about the date either.
   */
  const expenseDate = params.expenseDate?.trim() || null;
  if (expenseDate !== null && !isValidIsoDate(expenseDate)) throw new ExpenseError("invalid_expense_date");

  const receiptAssetId = params.receiptAssetId?.trim() || null;
  if (receiptAssetId) {
    const asset = await getMediaAsset(params.businessId, receiptAssetId);
    if (!asset) throw new ExpenseError("receipt_asset_not_found", 404);
  }

  await assertAccount(params.businessId, params.accountId, "expense");
  if (!onCredit) await assertAccount(params.businessId, params.paymentAccountId, "asset");

  let expenseId = "";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // The credited account: the chosen cash/bank account, or — owed — the A/P
    // control account a credit purchase credits too.
    let creditAccountId = params.paymentAccountId;
    if (onCredit) {
      if (!isUuid(settlement.supplierId!)) throw new ExpenseError("supplier_not_found", 404);
      // suppliers has no business_id; the match goes through its location, as in payBill.
      const { rows: supplierRows } = await client.query(
        `SELECT 1 FROM suppliers s JOIN locations l ON l.id = s.location_id WHERE s.id = $1 AND l.business_id = $2`,
        [settlement.supplierId, params.businessId],
      );
      if (!supplierRows[0]) throw new ExpenseError("supplier_not_found", 404);
      const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.accountsPayable]);
      creditAccountId = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO expenses (business_id, location_id, account_id, payment_account_id, amount, expense_date, vendor, memo, created_by, receipt_asset_id,
                             settlement, supplier_id, due_date)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        params.businessId,
        params.locationId,
        params.accountId,
        creditAccountId,
        params.amount,
        expenseDate,
        params.vendor?.trim() || null,
        params.memo.trim(),
        params.createdBy,
        receiptAssetId,
        settlement.settlement,
        settlement.supplierId,
        settlement.dueDate,
      ],
    );
    expenseId = rows[0].id;

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: expenseDate,
      memo: params.memo.trim(),
      sourceType: "expense",
      sourceId: expenseId,
      createdBy: params.createdBy,
      lines: [
        { accountId: params.accountId, debit: params.amount, credit: 0 },
        { accountId: creditAccountId, debit: 0, credit: params.amount },
      ],
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const { rows: expenseRows } = await query<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.id = $1`, [expenseId]);
  return toExpense(expenseRows[0]);
}
