/**
 * Accounting adapters — chart of accounts, invoices, payments and expenses.
 *
 * Two of the four are export-only, for the same reason POS orders are:
 *
 *  - An **invoice** in this product is an `orders` row with its items, its
 *    inventory movements, its VAT and its journal entry (see
 *    `retail-invoice-service.ts`). There is no `invoices` table to insert
 *    into, and manufacturing one would produce revenue that reconciles with
 *    nothing.
 *  - A **payment** settles an invoice and moves cash between ledger accounts.
 *    A payment with no invoice is a number, not a receipt.
 *
 * Accounts and expenses *are* importable, and both go through their own
 * services (`createAccount`, `recordExpense`) so the chart's level rules and
 * the expense's double-entry posting happen exactly as they do from the
 * screens. An expense imported around `recordExpense` would be an expense with
 * no journal entry — money that left the business and never appeared in the
 * books.
 */

import { query } from "../../db";
import { AccountsError, createAccount, setAccountActive } from "../../accounts-service";
import { MissingLedgerAccountError, recordExpense } from "../../expense-service";
import {
  DIMENSION_CODE_FIELD,
  DIMENSION_ERROR_MESSAGES,
  DIMENSION_KINDS,
  dimensionErrorMessage,
  resolveDimensionCode,
  type LineDimensions,
} from "../../accounting-dimensions";
import { AccountingDimensionError, findDimensionValueByCode } from "../../accounting-dimensions-service";
import { expenseErrorMessage } from "../../expense-errors";
import { parseExpenseAmount, parseExpenseVatAmount } from "../../expense-input";
import { expenseDuplicatePredicate, expenseDuplicateRule } from "../../expense-import";
import { listSupplierDirectory } from "../../ap-service";
import { searchParties } from "../../parties-service";
import {
  parseExpenseSettlement,
  PayablesInputError,
  type ExpenseSettlementInput,
} from "../../payables-input";
import { WELL_KNOWN_CODES } from "../../coa-template";
import { isUuid } from "../../uuid";
import { normaliseHeader } from "../codecs";
import { fiscalPeriodLockErrorCode } from "../../fiscal-periods";
import { postgresDateToIso } from "../../jalali";
import {
  registerAdapter,
  RowRejection,
  type AdapterContext,
  type EntityAdapter,
} from "../adapters";

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return postgresDateToIso(value);
  return String(value).slice(0, 10);
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A supplier, resolved through the canonical A/P directory — the same
 * `listSupplierDirectory` the expense form's picker reads. That matters twice
 * over: the list is tenant-scoped by construction (it joins this business's own
 * branches and skips inactive aliases), so guessing a foreign uuid finds nothing;
 * and one ambiguous name is refused rather than settled by "first match", because
 * a payable booked against the wrong supplier is a bill nobody will ever pay.
 *
 * The three things a file can name a supplier by are its id, its exact name and
 * its phone digits.
 */
async function resolveSupplierId(businessId: string, needle: string): Promise<string> {
  const directory = await listSupplierDirectory(businessId);
  const wanted = needle.trim();
  if (isUuid(wanted)) {
    const direct = directory.find((item) => item.supplierId === wanted);
    if (direct) return direct.supplierId;
  }
  const byName = normaliseHeader(wanted);
  const phoneDigits = wanted.replace(/\D/g, "");
  const matches = directory.filter(
    (item) =>
      normaliseHeader(item.supplierName) === byName ||
      (phoneDigits.length >= 4 && (item.supplierPhone ?? "").replace(/\D/g, "") === phoneDigits),
  );
  if (matches.length === 1) return matches[0].supplierId;
  if (matches.length > 1) {
    throw new RowRejection(`«${wanted}» به بیش از یک تأمین‌کنندهٔ این کسب‌وکار می‌رسد؛ با شناسه مشخصش کنید.`);
  }
  throw new RowRejection(`تأمین‌کنندهٔ «${wanted}» در «حساب‌های پرداختنی» این کسب‌وکار نیست؛ اول همان‌جا بسازیدش.`);
}

/**
 * The same principle for a person, with the directory doing the work only the
 * directory can do: names are matched in the open while phone numbers are hashed
 * with the business's key, and a merged-away or retired record must not become a
 * new expense's counterparty (0148's merge keeps the survivor).
 */
async function resolvePartyId(businessId: string, needle: string): Promise<string> {
  const term = needle.trim();
  const wanted = normaliseHeader(term);
  const phoneDigits = term.replace(/\D/g, "");
  const found = await searchParties(businessId, term, { limit: 25 });
  const exact = found.filter(
    (party) =>
      normaliseHeader(party.name) === wanted ||
      (phoneDigits.length >= 4 && (party.phone ?? "").replace(/\D/g, "") === phoneDigits),
  );
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) {
    throw new RowRejection(`«${term}» به بیش از یک شخص در فهرست اشخاص می‌رسد؛ با شمارهٔ تماس مشخصش کنید.`);
  }
  throw new RowRejection(`شخص «${term}» در فهرست اشخاص این کسب‌وکار نیست (یا دیگر فعال نیست).`);
}

/** An account by code, then by name — the two things a file names one by. */
async function findAccountByLookup(
  businessId: string,
  lookup: string,
): Promise<{ id: string; code: string; name: string; type: string; level: string } | null> {
  const needle = lookup.trim();
  if (!needle) return null;
  const { rows } = await query<{
    id: string;
    code: string;
    name: string;
    type: string;
    level: string;
  }>(
    `SELECT id, code, name, type::text AS type, level::text AS level
       FROM accounts
      WHERE business_id = $1
        AND (code = $2 OR lower(btrim(name)) = lower(btrim($2)))
      ORDER BY (code = $2) DESC
      LIMIT 1`,
    [businessId, needle],
  );
  return rows[0] ?? null;
}

const accountsAdapter: EntityAdapter = {
  entity: "accounting.accounts",
  async read(context, options) {
    const where = ["a.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`a.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.type === "string" && options.filters.type) {
      params.push(options.filters.type);
      where.push(`a.type = $${params.length}::account_type`);
    }
    if (options.filters.activeOnly === true) where.push("a.is_active");
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT a.id, a.code, a.name, a.type::text AS type, a.level::text AS level,
              parent.code AS "parentCode", a.normal_balance AS "normalBalance",
              a.is_active AS "isActive"
         FROM accounts a
         LEFT JOIN accounts parent ON parent.id = a.parent_id
        WHERE ${where.join(" AND ")}
        ORDER BY a.code
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  },
  async write(context, values, options) {
    const code = text(values.code);
    const name = text(values.name);
    if (!code) throw new RowRejection("کد حساب الزامی است.");
    if (!name) throw new RowRejection("نام حساب الزامی است.");
    const warnings: string[] = [];

    let parentId: string | null = null;
    const parentCode = text(values.parentCode);
    if (parentCode) {
      const parent = await findAccountByLookup(context.businessId, parentCode);
      if (parent) parentId = parent.id;
      else {
        const strategy = options.relationStrategy.parentCode ?? "skip";
        if (strategy === "skip") {
          return { status: "skipped", reason: `حساب بالادست «${parentCode}» یافت نشد.` };
        }
        warnings.push(`حساب بالادست «${parentCode}» یافت نشد؛ حساب در سطح گروه ثبت شد.`);
      }
    }

    const existing = await findAccountByLookup(
      context.businessId,
      options.duplicateRule === "name" ? name : code,
    );
    if (existing && options.duplicateStrategy === "skip") {
      return {
        status: "skipped",
        id: existing.id,
        reason: `حساب «${existing.code} — ${existing.name}» از پیش وجود دارد.`,
      };
    }
    if (existing && options.duplicateStrategy === "update") {
      // Name and active flag only. Re-typing a code or re-parenting an account
      // reshapes every historical report built on it, and the chart screen
      // gates both behind their own confirmations for exactly that reason.
      await query(
        `UPDATE accounts SET name = $3 WHERE business_id = $1 AND id = $2`,
        [context.businessId, existing.id, name],
      );
      if (values.isActive !== undefined) {
        await setAccountActive(context.businessId, existing.id, values.isActive !== false);
      }
      return { status: "updated", id: existing.id, warnings };
    }

    try {
      const created = await createAccount({
        businessId: context.businessId,
        code,
        name,
        type: String(values.type ?? "expense"),
        parentId,
      });
      if (values.isActive === false) {
        await setAccountActive(context.businessId, created.id, false);
      }
      return { status: "created", id: created.id, warnings };
    } catch (error) {
      if (error instanceof AccountsError) throw new RowRejection(accountErrorMessage(error.message));
      throw error;
    }
  },
  async resolveReference(context, lookup) {
    const account = await findAccountByLookup(context.businessId, lookup);
    return account ? { id: account.id, label: `${account.code} — ${account.name}` } : null;
  },
};

function accountErrorMessage(code: string): string {
  switch (code) {
    case "code_in_use":
      return "این کد حساب از پیش استفاده شده است.";
    case "invalid_code":
      return "کد حساب معتبر نیست.";
    case "code_required":
      return "کد حساب الزامی است.";
    case "name_required":
      return "نام حساب الزامی است.";
    case "invalid_type":
      return "نوع حساب معتبر نیست.";
    case "parent_not_found":
      return "حساب بالادست یافت نشد.";
    case "parent_too_deep":
      return "حساب بالادست در پایین‌ترین سطح است و زیرمجموعه نمی‌پذیرد.";
    default:
      return `ثبت حساب ممکن نشد (${code}).`;
  }
}

/**
 * The invoice projection.
 *
 * A retail invoice is an `orders` row (see `retail-invoice-service.ts`), so
 * this reads orders and presents them in invoice vocabulary, with the customer
 * name and the branch resolved — never `customer_id`.
 */
const invoicesAdapter: EntityAdapter = {
  entity: "accounting.invoices",
  async read(context, options) {
    const where = ["l.business_id = $1", "o.status = 'completed'"];
    const params: unknown[] = [context.businessId];
    if (context.locationId) {
      params.push(context.locationId);
      where.push(`o.location_id = $${params.length}`);
    }
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`o.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.dateFrom === "string" && options.filters.dateFrom) {
      params.push(options.filters.dateFrom);
      where.push(`o.closed_at >= $${params.length}::date`);
    }
    if (typeof options.filters.dateTo === "string" && options.filters.dateTo) {
      params.push(options.filters.dateTo);
      where.push(`o.closed_at < ($${params.length}::date + interval '1 day')`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT o.id, o.order_number AS "invoiceNumber", p.name AS "customerName",
              p.phone AS "customerPhone", o.closed_at AS "invoiceDate",
              o.subtotal, o.discount, o.tax, o.total,
              coalesce((SELECT sum(pay.amount) FROM payments pay
                         WHERE pay.order_id = o.id), 0) AS paid,
              o.total - coalesce((SELECT sum(pay.amount) FROM payments pay
                                   WHERE pay.order_id = o.id), 0) AS balance,
              l.name AS "branchName"
         FROM orders o
         JOIN locations l ON l.id = o.location_id
         LEFT JOIN parties p ON p.id = o.customer_id
        WHERE ${where.join(" AND ")}
        ORDER BY o.closed_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      invoiceNumber: Number(row.invoiceNumber ?? 0),
      invoiceDate: isoDate(row.invoiceDate),
      subtotal: Number(row.subtotal ?? 0),
      discount: Number(row.discount ?? 0),
      tax: Number(row.tax ?? 0),
      total: Number(row.total ?? 0),
      paid: Number(row.paid ?? 0),
      balance: Number(row.balance ?? 0),
    }));
  },
};

const paymentsAdapter: EntityAdapter = {
  entity: "accounting.payments",
  async read(context, options) {
    const where = ["l.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (context.locationId) {
      params.push(context.locationId);
      where.push(`pay.location_id = $${params.length}`);
    }
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`pay.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.method === "string" && options.filters.method) {
      params.push(options.filters.method);
      where.push(`pay.method = $${params.length}::payment_method`);
    }
    if (typeof options.filters.dateFrom === "string" && options.filters.dateFrom) {
      params.push(options.filters.dateFrom);
      where.push(`pay.received_at >= $${params.length}::date`);
    }
    if (typeof options.filters.dateTo === "string" && options.filters.dateTo) {
      params.push(options.filters.dateTo);
      where.push(`pay.received_at < ($${params.length}::date + interval '1 day')`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT pay.id, o.order_number AS "invoiceNumber", p.name AS "customerName",
              pay.method::text AS method, pay.amount, pay.received_at AS "receivedAt",
              pay.reference, l.name AS "branchName"
         FROM payments pay
         JOIN locations l ON l.id = pay.location_id
         JOIN orders o ON o.id = pay.order_id
         LEFT JOIN parties p ON p.id = o.customer_id
        WHERE ${where.join(" AND ")}
        ORDER BY pay.received_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      invoiceNumber: Number(row.invoiceNumber ?? 0),
      amount: Number(row.amount ?? 0),
      receivedAt: isoDate(row.receivedAt),
    }));
  },
};

/**
 * The four code columns a sheet may carry, resolved to this business's own values
 * (issue #868). A code that names nothing, or names an archived value, refuses the
 * row by name: an import never creates a cost centre it was not told about, and
 * never drops one it was. Whether the kind is enabled, and whether the value is
 * open at this branch and on this date, is the posting guard's question, asked by
 * `recordExpense` exactly as the screens ask it, so it is decided once.
 */
async function resolveExpenseDimensions(
  businessId: string,
  values: Record<string, unknown>,
): Promise<LineDimensions> {
  const dimensions: LineDimensions = {};
  for (const kind of DIMENSION_KINDS) {
    const cell = text(values[DIMENSION_CODE_FIELD[kind]]);
    if (cell === null) continue;
    const value = await findDimensionValueByCode(businessId, kind, cell);
    const resolution = resolveDimensionCode(cell, value ? [value] : []);
    if (resolution.status === "unknown") {
      throw new RowRejection(`${DIMENSION_ERROR_MESSAGES.unknown_dimension_code} («${cell}»)`);
    }
    if (resolution.status === "inactive") {
      throw new RowRejection(`${DIMENSION_ERROR_MESSAGES.inactive_dimension_code} («${cell}»)`);
    }
    dimensions[kind] = resolution.valueId;
  }
  return dimensions;
}

const expensesAdapter: EntityAdapter = {
  entity: "accounting.expenses",
  async read(context, options) {
    const where = ["e.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`e.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.dateFrom === "string" && options.filters.dateFrom) {
      params.push(options.filters.dateFrom);
      where.push(`e.expense_date >= $${params.length}::date`);
    }
    if (typeof options.filters.dateTo === "string" && options.filters.dateTo) {
      params.push(options.filters.dateTo);
      where.push(`e.expense_date <= $${params.length}::date`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT e.id, a.code AS "accountCode", pa.code AS "paymentAccountCode",
              e.amount, e.expense_date AS "expenseDate", e.vendor, e.memo,
              e.vat_amount AS "vatAmount", e.settlement, e.due_date::text AS "dueDate",
              e.reference, COALESCE(sp.name, s.name) AS "supplier", pt.name AS "party",
              dcc.code AS "costCenterCode", dpc.code AS "profitCenterCode",
              ddp.code AS "departmentCode", ddt.code AS "detailCode"
         FROM expenses e
         JOIN accounts a ON a.id = e.account_id
         JOIN accounts pa ON pa.id = e.payment_account_id
         LEFT JOIN suppliers s ON s.id = e.supplier_id
         LEFT JOIN parties sp ON sp.id = s.party_id
         LEFT JOIN parties pt ON pt.id = e.party_id
         -- The attribution a row carries, as the code it was entered with. The business
         -- check is repeated here on purpose: the id alone would be enough for the
         -- database, and a reader should not have to know that to trust the join.
         LEFT JOIN accounting_dimension_values dcc
                ON dcc.id = e.cost_center_id AND dcc.business_id = e.business_id
         LEFT JOIN accounting_dimension_values dpc
                ON dpc.id = e.profit_center_id AND dpc.business_id = e.business_id
         LEFT JOIN accounting_dimension_values ddp
                ON ddp.id = e.department_id AND ddp.business_id = e.business_id
         LEFT JOIN accounting_dimension_values ddt
                ON ddt.id = e.detail_dimension_id AND ddt.business_id = e.business_id
        WHERE ${where.join(" AND ")}
        ORDER BY e.expense_date DESC, e.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    /*
     * The export is the register's own projection: the supplier's party name when
     * there is one and the branch alias's when there is not, exactly as
     * `SELECT_EXPENSE` resolves it — so the sheet an operator exports is a sheet
     * they can feed back in, and every column here is one `write` accepts.
     * `reference` is read-only, which is the engine's way of saying it may inform a
     * file but may never be written, so no import can claim an existing document
     * number.
     */
    return rows.map((row) => ({
      ...row,
      amount: Number(row.amount ?? 0),
      vatAmount: Number(row.vatAmount ?? 0),
      expenseDate: isoDate(row.expenseDate),
      dueDate: isoDate(row.dueDate),
    }));
  },
  async write(context: AdapterContext, values, options) {
    const accountLookup = text(values.accountCode);
    const paymentLookup = text(values.paymentAccountCode);
    if (!accountLookup) throw new RowRejection("سرفصل هزینه الزامی است.");

    /*
     * The settlement is read by the parser the form, the API and the service share,
     * and *before* any account rule, because it decides which rules apply to this
     * row at all: an owed expense has no payment account to check. A cell holding
     * anything else is refused with that code's own words — never defaulted to
     * «پرداخت‌شده», which is how a channel ends up disagreeing with the file it
     * just read (issue #832 §16).
     */
    const supplierCell = text(values.supplier);
    const dueCell = text(values.dueDate);
    const settlementCell =
      values.settlement === null || values.settlement === undefined ? null : String(values.settlement);
    /*
     * The engine's own `enum` coercion has already run: «پرداخت بعدی» arrived as
     * `credit`, and a cell saying anything else left the row in `error` — a status
     * `runImportJob` never writes, so an unreadable settlement is never read as
     * paid either. This guard is therefore not the rule but the promise that the
     * adapter stays right even when handed a mapped object from elsewhere, and that
     * an empty cell means what the form and `POST /api/ledger/expenses` say it
     * means — which `parseExpenseSettlement` below states, once.
     */
    if (settlementCell !== null && settlementCell !== "paid" && settlementCell !== "credit") {
      throw new RowRejection(
        expenseErrorMessage("invalid_settlement") ?? "نحوهٔ تسویهٔ این ردیف معتبر نیست.",
      );
    }
    const onCredit = settlementCell === "credit";
    if (!onCredit && (supplierCell !== null || dueCell !== null)) {
      /*
       * `parseExpenseSettlement` clears both fields for a paid row, and 0212's
       * `expenses_settlement_shape` CHECK forbids storing them. Dropping them in
       * silence would post a bill whose supplier nobody recorded, so the row comes
       * back with the contradiction named — the only answer that lets the operator
       * fix the file instead of the ledger.
       */
      throw new RowRejection(
        "«تأمین‌کننده» و «سررسید پرداخت» فقط برای «پرداخت بعدی» پر می‌شوند؛ یا نحوهٔ تسویه را عوض کنید یا این دو ستون را خالی بگذارید.",
      );
    }
    if (!onCredit && !paymentLookup) throw new RowRejection("برای «پرداخت‌شده» «حساب پرداخت» الزامی است.");

    const account = await findAccountByLookup(context.businessId, accountLookup);
    if (!account) {
      const strategy = options.relationStrategy.accountCode ?? "skip";
      if (strategy !== "create") {
        return { status: "skipped", reason: `سرفصل هزینهٔ «${accountLookup}» یافت نشد.` };
      }
      throw new RowRejection(
        `سرفصل هزینهٔ «${accountLookup}» یافت نشد. سرفصل حسابداری باید از پیش تعریف شده باشد.`,
      );
    }

    /*
     * An owed expense credits the Accounts Payable control account, which the
     * service derives from this business's own chart — so on such a row the column
     * is not a choice to honour. It is accepted when it agrees (an export carries
     * 2100 on every owed row, and a sheet that round-trips has to re-import) and
     * refused when it names anything else: crediting some other account on a row
     * that says «پرداخت بعدی» is a payment nobody made.
     */
    let paymentAccountId: string | null = null;
    if (paymentLookup) {
      const found = await findAccountByLookup(context.businessId, paymentLookup);
      if (!found) {
        return { status: "skipped", reason: `حساب پرداخت «${paymentLookup}» یافت نشد.` };
      }
      if (onCredit && found.code !== WELL_KNOWN_CODES.accountsPayable) {
        throw new RowRejection(
          `برای «پرداخت بعدی» حساب پرداخت جدا تعیین نمی‌شود؛ بستانکار «${WELL_KNOWN_CODES.accountsPayable} حساب‌های پرداختنی» است. این ستون را خالی بگذارید.`,
        );
      }
      paymentAccountId = found.id;
    } else if (onCredit) {
      /*
       * Matching only. The duplicate lookup has to compare against what the write
       * will store — the control account — or re-importing the same sheet would
       * post the bill a second time. The write re-derives the id inside its own
       * transaction, so nothing resolved here is trusted as the answer.
       */
      const control = await findAccountByLookup(context.businessId, WELL_KNOWN_CODES.accountsPayable);
      paymentAccountId = control?.id ?? null;
    }

    // Both directories, both tenant-scoped, both refusing to guess (see above).
    const supplierId = onCredit && supplierCell ? await resolveSupplierId(context.businessId, supplierCell) : null;
    const partyCell = text(values.party);
    const partyId = partyCell ? await resolvePartyId(context.businessId, partyCell) : null;

    /*
     * The shared settlement rule gets the last word on the pair, because it owns
     * «a credit row must name someone», the due date's shape, and the clearing of
     * both on a paid row. It is asked *after* the directory lookup on purpose: a
     * spreadsheet names a supplier rather than quoting its uuid, so handing the
     * cell straight to the parser would call «برکت» an invalid supplier id, and
     * handing it an empty one would call the same cell a missing supplier. Both are
     * wrong refusals of a file that was fine; resolving first lets the rule refuse
     * only what is genuinely absent.
     */
    let parsed: ExpenseSettlementInput;
    try {
      parsed = parseExpenseSettlement({ settlement: settlementCell, supplierId, dueDate: dueCell });
    } catch (err) {
      if (err instanceof PayablesInputError) {
        throw new RowRejection(
          expenseErrorMessage(err.code) ?? `نحوهٔ تسویه این ردیف پذیرفته نیست (${err.code}).`,
        );
      }
      throw err;
    }

    const amount = parseExpenseAmount(values.amount);
    if (amount === null) {
      throw new RowRejection(expenseErrorMessage("invalid_amount") ?? "مبلغ هزینه معتبر نیست.");
    }
    const vatAmount = parseExpenseVatAmount(values.vatAmount ?? 0);
    if (vatAmount === null) {
      throw new RowRejection(expenseErrorMessage("vat_amount_invalid") ?? "مالیات بر ارزش افزودهٔ هزینه معتبر نیست.");
    }
    const expenseDate = typeof values.expenseDate === "string" ? values.expenseDate : null;
    const memo = text(values.memo) ?? "ورود از فایل";
    const vendor = text(values.vendor);
    // Refused before the duplicate check, so a row with an unknown code is named as
    // that, whether or not it would also have been a duplicate.
    const dimensions = await resolveExpenseDimensions(context.businessId, values);

    /*
     * Duplicates are matched on the rule the operator chose — by default date,
     * amount, category, payment account, settlement, supplier, vendor and memo —
     * and the clause comes from `expense-import.ts`, the same table the in-file
     * preview compares on (issue #832 §16). The old three-field match made two
     * legitimate, separate expenses on one day (two taxis, same fare, same
     * category) look like a re-import, and a silently skipped row is a row nobody
     * can find afterwards. The settlement and the supplier belong in the match for
     * the same reason: the same amount paid from a till is not the same bill owed
     * to a person, and one bill owed to two suppliers is two bills.
     */
    const rule = expenseDuplicateRule(options.duplicateRule);
    const duplicate = expenseDuplicatePredicate(
      rule,
      {
        expenseDate,
        amount,
        accountId: account.id,
        paymentAccountId,
        settlement: onCredit ? "credit" : "paid",
        supplierId,
        vendor,
        memo,
      },
      2,
    );
    // Dimension attribution is part of identity (issue #868): two rows that are
    // identical on every other field but carry different cost-centre/profit-centre
    // codes are different expenses. This comparison is appended to the operator's
    // chosen rule rather than offered as a selectable field, because an imported
    // cell that names a dimension code always resolves before duplicate detection.
    const dimStart = duplicate.params.length + 2; // $1 is business_id; base uses $2..
    const dimParts = ["cost_center_id", "profit_center_id", "department_id", "detail_dimension_id"]
      .map((col, i) => `COALESCE(${col}::text, '') = COALESCE($${dimStart + i}::uuid::text, '')`)
      .join(" AND ");
    duplicate.params.push(
      dimensions.cost_center ?? null,
      dimensions.profit_center ?? null,
      dimensions.department ?? null,
      dimensions.detail ?? null,
    );
    const { rows: existingRows } = await query<{ id: string }>(
      `SELECT id FROM expenses WHERE business_id = $1 AND ${duplicate.sql} AND ${dimParts} LIMIT 1`,
      [context.businessId, ...duplicate.params],
    );
    const existing = existingRows[0];
    if (existing && options.duplicateStrategy !== "create") {
      return {
        status: "skipped",
        id: existing.id,
        reason: `هزینه‌ای با همین ${rule.label} از پیش ثبت شده است. اگر واقعاً دو هزینهٔ جداست، با استراتژی «ایجاد» واردش کنید.`,
      };
    }

    try {
      const expense = await recordExpense({
        businessId: context.businessId,
        locationId: context.locationId,
        accountId: account.id,
        // Null on an owed row: there is nothing for the file to have chosen, and
        // the service resolves the control account inside the same transaction.
        paymentAccountId,
        settlement: parsed.settlement,
        supplierId,
        dueDate: parsed.dueDate,
        amount,
        vatAmount,
        expenseDate,
        vendor,
        partyId,
        memo,
        dimensions,
        createdBy: context.actorUserId,
      });
      return { status: "created", id: String(expense.id) };
    } catch (error) {
      if (error instanceof AccountingDimensionError) {
        // The posting guard's own answer, in the words the screens use (issue #868): a
        // kind the business has not enabled, or a value closed on this date or at this
        // branch. Named, so the operator knows which setting or which value to change.
        throw new RowRejection(dimensionErrorMessage(error.message));
      }
      if (error instanceof MissingLedgerAccountError) {
        // The answer `POST /api/ledger/expenses` gives for the same fact (409
        // `ledger_account_missing`). This is not an `ExpenseError`, so before it was
        // mapped the operator read «ثبت هزینه ممکن نشد (2100).» — a bare account code
        // where a sentence should be, for a chart they can actually go and fix.
        throw new RowRejection(
          `حساب «${error.code}» در سرفصل این کسب‌وکار نیست؛ «پرداخت بعدی» بدون آن ثبت نمی‌شود.`,
        );
      }
      const code = error instanceof Error ? error.message : "unknown";
      const lockCode = fiscalPeriodLockErrorCode(error);
      // Every code the service can throw, translated by the one map the screen
      // also uses (issue #832 §17). This used to hand-translate a private switch
      // that still mentioned `wrong_account_type` and `period_closed` — codes the
      // expense service stopped emitting years ago — so a real failure such as
      // «this is not a payment account» reached the operator as raw technical
      // text, and the fiscal lock was mistaken for a closed period.
      throw new RowRejection(
        lockCode === "fiscal_period_locked"
          ? "دورهٔ مالی این تاریخ قفل است و امکان ثبت سند وجود ندارد."
          : lockCode === "fiscal_period_soft_closed"
            ? "دورهٔ مالی این تاریخ بستهٔ موقت است؛ فقط مالک یا حسابدار می‌تواند سند ثبت کند."
            : (expenseErrorMessage(code) ?? `ثبت هزینه ممکن نشد (${code}).`),
      );
    }
  },
};

export function registerAccountingAdapters(): void {
  registerAdapter(accountsAdapter);
  registerAdapter(invoicesAdapter);
  registerAdapter(paymentsAdapter);
  registerAdapter(expensesAdapter);
}
