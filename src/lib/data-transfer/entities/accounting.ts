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
import { recordExpense } from "../../expense-service";
import { expenseErrorMessage } from "../../expense-errors";
import { expenseDuplicatePredicate, expenseDuplicateRule } from "../../expense-import";
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
              e.amount, e.expense_date AS "expenseDate", e.vendor, e.memo
         FROM expenses e
         JOIN accounts a ON a.id = e.account_id
         JOIN accounts pa ON pa.id = e.payment_account_id
        WHERE ${where.join(" AND ")}
        ORDER BY e.expense_date DESC, e.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      amount: Number(row.amount ?? 0),
      expenseDate: isoDate(row.expenseDate),
    }));
  },
  async write(context: AdapterContext, values, options) {
    const accountLookup = text(values.accountCode);
    const paymentLookup = text(values.paymentAccountCode);
    if (!accountLookup) throw new RowRejection("سرفصل هزینه الزامی است.");
    if (!paymentLookup) throw new RowRejection("حساب پرداخت الزامی است.");

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
    const paymentAccount = await findAccountByLookup(context.businessId, paymentLookup);
    if (!paymentAccount) {
      return { status: "skipped", reason: `حساب پرداخت «${paymentLookup}» یافت نشد.` };
    }

    const amount = typeof values.amount === "number" ? values.amount : 0;
    const expenseDate = typeof values.expenseDate === "string" ? values.expenseDate : null;
    const memo = text(values.memo) ?? "ورود از فایل";
    const vendor = text(values.vendor);

    /*
     * Duplicates are matched on the rule the operator chose — by default date +
     * amount + category + payment account + vendor + memo — and the clause comes
     * from `expense-import.ts`, the same table the in-file preview compares on
     * (issue #832 §16). The old three-field match made two legitimate, separate
     * expenses on one day (two taxis, same fare, same category) look like a
     * re-import, and a silently skipped row is a row nobody can find afterwards.
     */
    const rule = expenseDuplicateRule(options.duplicateRule);
    const duplicate = expenseDuplicatePredicate(
      rule,
      {
        expenseDate,
        amount,
        accountId: account.id,
        paymentAccountId: paymentAccount.id,
        vendor,
        memo,
      },
      2,
    );
    const { rows: existingRows } = await query<{ id: string }>(
      `SELECT id FROM expenses WHERE business_id = $1 AND ${duplicate.sql} LIMIT 1`,
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
        paymentAccountId: paymentAccount.id,
        amount,
        expenseDate,
        vendor: text(values.vendor),
        memo,
        createdBy: context.actorUserId,
      });
      return { status: "created", id: String(expense.id) };
    } catch (error) {
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
