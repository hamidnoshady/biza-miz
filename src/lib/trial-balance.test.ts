/**
 * The presentation rules of the trial balance, pinned as pure logic.
 *
 * These are the decisions that used to live inline in the section component —
 * and one of them was `Number(a.debit) !== 0`, a floating-point comparison on
 * a BIGINT Rial column. The filter here compares decimal strings, so a balance
 * above `Number.MAX_SAFE_INTEGER` is still exactly zero or exactly not.
 */
import { describe, expect, it } from "vitest";
import {
  filterTrialBalanceRows,
  isZeroTrialBalanceRow,
  type TrialBalanceDisplayRow,
} from "./trial-balance";

function row(overrides: Partial<TrialBalanceDisplayRow> = {}): TrialBalanceDisplayRow {
  return {
    code: "1100",
    name: "صندوق",
    type: "asset",
    isActive: true,
    openingDebit: "0",
    openingCredit: "0",
    periodDebit: "0",
    periodCredit: "0",
    closingDebit: "0",
    closingCredit: "0",
    ...overrides,
  };
}

const HUGE = "18014398509481986"; // above Number.MAX_SAFE_INTEGER

describe("isZeroTrialBalanceRow", () => {
  it("is exact for amounts a JS number cannot hold", () => {
    expect(isZeroTrialBalanceRow(row({ closingDebit: HUGE }), "closing")).toBe(false);
    expect(isZeroTrialBalanceRow(row({ closingCredit: HUGE }), "closing")).toBe(false);
    expect(isZeroTrialBalanceRow(row(), "closing")).toBe(true);
  });

  it("counts opening and movement in the detailed view, so a settled account is not 'empty'", () => {
    // An account that took 1,000 and paid it all back closes at zero — but it
    // moved, and a detailed trial balance must still show the movement.
    const settled = row({ openingDebit: "0", periodDebit: "1000", periodCredit: "1000" });
    expect(isZeroTrialBalanceRow(settled, "closing")).toBe(true);
    expect(isZeroTrialBalanceRow(settled, "detailed")).toBe(false);
  });

  it("treats a carried-in balance as non-zero even with no movement", () => {
    const carried = row({ openingCredit: "500", closingCredit: "500" });
    expect(isZeroTrialBalanceRow(carried, "closing")).toBe(false);
    expect(isZeroTrialBalanceRow(carried, "detailed")).toBe(false);
  });
});

describe("filterTrialBalanceRows", () => {
  const rows = [
    row({ code: "1100", name: "صندوق", type: "asset", closingDebit: "600" }),
    row({ code: "4100", name: "درآمد فروش", type: "revenue", closingCredit: "600" }),
    row({ code: "5300", name: "اجاره", type: "expense" }),
    row({ code: "5999", name: "حساب بایگانی", type: "expense", isActive: false }),
    row({ code: "2100", name: "پرداختنی", type: "liability", closingCredit: "100" }),
  ];

  it("hides zero rows unless the accountant asks for them", () => {
    expect(filterTrialBalanceRows(rows, { presentation: "detailed" }).map((r) => r.code))
      .toEqual(["1100", "4100", "2100"]);
    expect(
      filterTrialBalanceRows(rows, { presentation: "detailed", includeZeroBalances: true }).map((r) => r.code),
    ).toEqual(["1100", "4100", "5300", "5999", "2100"]);
  });

  it("searches by code and by name, case-insensitively and ignoring surrounding space", () => {
    expect(filterTrialBalanceRows(rows, { presentation: "detailed", search: "1100" }).map((r) => r.code))
      .toEqual(["1100"]);
    expect(filterTrialBalanceRows(rows, { presentation: "detailed", search: "  فروش " }).map((r) => r.code))
      .toEqual(["4100"]);
  });

  it("filters by account type", () => {
    expect(filterTrialBalanceRows(rows, { presentation: "detailed", accountType: "expense" }).map((r) => r.code))
      .toEqual([]);
    expect(
      filterTrialBalanceRows(rows, {
        presentation: "detailed",
        accountType: "expense",
        includeZeroBalances: true,
      }).map((r) => r.code),
    ).toEqual(["5300", "5999"]);
    expect(filterTrialBalanceRows(rows, { presentation: "detailed", accountType: "all" }).length).toBe(3);
  });

  it("filters by active/archived without dropping archived history", () => {
    // The archived account here carries no balance, so it is the zero-balance
    // rule hiding it — ask for zeros and the archived filter still finds it.
    const withZeros = { includeZeroBalances: true } as const;
    expect(filterTrialBalanceRows(rows, { presentation: "detailed", accountStatus: "archived", ...withZeros }).map((r) => r.code))
      .toEqual(["5999"]);
    expect(filterTrialBalanceRows(rows, { presentation: "detailed", accountStatus: "active", ...withZeros }).map((r) => r.code))
      .toEqual(["1100", "4100", "5300", "2100"]);
  });

  it("keeps an archived account that still has a balance", () => {
    const archivedWithHistory = row({ code: "4100", name: "درآمد فروش", type: "revenue", isActive: false, closingCredit: "600" });
    expect(filterTrialBalanceRows([archivedWithHistory], { presentation: "detailed" }).map((r) => r.code))
      .toEqual(["4100"]);
    expect(
      filterTrialBalanceRows([archivedWithHistory], { presentation: "detailed", accountStatus: "active" }).map((r) => r.code),
    ).toEqual([]);
  });

  it("combines every control without one silently overriding another", () => {
    expect(
      filterTrialBalanceRows(rows, {
        presentation: "closing",
        search: "1",
        accountType: "asset",
        accountStatus: "active",
        includeZeroBalances: false,
      }).map((r) => r.code),
    ).toEqual(["1100"]);
  });

  it("never mutates the rows it is given", () => {
    const input = [row({ closingDebit: "5" })];
    filterTrialBalanceRows(input, { presentation: "detailed" });
    expect(input[0].closingDebit).toBe("5");
  });
});
