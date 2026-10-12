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
 * One asymmetry worth knowing before changing either half: the engine's in-file
 * rule signs a row only when *every* field of the rule is filled (`validateSheet`
 * refuses to compare two incomplete rows), and an expense row always leaves one of
 * them empty — a paid row has no supplier, an owed row no payment account. So for
 * this entity the repeat inside one file is caught by the database-side lookup
 * during the run, and the row report says so with the same fields; the preview
 * stays quiet rather than guessing. The columns below are therefore written for
 * both readers, and the skip is never silent.
 *
 * Why the old rule was wrong: «تاریخ، مبلغ و سرفصل» made two legitimate,
 * separate expenses — two taxi receipts on the same day, same fare, same
 * category — look like one of them. Two rows that differ only by memo are also
 * not the same transaction, but they are close enough that the operator, not a
 * silent skip, should decide: hence the looser rule is still offered (and
 * `duplicateStrategy: "create"` still means "I know, import it anyway").
 *
 * What the rules may key on is a *contract with the adapter*, not a detail: the
 * fragment this module builds is pasted into a `WHERE` clause the adapter owns.
 * That is why every column here is unqualified — a fragment cannot name an alias
 * it has not chosen. (It used to emit `e.expense_date`, while the adapter's
 * query was `FROM expenses WHERE …` with no `e`, so **every** expense import died
 * on `missing FROM-clause entry for table "e"`: not a wrong skip, a failed run.
 * `expense-import.test.ts` pins the shape and
 * `integration/expense-import-adapter.integration.test.ts` runs the real query.)
 *
 * Since audit F11 the channel can produce an owed expense too — `settlement`,
 * `supplier` and `dueDate` are mapped columns — so a sheet may say «پرداخت بعدی»
 * and the row lands on Accounts Payable like the one the form would have posted.
 * `حساب پرداخت` is therefore required of a **paid** row only, and the adapter
 * refuses rather than ignores anything that contradicts the settlement it was
 * told (a supplier on a paid row, a payment account other than the A/P control
 * account on an owed one), because a silently dropped column is how an import
 * ends up disagreeing with the file it came from.
 */

/** A field of the expense entity a duplicate rule may be keyed on. */
export type ExpenseDuplicateField =
  | "expenseDate"
  | "amount"
  | "accountCode"
  | "paymentAccountCode"
  | "settlement"
  | "supplier"
  | "vendor"
  | "memo";

export interface ExpenseDuplicateRule {
  key: string;
  label: string;
  fields: ExpenseDuplicateField[];
}

/**
 * What the operator is told each matched column is called.
 *
 * The rule's sentence is built from this list rather than written beside it,
 * because a label that names four of seven matched fields is how an operator
 * learns to distrust the report: «از پیش ثبت شده است» has to say *on what grounds*,
 * and the grounds are the `fields` array two lines away.
 */
export const EXPENSE_DUPLICATE_FIELD_LABELS: Record<ExpenseDuplicateField, string> = {
  expenseDate: "تاریخ",
  amount: "مبلغ",
  accountCode: "سرفصل",
  paymentAccountCode: "حساب پرداخت",
  settlement: "نحوهٔ تسویه",
  supplier: "تأمین‌کننده",
  vendor: "طرف حساب",
  memo: "شرح",
};

/** «تاریخ، مبلغ و سرفصل» — Persian list punctuation, from the fields a rule matches. */
export function expenseDuplicateRuleLabel(
  fields: readonly ExpenseDuplicateField[],
  suffix = "",
): string {
  const names = fields.map((field) => EXPENSE_DUPLICATE_FIELD_LABELS[field]);
  const list =
    names.length <= 1
      ? names.join("")
      : `${names.slice(0, -1).join("، ")} و ${names[names.length - 1]}`;
  return suffix ? `${list} (${suffix})` : list;
}

const EXPENSE_DEFAULT_DUPLICATE_FIELDS: readonly ExpenseDuplicateField[] = [
  "expenseDate",
  "amount",
  "accountCode",
  "paymentAccountCode",
  "settlement",
  "supplier",
  "vendor",
  "memo",
];

/**
 * The rules offered to the operator, most specific first — the first is the
 * default, so a re-import of last month's file no longer swallows a second
 * same-day, same-amount receipt that was paid from a different account or to a
 * different vendor.
 */
export const EXPENSE_DUPLICATE_RULES: readonly ExpenseDuplicateRule[] = [
  {
    key: "date_amount_account_payment_party_memo",
    // The linked *person* (`party_id`) is deliberately not part of the identity
    // of a row: it is an enrichment resolved from the free-text «طرف حساب», so
    // the same taxi receipt whose party link one operator added and another left
    // out is still one transaction, not two.
    label: expenseDuplicateRuleLabel(EXPENSE_DEFAULT_DUPLICATE_FIELDS),
    fields: [...EXPENSE_DEFAULT_DUPLICATE_FIELDS],
  },
  {
    key: "date_amount_account",
    // The *older* rule, kept for a file that was itself exported from Biza: it
    // calls more rows duplicates, so it has to be chosen on purpose and labelled
    // as what it does rather than as "stricter".
    label: expenseDuplicateRuleLabel(
      ["expenseDate", "amount", "accountCode"],
      "قاعدهٔ قدیمی — ردیف‌های بیشتری را تکراری می‌گیرد",
    ),
    fields: ["expenseDate", "amount", "accountCode"],
  },
];

/** How one rule field is compared against the `expenses` table. */
export interface ExpenseDuplicateColumn {
  /**
   * The column of `expenses` to compare, **unqualified** — the adapter owns the
   * `FROM` clause, and a fragment that assumed an alias it was never given made
   * the whole import fail with `missing FROM-clause entry for table "e"`.
   */
  column: string;
  /**
   * A cast on the *column* side, needed when a nullable id is compared as text
   * so that an empty cell and a NULL row match instead of erroring on types.
   */
  columnCast: string | null;
  /** A cast to apply to the bound value, when the column needs one. */
  cast: string | null;
  /**
   * `text` compares `IS NOT DISTINCT FROM`-style through COALESCE, because an
   * empty spreadsheet cell and a NULL in the database are the same statement
   * about a row and must not both count as "different".
   */
  nullableText: boolean;
  /** Which resolved value feeds it. */
  source:
    | "expenseDate"
    | "amount"
    | "accountId"
    | "paymentAccountId"
    | "settlement"
    | "supplierId"
    | "vendor"
    | "memo";
}

/** Every rule field has a column; `expense-import.test.ts` fails if one is added without it. */
export const EXPENSE_DUPLICATE_COLUMNS: Record<ExpenseDuplicateField, ExpenseDuplicateColumn> = {
  expenseDate: { column: "expense_date", columnCast: null, cast: "date", nullableText: false, source: "expenseDate" },
  amount: { column: "amount", columnCast: null, cast: null, nullableText: false, source: "amount" },
  accountCode: { column: "account_id", columnCast: null, cast: "uuid", nullableText: false, source: "accountId" },
  paymentAccountCode: {
    column: "payment_account_id",
    columnCast: null,
    cast: "uuid",
    nullableText: false,
    source: "paymentAccountId",
  },
  // `settlement` is NOT NULL with a `'paid'` default (0212), so a paid row and an
  // owed one are never the same transaction even when everything else matches.
  settlement: { column: "settlement", columnCast: null, cast: null, nullableText: false, source: "settlement" },
  supplier: { column: "supplier_id", columnCast: "::text", cast: null, nullableText: true, source: "supplierId" },
  vendor: { column: "vendor", columnCast: null, cast: null, nullableText: true, source: "vendor" },
  memo: { column: "memo", columnCast: null, cast: null, nullableText: true, source: "memo" },
};

/** The rule a write should honour — the first (tightest) when none was chosen. */
export function expenseDuplicateRule(key: string | null | undefined): ExpenseDuplicateRule {
  return EXPENSE_DUPLICATE_RULES.find((rule) => rule.key === key) ?? EXPENSE_DUPLICATE_RULES[0];
}

export interface ExpenseDuplicateValues {
  expenseDate: string | null;
  amount: number;
  accountId: string;
  /** Null on an owed row: the A/P control account is what got credited, not a payment. */
  paymentAccountId: string | null;
  settlement: "paid" | "credit";
  supplierId: string | null;
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
    const side = `${column.column}${column.columnCast ?? ""}`;
    parts.push(
      column.nullableText
        ? `COALESCE(${side}, '') = COALESCE(${placeholder.replace(/::/, "")}, '')`
        : `${side} = ${placeholder}`,
    );
  }
  return { sql: parts.join(" AND "), params };
}
