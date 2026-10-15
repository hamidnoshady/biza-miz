/**
 * The Financial Accounts domain's pure rules (issue #862).
 *
 * Everything the register and the transfer screen decide *without* a database:
 * which GL accounts may back a container of each kind, what a form may store,
 * what a balance says, and which numbers a caller may read. The service is
 * covered by `integration/financial-accounts.integration.test.ts` against a real
 * PostgreSQL; this file is what makes the decisions themselves cheap to pin,
 * because a wrong sentence here is a wrong screen everywhere.
 */
import { describe, expect, it } from "vitest";

import {
  FINANCIAL_ACCOUNT_KINDS,
  FINANCIAL_ACCOUNT_KIND_META,
  FINANCIAL_ACCOUNT_KIND_ROLE,
  accountCardFromMovements,
  balanceFromLines,
  classifyGlAccountForKind,
  financialAccountDisplayLabel,
  financialAccountInputProblem,
  financialAccountKindLabel,
  financialAccountScopeLabel,
  formatBalanceToman,
  glAccountCandidatesForKind,
  isFinancialAccountKind,
  isRialAmountText,
  isZeroBalance,
  maskIdentifier,
  maskSensitiveFinancialDetails,
  normalizeIdentifier,
  sumCredits,
  sumDebits,
  type ClassifiableFinancialGlAccount,
} from "./financial-accounts";

/**
 * A chart, as `financial-accounts-service` reads it: the seeds from migration
 * 0001 plus a payable, so a wrong-type refusal is a real one rather than a
 * missing row.
 */
const CASH = account("gl-cash", "1100", "صندوق", "asset");
const BANK = account("gl-bank", "1110", "بانک", "asset");
const BANK_SECOND = account("gl-bank-2", "1111", "بانک دوم", "asset");
const CLEARING = account("gl-clearing", "1120", "وجوه در راه", "asset");
const PETTY = account("gl-petty", "1130", "تنخواه", "asset");
const PAYABLE = account("gl-ap", "2100", "حساب‌های پرداختنی", "liability");

function account(
  id: string,
  code: string,
  name: string,
  type: ClassifiableFinancialGlAccount["type"],
  extra: Partial<ClassifiableFinancialGlAccount> = {},
): ClassifiableFinancialGlAccount {
  return { id, code, name, parentId: null, type, isActive: true, hasChildren: false, ...extra };
}

describe("financial account kinds", () => {
  it("names exactly the four containers the issue asks for", () => {
    expect([...FINANCIAL_ACCOUNT_KINDS]).toEqual(["bank", "cash", "petty_cash", "pos_psp"]);
  });

  it("gives every kind a label, a plural and a role", () => {
    for (const kind of FINANCIAL_ACCOUNT_KINDS) {
      expect(FINANCIAL_ACCOUNT_KIND_META[kind].label).not.toBe("");
      expect(FINANCIAL_ACCOUNT_KIND_META[kind].plural).not.toBe("");
      expect(FINANCIAL_ACCOUNT_KIND_META[kind].description).not.toBe("");
      expect(FINANCIAL_ACCOUNT_KIND_META[kind].roles.has(FINANCIAL_ACCOUNT_KIND_ROLE[kind])).toBe(true);
      expect(financialAccountKindLabel(kind)).toBe(FINANCIAL_ACCOUNT_KIND_META[kind].label);
    }
  });

  it("keeps bank/PSP metadata on the kinds that own it, and off the ones that do not", () => {
    expect(FINANCIAL_ACCOUNT_KIND_META.bank.bankMetadata).toBe(true);
    expect(FINANCIAL_ACCOUNT_KIND_META.bank.pspMetadata).toBe(false);
    expect(FINANCIAL_ACCOUNT_KIND_META.pos_psp.pspMetadata).toBe(true);
    expect(FINANCIAL_ACCOUNT_KIND_META.pos_psp.bankMetadata).toBe(false);
    expect(FINANCIAL_ACCOUNT_KIND_META.cash.bankMetadata).toBe(false);
    expect(FINANCIAL_ACCOUNT_KIND_META.petty_cash.pspMetadata).toBe(false);
  });

  it("recognises only its own kinds", () => {
    expect(isFinancialAccountKind("bank")).toBe(true);
    expect(isFinancialAccountKind("pos_psp")).toBe(true);
    expect(isFinancialAccountKind("wallet")).toBe(false);
    expect(isFinancialAccountKind(null)).toBe(false);
    expect(isFinancialAccountKind(7)).toBe(false);
  });

  it("reads the bank out of a display label, and nothing else out of the others", () => {
    expect(financialAccountDisplayLabel({ name: "حساب جاری", kind: "bank", bankName: "ملت" })).toBe(
      "حساب جاری — ملت",
    );
    expect(financialAccountDisplayLabel({ name: "حساب جاری", kind: "bank", bankName: null })).toBe("حساب جاری");
    expect(financialAccountDisplayLabel({ name: "صندوق مرکزی", kind: "cash", bankName: "ملت" })).toBe(
      "صندوق مرکزی",
    );
  });

  it("reads a missing branch as the whole business, never as an empty cell", () => {
    expect(financialAccountScopeLabel(null)).toBe("همهٔ شعبه‌ها");
    expect(financialAccountScopeLabel(undefined)).toBe("همهٔ شعبه‌ها");
    expect(financialAccountScopeLabel("شعبهٔ مرکزی")).toBe("شعبهٔ مرکزی");
  });
});

describe("GL eligibility", () => {
  it("links a bank container to a bank account and refuses a till's own account", () => {
    expect(classifyGlAccountForKind(BANK, "bank")).toEqual({ eligible: true, reason: null, role: "bank" });
    expect(classifyGlAccountForKind(CASH, "bank")).toEqual({
      eligible: false,
      reason: "wrong_role",
      role: "cash",
    });
    expect(classifyGlAccountForKind(PETTY, "petty_cash").eligible).toBe(true);
    expect(classifyGlAccountForKind(CLEARING, "cash").eligible).toBe(false);
  });

  it("accepts either a clearing account or a bank for a card terminal", () => {
    expect(classifyGlAccountForKind(CLEARING, "pos_psp")).toEqual({
      eligible: true,
      reason: null,
      role: "payment_clearing",
    });
    expect(classifyGlAccountForKind(BANK, "pos_psp").eligible).toBe(true);
  });

  it("refuses an account another container already holds — the shared-balance rule", () => {
    const linked = new Set([BANK.id]);
    expect(classifyGlAccountForKind(BANK, "bank", { linkedAccountIds: linked })).toEqual({
      eligible: false,
      reason: "already_linked",
      role: "bank",
    });
  });

  it("refuses a parent, an inactive account and a non-asset, each for its own reason", () => {
    expect(classifyGlAccountForKind(account("p", "1100", "دارایی جاری", "asset", { hasChildren: true }), "bank").reason).toBe(
      "has_children",
    );
    expect(classifyGlAccountForKind({ ...BANK, isActive: false }, "bank").reason).toBe("inactive");
    expect(classifyGlAccountForKind(PAYABLE, "bank").reason).toBe("not_asset");
  });

  it("says 'already linked' before 'wrong role' — the reason a person would ask first", () => {
    const verdict = classifyGlAccountForKind(CASH, "bank", { linkedAccountIds: new Set([CASH.id]) });
    expect(verdict.reason).toBe("already_linked");
  });

  it("refuses an account whose code classifies as nothing at all", () => {
    const odd = account("odd", "9999", "سرفصل ناشناس", "asset");
    expect(classifyGlAccountForKind(odd, "bank")).toEqual({
      eligible: false,
      reason: "unclassified",
      role: null,
    });
  });

  it("offers the whole chart's candidates, with the refusals kept for the empty state", () => {
    const chart = [BANK, BANK_SECOND, CASH, PETTY, CLEARING, PAYABLE];
    const picked = glAccountCandidatesForKind(chart, "bank");
    expect(picked.eligible.map((row) => row.id)).toEqual([BANK.id, BANK_SECOND.id]);
    expect(picked.refused.map((row) => [row.account.id, row.reason])).toEqual([
      [CASH.id, "wrong_role"],
      [PETTY.id, "wrong_role"],
      [CLEARING.id, "wrong_role"],
      [PAYABLE.id, "not_asset"],
    ]);
  });

  it("decides postability from the chart, not from a flag on one row", () => {
    // The parent is only a parent because a child exists — the same fact the
    // picker's query counts with `child_count`.
    const parent = account("gl-current", "1110", "بانک", "asset", { hasChildren: true });
    const child = account("gl-bank-child", "1115", "بانک — شعبهٔ مرکزی", "asset", { parentId: parent.id });
    const picked = glAccountCandidatesForKind([parent, child], "bank");
    expect(picked.eligible.map((row) => row.id)).toEqual([child.id]);
    expect(picked.refused.map((row) => [row.account.id, row.reason])).toEqual([[parent.id, "has_children"]]);
  });

  it("takes an already-linked account out of the picker, not just out of the write", () => {
    const picked = glAccountCandidatesForKind([BANK, BANK_SECOND], "bank", {
      linkedAccountIds: new Set([BANK.id]),
    });
    expect(picked.eligible.map((row) => row.id)).toEqual([BANK_SECOND.id]);
  });
});

describe("what a form may store", () => {
  const base = { kind: "bank", name: "حساب جاری", glAccountId: "4c9b1f6e-0f9a-4a1c-9f2e-6f7a1c0b2d3e" };

  it("accepts a well-formed bank account", () => {
    expect(
      financialAccountInputProblem({
        ...base,
        accountNumber: "1234567890",
        cardNumber: "6037991234567890",
        iban: "IR820540102680020817909002",
      }),
    ).toBeNull();
  });

  it("asks for the two things without which nothing can be linked", () => {
    expect(financialAccountInputProblem({ name: "x", glAccountId: base.glAccountId })?.code).toBe("kind_required");
    expect(financialAccountInputProblem({ ...base, name: "   " })?.code).toBe("name_required");
    expect(financialAccountInputProblem({ ...base, glAccountId: "not-a-uuid" })?.code).toBe("gl_account_required");
    expect(financialAccountInputProblem({ ...base, glAccountId: undefined })?.code).toBe("gl_account_required");
    expect(financialAccountInputProblem({ ...base, kind: "wallet" })?.code).toBe("invalid_kind");
  });

  it("names the field the message belongs beside", () => {
    const problem = financialAccountInputProblem({ ...base, iban: "IR123" });
    expect(problem).toEqual({ code: "iban_invalid", field: "iban" });
  });

  it("checks the two identifier shapes the issue asks for", () => {
    expect(financialAccountInputProblem({ ...base, iban: "IR820540102680020817909002" })).toBeNull();
    expect(financialAccountInputProblem({ ...base, iban: "IR82-0540-1026-8002-0817-9090-02" })).toBeNull();
    expect(financialAccountInputProblem({ ...base, iban: "820540102680020817909002" })?.code).toBe("iban_invalid");
    expect(financialAccountInputProblem({ ...base, cardNumber: "6037 9912 3456 7890" })).toBeNull();
    expect(financialAccountInputProblem({ ...base, cardNumber: "60379912345678" })?.code).toBe(
      "card_number_invalid",
    );
    // A Persian keyboard types Persian digits; storing them would be a string
    // nothing else can match.
    expect(normalizeIdentifier("۶۰۳۷۹۹۱۲۳۴۵۶۷۸۹۰")).toBe("6037991234567890");
    expect(normalizeIdentifier("   ")).toBeNull();
    expect(normalizeIdentifier(42)).toBeNull();
  });

  it("refuses bank metadata on a till and terminal metadata on a bank", () => {
    expect(financialAccountInputProblem({ ...base, kind: "cash", bankName: "ملت" })?.code).toBe(
      "kind_metadata_mismatch",
    );
    expect(financialAccountInputProblem({ ...base, kind: "bank", terminalNumber: "1234" })?.code).toBe(
      "kind_metadata_mismatch",
    );
    expect(
      financialAccountInputProblem({ ...base, kind: "pos_psp", pspProvider: "به‌پرداخت", settlementDelayDays: 3 }),
    ).toBeNull();
  });

  it("bounds the settlement delay at the database's own 0..90", () => {
    expect(financialAccountInputProblem({ ...base, kind: "pos_psp", settlementDelayDays: 0 })).toBeNull();
    expect(financialAccountInputProblem({ ...base, kind: "pos_psp", settlementDelayDays: 90 })).toBeNull();
    expect(financialAccountInputProblem({ ...base, kind: "pos_psp", settlementDelayDays: 91 })?.code).toBe(
      "invalid_settlement_delay",
    );
    expect(financialAccountInputProblem({ ...base, kind: "pos_psp", settlementDelayDays: 1.5 })?.code).toBe(
      "invalid_settlement_delay",
    );
  });

  it("holds a partial update to the fields it actually carries", () => {
    // A PATCH that only renames must not be asked for a GL account or a kind.
    expect(financialAccountInputProblem({ name: "نام تازه" }, { partial: true })).toBeNull();
    expect(financialAccountInputProblem({ name: "" }, { partial: true })?.code).toBe("name_required");
    expect(financialAccountInputProblem({ name: "x", glAccountId: "nope" }, { partial: true })?.code).toBe(
      "gl_account_required",
    );
    expect(financialAccountInputProblem({ terminalNumber: "1234" }, { partial: true })).toBeNull();
    expect(financialAccountInputProblem({ kind: "cash", terminalNumber: "1234" }, { partial: true })?.code).toBe(
      "kind_metadata_mismatch",
    );
  });

  it("bounds text at the database's own column widths", () => {
    expect(financialAccountInputProblem({ ...base, name: "ن".repeat(121) })?.code).toBe("name_too_long");
    expect(financialAccountInputProblem({ ...base, code: "c".repeat(33) })?.code).toBe("code_too_long");
    expect(financialAccountInputProblem({ ...base, name: "ن".repeat(120) })).toBeNull();
  });

  it("takes only a boolean for the default flag", () => {
    expect(financialAccountInputProblem({ ...base, isDefault: true })).toBeNull();
    expect(financialAccountInputProblem({ ...base, isDefault: "yes" })?.code).toBe("invalid_isDefault");
  });
});

describe("sensitive bank details", () => {
  it("keeps a readable tail and hides the rest", () => {
    // Eight bullets is the cap: the mask says "hidden", it does not spell out
    // how many digits are hidden for a reader who is not meant to have them.
    expect(maskIdentifier("6037991234567890")).toBe("••••••••7890");
    expect(maskIdentifier("6037991234567890")?.length).toBe(12);
    expect(maskIdentifier("1234")).toBe("••••");
    expect(maskIdentifier("")).toBeNull();
    expect(maskIdentifier(null)).toBeNull();
    expect(maskIdentifier("   ")).toBeNull();
  });

  it("never lengthens the mask past what the value hides", () => {
    expect(maskIdentifier("123456789")?.length).toBe("123456789".length);
    expect(maskIdentifier("0000123456789012345678901234567890")).toBe("••••••••7890");
  });

  it("masks the routing fields and leaves the descriptive ones alone", () => {
    const row = {
      name: "حساب جاری",
      bankName: "ملت",
      accountNumber: "1234567890",
      cardNumber: "6037991234567890",
      iban: "IR820540102680020817909002",
      accountHolder: "شرکت نمونه",
      settlementReference: "SETTLE-1",
      merchantNumber: "MERCHANT-9",
      terminalNumber: "TERM-7",
    };
    const masked = maskSensitiveFinancialDetails(row, { canViewSensitive: false });
    expect(masked.accountNumber).not.toBe("1234567890");
    expect(masked.cardNumber).toContain("7890");
    expect(masked.iban?.endsWith("9002")).toBe(true);
    // The holder is a name, not a number: it still says whose account it is.
    expect(masked.accountHolder).toBe("شرکت نمونه");
    expect(masked.name).toBe("حساب جاری");
  });

  it("hands the row over untouched to a member who may see it", () => {
    const row = {
      accountNumber: "1234567890",
      cardNumber: "6037991234567890",
      iban: "IR820540102680020817909002",
      accountHolder: "شرکت نمونه",
      settlementReference: null,
      merchantNumber: null,
      terminalNumber: null,
    };
    expect(maskSensitiveFinancialDetails(row, { canViewSensitive: true })).toBe(row);
  });
});

describe("balances", () => {
  it("nets debits against credits exactly", () => {
    expect(
      balanceFromLines([
        { debit: "1500", credit: "0" },
        { debit: "0", credit: "500" },
      ]),
    ).toBe("1000");
    expect(sumDebits([{ debit: "1500", credit: "0" }, { debit: "250", credit: "0" }])).toBe("1750");
    expect(sumCredits([{ debit: "0", credit: "500" }, { debit: "0", credit: "250" }])).toBe("750");
    expect(balanceFromLines([])).toBe("0");
  });

  it("stays exact past 2^53 — the reason none of this is a Number", () => {
    const huge = "9007199254740993";
    expect(balanceFromLines([{ debit: huge, credit: "0" }])).toBe(huge);
    expect(balanceFromLines([{ debit: huge, credit: "1" }])).toBe("9007199254740992");
  });

  it("carries an overdrawn balance as a negative net", () => {
    expect(balanceFromLines([{ debit: "0", credit: "2500" }])).toBe("-2500");
  });

  it("knows exactly zero when it sees it", () => {
    expect(isZeroBalance("0")).toBe(true);
    expect(isZeroBalance("-0")).toBe(true);
    expect(isZeroBalance("1")).toBe(false);
    expect(isZeroBalance("-1")).toBe(false);
  });

  it("reads a balance in the business's own unit, grouped and in Persian digits", () => {
    expect(formatBalanceToman("1234500", "rial")).toBe("۱٬۲۳۴٬۵۰۰");
    // Toman drops the single Rial, exactly as `rialToToman` does.
    expect(formatBalanceToman("12345", "toman")).toBe("۱٬۲۳۴");
    expect(formatBalanceToman("-25000", "toman")).toBe("−۲٬۵۰۰");
  });
});

describe("amount text from a client", () => {
  it("accepts canonical Rial text, with or without separators", () => {
    expect(isRialAmountText("0")).toBe(true);
    expect(isRialAmountText("1234500")).toBe(true);
    expect(isRialAmountText("۱٬۲۳۴٬۵۰۰")).toBe(true);
    for (const value of ["", "-5", "1.5", "12a", null, 12, "1e5", "9".repeat(16)]) {
      expect(isRialAmountText(value)).toBe(false);
    }
  });
});

describe("the account card", () => {
  const movements = [
    { entryId: "e1", entryDate: "2026-01-02", memo: "واریز", sourceType: "financial_transfer", journalSourceId: "t1", debit: "1000", credit: "0", counterparty: "صندوق" },
    { entryId: "e2", entryDate: "2026-01-03", memo: "برداشت", sourceType: "expense", journalSourceId: null, debit: "0", credit: "400", counterparty: "اجاره" },
  ];

  it("runs the balance through the movements and totals both sides", () => {
    const card = accountCardFromMovements("500", movements);
    expect(card.rows.map((row) => row.balance)).toEqual(["1500", "1100"]);
    expect(card.totalDebit).toBe("1000");
    expect(card.totalCredit).toBe("400");
    expect(card.opening).toBe("500");
    expect(card.closing).toBe("1100");
    expect(card.reconciliationDifference).toBe("0");
  });

  it("states its own reconciliation against the ledger's closing figure", () => {
    const card = accountCardFromMovements("500", movements, "1100");
    expect(card.reconciliationDifference).toBe("0");
    const wrong = accountCardFromMovements("500", movements, "999");
    expect(wrong.reconciliationDifference).toBe("101");
  });

  it("keeps the movement's own identity and counterparty on the row", () => {
    const card = accountCardFromMovements("0", movements);
    expect(card.rows[0].journalSourceId).toBe("t1");
    expect(card.rows[0].counterparty).toBe("صندوق");
    expect(card.rows[1].counterparty).toBe("اجاره");
  });

  it("handles an empty period without inventing a row", () => {
    const card = accountCardFromMovements("700", []);
    expect(card.rows).toEqual([]);
    expect(card.closing).toBe("700");
    expect(card.reconciliationDifference).toBe("0");
  });
});
