/**
 * Expense management — the DB-touching half of the Expenses subledger.
 *
 * "Categorised" needs no new taxonomy: the expense account chosen is the
 * category. Every expense posts a real journal entry through the same
 * `postJournalEntry()` every other posting path uses, so it is subject to the
 * fiscal-period lock exactly like everything else.
 *
 * An expense is either **paid** (Cash / bank / float / card-settlement credited)
 * or **owed** (audit F11 «پرداخت بعدی»: Accounts Payable credited for a named
 * supplier, which is exactly the shape a credit purchase posts — so it lands in
 * the A/P subledger, ages there, appears on the supplier's statement and is
 * settled by the ordinary `payBill`). `payment_account_id` stores the account
 * actually credited (2100 when owed), which is why every read that joins it keeps
 * working and why the payment-source rule below applies to a paid expense only.
 *
 * Issue #832 turned this from a form that writes two tables into a register an
 * accountant can trust, by giving it the three things it was missing:
 *
 *  - **reversal** (`reverseExpense`), so a wrong expense is corrected the way a
 *    ledger corrects anything — a second, dated, mirrored entry beside the
 *    first, both visible, the pair netting to zero. Never an edit, never a
 *    delete: a register whose totals can be rewound by hand is not evidence.
 *  - **the payment-source rule** (`expense-accounts.ts`), so «پرداخت از» can
 *    only ever be answered with cash, a bank, a float or a card-settlement
 *    account instead of any asset account in the chart.
 *  - **the date rule** (`expense-input.ts`), enforced here rather than only in
 *    the browser, so the API, the importer and the AI cannot record what the
 *    form refuses.
 *
 * DB-touching, so per repo convention it has no direct unit test: the rules live
 * in the pure modules above (unit-tested), and this file is covered by
 * `integration/expense.integration.test.ts` and
 * `integration/f11-payables.integration.test.ts`.
 */
import { getPool, query } from "./db";
import {
  expenseDateViolation,
  EXPENSE_LIST_DEFAULT_LIMIT,
  formatExpenseReference,
  isExpenseVatWithinAmount,
  isValidIsoDate,
  MAX_EXPENSE_AMOUNT_RIAL,
  parseExpenseVatAmount,
  type ExpenseCursor,
  type ExpenseListFilters,
  type ExpenseRegisterStatus,
} from "./expense-input";
import { expenseCategoryAccounts, expensePaymentSourceIds } from "./expense-accounts";
import { EXPENSE_ERROR_MESSAGES, expenseErrorStatus } from "./expense-errors";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry, type PostJournalEntryInput } from "./ledger-service";
import { getMediaAsset } from "./media-service";
import { isUuid } from "./uuid";
import {
  parseExpenseSettlement,
  PayablesInputError,
  type ExpenseSettlement,
  type ExpenseSettlementInput,
} from "./payables-input";
import { classifyAccounts } from "./account-classification";
import { WELL_KNOWN_CODES } from "./coa-template";
import { todayIsoDate } from "./jalali";
import type { PoolClient } from "pg";

export { MissingLedgerAccountError };

export class ExpenseError extends Error {
  status: number;
  constructor(code: string, status = expenseErrorStatus(code)) {
    super(code);
    this.status = status;
    this.name = "ExpenseError";
  }
}

/** The Persian text for a code, when a caller has the code but not the error. */
export function expenseErrorMessage(code: string): string | undefined {
  return EXPENSE_ERROR_MESSAGES[code as keyof typeof EXPENSE_ERROR_MESSAGES];
}

/**
 * One read of everything the eligibility rules and the input-VAT account need:
 * the business's active chart, flat. Classification resolves a custom
 * sub-account through its parent, so the parent rows have to be in the same set
 * — which is why this is the whole chart and not just the two types.
 */
interface ChartAccount extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
}

async function loadChart(businessId: string): Promise<ChartAccount[]> {
  const { rows } = await query<ChartAccount>(
    `SELECT id, code, name, parent_id, type FROM accounts WHERE business_id = $1 AND is_active ORDER BY code`,
    [businessId],
  );
  return rows;
}

/**
 * The row shape the eligibility rules read. `name` is carried along because the
 * AI candidates need it and `expenseCategoryAccounts` returns the rows it was
 * given — a shape without the label would leave them describing an account by
 * its code alone.
 */
function asShape(account: ChartAccount) {
  return { id: account.id, code: account.code, name: account.name, parentId: account.parent_id, type: account.type };
}

/**
 * The tenant's own active expense accounts — the *only* vocabulary receipt
 * extraction is allowed to answer with (issue #832 §13). Exported because two
 * channels ask the same question (`/api/ai/receipt-ocr` and the assistant's
 * `draft_expense_from_receipt` tool) and a hard-coded F&B list is how both
 * started proposing codes a customised chart does not contain.
 */
export async function listExpenseCategoryAccounts(
  businessId: string,
): Promise<{ id: string; code: string; name: string }[]> {
  const chart = await loadChart(businessId);
  return expenseCategoryAccounts(chart.map(asShape))
    .map((account) => ({ id: account.id, code: account.code, name: account.name }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * The chart's input-VAT account (issue #832 §11) — recovered from the tenant's
 * own chart instead of a constant: the well-known ۱۲۲۰ when it exists, otherwise
 * the lowest-coded active account the classification still calls a VAT
 * receivable (a business that rebuilt its chart under a different code keeps
 * working; one that has no such account cannot post VAT at all, and says so).
 */
function inputVatAccountId(chart: ChartAccount[]): string | null {
  const roles = classifyAccounts(chart.map(asShape));
  const wellKnown = chart.find((account) => account.code === WELL_KNOWN_CODES.vatReceivable);
  if (wellKnown) return wellKnown.id;
  const byRole = chart
    .filter((account) => roles.get(account.id) === "vat_receivable")
    .sort((a, b) => a.code.localeCompare(b.code));
  return byRole[0]?.id ?? null;
}

/**
 * Which day it is *for this business*: `businesses.timezone`, not the server's
 * or UTC's. Every date rule in the expense channel is measured against it, so
 * an expense typed at 23:30 in Tehran is not "tomorrow" to a UTC box.
 */
async function businessToday(businessId: string): Promise<string> {
  const { rows } = await query<{ timezone: string | null }>(
    "SELECT timezone FROM businesses WHERE id = $1",
    [businessId],
  );
  return todayIsoDate(rows[0]?.timezone ?? undefined);
}

/**
 * Per-business reference numbering (issue #832 §21). One row per business,
 * bumped inside the caller's transaction: the row lock Postgres takes for the
 * `ON CONFLICT DO UPDATE` is what makes two concurrent postings land on two
 * different numbers, and because the number is spent in the same transaction
 * that inserts the expense, a rolled-back expense leaves no gap behind.
 */
async function nextReference(client: PoolClient, businessId: string, businessDate: string): Promise<string> {
  const { rows } = await client.query<{ last_number: string | number }>(
    `INSERT INTO expense_reference_counters (business_id, last_number)
     VALUES ($1, 1)
     ON CONFLICT (business_id) DO UPDATE
       SET last_number = expense_reference_counters.last_number + 1,
           updated_at = now()
      RETURNING last_number`,
    [businessId],
  );
  const sequence = Number(rows[0]?.last_number ?? 1);
  return formatExpenseReference(businessDate, sequence);
}

export interface Expense {
  id: string;
  /** `EXP-<Jalali year>-<n>`; null only on rows recorded before migration 0211. */
  reference: string | null;
  expenseDate: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  paymentAccountId: string;
  paymentAccountCode: string;
  paymentAccountName: string;
  /** The gross money that left the payment account. */
  amount: number;
  /** The input-VAT part of `amount`; the expense-account debit is `amount - vatAmount`. */
  vatAmount: number;
  netAmount: number;
  vendor: string | null;
  /** The shared directory's record, when the operator linked one (issue #832 §12). */
  partyId: string | null;
  partyName: string | null;
  /** The branch that incurred it — read from the row, never inferred from whoever is switched to. */
  locationId: string | null;
  locationName: string | null;
  memo: string;
  createdByName: string | null;
  createdAt: string;
  /** Migration 0177 — the canonical Media Library asset for the receipt
   * photo this expense was recorded from, when one was attached (e.g. via
   * the receipt-OCR upload flow). Null for an expense entered by hand. */
  receiptAssetId: string | null;
  /** The file's name as it was when it was attached. Survives the asset itself
   * (0177's FK is `ON DELETE SET NULL`), which is what lets the register tell
   * «no receipt» apart from «receipt purged later» (issue #832 §7). */
  receiptFileName: string | null;
  /** Audit F11 — `paid` (a cash/bank account was credited) or `credit` (A/P owes a supplier). */
  settlement: ExpenseSettlement;
  /** The supplier an owed expense is owed to — the branch alias `payBill` settles against. */
  supplierId: string | null;
  supplierName: string | null;
  dueDate: string | null;
  /**
   * Where this row stands in the register: an ordinary expense, one that has
   * been reversed, or the reversal of another. Derived, never stored — the two
   * timestamp/link columns are the facts (issue #832 §1).
   */
  status: ExpenseRegisterStatus;
  reversedAt: string | null;
  reversedByName: string | null;
  /** Set on an original that has been reversed: the row that undoes it. */
  reversalExpenseId: string | null;
  reversalReference: string | null;
  /** Set on a reversal: the row it undoes. */
  reversesExpenseId: string | null;
  reversesExpenseReference: string | null;
  /** The entry this row posted (`source_type='expense'`), for the detail view. */
  journalEntryId: string | null;
}

interface ExpenseRow extends Record<string, unknown> {
  id: string;
  reference: string | null;
  expense_date: string;
  account_id: string;
  account_code: string;
  account_name: string;
  payment_account_id: string;
  payment_account_code: string;
  payment_account_name: string;
  amount: string;
  vat_amount: string;
  vendor: string | null;
  party_id: string | null;
  party_name: string | null;
  location_id: string | null;
  location_name: string | null;
  memo: string;
  created_by_name: string | null;
  created_at: string;
  receipt_asset_id: string | null;
  receipt_file_name: string | null;
  settlement: ExpenseSettlement;
  supplier_id: string | null;
  supplier_name: string | null;
  due_date: string | null;
  reversed_at: string | null;
  reversed_by_name: string | null;
  reversal_expense_id: string | null;
  reversal_reference: string | null;
  reverses_expense_id: string | null;
  reverses_expense_reference: string | null;
  journal_entry_id: string | null;
}

function statusOf(row: ExpenseRow): ExpenseRegisterStatus {
  if (row.reverses_expense_id) return "reversal";
  if (row.reversed_at) return "reversed";
  return "active";
}

function toExpense(r: ExpenseRow): Expense {
  const amount = Number(r.amount);
  const vatAmount = Number(r.vat_amount ?? 0);
  return {
    id: r.id,
    reference: r.reference,
    expenseDate: r.expense_date,
    accountId: r.account_id,
    accountCode: r.account_code,
    accountName: r.account_name,
    paymentAccountId: r.payment_account_id,
    paymentAccountCode: r.payment_account_code,
    paymentAccountName: r.payment_account_name,
    amount,
    vatAmount,
    netAmount: amount - vatAmount,
    vendor: r.vendor,
    partyId: r.party_id,
    partyName: r.party_name,
    locationId: r.location_id,
    locationName: r.location_name,
    memo: r.memo,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    receiptAssetId: r.receipt_asset_id,
    receiptFileName: r.receipt_file_name,
    settlement: r.settlement,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    dueDate: r.due_date,
    status: statusOf(r),
    reversedAt: r.reversed_at,
    reversedByName: r.reversed_by_name,
    reversalExpenseId: r.reversal_expense_id,
    reversalReference: r.reversal_reference,
    reversesExpenseId: r.reverses_expense_id,
    reversesExpenseReference: r.reverses_expense_reference,
    journalEntryId: r.journal_entry_id,
  };
}

const SELECT_EXPENSE = `
  SELECT e.id, e.reference, e.expense_date::text AS expense_date, e.amount::text AS amount,
         e.vat_amount::text AS vat_amount, e.vendor, e.memo, e.created_at::text AS created_at,
         e.reversed_at::text AS reversed_at, e.reverses_expense_id, e.receipt_asset_id, e.receipt_file_name,
         e.settlement, e.supplier_id, COALESCE(sp.name, s.name) AS supplier_name, e.due_date::text AS due_date,
         e.account_id, a.code AS account_code, a.name AS account_name,
         e.payment_account_id, p.code AS payment_account_code, p.name AS payment_account_name,
         e.location_id, l.name AS location_name,
         e.party_id, pt.name AS party_name,
         u.full_name AS created_by_name,
         rb.full_name AS reversed_by_name,
         rev.id AS reversal_expense_id, rev.reference AS reversal_reference,
         orig.reference AS reverses_expense_reference,
         je.id AS journal_entry_id
    FROM expenses e
    JOIN accounts a ON a.id = e.account_id
    JOIN accounts p ON p.id = e.payment_account_id
    LEFT JOIN locations l ON l.id = e.location_id
    LEFT JOIN parties pt ON pt.id = e.party_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    LEFT JOIN parties sp ON sp.id = s.party_id
    LEFT JOIN users u ON u.id = e.created_by
    LEFT JOIN users rb ON rb.id = e.reversed_by
    LEFT JOIN expenses rev ON rev.reverses_expense_id = e.id
    LEFT JOIN expenses orig ON orig.id = e.reverses_expense_id
    LEFT JOIN journal_entries je ON je.source_type = 'expense' AND je.source_id = e.id`;

/**
 * The register's money. `amount` is gross, so a row's *expense* is
 * `amount - vat_amount` and what the payment account lost is `amount`; a
 * reversal carries the same figures with the opposite sign, which is what makes
 * the net total equal the General Ledger's net movement on the expense accounts
 * instead of drifting away from it every time somebody corrects a mistake.
 *
 * «پرداختی از حساب‌ها» counts only what actually settled: an owed expense credited
 * Accounts Payable, so no cash left anywhere, and folding it into that number
 * would report a payment that has not happened. What is still owed is therefore
 * returned beside it (audit F11), never inside it.
 */
const TOTALS_SQL = `
  SELECT COALESCE(SUM(CASE WHEN e.reverses_expense_id IS NULL
                           THEN e.amount - e.vat_amount
                           ELSE -(e.amount - e.vat_amount) END), 0)::text AS total,
         COALESCE(SUM(CASE WHEN e.reverses_expense_id IS NULL
                           THEN e.vat_amount ELSE -e.vat_amount END), 0)::text AS vat,
         COALESCE(SUM(CASE WHEN e.settlement = 'credit' THEN 0
                           WHEN e.reverses_expense_id IS NULL THEN e.amount
                           ELSE -e.amount END), 0)::text AS paid,
         COALESCE(SUM(CASE WHEN e.settlement = 'credit' THEN e.amount ELSE 0 END), 0)::text AS owed,
         COUNT(*)::text AS count
    FROM expenses e
    JOIN accounts a ON a.id = e.account_id
    JOIN accounts p ON p.id = e.payment_account_id`;

export interface ExpenseListResult {
  expenses: Expense[];
  /** Whether the window is cutting rows off, so the screen can say so. */
  hasMore: boolean;
  /** Where the next page starts — the last row of this one, in the register's order. */
  nextCursor: ExpenseCursor | null;
  /** Net expense over *every* matching row (gross minus input VAT), reversals signed off. */
  totalAmount: number;
  /** The input-VAT part of the same set. */
  totalVatAmount: number;
  /** What the payment accounts actually lost in the same set (owed rows excluded). */
  totalPaidAmount: number;
  /** What the same set still owes suppliers, gross (audit F11). */
  totalOwedAmount: number;
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
 * matching set now, and the window walks a keyset cursor rather than an offset
 * (issue #832 §9): a register an accountant browses must not shift rows onto
 * the next page because somebody posted one while they were reading, and it must
 * not cost a full scan of the tenant to reach page forty.
 */
export async function listExpenses(
  businessId: string,
  filters: Partial<ExpenseListFilters> = {},
): Promise<ExpenseListResult> {
  const where: string[] = ["e.business_id = $1"];
  const values: unknown[] = [businessId];
  // A predicate with no value (a status test) is pushed as-is; one with a value
  // gets its `$n` placeholder numbered, so nothing here counts parameters by
  // hand.
  const add = (sql: string, value?: unknown) => {
    if (value === undefined) {
      where.push(sql);
      return;
    }
    values.push(value);
    where.push(sql.replace("$n", `$${values.length}`));
  };

  if (filters.dateFrom) add("e.expense_date >= $n::date", filters.dateFrom);
  if (filters.dateTo) add("e.expense_date <= $n::date", filters.dateTo);
  if (filters.accountId) add("e.account_id = $n", filters.accountId);
  if (filters.paymentAccountId) add("e.payment_account_id = $n", filters.paymentAccountId);
  // A `locationId` the business does not own is not dropped: it stays in the
  // predicate, where it matches no row, rather than quietly widening to
  // "every branch" (issue #832 §6).
  if (filters.locationId) add("e.location_id = $n", filters.locationId);
  if (filters.status === "active") add("(e.reversed_at IS NULL AND e.reverses_expense_id IS NULL)");
  if (filters.status === "reversed") add("e.reversed_at IS NOT NULL");
  if (filters.status === "reversal") add("e.reverses_expense_id IS NOT NULL");
  if (filters.q) {
    values.push(`%${filters.q}%`);
    const i = values.length;
    where.push(
      `(e.memo ILIKE $${i} OR e.vendor ILIKE $${i} OR e.reference ILIKE $${i}
         OR a.code ILIKE $${i} OR a.name ILIKE $${i} OR p.code ILIKE $${i} OR p.name ILIKE $${i})`,
    );
  }

  const clause = where.join(" AND ");
  const limit = Math.max(1, Math.trunc(filters.limit ?? EXPENSE_LIST_DEFAULT_LIMIT));

  // Totals over the whole filtered set, deliberately *before* the cursor joins
  // `where`: paging must not change the number at the bottom of the register.
  const { rows: totals } = await query<{
    total: string;
    vat: string;
    paid: string;
    owed: string;
    count: string;
  }>(
    `${TOTALS_SQL} WHERE ${clause}`,
    values,
  );

  // One extra row is the cheapest possible "is there more?" probe.
  const pageValues = [...values];
  if (filters.cursor) {
    pageValues.push(filters.cursor.date, filters.cursor.createdAt, filters.cursor.id);
    const n = pageValues.length;
    where.push(`(e.expense_date, e.created_at, e.id) < ($${n - 2}::date, $${n - 1}::timestamptz, $${n}::uuid)`);
  }
  const pageClause = where.join(" AND ");
  const { rows } = await query<ExpenseRow>(
    `${SELECT_EXPENSE} WHERE ${pageClause}
      ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
      LIMIT $${pageValues.length + 1}`,
    [...pageValues, limit + 1],
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    expenses: page.map(toExpense),
    hasMore: rows.length > limit,
    nextCursor:
      rows.length > limit && last
        ? { date: last.expense_date, createdAt: last.created_at, id: last.id }
        : null,
    totalAmount: Number(totals[0]?.total ?? 0),
    totalVatAmount: Number(totals[0]?.vat ?? 0),
    totalPaidAmount: Number(totals[0]?.paid ?? 0),
    totalOwedAmount: Number(totals[0]?.owed ?? 0),
    totalCount: Number(totals[0]?.count ?? 0),
  };
}

export interface RecordExpenseParams {
  businessId: string;
  /** The branch that incurred it. Validated against the business, never trusted. */
  locationId: string | null;
  accountId: string;
  /**
   * The cash-shaped account to credit. Required for a **paid** expense and
   * ignored when the expense is owed: an «پرداخت بعدی» row credits Accounts
   * Payable instead, and the account actually credited is what gets stored
   * (audit F11).
   */
  paymentAccountId?: string | null;
  /** Audit F11 — `credit` records the expense as owed to `supplierId` (Credit A/P) instead of paid. */
  settlement?: ExpenseSettlement | null;
  supplierId?: string | null;
  dueDate?: string | null;
  /** Gross Rial that left the payment account — or, when owed, that the supplier is due. */
  amount: number;
  expenseDate?: string | null;
  vendor?: string | null;
  /** Optional link to the one shared party directory (issue #832 §12). */
  partyId?: string | null;
  memo: string;
  createdBy: string | null;
  /**
   * Migration 0177 — a Media Library asset (the receipt photo) to attach,
   * typically the one `/api/ai/receipt-ocr` just stored. Re-validated
   * server-side against this business so a stale or cross-tenant id from the
   * client can never be linked onto someone else's financial record.
   */
  receiptAssetId?: string | null;
  /** The input-VAT part of `amount`, in Rial (issue #832 §11). Absent means none. */
  vatAmount?: number | string | null;
}

/**
 * Records one paid operating expense and posts it, atomically.
 *
 * Every rule the Expenses screen applies is applied here as well, because this
 * is the one path four different hands reach: the form, `POST
 * /api/ledger/expenses`, the data-transfer importer and the AI/autopilot
 * executor. A rule enforced only in the browser is not a rule (issue #832 §5),
 * and a permission checked only on one of those four is a second, unguarded
 * door.
 */
export async function recordExpense(params: RecordExpenseParams): Promise<Expense> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0 || params.amount > MAX_EXPENSE_AMOUNT_RIAL) {
    throw new ExpenseError("invalid_amount");
  }
  if (!params.memo.trim()) throw new ExpenseError("memo_required");
  /*
   * The settlement shape is parsed first, because it decides which account rules
   * below even apply: an owed expense has no payment account to check, and a paid
   * one must not arrive carrying a supplier. It is parsed by the same module the
   * form and the importer read, so «پرداخت بعدی» means one thing everywhere it can
   * be typed (issue #832 §15).
   */
  let settlement: ExpenseSettlementInput;
  try {
    settlement = parseExpenseSettlement({
      settlement: params.settlement,
      supplierId: params.supplierId,
      dueDate: params.dueDate,
    });
  } catch (err) {
    if (err instanceof PayablesInputError) throw new ExpenseError(err.code);
    throw err;
  }
  const onCredit = settlement.settlement === "credit";
  if (!params.accountId || (!onCredit && !params.paymentAccountId)) throw new ExpenseError("unknown_account");
  if (!onCredit && params.accountId === params.paymentAccountId) throw new ExpenseError("same_account");

  const vatAmount = parseExpenseVatAmount(params.vatAmount ?? 0);
  if (vatAmount === null) throw new ExpenseError("vat_amount_invalid");
  if (vatAmount > 0 && !isExpenseVatWithinAmount(vatAmount, params.amount)) {
    throw new ExpenseError("vat_amount_invalid");
  }

  /*
   * An unparsable date used to be handed straight to Postgres as `text`, which
   * answered with a 22007 the route did not catch — a 500 and a generic
   * «خطای غیرمنتظره» for what is a user input mistake. Validate it here so the
   * form gets a named error instead. The journal entry gets the same value, so
   * an expense and its posting can never disagree about the date either.
   */
  const expenseDate = params.expenseDate?.trim() || null;
  if (expenseDate !== null && !isValidIsoDate(expenseDate)) throw new ExpenseError("invalid_expense_date");

  const businessId = params.businessId;
  const today = await businessToday(businessId);
  const postingDate = expenseDate ?? today;
  const violation = expenseDateViolation(postingDate, today);
  if (violation) throw new ExpenseError(violation);
  /*
   * `parseExpenseSettlement` checked that a due date is a date; this checks it
   * against the day the expense is posted, because a payable created already
   * overdue is a mistyped year far more often than a genuinely backdated bill —
   * and it would open in the A/P ageing in the «تأخیر» bucket on its first day.
   * The rule lives here rather than only in the form so the importer and the
   * autopilot cannot walk past it (issue #832 §5).
   */
  if (onCredit && settlement.dueDate !== null && settlement.dueDate < postingDate) {
    throw new ExpenseError("due_date_before_expense_date");
  }

  const receiptAssetId = params.receiptAssetId?.trim() || null;
  let receiptFileName: string | null = null;
  if (receiptAssetId) {
    // Same rule as the party below: an id that is not a uuid is a refusal the
    // caller can act on, not a `22P02` from comparing text to a uuid column.
    if (!isUuid(receiptAssetId)) throw new ExpenseError("receipt_asset_not_found");
    const asset = await getMediaAsset(businessId, receiptAssetId);
    if (!asset) throw new ExpenseError("receipt_asset_not_found");
    // The name is snapshotted alongside the id so the register can still say
    // «the receipt was purged» after 0177's `ON DELETE SET NULL` has cleared
    // the link (issue #832 §7).
    receiptFileName = asset.fileName.slice(0, 200) || null;
  }

  const partyId = params.partyId?.trim() || null;
  if (partyId) {
    /*
     * Shaped like a uuid *before* it is compared to one. Without this, a channel
     * that forwards a name or a spreadsheet cell instead of an id gets Postgres's
     * `22P02` — a 500 with driver text in it, where the caller should read «this
     * party is not in your directory». The three id fields of an expense arrive
     * from four different places (form, route, importer, assistant) and none of
     * them may be trusted to have checked it first.
     */
    if (!isUuid(partyId)) throw new ExpenseError("party_not_found");
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM parties WHERE business_id = $1 AND id = $2",
      [businessId, partyId],
    );
    if (!rows[0]) throw new ExpenseError("party_not_found");
  }

  const locationId = params.locationId?.trim() || null;
  if (locationId) {
    if (!isUuid(locationId)) throw new ExpenseError("invalid_location");
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM locations WHERE business_id = $1 AND id = $2",
      [businessId, locationId],
    );
    if (!rows[0]) throw new ExpenseError("invalid_location");
  }

  // The authoritative eligibility check (issue #832 §2): the category must be an
  // active expense account and the payment source an active cash/bank-style one,
  // both resolved from this business's own chart.
  const chart = await loadChart(businessId);
  const categories = expenseCategoryAccounts(chart.map(asShape)).map((account) => account.id);
  if (!categories.includes(params.accountId)) {
    throw new ExpenseError(chart.some((account) => account.id === params.accountId) ? "invalid_expense_account" : "unknown_account");
  }
  // The paid half of the rule: what may be credited is cash-shaped, never merely
  // an asset. An owed expense has no payment account of its own — the A/P control
  // account is resolved from the chart below exactly as a credit purchase resolves
  // it, so there is nothing for a caller to get wrong there.
  if (!onCredit) {
    const paymentSources = expensePaymentSourceIds(chart.map(asShape));
    if (!paymentSources.has(params.paymentAccountId!)) {
      throw new ExpenseError(
        chart.some((account) => account.id === params.paymentAccountId) ? "invalid_payment_account" : "unknown_account",
      );
    }
  }

  let vatAccountId: string | null = null;
  if (vatAmount > 0) {
    vatAccountId = inputVatAccountId(chart);
    if (!vatAccountId) throw new ExpenseError("vat_account_missing");
  }

  const expenseNet = params.amount - vatAmount;

  let expenseId = "";
  let reference = "";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // The credited account: the chosen cash/bank account, or — owed — the A/P
    // control account a credit purchase credits too, so an owed expense is never
    // a bill that nobody can settle from «حساب‌های پرداختنی».
    let creditAccountId = params.paymentAccountId ?? "";
    if (onCredit) {
      if (!isUuid(settlement.supplierId!)) throw new ExpenseError("supplier_not_found", 404);
      // `suppliers` has no business_id; the match goes through its location, as in `payBill`.
      const { rows: supplierRows } = await client.query(
        `SELECT 1 FROM suppliers s JOIN locations l ON l.id = s.location_id WHERE s.id = $1 AND l.business_id = $2`,
        [settlement.supplierId, businessId],
      );
      if (!supplierRows[0]) throw new ExpenseError("supplier_not_found", 404);
      const accounts = await accountIdsByCode(client, businessId, [WELL_KNOWN_CODES.accountsPayable]);
      creditAccountId = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
    }

    reference = await nextReference(client, businessId, postingDate);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO expenses (business_id, location_id, account_id, payment_account_id, amount, vat_amount,
                             expense_date, vendor, party_id, memo, created_by, receipt_asset_id,
                             receipt_file_name, reference, settlement, supplier_id, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [
        businessId,
        locationId,
        params.accountId,
        creditAccountId,
        params.amount,
        vatAmount,
        postingDate,
        params.vendor?.trim() || null,
        partyId,
        params.memo.trim(),
        params.createdBy,
        receiptAssetId,
        receiptFileName,
        reference,
        settlement.settlement,
        settlement.supplierId,
        settlement.dueDate,
      ],
    );
    expenseId = rows[0].id;

    const lines: PostJournalEntryInput["lines"] = [
      { accountId: params.accountId, debit: expenseNet, credit: 0 },
      { accountId: creditAccountId, debit: 0, credit: params.amount },
    ];
    if (vatAmount > 0 && vatAccountId) {
      lines.splice(1, 0, { accountId: vatAccountId, debit: vatAmount, credit: 0 });
    }

    await postJournalEntry(client, {
      businessId,
      locationId,
      entryDate: postingDate,
      memo: params.memo.trim(),
      sourceType: "expense",
      sourceId: expenseId,
      createdBy: params.createdBy,
      lines,
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

/**
 * Mirrors a posted expense: the same two (or three) accounts, every debit and
 * credit swapped, dated the day the correction is *made* rather than backdated
 * into the original's period, and subject to that day's fiscal lock like any
 * other posting.
 *
 * The reversing lines are read back from the original's own journal entry rather
 * than rebuilt from the expense row, which is the whole point: whatever the
 * original posted — VAT on a custom input-VAT account, a payment account that
 * has since been archived — is exactly what gets undone, so the pair nets to
 * zero on every account by construction instead of by agreement between two
 * pieces of arithmetic. The original row keeps its amount, its memo and its
 * receipt and is only ever *annotated* (`reversed_at`, `reversed_by`).
 */
export async function reverseExpense(params: {
  businessId: string;
  expenseId: string;
  actorId: string;
  /** ISO date to date the reversal with; defaults to the business's today. */
  reversalDate?: string | null;
  memo?: string | null;
}): Promise<Expense> {
  const { rows: originalRows } = await query<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.business_id = $1 AND e.id = $2`, [
    params.businessId,
    params.expenseId,
  ]);
  const original = originalRows[0];
  if (!original) throw new ExpenseError("expense_not_found");
  if (original.reversed_at) throw new ExpenseError("expense_already_reversed");
  if (original.reverses_expense_id) throw new ExpenseError("expense_is_reversal");

  const today = await businessToday(params.businessId);
  const givenDate = params.reversalDate?.trim() || null;
  if (givenDate !== null && !isValidIsoDate(givenDate)) throw new ExpenseError("invalid_expense_date");
  const reversalDate = givenDate ?? today;
  const violation = expenseDateViolation(reversalDate, today);
  if (violation) throw new ExpenseError(violation);

  const memo = params.memo?.trim() || `برگشت هزینه${original.reference ? ` ${original.reference}` : ""}: ${original.memo}`;

  let reversalId = "";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // `FOR UPDATE` on the original, so two accountants pressing «برگشت» at the
    // same moment cannot both get past the `reversed_at IS NULL` guard above.
    const { rows: locked } = await client.query<{ id: string }>(
      "SELECT id FROM expenses WHERE business_id = $1 AND id = $2 AND reversed_at IS NULL FOR UPDATE",
      [params.businessId, params.expenseId],
    );
    if (!locked[0]) {
      await client.query("ROLLBACK");
      throw new ExpenseError("expense_already_reversed");
    }

    const mirrored = await mirroredLines(client, original.journal_entry_id, {
      accountId: original.account_id,
      paymentAccountId: original.payment_account_id,
      amount: Number(original.amount),
      vatAmount: Number(original.vat_amount ?? 0),
    });

    const reference = await nextReference(client, params.businessId, reversalDate);
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO expenses (business_id, location_id, account_id, payment_account_id, amount, vat_amount,
                             expense_date, vendor, party_id, memo, created_by, reference, reverses_expense_id,
                             settlement, supplier_id, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [
        params.businessId,
        original.location_id,
        original.account_id,
        original.payment_account_id,
        Number(original.amount),
        Number(original.vat_amount ?? 0),
        reversalDate,
        original.vendor,
        original.party_id,
        memo.slice(0, 300),
        params.actorId,
        reference,
        params.expenseId,
        // A reversal of an owed expense is itself an A/P movement, or the payable
        // the original opened would stay open forever: the A/P subledger reads the
        // journal, and the mirrored entry's debit only reaches supplier 2100 while
        // this row still says who is owed (audit F11, issue #832 §1).
        original.settlement,
        original.supplier_id,
        original.due_date,
      ],
    );
    reversalId = inserted[0].id;

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: original.location_id,
      entryDate: reversalDate,
      memo: memo.slice(0, 300),
      sourceType: "expense",
      sourceId: reversalId,
      createdBy: params.actorId,
      lines: mirrored,
    });

    const { rows: marked } = await client.query<{ id: string }>(
      `UPDATE expenses SET reversed_at = now(), reversed_by = $2
        WHERE id = $1 AND reversed_at IS NULL RETURNING id`,
      [params.expenseId, params.actorId],
    );
    if (!marked[0]) {
      await client.query("ROLLBACK");
      throw new ExpenseError("expense_already_reversed");
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The transaction is already gone (the explicit rollback paths above).
    }
    throw err;
  } finally {
    client.release();
  }

  const { rows: reversalRows } = await query<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.id = $1`, [reversalId]);
  return toExpense(reversalRows[0]);
}

/**
 * The original entry's lines with debit and credit swapped. Falls back to the
 * expense row's own figures only when the entry cannot be found at all — a
 * posted expense always has one, and the fallback keeps a hand-repaired
 * database reversible rather than stuck.
 */
async function mirroredLines(
  client: PoolClient,
  entryId: string | null,
  fallback: { accountId: string; paymentAccountId: string; amount: number; vatAmount: number },
): Promise<PostJournalEntryInput["lines"]> {
  if (entryId) {
    const { rows } = await client.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit
         FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [entryId],
    );
    if (rows.length > 0) {
      return rows.map((line) => ({
        accountId: line.account_id,
        // `postJournalEntry` takes JS numbers; every journal amount in this
        // platform is an integer Rial that fits in one, and the BIGINT columns
        // come back as strings only to keep the read exact.
        debit: Number(line.credit),
        credit: Number(line.debit),
      }));
    }
  }
  const lines: PostJournalEntryInput["lines"] = [
    { accountId: fallback.paymentAccountId, debit: fallback.amount, credit: 0 },
    { accountId: fallback.accountId, debit: 0, credit: fallback.amount - fallback.vatAmount },
  ];
  if (fallback.vatAmount > 0) {
    lines.splice(1, 0, { accountId: fallback.accountId, debit: 0, credit: fallback.vatAmount });
  }
  return lines;
}

/** One expense with everything the register's detail panel shows. */
export async function getExpense(businessId: string, expenseId: string): Promise<Expense | null> {
  const { rows } = await query<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.business_id = $1 AND e.id = $2`, [
    businessId,
    expenseId,
  ]);
  return rows[0] ? toExpense(rows[0]) : null;
}

/** The lines of the entry an expense posted, for the detail panel's ledger view. */
export async function getExpenseJournalLines(
  businessId: string,
  entryId: string,
): Promise<{ accountCode: string; accountName: string; debit: number; credit: number }[]> {
  const { rows } = await query<{ account_code: string; account_name: string; debit: string; credit: string }>(
    `SELECT a.code AS account_code, a.name AS account_name, l.debit::text AS debit, l.credit::text AS credit
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
       JOIN journal_entries je ON je.id = l.entry_id
      WHERE l.entry_id = $1 AND je.business_id = $2
      ORDER BY l.id`,
    [entryId, businessId],
  );
  return rows.map((row) => ({
    accountCode: row.account_code,
    accountName: row.account_name,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }));
}


