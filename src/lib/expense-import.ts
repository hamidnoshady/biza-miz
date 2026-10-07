/**
 * Pure rules for the `accounting.expenses` import channel (issue #832 §16).
 *
 * The engine's duplicate detection is split in two by design: rows *inside one
 * file* are compared in `mapping.ts` against an entity's `duplicateRules`, and
 * rows that already exist in the database are found by the adapter's own
 * lookup. Both halves must mean the same thing by the same fields, or the
 * preview tells the operator one story and the write does another — so the rule
 * list and the field→column table live here, and the registry and the adapter
 * each read them instead of restating them.
 *
 * Why the old rule was wrong: «تاریخ، مبلغ و سرفصل» made two legitimate,
 * separate expenses — two taxi receipts on the same day, same fare, same
 * category — look like one of them. Two rows that differ only by memo are also
 * not the same transaction, but they are close enough that the operator, not a
 * silent skip, should decide: hence the looser rule is still offered (and
 * `duplicateStrategy: "create"` still means "I know, import it anyway").
 */

/** A field of the expense entity a duplicate rule may be keyed on. */
export type ExpenseDuplicateField =
  | "expenseDate"
  | "amount"
  | "accountCode"
  | "paymentAccountCode"
  | "vendor"
  | "memo";

export interface ExpenseDuplicateRule {
  key: string;
  label: string;
  fields: ExpenseDuplicateField[];
}

/**
 * The rules offered to the operator, most specific first — the first is the
 * default, so a re-import of last month's file no longer swallows a second
 * same-day, same-amount receipt that was paid from a different account or to a
 * different vendor.
 */
export const EXPENSE_DUPLICATE_RULES: readonly ExpenseDuplicateRule[] = [
  {
    key: "date_amount_account_payment_party_memo",
    label: "تاریخ، مبلغ، سرفصل، حساب پرداخت و شرح",
    fields: ["expenseDate", "amount", "accountCode", "paymentAccountCode", "vendor", "memo"],
  },
  {
    key: "date_amount_account",
    // The *older* rule, kept for a file that was itself exported from Biza: it
    // calls more rows duplicates, so it has to be chosen on purpose and labelled
    // as what it does rather than as "stricter".
    label: "تاریخ، مبلغ و سرفصل (قاعدهٔ قدیمی — ردیف‌های بیشتری را تکراری می‌گیرد)",
    fields: ["expenseDate", "amount", "accountCode"],
  },
];

/** How one rule field is compared against the `expenses` table. */
export interface ExpenseDuplicateColumn {
  /** The SQL expression to compare. */
  column: string;
  /** A cast to apply to the bound value, when the column needs one. */
  cast: string | null;
  /**
   * `text` compares `IS NOT DISTINCT FROM`-style through COALESCE, because an
   * empty spreadsheet cell and a NULL in the database are the same statement
   * about a row and must not both count as "different".
   */
  nullableText: boolean;
  /** Which resolved value feeds it. */
  source: "expenseDate" | "amount" | "accountId" | "paymentAccountId" | "vendor" | "memo";
}

/** Every rule field has a column; `expense-import.test.ts` fails if one is added without it. */
export const EXPENSE_DUPLICATE_COLUMNS: Record<ExpenseDuplicateField, ExpenseDuplicateColumn> = {
  expenseDate: { column: "e.expense_date", cast: "date", nullableText: false, source: "expenseDate" },
  amount: { column: "e.amount", cast: null, nullableText: false, source: "amount" },
  accountCode: { column: "e.account_id", cast: "uuid", nullableText: false, source: "accountId" },
  paymentAccountCode: {
    column: "e.payment_account_id",
    cast: "uuid",
    nullableText: false,
    source: "paymentAccountId",
  },
  vendor: { column: "e.vendor", cast: null, nullableText: true, source: "vendor" },
  memo: { column: "e.memo", cast: null, nullableText: true, source: "memo" },
};

/** The rule a write should honour — the first (tightest) when none was chosen. */
export function expenseDuplicateRule(key: string | null | undefined): ExpenseDuplicateRule {
  return EXPENSE_DUPLICATE_RULES.find((rule) => rule.key === key) ?? EXPENSE_DUPLICATE_RULES[0];
}

export interface ExpenseDuplicateValues {
  expenseDate: string | null;
  amount: number;
  accountId: string;
  paymentAccountId: string;
  vendor: string | null;
  memo: string | null;
}

/**
 * The SQL fragment that finds the row a given import row would duplicate, with
 * its parameters in binding order. A `WHERE` clause rather than a whole query, so
 * the adapter keeps ownership of the table, the tenant and the `LIMIT`.
 */
export function expenseDuplicatePredicate(
  rule: ExpenseDuplicateRule,
  values: ExpenseDuplicateValues,
  firstParam = 4,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const field of rule.fields) {
    const column = EXPENSE_DUPLICATE_COLUMNS[field];
    if (!column) continue; // Unreachable while the test holds the two tables in step.
    const value = values[column.source];
    const placeholder = `$${firstParam + params.length}${column.cast ? `::${column.cast}` : ""}`;
    params.push(value ?? null);
    parts.push(
      column.nullableText
        ? `COALESCE(${column.column}, '') = COALESCE(${placeholder.replace(/::/, "")}, '')`
        : `${column.column} = ${placeholder}`,
    );
  }
  return { sql: parts.join(" AND "), params };
}
