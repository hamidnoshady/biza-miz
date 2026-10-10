import { describe, expect, it } from "vitest";
import {
  cardTable,
  matrixCellDrill,
  matrixCellDrillHref,
  matrixColumnTitle,
  matrixTable,
  profitTable,
  type MatrixTableInput,
} from "./dimension-report-table";
import { journalFiltersFromParams } from "./journal-view";

const V1 = "11111111-1111-4111-8111-111111111111";
const key = (valueId: string | null) => valueId ?? "unassigned";

describe("matrixTable", () => {
  const report: MatrixTableInput = {
    columns: [
      { valueId: V1, code: "CC-HQ", name: "Head office" },
      { valueId: null, code: null, name: "بدون بُعد" },
    ],
    rows: [
      { code: "5300", name: "Rent", cells: { [V1]: 600_000, unassigned: 400_000 }, total: 1_000_000 },
      { code: "1100", name: "Cash", cells: { unassigned: -100_000 }, total: -100_000 },
    ],
    columnTotals: { [V1]: 600_000, unassigned: 300_000 },
    grandTotal: 900_000,
  };

  it("draws one column per dimension column, then the row total, with a totals row", () => {
    const table = matrixTable(report, key);
    expect(table.headers).toEqual(["کد حساب", "نام حساب", "CC-HQ · Head office", "بدون بُعد", "جمع"]);
    expect(table.rows[0]).toEqual(["5300", "Rent", 600_000, 400_000, 1_000_000]);
    // A row with no line in a column shows zero there, not a blank.
    expect(table.rows[1]).toEqual(["1100", "Cash", 0, -100_000, -100_000]);
    expect(table.rows[2]).toEqual(["", "جمع کل", 600_000, 300_000, 900_000]);
  });

  it("titles the unassigned column by its name and a value column by code and name", () => {
    expect(matrixColumnTitle({ valueId: V1, code: "CC-HQ", name: "Head office" })).toBe("CC-HQ · Head office");
    expect(matrixColumnTitle({ valueId: null, code: null, name: "بدون بُعد" })).toBe("بدون بُعد");
  });
});

describe("profitTable", () => {
  it("lists each centre's figures and closes on the total", () => {
    const table = profitTable({
      groups: [
        { code: "PC-ONLINE", name: "Online", revenue: 900_000, costOfSales: 350_000, grossProfit: 550_000, laborCost: 0, operatingExpenses: 0, netIncome: 550_000 },
        { code: null, name: "بدون بُعد", revenue: 100_000, costOfSales: 0, grossProfit: 100_000, laborCost: 0, operatingExpenses: 1_300_000, netIncome: -1_200_000 },
      ],
      total: { revenue: 1_000_000, costOfSales: 350_000, grossProfit: 650_000, laborCost: 0, operatingExpenses: 1_300_000, netIncome: -650_000 },
    });
    expect(table.rows[0][0]).toBe("PC-ONLINE · Online");
    expect(table.rows[1][0]).toBe("بدون بُعد");
    expect(table.rows[2]).toEqual(["جمع", 1_000_000, 350_000, 650_000, 0, 1_300_000, -650_000]);
    expect(table.headers).toHaveLength(7);
  });
});

describe("cardTable", () => {
  it("shows the opening balance, every movement with its Shamsi date, and the closing balance", () => {
    const table = cardTable({
      openingBalance: 600_000,
      closingBalance: 350_000,
      lines: [{ date: "2026-10-05", memo: "پرداخت اجاره", debit: 0, credit: 250_000, balance: 350_000 }],
    });
    expect(table.rows[0]).toEqual(["", "مانده اول دوره", "", "", 600_000]);
    // The date is Shamsi on screen and in the file: 2026-10-05 is 13 Mehr 1405.
    expect(table.rows[1][0]).toMatch(/۱۴۰۵|1405/);
    expect(table.rows[1]).toMatchObject([expect.any(String), "پرداخت اجاره", 0, 250_000, 350_000]);
    expect(table.rows[2]).toEqual(["", "مانده پایان دوره", "", "", 350_000]);
  });
});

describe("matrixCellDrillHref — a matrix cell opens the journal lines behind it (issue #868)", () => {
  const ACCOUNT = "44444444-4444-4444-8444-444444444444";
  const PROFIT_CENTRE = "55555555-5555-4555-8555-555555555555";

  function parsed(href: string) {
    expect(href.startsWith("/accounting/entries?")).toBe(true);
    return journalFiltersFromParams(new URLSearchParams(href.split("?")[1]));
  }

  it("lands on the journal filtered to that account, value and period, as the journal itself reads them", () => {
    const href = matrixCellDrillHref({
      kind: "cost_center",
      accountId: ACCOUNT,
      valueId: V1,
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(href).not.toBeNull();
    const state = parsed(href!);
    expect(state.account).toBe(ACCOUNT);
    expect(state.dimensions).toEqual({ cost_center: V1 });
    expect(state.dateFrom).toBe("2026-01-01");
    expect(state.dateTo).toBe("2026-01-31");
  });

  it("names the journal's own parameter for the kind it was drawn from", () => {
    const state = parsed(
      matrixCellDrillHref({
        kind: "profit_center",
        accountId: ACCOUNT,
        valueId: PROFIT_CENTRE,
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      })!,
    );
    expect(state.dimensions).toEqual({ profit_center: PROFIT_CENTRE });
  });

  it("gives no link for the unassigned column, because the journal cannot filter by the absence of a value", () => {
    expect(
      matrixCellDrillHref({ kind: "cost_center", accountId: ACCOUNT, valueId: null, dateFrom: "2026-01-01", dateTo: "2026-01-31" }),
    ).toBeNull();
  });
});

describe("matrixCellDrill — which body cells open a journal page", () => {
  const ACCOUNT_RENT = "66666666-6666-4666-8666-666666666666";
  const ACCOUNT_WAGES = "77777777-7777-4777-8777-777777777777";
  const report = {
    columns: [
      { valueId: V1, code: "CC-HQ", name: "Head office" },
      { valueId: null, code: null, name: "بدون بُعد" },
    ],
    rows: [
      { accountId: ACCOUNT_RENT, code: "5200", name: "اجاره", cells: { [V1]: 1200000, unassigned: 0 }, total: 1200000 },
      { accountId: ACCOUNT_WAGES, code: "6100", name: "حقوق", cells: { [V1]: 0, unassigned: 500 }, total: 500 },
    ],
    columnTotals: { [V1]: 1200000, unassigned: 500 },
    grandTotal: 1200500,
  };
  const period = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };
  const drill = (rowIndex: number, cellIndex: number) =>
    matrixCellDrill({ report, kind: "cost_center", period, rowIndex, cellIndex, columnKeyOf: key });

  it("links a non-zero value cell to its own account and value", () => {
    const href = drill(0, 2);
    expect(href).not.toBeNull();
    const state = journalFiltersFromParams(new URLSearchParams(href!.split("?")[1]));
    expect(state.account).toBe(ACCOUNT_RENT);
    expect(state.dimensions).toEqual({ cost_center: V1 });
  });

  it("does not link a zero value cell", () => {
    expect(drill(1, 2)).toBeNull();
  });

  it("does not link the unassigned column, the row total, the code or the name", () => {
    expect(drill(0, 3)).toBeNull();
    expect(drill(0, 4)).toBeNull();
    expect(drill(0, 0)).toBeNull();
    expect(drill(0, 1)).toBeNull();
  });

  it("does not link the totals row, or a row that is not there", () => {
    expect(drill(2, 2)).toBeNull();
    expect(drill(9, 2)).toBeNull();
  });
});
