/**
 * Issue #867 — opening balance set rules and the fiscal carry-forward rule:
 * what a valid set is, what the next year opens with, and how the open is
 * proved against the close it came from.
 */
import { describe, expect, it } from "vitest";
import {
  OPENING_LINES_MAX,
  buildCarryForwardProposal,
  openingLineNet,
  openingLineTotals,
  openingSetProblem,
  reconcileOpeningToClosing,
  type CarryForwardAccount,
  type CarryForwardInput,
  type CarryForwardLine,
} from "./opening-balances";

const M = 1_000_000n; // one million Rial

function line(input: {
  debit: bigint;
  credit: bigint;
  accountId?: string;
  partyType?: "customer" | "supplier" | "cheque" | "fixed_asset" | "inventory" | null;
  partyId?: string | null;
  reference?: string | null;
  sourceNote?: string | null;
}): CarryForwardLine {
  return {
    accountId: input.accountId ?? "a1",
    debit: input.debit,
    credit: input.credit,
    partyType: input.partyType ?? null,
    partyId: input.partyId ?? null,
    reference: input.reference ?? null,
    sourceNote: input.sourceNote ?? null,
  };
}

// ---------------------------------------------------------------------------
// Set validation
// ---------------------------------------------------------------------------

describe("openingSetProblem", () => {
  const balanced = () => [
    { accountId: "a1", debit: 100, credit: 0 },
    { accountId: "a2", debit: 0, credit: 100 },
  ];

  it("accepts a balanced two-account set", () => {
    expect(openingSetProblem(balanced())).toBeNull();
  });

  it("refuses an empty set and a set of zero rows", () => {
    expect(openingSetProblem([])).toBe("no_lines");
    expect(openingSetProblem([{ accountId: "a1", debit: 0, credit: 0 }])).toBe("no_lines");
  });

  it("refuses more than the line cap", () => {
    const lines = Array.from({ length: OPENING_LINES_MAX + 1 }, (_, i) => ({
      accountId: `a${i % 7}`,
      debit: 1,
      credit: i % 2,
    }));
    expect(openingSetProblem(lines)).toBe("too_many_lines");
  });

  it("refuses rows with both sides filled, negatives, or non-integers", () => {
    expect(openingSetProblem([{ accountId: "a1", debit: 5, credit: 5 }])).toBe("invalid_line");
    expect(openingSetProblem([{ accountId: "a1", debit: -1, credit: 0 }, { accountId: "a2", debit: 0, credit: 1 }])).toBe(
      "invalid_line",
    );
    expect(openingSetProblem([{ accountId: "a1", debit: 1.5, credit: 0 }, { accountId: "a2", debit: 0, credit: 1.5 }])).toBe(
      "invalid_line",
    );
    expect(openingSetProblem([{ accountId: "", debit: 1, credit: 0 }, { accountId: "a2", debit: 0, credit: 1 }])).toBe(
      "invalid_line",
    );
  });

  it("refuses a one-row set and a set that posts one account against itself", () => {
    expect(openingSetProblem([{ accountId: "a1", debit: 100, credit: 0 }])).toBe("too_few_lines");
    expect(
      openingSetProblem([
        { accountId: "a1", debit: 100, credit: 0 },
        { accountId: "a1", debit: 0, credit: 100 },
      ]),
    ).toBe("single_account_set");
  });

  it("refuses an unbalanced set even with many accounts", () => {
    expect(
      openingSetProblem([
        { accountId: "a1", debit: 100, credit: 0 },
        { accountId: "a2", debit: 0, credit: 90 },
        { accountId: "a3", debit: 0, credit: 5 },
      ]),
    ).toBe("not_balanced");
  });
});

describe("openingLineTotals / openingLineNet", () => {
  it("sums exactly, even past Number.MAX_SAFE_INTEGER-ish values", () => {
    const half = 9_500_000_000_000_000n; // 9.5 quadrillion Rial — beyond 2^53
    const t = openingLineTotals([{ debit: Number(half), credit: 0 }, { debit: 0, credit: Number(half) }]);
    expect(t.totalDebit).toBe(half);
    expect(t.totalCredit).toBe(half);
    expect(t.difference).toBe(0n);
    expect(openingLineNet({ debit: 7, credit: 3 })).toBe(4n);
    expect(openingLineNet({ debit: 3, credit: 7 })).toBe(-4n);
  });
});

// ---------------------------------------------------------------------------
// Carry-forward
// ---------------------------------------------------------------------------

/**
 * A balanced prior year:
 *
 *   assets  cash 5M · A/R 8M (customers 5M+3M) · inventory 2M · fixed 10M (6M+4M)
 *   contra  accumulated depreciation −2M (1.2M+0.8M)
 *   liab    A/P −4M (suppliers 2.5M+1.5M) · loan −3M
 *   equity  capital −20M
 *   p&l     revenue −3M (credit) · expense +7M (debit) → a 4M loss
 *
 * The whole book nets to zero.
 */
function fullYear(): CarryForwardInput {
  const accounts: CarryForwardAccount[] = [
    { accountId: "cash", code: "1000", name: "نقد", type: "asset", closingNet: 5n * M },
    { accountId: "ar", code: "1200", name: "حساب‌های دریافتنی", type: "asset", closingNet: 8n * M },
    { accountId: "inv", code: "1300", name: "موجودی", type: "asset", closingNet: 2n * M },
    { accountId: "fixed", code: "1500", name: "دارایی ثابت", type: "asset", closingNet: 10n * M },
    { accountId: "accdep", code: "1510", name: "استهلاک انباشته", type: "asset", closingNet: -2n * M },
    { accountId: "ap", code: "2100", name: "حساب‌های پرداختنی", type: "liability", closingNet: -4n * M },
    { accountId: "loan", code: "2000", name: "قرض", type: "liability", closingNet: -3n * M },
    { accountId: "capital", code: "3000", name: "سرمایه", type: "equity", closingNet: -20n * M },
    { accountId: "rev", code: "7000", name: "فروش", type: "revenue", closingNet: -3n * M },
    { accountId: "exp", code: "8000", name: "هزینه", type: "expense", closingNet: 7n * M },
  ];
  return {
    accounts,
    arByCustomer: [
      { subledgerId: "c1", partyId: "p1", name: "مشتری یک", balance: 5n * M },
      { subledgerId: "c2", partyId: null, name: "مشتری دو", balance: 3n * M },
      { subledgerId: "c3", partyId: "p3", name: "مشتری صفر", balance: 0n },
    ],
    apBySupplier: [
      { subledgerId: "s1", partyId: "sp1", name: "تأمین‌کننده الف", balance: 2_500_000n },
      { subledgerId: "s2", partyId: null, name: "تأمین‌کننده ب", balance: 1_500_000n },
    ],
    openCheques: [],
    fixedAssets: [
      { assetId: "fa1", name: "ماشین", accountId: "fixed", cost: 6n * M, accumulatedDepreciation: 1_200_000n, acquisitionSource: "journal" },
      { assetId: "fa2", name: "ابزار", accountId: "fixed", cost: 4n * M, accumulatedDepreciation: 800_000n, acquisitionSource: "opening_balance" },
    ],
    accountIds: {
      accountsReceivable: "ar",
      accountsPayable: "ap",
      accumulatedDepreciation: "accdep",
      retainedEarnings: "re",
    },
  };
}

describe("buildCarryForwardProposal — a year that reconciles cleanly", () => {
  const proposal = buildCarryForwardProposal(fullYear());

  it("is balanced by construction", () => {
    expect(proposal.balanced).toBe(true);
    expect(proposal.totalDebit).toBe(proposal.totalCredit);
  });

  it("carries A/R per customer and drops the zero-balance one", () => {
    const arLines = proposal.lines.filter((l) => l.accountId === "ar");
    expect(arLines).toHaveLength(2); // c1 + c2, c3 had no balance
    expect(arLines.find((l) => l.partyId === "p1")).toMatchObject({ debit: 5n * M, credit: 0n, partyType: "customer" });
    const c2 = arLines.find((l) => l.partyId === null)!;
    expect(c2.reference).toBe("مشتری دو"); // unlinked customers are named
  });

  it("carries A/P per supplier as credits", () => {
    const s1 = proposal.lines.find((l) => l.partyId === "sp1")!;
    expect(s1).toMatchObject({ accountId: "ap", debit: 0n, credit: 2_500_000n, partyType: "supplier" });
  });

  it("carries fixed assets per item and one accumulated-depreciation line", () => {
    expect(proposal.lines.find((l) => l.partyId === "fa1")).toMatchObject({ debit: 6n * M, reference: "ماشین" });
    const acc = proposal.lines.find((l) => l.accountId === "accdep")!;
    expect(acc).toMatchObject({ debit: 0n, credit: 2n * M });
  });

  it("closes the prior year's loss into one retained-earnings debit line", () => {
    const re = proposal.lines.find((l) => l.accountId === "re")!;
    expect(re).toMatchObject({ debit: 4n * M, credit: 0n }); // 3M revenue − 7M expense
    // And never carries revenue/expense as ordinary opening lines.
    expect(proposal.lines.every((l) => l.accountId !== "rev" && l.accountId !== "exp")).toBe(true);
  });

  it("carries the plain balance-sheet accounts by their total", () => {
    expect(proposal.lines.find((l) => l.accountId === "cash")).toMatchObject({ debit: 5n * M });
    expect(proposal.lines.find((l) => l.accountId === "inv")).toMatchObject({ debit: 2n * M, sourceNote: "موجودی افتتاحیه" });
    expect(proposal.lines.find((l) => l.accountId === "loan")).toMatchObject({ credit: 3n * M });
    expect(proposal.lines.find((l) => l.accountId === "capital")).toMatchObject({ credit: 20n * M });
  });

  it("needs no fallback notes when every register agrees", () => {
    expect(proposal.notes).toEqual([]);
  });
});

describe("buildCarryForwardProposal — fallbacks when registers disagree", () => {
  it("keeps an unattributed A/R residual line instead of dropping it", () => {
    const input = fullYear();
    input.arByCustomer = input.arByCustomer.slice(0, 1); // 5M attributed of 8M
    const p = buildCarryForwardProposal(input);
    const residual = p.lines.filter((l) => l.accountId === "ar" && !l.partyType);
    expect(residual).toHaveLength(1);
    expect(residual[0].debit).toBe(3n * M);
    expect(residual[0].sourceNote).toContain("مغایرت");
    expect(p.notes.length).toBeGreaterThan(0); // the mismatch is explained, not hidden
    expect(p.balanced).toBe(true);
  });

  it("falls back to the account total when cheques and the GL disagree", () => {
    const input = fullYear();
    input.accounts = [...input.accounts, { accountId: "chq", code: "1241", name: "چک دریافتی", type: "asset", closingNet: 3n * M }];
    input.openCheques = [
      { chequeId: "ch1", direction: "receivable", accountId: "chq", serialNumber: "81234", sayadId: "99", counterpartyName: "X", amount: 2n * M },
    ];
    const p = buildCarryForwardProposal(input);
    // register (2M) ≠ GL (3M) → the whole account total carries, not the cheques
    expect(p.lines.find((l) => l.accountId === "chq")).toMatchObject({ debit: 3n * M });
    expect(p.lines.some((l) => l.partyType === "cheque")).toBe(false);
    expect(p.notes.join(" ")).toContain("چک");
  });

  it("keeps per-cheque identity when the register and the GL agree", () => {
    const input = fullYear();
    input.accounts = [...input.accounts, { accountId: "chq", code: "1242", name: "چک در وصول", type: "asset", closingNet: 2n * M }];
    input.openCheques = [
      { chequeId: "ch1", direction: "receivable", accountId: "chq", serialNumber: "111", sayadId: null, counterpartyName: "A", amount: 1_500_000n },
      { chequeId: "ch2", direction: "receivable", accountId: "chq", serialNumber: "222", sayadId: "77", counterpartyName: "B", amount: 500_000n },
    ];
    const p = buildCarryForwardProposal(input);
    const cheques = p.lines.filter((l) => l.partyType === "cheque");
    expect(cheques).toHaveLength(2);
    expect(cheques.find((l) => l.partyId === "ch2")!.reference).toBe("Sayad 77 / 222");
    // …and the account total itself is NOT also carried (double counting)
    expect(p.lines.filter((l) => l.accountId === "chq")).toHaveLength(2);
  });

  it("falls back to account totals when the asset register disagrees with the GL", () => {
    const input = fullYear();
    input.fixedAssets = input.fixedAssets.map((a) =>
      a.assetId === "fa1" ? { ...a, cost: 5n * M } : a, // register now says 9M, GL says 10M
    );
    const p = buildCarryForwardProposal(input);
    expect(p.lines.some((l) => l.partyType === "fixed_asset")).toBe(false);
    expect(p.lines.find((l) => l.accountId === "fixed")).toMatchObject({ debit: 10n * M });
    expect(p.notes.join(" ")).toContain("دارایی");
  });

  it("warns instead of balancing when no retained-earnings account exists", () => {
    const input = fullYear();
    input.accountIds.retainedEarnings = null;
    const p = buildCarryForwardProposal(input);
    expect(p.balanced).toBe(false);
    expect(p.notes.join(" ")).toContain("سود و زیان انباشته");
  });
});

describe("reconcileOpeningToClosing", () => {
  it("matches a set against its own proposal", () => {
    const p = buildCarryForwardProposal(fullYear());
    const r = reconcileOpeningToClosing(p.lines, p.lines);
    expect(r.matched).toBe(true);
    expect(r.rows.every((row) => row.difference === 0n)).toBe(true);
  });

  it("flags a changed customer balance, to the Rial", () => {
    const p = buildCarryForwardProposal(fullYear());
    const tampered = p.lines.map((l) =>
      l.partyId === "p1" ? { ...l, debit: l.debit + 1n } : l,
    );
    const r = reconcileOpeningToClosing(p.lines, tampered);
    expect(r.matched).toBe(false);
    const row = r.rows.find((row) => row.key === "party:customer:p1")!;
    expect(row.difference).toBe(-1n);
    // the account-level row also disagrees
    expect(r.rows.find((row) => row.key === "account:ar")!.matched).toBe(false);
  });

  it("compares attributed and unattributed amounts separately", () => {
    const expected = [
      line({ accountId: "ar", debit: 8n * M, credit: 0n, partyType: "customer", partyId: "p1" }),
      line({ accountId: "ar", debit: 0n, credit: 0n }),
    ];
    // same account totals, different attribution
    const actual = [line({ accountId: "ar", debit: 8n * M, credit: 0n, partyType: "customer", partyId: "p2" })];
    const r = reconcileOpeningToClosing(expected, actual);
    expect(r.rows.find((row) => row.key === "account:ar")!.matched).toBe(true);
    expect(r.matched).toBe(false);
  });

  it("reports the whole picture when the sets are unrelated", () => {
    const r = reconcileOpeningToClosing(
      [line({ accountId: "a", debit: 100n, credit: 0n })],
      [line({ accountId: "b", debit: 0n, credit: 200n })],
    );
    expect(r.matched).toBe(false);
    expect(r.totalExpectedDebit).toBe(100n);
    expect(r.totalActualCredit).toBe(200n);
  });
});
