import { describe, expect, it } from "vitest";
import { WELL_KNOWN_CODES } from "./coa-template";
import {
  balanceTotals,
  canMoveOpeningSet,
  classifyOpeningProvenance,
  isOpeningSetEditable,
  reconcileToPriorClose,
  validateOpeningLines,
  type OpeningLineInput,
} from "./opening-balances";

const cash = "acc-cash";
const ar = "acc-ar";
const ap = "acc-ap";
const equity = "acc-equity";

function line(over: Partial<OpeningLineInput>): OpeningLineInput {
  return { accountId: cash, accountType: "asset", debit: 0, credit: 0, provenance: "gl", ...over };
}

describe("validateOpeningLines", () => {
  it("accepts a plain balanced set of balance-sheet lines and drops zero lines", () => {
    const { errors, activeLines } = validateOpeningLines([
      line({ debit: 500 }),
      line({ accountId: equity, accountType: "equity", credit: 500 }),
      line({ accountId: "zero", debit: 0, credit: 0 }),
    ]);
    expect(errors).toEqual([]);
    expect(activeLines).toHaveLength(2);
  });

  it("refuses revenue and expense accounts, which the year-end close already owns", () => {
    const { errors } = validateOpeningLines([
      line({ accountType: "revenue", credit: 10 }),
      line({ accountType: "expense", debit: 10 }),
    ]);
    expect(errors).toEqual(["revenue_expense_not_allowed"]);
  });

  it("requires exactly one side per line and integer Rial", () => {
    expect(validateOpeningLines([line({ debit: 5, credit: 5 })]).errors).toContain("one_side_per_line");
    expect(validateOpeningLines([line({ debit: 1.5 })]).errors).toContain("invalid_amount");
    expect(validateOpeningLines([line({ debit: -3 })]).errors).toContain("invalid_amount");
  });

  it("ties A/R to assets and A/P to liabilities", () => {
    expect(validateOpeningLines([line({ accountId: ar, provenance: "ar", debit: 1 })]).errors).toEqual([]);
    expect(
      validateOpeningLines([line({ accountId: ar, accountType: "liability", provenance: "ar", credit: 1 })]).errors,
    ).toContain("provenance_account_type_mismatch");
    expect(
      validateOpeningLines([line({ accountId: ap, accountType: "liability", provenance: "ap", credit: 1 })]).errors,
    ).toEqual([]);
  });

  it("only lets a customer sit on A/R and a supplier on A/P", () => {
    expect(
      validateOpeningLines([line({ provenance: "gl", debit: 1, customerId: "c1" })]).errors,
    ).toContain("customer_on_non_ar_line");
    expect(
      validateOpeningLines([line({ accountId: ap, accountType: "liability", provenance: "ap", credit: 1, customerId: "c1" })]).errors,
    ).toContain("customer_on_non_ar_line");
    expect(
      validateOpeningLines([line({ accountId: ap, accountType: "liability", provenance: "ap", credit: 1, supplierId: "s1" })]).errors,
    ).toEqual([]);
    expect(
      validateOpeningLines([line({ provenance: "gl", debit: 1, supplierId: "s1" })]).errors,
    ).toContain("supplier_on_non_ap_line");
  });

  it("allows many attributed lines on one A/R account but only one unattributed remainder", () => {
    const attributed = validateOpeningLines([
      line({ accountId: ar, provenance: "ar", debit: 100, customerId: "c1" }),
      line({ accountId: ar, provenance: "ar", debit: 200, customerId: "c2" }),
    ]);
    expect(attributed.errors).toEqual([]);

    const twoBlanks = validateOpeningLines([
      line({ accountId: ar, provenance: "ar", debit: 100 }),
      line({ accountId: ar, provenance: "ar", debit: 200 }),
    ]);
    expect(twoBlanks.errors).toContain("duplicate_unattributed_account");
  });
});

describe("balanceTotals", () => {
  it("reports the exact difference and whether the set balances", () => {
    expect(balanceTotals([{ debit: 700, credit: 0 }, { debit: 0, credit: 650 }])).toEqual({
      totalDebit: 700,
      totalCredit: 650,
      difference: 50,
      balanced: false,
    });
    expect(balanceTotals([{ debit: 700, credit: 0 }, { debit: 0, credit: 700 }]).balanced).toBe(true);
  });
});

describe("classifyOpeningProvenance", () => {
  it("names the subledger an account's balance belongs to", () => {
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.accountsReceivable, type: "asset" })).toBe("ar");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.accountsPayable, type: "liability" })).toBe("ap");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.chequesOnHand, type: "asset" })).toBe("cheque");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.chequesPayable, type: "liability" })).toBe("cheque");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.cash, type: "asset" })).toBe("cash_bank");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.bank, type: "asset" })).toBe("cash_bank");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.inventory, type: "asset" })).toBe("inventory");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.fixedAssets, type: "asset" })).toBe("fixed_asset");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.accumulatedDepreciation, type: "asset" })).toBe("fixed_asset");
    expect(classifyOpeningProvenance({ code: WELL_KNOWN_CODES.retainedEarnings, type: "equity" })).toBe("equity");
    expect(classifyOpeningProvenance({ code: "9999", type: "liability" })).toBe("gl");
  });
});

describe("reconcileToPriorClose", () => {
  it("reconciles when every account matches the prior close to the Rial", () => {
    const result = reconcileToPriorClose(
      [
        { accountId: cash, balance: 1000 },
        { accountId: ar, balance: 300 },
        { accountId: ap, balance: -200 },
      ],
      [
        { accountId: cash, debit: 1000, credit: 0 },
        { accountId: ar, debit: 300, credit: 0 },
        { accountId: ap, debit: 0, credit: 200 },
      ],
    );
    expect(result.reconciled).toBe(true);
    expect(result.rows.every((r) => r.difference === 0)).toBe(true);
  });

  it("names the account that differs, and treats an absent account as zero", () => {
    const result = reconcileToPriorClose(
      [{ accountId: cash, balance: 1000 }, { accountId: ar, balance: 300 }],
      [{ accountId: cash, debit: 900, credit: 0 }, { accountId: equity, debit: 0, credit: 100 }],
    );
    expect(result.reconciled).toBe(false);
    const byAccount = Object.fromEntries(result.rows.map((r) => [r.accountId, r.difference]));
    expect(byAccount).toEqual({ [cash]: -100, [ar]: -300, [equity]: -100 });
  });

  it("sums several lines on one account before comparing", () => {
    const result = reconcileToPriorClose(
      [{ accountId: ar, balance: 500 }],
      [{ accountId: ar, debit: 200, credit: 0 }, { accountId: ar, debit: 300, credit: 0 }],
    );
    expect(result.reconciled).toBe(true);
  });
});

describe("opening set lifecycle", () => {
  it("only moves forward through review, approval and posting", () => {
    expect(canMoveOpeningSet("draft", "in_review")).toBe(true);
    expect(canMoveOpeningSet("in_review", "approved")).toBe(true);
    expect(canMoveOpeningSet("in_review", "draft")).toBe(true);
    expect(canMoveOpeningSet("approved", "posted")).toBe(true);
    expect(canMoveOpeningSet("posted", "reversed")).toBe(true);
    expect(canMoveOpeningSet("draft", "posted")).toBe(false);
    expect(canMoveOpeningSet("posted", "draft")).toBe(false);
    expect(canMoveOpeningSet("reversed", "posted")).toBe(false);
  });

  it("freezes lines once the set leaves draft", () => {
    expect(isOpeningSetEditable("draft")).toBe(true);
    for (const status of ["in_review", "approved", "posted", "reversed"] as const) {
      expect(isOpeningSetEditable(status)).toBe(false);
    }
  });
});
