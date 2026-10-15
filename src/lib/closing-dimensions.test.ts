import { describe, it, expect } from "vitest";
import {
  closingTupleRows,
  calculateDimensionalClosingLines,
  type DimensionTupleRow,
} from "./closing-dimensions";

const RE = "10000000-0000-4000-8000-000000000001";
const REV = "10000000-0000-4000-8000-000000000002";
const EXP = "10000000-0000-4000-8000-000000000003";
const CC_A = "10000000-0000-4000-8000-00000000000a";
const CC_B = "10000000-0000-4000-8000-00000000000b";

function row(
  accountId: string,
  accountType: "revenue" | "expense",
  debit: bigint,
  credit: bigint,
  dimensions: DimensionTupleRow["dimensions"] = {},
): DimensionTupleRow {
  return { accountId, accountType, debit, credit, dimensions };
}

describe("closingTupleRows", () => {
  it("maps exact integer strings to bigints and folds null columns to {}", () => {
    const rows = closingTupleRows([
      {
        account_id: REV,
        account_type: "revenue",
        debit: "0",
        credit: "1250000",
        cost_center_id: null,
        profit_center_id: null,
        department_id: null,
        detail_dimension_id: null,
      },
    ]);
    expect(rows).toEqual([
      { accountId: REV, accountType: "revenue", debit: 0n, credit: 1250000n, dimensions: {} },
    ]);
  });

  it("keeps populated columns as a tuple", () => {
    const rows = closingTupleRows([
      {
        account_id: EXP,
        account_type: "expense",
        debit: "100",
        credit: "0",
        cost_center_id: CC_A,
        profit_center_id: null,
        department_id: null,
        detail_dimension_id: null,
      },
    ]);
    expect(rows[0].dimensions).toEqual({ cost_center: CC_A });
  });
});

describe("calculateDimensionalClosingLines", () => {
  it("an unattributed year produces exactly the pre-dimension entry (one RE line, appended last)", () => {
    const rows = [
      row(REV, "revenue", 0n, 1250000n),
      row(EXP, "expense", 800000n, 0n),
    ];
    const result = calculateDimensionalClosingLines(rows, RE);
    expect(result.netIncome).toBe(450000n);
    expect(result.lines).toEqual([
      { accountId: REV, debit: "1250000", credit: "0", dimensions: {} },
      { accountId: EXP, debit: "0", credit: "800000", dimensions: {} },
      { accountId: RE, debit: "0", credit: "450000", dimensions: {} },
    ]);
    expect(result.tuples).toEqual([{}]);
  });

  it("closes each dimension group against a retained-earnings line of its own, self-balancing", () => {
    const rows = [
      row(REV, "revenue", 0n, 1000n, { cost_center: CC_A }),
      row(REV, "revenue", 0n, 500n, { cost_center: CC_B }),
      row(EXP, "expense", 700n, 0n, { cost_center: CC_A }),
    ];
    const result = calculateDimensionalClosingLines(rows, RE);
    expect(result.netIncome).toBe(800n);
    // Group A: revenue 1000 - expense 700 → RE credit 300 with A's tuple.
    // Group B: revenue 500 → RE credit 500 with B's tuple.
    const reLines = result.lines.filter((l) => l.accountId === RE);
    expect(reLines).toEqual([
      { accountId: RE, debit: "0", credit: "300", dimensions: { cost_center: CC_A } },
      { accountId: RE, debit: "0", credit: "500", dimensions: { cost_center: CC_B } },
    ]);
    // Every group balances within itself.
    for (const cc of [CC_A, CC_B]) {
      const group = result.lines.filter((l) => (l.dimensions as { cost_center?: string }).cost_center === cc);
      const debit = group.reduce((s, l) => s + BigInt(l.debit), 0n);
      const credit = group.reduce((s, l) => s + BigInt(l.credit), 0n);
      expect(debit).toBe(credit);
    }
    // The whole entry balances.
    const totalDebit = result.lines.reduce((s, l) => s + BigInt(l.debit), 0n);
    const totalCredit = result.lines.reduce((s, l) => s + BigInt(l.credit), 0n);
    expect(totalDebit).toBe(totalCredit);
  });

  it("a group whose year nets to zero gets no retained-earnings line", () => {
    const rows = [
      row(REV, "revenue", 0n, 900n, { cost_center: CC_A }),
      row(EXP, "expense", 900n, 0n, { cost_center: CC_A }),
    ];
    const result = calculateDimensionalClosingLines(rows, RE);
    expect(result.lines.filter((l) => l.accountId === RE)).toEqual([]);
    expect(result.netIncome).toBe(0n);
    expect(result.tuples).toEqual([]);
  });

  it("rejects negative aggregates (invalid_closing_balance)", () => {
    expect(() =>
      calculateDimensionalClosingLines([row(REV, "revenue", -1n, 0n)], RE),
    ).toThrow("invalid_closing_balance");
  });

  it("is exact to the Rial on amounts no float could hold", () => {
    const big = 9007199254740993n; // > Number.MAX_SAFE_INTEGER, odd
    const result = calculateDimensionalClosingLines([row(REV, "revenue", 0n, big)], RE);
    expect(result.lines[0].debit).toBe(big.toString());
    expect(result.netIncome).toBe(big);
  });
});
