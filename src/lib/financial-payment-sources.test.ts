/**
 * The payment-source join (issue #862, phase 7).
 *
 * This is the contract the *existing* money-moving workflows read — expenses,
 * A/R and A/P settlement, payroll payment — so its central promise is the
 * backward-compatible one: a business that never registers a financial account
 * must get exactly the list it got before. Everything here is about that
 * promise, plus the branch rule (a container scoped to another branch is not a
 * payment source in this one).
 */
import { describe, expect, it } from "vitest";

import {
  defaultFinancialAccountForKind,
  financialAccountByGlAccount,
  financialAccountKindsForRole,
  paymentSourceOptions,
  resolveFinancialAccountForPayment,
  type FinancialAccountShape,
} from "./financial-payment-sources";

const CASH = "gl-cash";
const BANK = "gl-bank";
const OTHER_BRANCH_BANK = "gl-bank-2";

function financial(overrides: Partial<FinancialAccountShape> & { id: string; glAccountId: string }): FinancialAccountShape {
  return {
    name: "حساب",
    kind: "bank",
    currencyCode: "IRR",
    locationId: null,
    isActive: true,
    isDefault: false,
    ...overrides,
  };
}

const bankShape = { id: BANK, code: "1110", name: "بانک — جاری", parentId: null, type: "asset" as const };
const cashShape = { id: CASH, code: "1100", name: "صندوق", parentId: null, type: "asset" as const };
const otherBranchShape = {
  id: OTHER_BRANCH_BANK,
  code: "1111",
  name: "بانک — شعبهٔ دیگر",
  parentId: null,
  type: "asset" as const,
};

const accounts = [
  { id: CASH, code: "1100", name: "صندوق", parentId: null, type: "asset" as const },
  { id: BANK, code: "1110", name: "بانک — جاری", parentId: null, type: "asset" as const },
  { id: OTHER_BRANCH_BANK, code: "1111", name: "بانک — شعبهٔ دیگر", parentId: null, type: "asset" as const },
];

describe("backward compatibility", () => {
  it("offers every eligible GL account when nothing is registered", () => {
    const options = paymentSourceOptions({ accounts, financialAccounts: [] });
    expect(options.map((option) => option.accountId)).toEqual([CASH, BANK, OTHER_BRANCH_BANK]);
    for (const option of options) {
      expect(option.financialAccountId).toBeNull();
      expect(option.kind).toBeNull();
      expect(option.isDefault).toBe(false);
    }
  });

  it("keeps the caller's own order — the chart's code order at every call site", () => {
    const options = paymentSourceOptions({
      accounts: [...accounts].reverse(),
      financialAccounts: [financial({ id: "fa-1", glAccountId: BANK })],
    });
    expect(options.map((option) => option.accountId)).toEqual([OTHER_BRANCH_BANK, BANK, CASH]);
  });

  it("annotates a registered GL account without removing the unregistered ones", () => {
    const options = paymentSourceOptions({
      accounts,
      financialAccounts: [
        financial({ id: "fa-cash", glAccountId: CASH, name: "صندوق مرکزی", kind: "cash", isDefault: true }),
        financial({ id: "fa-bank", glAccountId: BANK, name: "حساب جاری", bankName: "ملت" }),
      ],
    });
    expect(options[0]).toMatchObject({
      financialAccountId: "fa-cash",
      financialAccountName: "صندوق مرکزی",
      kind: "cash",
      currencyCode: "IRR",
      isDefault: true,
    });
    expect(options[1]).toMatchObject({ financialAccountId: "fa-bank", kind: "bank", isDefault: false });
    // The third has no container — still offered, with the empty columns.
    expect(options[2].financialAccountId).toBeNull();
  });
});

describe("branch scope", () => {
  it("does not offer a container scoped to another branch", () => {
    const options = paymentSourceOptions({
      accounts: [otherBranchShape],
      financialAccounts: [financial({ id: "fa-2", glAccountId: OTHER_BRANCH_BANK, locationId: "branch-b" })],
      locationId: "branch-a",
    });
    expect(options[0]).toMatchObject({
      financialAccountId: null,
      financialAccountName: null,
      kind: null,
      branchScoped: true,
    });
  });

  it("offers a container of this branch and a business-wide one", () => {
    const options = paymentSourceOptions({
      accounts: [bankShape, cashShape],
      financialAccounts: [
        financial({ id: "fa-bank", glAccountId: BANK, locationId: "branch-a" }),
        financial({ id: "fa-cash", glAccountId: CASH, locationId: null, kind: "cash" }),
      ],
      locationId: "branch-a",
    });
    expect(options[0]).toMatchObject({ financialAccountId: "fa-bank", branchScoped: true });
    expect(options[1]).toMatchObject({ financialAccountId: "fa-cash", branchScoped: false });
  });

  it("does not filter by branch for a caller that has no branch context", () => {
    const options = paymentSourceOptions({
      accounts: [otherBranchShape],
      financialAccounts: [financial({ id: "fa-2", glAccountId: OTHER_BRANCH_BANK, locationId: "branch-b" })],
    });
    expect(options[0].financialAccountId).toBe("fa-2");
  });
});

describe("which container backs which GL account", () => {
  it("maps only active rows — an archived container is not a payment source", () => {
    const map = financialAccountByGlAccount([
      financial({ id: "fa-live", glAccountId: BANK }),
      financial({ id: "fa-gone", glAccountId: CASH, isActive: false }),
    ]);
    expect(map.has(BANK)).toBe(true);
    expect(map.has(CASH)).toBe(false);
    expect(resolveFinancialAccountForPayment([financial({ id: "fa-gone", glAccountId: CASH, isActive: false })], CASH)).toBeNull();
  });

  it("resolves a plain chart account to nothing rather than to a wrong neighbour", () => {
    const rows = [financial({ id: "fa-bank", glAccountId: BANK })];
    expect(resolveFinancialAccountForPayment(rows, BANK)?.id).toBe("fa-bank");
    expect(resolveFinancialAccountForPayment(rows, CASH)).toBeNull();
    expect(resolveFinancialAccountForPayment(rows, "not-a-gl-account")).toBeNull();
  });

  it("picks the branch default first, then the business-wide one", () => {
    const rows = [
      financial({ id: "fa-wide", glAccountId: BANK, isDefault: true, locationId: null }),
      financial({ id: "fa-branch", glAccountId: CASH, kind: "cash", isDefault: true, locationId: "branch-a" }),
    ];
    expect(defaultFinancialAccountForKind(rows, "cash", "branch-a")?.id).toBe("fa-branch");
    expect(defaultFinancialAccountForKind(rows, "bank", "branch-a")?.id).toBe("fa-wide");
    expect(defaultFinancialAccountForKind(rows, "bank", "branch-b")?.id).toBe("fa-wide");
  });

  it("ignores a default of the wrong kind, an archived one and a non-default one", () => {
    const rows = [
      financial({ id: "fa-cash", glAccountId: CASH, kind: "cash", isDefault: true }),
      financial({ id: "fa-archived", glAccountId: BANK, isDefault: true, isActive: false }),
      financial({ id: "fa-plain", glAccountId: OTHER_BRANCH_BANK, isDefault: false }),
    ];
    expect(defaultFinancialAccountForKind(rows, "cash")?.id).toBe("fa-cash");
    expect(defaultFinancialAccountForKind(rows, "bank")).toBeNull();
  });

  it("falls back to the only default it has when the branch has none of its own", () => {
    const rows = [financial({ id: "fa-b", glAccountId: BANK, isDefault: true, locationId: "branch-b" })];
    expect(defaultFinancialAccountForKind(rows, "bank", "branch-a")?.id).toBe("fa-b");
  });
});

describe("role ↔ kind", () => {
  it("finds the kinds a role's money sits in", () => {
    expect(financialAccountKindsForRole("bank")).toEqual(["bank"]);
    expect(financialAccountKindsForRole("cash")).toEqual(["cash"]);
    expect(financialAccountKindsForRole("petty_cash")).toEqual(["petty_cash"]);
    // A card terminal's money sits in the clearing account until it settles.
    expect(financialAccountKindsForRole("payment_clearing")).toEqual(["pos_psp"]);
    // A receivable is money somebody owes, not a container this business holds.
    expect(financialAccountKindsForRole("trade_receivable")).toEqual([]);
  });
});
