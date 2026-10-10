import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_COLUMN_KEY,
  buildAccountDimensionMatrix,
  buildDimensionProfitReport,
  dimensionLinePredicate,
  effectiveNormalBalance,
  type MatrixAccountRow,
  type MatrixAccountTotal,
  type ProfitRow,
} from "./accounting-dimension-reports";
import { WELL_KNOWN_CODES, costOfSalesCodesForIndustry } from "./coa-template";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const RENT = "acc-rent";
const SALES = "acc-sales";
const CASH = "acc-cash";

const values = [
  { id: V1, code: "CC-HQ", name: "Head office", isActive: true },
  { id: V2, code: "CC-SALES", name: "Sales", isActive: false },
];

function line(overrides: Partial<MatrixAccountRow> & Pick<MatrixAccountRow, "accountId" | "valueId">): MatrixAccountRow {
  return {
    code: "5300",
    name: "Rent",
    type: "expense",
    normalBalance: "debit",
    isContra: false,
    debit: 0n,
    credit: 0n,
    ...overrides,
  };
}

describe("dimensionLinePredicate", () => {
  it("is TRUE with no filter, so an unfiltered query is unchanged", () => {
    expect(dimensionLinePredicate(null, () => "$9")).toBe("TRUE");
  });

  it("binds a value through the parameter callback and never interpolates it", () => {
    const bound: string[] = [];
    const sql = dimensionLinePredicate({ kind: "cost_center", valueId: V1 }, (v) => {
      bound.push(v);
      return "$4";
    });
    expect(sql).toBe("jl.cost_center_id = $4::uuid");
    expect(bound).toEqual([V1]);
  });

  it("selects the unassigned lines with IS NULL on the kind's own column", () => {
    expect(dimensionLinePredicate({ kind: "profit_center", valueId: "unassigned" }, () => "$1")).toBe(
      "jl.profit_center_id IS NULL",
    );
    expect(dimensionLinePredicate({ kind: "detail", valueId: "unassigned" }, () => "$1")).toBe(
      "jl.detail_dimension_id IS NULL",
    );
  });
});

describe("effectiveNormalBalance", () => {
  it("flips a contra account, and leaves an ordinary one alone", () => {
    expect(effectiveNormalBalance("debit", false)).toBe("debit");
    expect(effectiveNormalBalance("debit", true)).toBe("credit");
    expect(effectiveNormalBalance("credit", true)).toBe("debit");
  });
});

describe("buildAccountDimensionMatrix", () => {
  const totals: MatrixAccountTotal[] = [{ accountId: RENT, debit: 1_000_000n, credit: 0n }];

  it("places every line in exactly one column, and the columns add up to the account total", () => {
    const matrix = buildAccountDimensionMatrix({
      rows: [
        line({ accountId: RENT, valueId: V1, debit: 600_000n }),
        line({ accountId: RENT, valueId: null, debit: 400_000n }),
      ],
      accountTotals: totals,
      values,
    });
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0].cells).toEqual({ [V1]: 600_000, [UNASSIGNED_COLUMN_KEY]: 400_000 });
    expect(matrix.rows[0].total).toBe(1_000_000);
    expect(matrix.grandTotal).toBe(1_000_000);
    expect(matrix.reconciled).toBe(true);
  });

  it("reports unreconciled when a line is missing from the cells", () => {
    const matrix = buildAccountDimensionMatrix({
      rows: [line({ accountId: RENT, valueId: V1, debit: 600_000n })],
      accountTotals: totals,
      values,
    });
    expect(matrix.reconciled).toBe(false);
  });

  it("shows an expense as positive and a revenue, which sits on the credit side, as positive too", () => {
    const matrix = buildAccountDimensionMatrix({
      rows: [
        line({ accountId: RENT, valueId: V1, debit: 250_000n }),
        line({ accountId: SALES, valueId: V1, code: "4300", name: "Sales", type: "revenue", normalBalance: "credit", credit: 900_000n }),
      ],
      accountTotals: [
        { accountId: RENT, debit: 250_000n, credit: 0n },
        { accountId: SALES, debit: 0n, credit: 900_000n },
      ],
      values,
    });
    const byCode = Object.fromEntries(matrix.rows.map((r) => [r.code, r]));
    expect(byCode["5300"].total).toBe(250_000);
    expect(byCode["4300"].total).toBe(900_000);
    expect(matrix.reconciled).toBe(true);
  });

  it("sums a column across accounts, so a cost centre's total is its real spend", () => {
    const matrix = buildAccountDimensionMatrix({
      rows: [
        line({ accountId: RENT, valueId: V1, debit: 300_000n }),
        line({ accountId: "acc-power", valueId: V1, code: "5310", name: "Power", debit: 120_000n }),
        line({ accountId: RENT, valueId: null, debit: 50_000n }),
      ],
      accountTotals: [
        { accountId: RENT, debit: 350_000n, credit: 0n },
        { accountId: "acc-power", debit: 120_000n, credit: 0n },
      ],
      values,
    });
    expect(matrix.columnTotals[V1]).toBe(420_000);
    expect(matrix.columnTotals[UNASSIGNED_COLUMN_KEY]).toBe(50_000);
    expect(matrix.grandTotal).toBe(470_000);
    expect(matrix.reconciled).toBe(true);
  });

  it("keeps an archived value that still has activity, labelled as archived", () => {
    const matrix = buildAccountDimensionMatrix({
      rows: [line({ accountId: RENT, valueId: V2, debit: 10_000n })],
      accountTotals: [{ accountId: RENT, debit: 10_000n, credit: 0n }],
      values,
    });
    expect(matrix.columns).toEqual([{ valueId: V2, code: "CC-SALES", name: "Sales", isActive: false }]);
  });

  it("leaves out an archived value with no activity in the period", () => {
    const matrix = buildAccountDimensionMatrix({
      rows: [line({ accountId: RENT, valueId: V1, debit: 10_000n })],
      accountTotals: [{ accountId: RENT, debit: 10_000n, credit: 0n }],
      values,
    });
    expect(matrix.columns.map((c) => c.valueId)).toEqual([V1]);
  });

  it("reconciles a contra account against its own unfiltered total", () => {
    const matrix = buildAccountDimensionMatrix({
      rows: [line({ accountId: "acc-allow", valueId: V1, code: "1290", name: "Allowance", type: "asset", normalBalance: "debit", isContra: true, credit: 40_000n })],
      accountTotals: [{ accountId: "acc-allow", debit: 0n, credit: 40_000n }],
      values,
    });
    expect(matrix.rows[0].total).toBe(40_000);
    expect(matrix.reconciled).toBe(true);
  });
});

describe("buildDimensionProfitReport", () => {
  const rev = (valueId: string | null, credit: bigint): ProfitRow => ({
    valueId,
    accountId: SALES,
    code: "4300",
    type: "revenue",
    debit: 0n,
    credit,
  });
  const exp = (valueId: string | null, code: string, debit: bigint, accountId = `acc-${code}`): ProfitRow => ({
    valueId,
    accountId,
    code,
    type: "expense",
    debit,
    credit: 0n,
  });
  // WELL_KNOWN_CODES.cogs is the food-service cost-of-sales code, and it is a
  // member of the food-service list the builder classifies with.
  const cogs = WELL_KNOWN_CODES.cogs;
  it("uses a cost-of-sales code the food-service list really contains", () => {
    expect(costOfSalesCodesForIndustry("food_service")).toContain(cogs);
  });

  it("splits revenue and cost by the value each line carries, and the groups add up to the whole", () => {
    const rows = [rev(V1, 1_000_000n), rev(V2, 400_000n), exp(V1, cogs, 300_000n), exp(V2, "5300", 100_000n), exp(null, "5300", 50_000n)];
    const report = buildDimensionProfitReport({
      rows,
      unfilteredRows: rows.map((r) => ({ ...r, valueId: null })),
      values,
      industry: "food_service",
    });
    const groups = Object.fromEntries(report.groups.map((g) => [g.valueId ?? "none", g]));
    expect(groups[V1].revenue).toBe(1_000_000);
    expect(groups[V1].netIncome).toBe(700_000);
    expect(groups[V2].netIncome).toBe(300_000);
    expect(groups.none.netIncome).toBe(-50_000);
    expect(report.total.revenue).toBe(1_400_000);
    expect(report.total.totalExpenses).toBe(450_000);
    expect(report.total.netIncome).toBe(950_000);
    expect(report.reconciled).toBe(true);
  });

  it("classifies cost of sales by the industry's codes and labour by the salaries code", () => {
    const rows = [rev(V1, 1_000_000n), exp(V1, cogs, 300_000n), exp(V1, WELL_KNOWN_CODES.salariesExpense, 200_000n), exp(V1, "5300", 100_000n)];
    const report = buildDimensionProfitReport({
      rows,
      unfilteredRows: rows.map((r) => ({ ...r, valueId: null })),
      values,
      industry: "food_service",
    });
    const g = report.groups.find((x) => x.valueId === V1)!;
    expect(g.costOfSales).toBe(300_000);
    expect(g.laborCost).toBe(200_000);
    expect(g.grossProfit).toBe(700_000);
    expect(g.operatingExpenses).toBe(100_000);
    expect(g.netIncome).toBe(400_000);
  });

  it("ignores balance-sheet and other non-P&L accounts entirely", () => {
    const rows: ProfitRow[] = [
      rev(V1, 500_000n),
      { valueId: V1, accountId: CASH, code: "1100", type: "asset", debit: 500_000n, credit: 0n },
    ];
    const report = buildDimensionProfitReport({ rows, unfilteredRows: rows, values, industry: "food_service" });
    expect(report.total.revenue).toBe(500_000);
    expect(report.total.totalExpenses).toBe(0);
    expect(report.groups.map((g) => g.valueId)).toEqual([V1]);
  });

  it("reports unreconciled when the grouped rows lose a line the unfiltered rows contain", () => {
    const grouped = [rev(V1, 500_000n)];
    const unfiltered = [rev(null, 500_000n), rev(V1, 500_000n)];
    const report = buildDimensionProfitReport({ rows: grouped, unfilteredRows: unfiltered, values, industry: "food_service" });
    expect(report.reconciled).toBe(false);
  });
});
