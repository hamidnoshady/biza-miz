/**
 * The import channel's pure rules (issue #832 §16).
 *
 * The engine compares rows *inside one file* against `duplicateRules` and rows
 * against the *database* in the adapter's own lookup. Both halves read the tables
 * asserted here, which is the only reason they still mean the same thing: the
 * preview tells the operator «۲ ردیف تکراری» about the same fields the write will
 * skip on. If a field is added to a rule without a column, or a rule's fields go
 * out of the column table, these tests fail before an import can quietly skip
 * rows for a reason the preview never mentioned.
 */
import { describe, expect, it } from "vitest";
import {
  EXPENSE_DUPLICATE_COLUMNS,
  EXPENSE_DUPLICATE_RULES,
  expenseDuplicatePredicate,
  expenseDuplicateRule,
  type ExpenseDuplicateValues,
} from "./expense-import";

const VALUES: ExpenseDuplicateValues = {
  expenseDate: "2026-04-01",
  amount: 12_000_000,
  accountId: "11111111-1111-1111-1111-111111111111",
  paymentAccountId: "22222222-2222-2222-2222-222222222222",
  vendor: "سوپرمارکت",
  memo: "خرید هفته",
};

describe("EXPENSE_DUPLICATE_RULES", () => {
  it("offers the tighter rule first, because that is the default", () => {
    // The audit's case: two taxi receipts, same day, same fare, same category.
    // Under the old rule the second one was silently skipped; the default now
    // compares the payment account, the vendor and the memo as well.
    expect(EXPENSE_DUPLICATE_RULES[0].fields).toEqual([
      "expenseDate",
      "amount",
      "accountCode",
      "paymentAccountCode",
      "vendor",
      "memo",
    ]);
    expect(expenseDuplicateRule(undefined)).toBe(EXPENSE_DUPLICATE_RULES[0]);
  });

  it("still offers the old rule, labelled as the looser one", () => {
    const legacy = EXPENSE_DUPLICATE_RULES.find((rule) => rule.key === "date_amount_account");
    expect(legacy?.fields).toEqual(["expenseDate", "amount", "accountCode"]);
    // Every rule is labelled in Persian and no two rules share a label.
    for (const rule of EXPENSE_DUPLICATE_RULES) expect(rule.label.trim().length).toBeGreaterThan(8);
    expect(new Set(EXPENSE_DUPLICATE_RULES.map((rule) => rule.label)).size).toBe(EXPENSE_DUPLICATE_RULES.length);
  });

  it("falls back to the default for an unknown key rather than importing without a rule", () => {
    expect(expenseDuplicateRule("nope")).toBe(EXPENSE_DUPLICATE_RULES[0]);
    expect(expenseDuplicateRule("")).toBe(EXPENSE_DUPLICATE_RULES[0]);
  });

  it("covers every rule with distinct keys", () => {
    const keys = EXPENSE_DUPLICATE_RULES.map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("EXPENSE_DUPLICATE_COLUMNS", () => {
  it("has a column for every field any rule names", () => {
    for (const rule of EXPENSE_DUPLICATE_RULES) {
      for (const field of rule.fields) {
        expect(EXPENSE_DUPLICATE_COLUMNS[field], `${rule.key}.${field}`).toBeDefined();
        expect(EXPENSE_DUPLICATE_COLUMNS[field].column, field).toMatch(/^e\.[a-z_]+$/);
        expect(EXPENSE_DUPLICATE_COLUMNS[field].source, field).toBeTruthy();
      }
    }
  });

  it("compares the columns the register actually stores", () => {
    expect(EXPENSE_DUPLICATE_COLUMNS.accountCode.column).toBe("e.account_id");
    expect(EXPENSE_DUPLICATE_COLUMNS.paymentAccountCode.column).toBe("e.payment_account_id");
    expect(EXPENSE_DUPLICATE_COLUMNS.amount.column).toBe("e.amount");
    expect(EXPENSE_DUPLICATE_COLUMNS.expenseDate.cast).toBe("date");
  });
});

describe("expenseDuplicatePredicate", () => {
  it("builds one equality per field, in the rule's own order, with params to match", () => {
    const { sql, params } = expenseDuplicatePredicate(EXPENSE_DUPLICATE_RULES[1], VALUES);
    expect(sql).toBe(
      `e.expense_date = $4::date AND e.amount = $5 AND e.account_id = $6::uuid`,
    );
    expect(params).toEqual([VALUES.expenseDate, VALUES.amount, VALUES.accountId]);
  });

  it("numbers placeholders from the caller's first parameter", () => {
    const { sql } = expenseDuplicatePredicate(EXPENSE_DUPLICATE_RULES[1], VALUES, 7);
    expect(sql).toContain("$7::date");
    expect(sql).toContain("$9::uuid");
  });

  it("treats an empty cell and a NULL column as the same statement about a row", () => {
    // Both text fields are compared through COALESCE: a spreadsheet whose vendor
    // column is blank must not "differ" from a stored NULL for no reason, and
    // must not either — the pair is symmetric, which is what makes the skip
    // decision reproducible between preview and write.
    const { sql } = expenseDuplicatePredicate(EXPENSE_DUPLICATE_RULES[0], VALUES);
    expect(sql).toContain("COALESCE(e.vendor, '') = COALESCE($8, '')");
    expect(sql).toContain("COALESCE(e.memo, '') = COALESCE($9, '')");
  });

  it("never matches on a missing expense date", () => {
    // `e.expense_date = NULL::date` is unknown, not true, so a row with no date
    // is imported rather than skipped. The alternative — an `IS NULL`-tolerant
    // comparison — would let one undated row absorb every other undated row of
    // the same amount, and a possible duplicate is a better outcome than a
    // silently missing expense.
    const { sql, params } = expenseDuplicatePredicate(EXPENSE_DUPLICATE_RULES[0], {
      ...VALUES,
      expenseDate: null,
    });
    expect(sql).toContain("e.expense_date = $4::date");
    expect(params[0]).toBeNull();
  });

  it("keeps a distinct payment account from looking like a duplicate", () => {
    const defaultRule = EXPENSE_DUPLICATE_RULES[0];
    const paid = expenseDuplicatePredicate(defaultRule, VALUES);
    const otherAccount = expenseDuplicatePredicate(defaultRule, {
      ...VALUES,
      paymentAccountId: "33333333-3333-3333-3333-333333333333",
    });
    // Same fields compared, different value bound: the SQL is identical, which is
    // the point — the *database* decides whether the two rows differ.
    expect(paid.sql).toBe(otherAccount.sql);
    expect(paid.params).not.toEqual(otherAccount.params);
  });
});
