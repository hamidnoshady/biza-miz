/**
 * The one payment-source rule behind «پرداخت از» (issue #832 §2).
 *
 * These are the exact cases the issue names — till and bank and card-clearing
 * accepted; inventory, receivables, recoverable VAT and an unrelated asset
 * refused — plus the two that make it a *rule* rather than a list: a custom
 * sub-account inherits its well-known parent's meaning, and a business that
 * renamed or renumbered its chart is not penalised. The server checks membership
 * against the same function the pickers use, so if this file and
 * `expense-service.ts' agree, every entry channel does.
 */
import { describe, expect, it } from "vitest";
import {
  expenseCategoryAccounts,
  expensePaymentSourceAccounts,
  expensePaymentSourceIds,
  type ExpenseAccountShape,
} from "./expense-accounts";

function account(
  id: string,
  code: string,
  type: ExpenseAccountShape["type"],
  parentId: string | null = null,
): ExpenseAccountShape {
  return { id, code, type, parentId };
}

/** The default chart's asset side, as `0170`-era seeds build it. */
const CHART: ExpenseAccountShape[] = [
  // The codes `coa-template.ts` actually seeds: 1100 cash, 1110 bank, 1120 the
  // card/PSP settlement account, 1130 petty cash.
  account("cash", "1100", "asset"),
  account("bank", "1110", "asset"),
  account("clearing", "1120", "asset"),
  account("petty", "1130", "asset"),
  account("receivable", "1200", "asset"),
  account("vat", "1220", "asset"),
  account("platform", "1230", "asset"),
  account("inventory", "1500", "asset"),
  account("prepay", "1600", "asset"),
  account("rent", "5400", "expense"),
  account("utilities", "5500", "expense"),
];

describe("expensePaymentSourceAccounts", () => {
  it("accepts the money a business actually pays people with", () => {
    expect(expensePaymentSourceAccounts(CHART).map((a) => a.id)).toEqual([
      "cash",
      "bank",
      "clearing",
      "petty",
    ]);
  });

  it("refuses every other asset account, by name and by kind", () => {
    const ids = expensePaymentSourceIds(CHART);
    // The four the audit called out, and the two neighbours they sit beside.
    for (const id of ["inventory", "receivable", "vat", "prepay", "platform"]) {
      expect(ids.has(id), `${id} must not be a payment source`).toBe(false);
    }
  });

  it("keeps a platform receivable out even though it is money in transit", () => {
    // `CLEARING_ROLES` counts it as in-transit cash for the POS's purposes; an
    // expense paid "from" it would be spending money the platform still owes.
    expect(expensePaymentSourceIds(CHART).has("platform")).toBe(false);
  });

  it("inherits the meaning through the parent, so a custom sub-account works", () => {
    const chart = [
      account("bank", "1110", "asset"),
      account("mellat", "1111", "asset", "bank"),
      // A second till in the 110x block, with no parent at all: the block rule
      // still knows what it is.
      account("branchTill", "1101", "asset"),
    ];
    expect(expensePaymentSourceIds(chart).has("mellat")).toBe(true);
    expect(expensePaymentSourceIds(chart).has("branchTill")).toBe(true);
  });

  it("does not guess a liquid account that has no recognisable ancestor", () => {
    // A custom asset account whose code means nothing and whose parent is a
    // receivable stays ineligible: the operator points it at the right parent
    // rather than the register inventing a payment source.
    const chart = [
      account("receivable", "1200", "asset"),
      account("mystery", "1299", "asset", "receivable"),
    ];
    expect(expensePaymentSourceIds(chart).has("mystery")).toBe(false);
    expect(expensePaymentSourceIds(chart).has("receivable")).toBe(false);
  });

  it("leaves an archived-account decision to the caller", () => {
    // Nothing here knows `is_active`: callers pass the active chart. The rule is
    // about meaning, and archiving is the chart's business.
    const chart = [account("cash", "1100", "asset")];
    expect(expensePaymentSourceAccounts(chart).map((a) => a.id)).toEqual(["cash"]);
  });

  it("preserves the chart's own order, so the picker shows the ledger's order", () => {
    const reversed = [...CHART].reverse();
    expect(expensePaymentSourceAccounts(reversed).map((a) => a.id)).toEqual([
      "petty",
      "clearing",
      "bank",
      "cash",
    ]);
  });

  it("returns a plain empty set for a chart with no liquid account", () => {
    expect(expensePaymentSourceIds([account("rent", "5400", "expense")])).toEqual(new Set());
  });
});

describe("expenseCategoryAccounts", () => {
  it("is every expense-type account — the account *is* the category", () => {
    expect(expenseCategoryAccounts(CHART).map((a) => a.id)).toEqual(["rent", "utilities"]);
  });

  it("carries the caller's extra fields through, so a prompt can name accounts", () => {
    const withMeta = CHART.map((a) => ({ ...a, isSystem: false }));
    expect(expenseCategoryAccounts(withMeta)[0]).toMatchObject({ id: "rent", isSystem: false });
  });

  it("never filters by a hard-coded code list", () => {
    // The chart this business built for itself, with no default codes at all.
    const custom = [
      account("feed", "51100", "expense"),
      account("uniforms", "51200", "expense"),
      account("unknown", "99001", "expense"),
    ];
    expect(expenseCategoryAccounts(custom).map((a) => a.id)).toEqual(["feed", "uniforms", "unknown"]);
  });

  it("refuses an asset or revenue account as a category", () => {
    expect(expenseCategoryAccounts([account("cash", "1100", "asset"), account("sales", "4000", "revenue")])).toEqual([]);
  });
});
