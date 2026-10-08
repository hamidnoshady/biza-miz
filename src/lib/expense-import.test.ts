/**
 * The import channel's pure rules (issue #832 §16).
 *
 * The engine compares rows *inside one file* against `duplicateRules` and rows
 * against the *database* in the adapter's own lookup. Both halves read the tables
 * asserted here, which is the only reason they still mean the same thing: whichever
 * half fires, the fields it compared are the fields the other half would have
 * compared. If a field is added to a rule without a column, or a rule's fields go
 * out of the column table, these tests fail before an import can quietly skip a
 * row for a reason nobody was told.
 *
 * They cannot, however, prove the fragment is *valid SQL in the query it is pasted
 * into* — that assumption is what broke the whole channel once already (see the
 * alias test), which is why the integration file exists beside this one.
 */
import { describe, expect, it } from "vitest";
import {
  EXPENSE_DUPLICATE_FIELD_LABELS,
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
  settlement: "paid",
  supplierId: null,
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
      "settlement",
      "supplier",
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
        expect(EXPENSE_DUPLICATE_COLUMNS[field].column, field).toMatch(/^[a-z_]+$/);
        expect(EXPENSE_DUPLICATE_COLUMNS[field].source, field).toBeTruthy();
      }
    }
  });

  /*
   * The regression this file exists for. Every column used to be emitted as
   * `e.expense_date`, while the adapter's query was
   * `FROM expenses WHERE business_id = $1 AND …` — no `e`, no alias anywhere. So
   * *every* expense import row died on `missing FROM-clause entry for table "e"`:
   * not a wrong skip, a failed run, and the whole channel was broken behind a
   * green CI because the pure tests here asserted the same wrong assumption the
   * code made (`toMatch(/^e\.[a-z_]+$/)`) and nothing ran the SQL.
   *
   * Which is the lesson worth keeping: a shape test can only pin a *shape*. Whether
   * the fragment runs is a database question, and it is answered in
   * `integration/expense-import-adapter.integration.test.ts`. A predicate must
   * never name a table its caller has not promised.
   */
  it("emits a fragment that cannot reference an alias it was not given", () => {
    for (const rule of EXPENSE_DUPLICATE_RULES) {
      const { sql } = expenseDuplicatePredicate(rule, VALUES);
      expect(sql, rule.key).not.toMatch(/\be\./);
      expect(sql, rule.key).not.toContain(".");
    }
  });

  it("names every matched field in the sentence the operator is shown", () => {
    // `EXPENSE_DUPLICATE_RULES[*].label` is built from `fields`, so this is the
    // drift lock: a skip reason that under-reports what was compared is a row the
    // operator cannot explain to themselves.
    for (const rule of EXPENSE_DUPLICATE_RULES) {
      for (const field of rule.fields) {
        expect(rule.label, `${rule.key} → ${field}`).toContain(EXPENSE_DUPLICATE_FIELD_LABELS[field]);
      }
      // The default rule is the one a file gets without being asked, and it owes
      // the operator both new columns in its sentence.
      if (rule === EXPENSE_DUPLICATE_RULES[0]) {
        expect(rule.label).toContain("نحوهٔ تسویه");
        expect(rule.label).toContain("تأمین‌کننده");
        expect(rule.label).toContain("طرف حساب");
      }
    }
  });

  it("compares the columns the register actually stores", () => {
    expect(EXPENSE_DUPLICATE_COLUMNS.accountCode.column).toBe("account_id");
    expect(EXPENSE_DUPLICATE_COLUMNS.paymentAccountCode.column).toBe("payment_account_id");
    expect(EXPENSE_DUPLICATE_COLUMNS.amount.column).toBe("amount");
    expect(EXPENSE_DUPLICATE_COLUMNS.expenseDate.cast).toBe("date");
  });

  it("keeps the settlement and its supplier in the default match", () => {
    // An owed bill and a paid one of the same amount on the same day are not the
    // same transaction, and one bill owed to two suppliers is two bills.
    const fields = EXPENSE_DUPLICATE_RULES[0].fields;
    expect(fields).toContain("settlement");
    expect(fields).toContain("supplier");
    expect(EXPENSE_DUPLICATE_COLUMNS.settlement.source).toBe("settlement");
    // 0212 stores `settlement` NOT NULL, so a plain equality is right there;
    // `supplier_id` is nullable, so it joins the empty-cell-is-NULL rule.
    expect(EXPENSE_DUPLICATE_COLUMNS.settlement.nullableText).toBe(false);
    expect(EXPENSE_DUPLICATE_COLUMNS.supplier.nullableText).toBe(true);
    // Comparing a nullable uuid through COALESCE('') needs the column side in
    // text, or Postgres refuses the query for mismatched COALESCE types.
    expect(EXPENSE_DUPLICATE_COLUMNS.supplier.columnCast).toBe("::text");
  });

  it("binds the settlement and the resolved supplier in the rule's own order", () => {
    const owed = expenseDuplicatePredicate(EXPENSE_DUPLICATE_RULES[0], {
      ...VALUES,
      settlement: "credit",
      supplierId: "44444444-4444-4444-4444-444444444444",
      paymentAccountId: null,
    });
    expect(owed.params).toEqual([
      VALUES.expenseDate,
      VALUES.amount,
      VALUES.accountId,
      null,
      "credit",
      "44444444-4444-4444-4444-444444444444",
      VALUES.vendor,
      VALUES.memo,
    ]);
  });

  it("numbers one placeholder per bound value, contiguously, from the caller's first", () => {
    // The adapter keeps `$1` for the tenant and starts here; a gap or a repeat in
    // this list is a Postgres error on every row of the import, which is exactly
    // how the alias bug above managed to hide.
    for (const [firstParam, rule] of [[2, EXPENSE_DUPLICATE_RULES[0]], [7, EXPENSE_DUPLICATE_RULES[1]]] as const) {
      const { sql, params } = expenseDuplicatePredicate(rule, VALUES, firstParam);
      const found = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      expect(new Set(found).size, rule.key).toBe(found.length);
      expect(found).toEqual(params.map((_, index) => firstParam + index));
    }
  });
});

describe("expenseDuplicatePredicate", () => {
  it("builds one equality per field, in the rule's own order, with params to match", () => {
    const { sql, params } = expenseDuplicatePredicate(EXPENSE_DUPLICATE_RULES[1], VALUES);
    expect(sql).toBe(`expense_date = $4::date AND amount = $5 AND account_id = $6::uuid`);
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
    expect(sql).toContain("COALESCE(supplier_id::text, '') = COALESCE($9, '')");
    expect(sql).toContain("COALESCE(vendor, '') = COALESCE($10, '')");
    expect(sql).toContain("COALESCE(memo, '') = COALESCE($11, '')");
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
    expect(sql).toContain("expense_date = $4::date");
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
