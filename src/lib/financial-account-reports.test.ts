/**
 * The Financial Accounts reports, as tables (issue #862).
 *
 * These builders decide what a downloaded file *says* — the columns, the Shamsi
 * dates, and above all what happens to a Rial figure on its way into a
 * spreadsheet. A spreadsheet cell is where money quietly becomes a float, so the
 * exactness rule is pinned here: a value a spreadsheet can hold exactly is
 * written as a number, anything larger stays text rather than being rounded.
 */
import { describe, expect, it } from "vitest";

import {
  accountCardTables,
  balanceSummaryTable,
  financialReportFilename,
  transferRegisterTable,
  type AccountCardExportMeta,
} from "./financial-account-reports";

const meta: AccountCardExportMeta = {
  accountName: "حساب جاری ملت",
  accountKind: "bank",
  glAccountCode: "1110",
  glAccountName: "بانک",
  branchName: "شعبهٔ مرکزی",
  currencyCode: "IRR",
  from: "2026-04-01",
  to: "2026-04-30",
  opening: "5000000",
  totalDebit: "1000000",
  totalCredit: "400000",
  closing: "5600000",
  ledgerBalance: "5600000",
  reconciliationDifference: "0",
};

describe("the account card as a file", () => {
  it("repeats the account's identity and reconciliation in a header block", () => {
    const { header } = accountCardTables(meta, [], "toman");
    const rows = new Map(header.rows.map((row) => [row.label, row.value]));
    expect(rows.get("حساب")).toBe("حساب جاری ملت");
    expect(rows.get("سرفصل دفتر کل")).toBe("بانک (1110)");
    expect(rows.get("شعبه")).toBe("شعبهٔ مرکزی");
    // The proof that the file agrees with the ledger travels WITH the file.
    expect(rows.get("مانده دفتر کل (تومان)")).toBe(560000);
    expect(rows.get("مغایرت با دفتر کل (تومان)")).toBe(0);
  });

  it("writes Shamsi dates, and a dash when the card has no bound", () => {
    const { header } = accountCardTables({ ...meta, from: null, to: null }, [], "toman");
    const rows = new Map(header.rows.map((row) => [row.label, row.value]));
    expect(rows.get("از تاریخ")).toBe("—");
    expect(rows.get("تا تاریخ")).toBe("—");
    const bounded = accountCardTables(meta, [], "toman").header.rows.map((row) => row.value);
    expect(bounded.join(" ")).toContain("۱۴۰۵");
  });

  it("carries every movement with its own running balance", () => {
    const { movements } = accountCardTables(
      meta,
      [
        {
          entryDate: "2026-04-02",
          entryId: "e1",
          memo: "واریز از صندوق",
          counterparty: "صندوق مرکزی",
          debit: "1000000",
          credit: "0",
          balance: "6000000",
        },
        {
          entryDate: "2026-04-03",
          entryId: "e2",
          memo: null,
          counterparty: "اجاره",
          debit: "0",
          credit: "400000",
          balance: "5600000",
        },
      ],
      "toman",
    );
    expect(movements.columns.map((column) => column.key)).toEqual([
      "entryDate",
      "entryId",
      "memo",
      "counterparty",
      "debit",
      "credit",
      "balance",
    ]);
    expect(movements.rows[0].entryDate).toBe("۱۴۰۵/۰۱/۱۳");
    expect(movements.rows[0].debit).toBe(100000);
    expect(movements.rows[1].memo).toBe("");
    expect(movements.rows[1].credit).toBe(40000);
    expect(movements.rows[1].balance).toBe(560000);
  });

  it("keeps the money exact — a number while that is honest, text when it is not", () => {
    const { movements } = accountCardTables(
      meta,
      [
        {
          entryDate: "2026-04-02",
          entryId: "e1",
          memo: null,
          counterparty: "",
          // 16 digits in Rial: past 2^53, so a spreadsheet must NOT get a number.
          debit: "9007199254740993",
          credit: "0",
          balance: "9007199254740993",
        },
      ],
      "rial",
    );
    expect(movements.rows[0].debit).toBe("9007199254740993");
    expect(typeof movements.rows[0].debit).toBe("string");
  });

  it("divides by ten for Toman without passing through a float", () => {
    const { header } = accountCardTables({ ...meta, closing: "19" }, [], "toman");
    const rows = new Map(header.rows.map((row) => [row.label, row.value]));
    // Truncated toward zero, like `rialToToman` — one Rial never becomes a
    // tenth of a Toman in a column a person reads.
    expect(rows.get("مانده پایان دوره (تومان)")).toBe(1);
  });
});

describe("the transfer register as a file", () => {
  const row = {
    transferNumber: "TR-000042",
    transferDate: "2026-04-20",
    sourceAccountName: "صندوق مرکزی",
    destinationAccountName: "حساب جاری ملت",
    amount: "15000000",
    feeAmount: "0",
    feePayerLabel: "مبدأ",
    currencyCode: "IRR",
    status: "posted" as const,
    referenceNumber: null,
    description: "واریز نقدی روز",
    projectName: null,
    branchName: "شعبهٔ مرکزی",
    createdByName: "زهرا",
    journalEntryId: "8f14e45f-ea4c-4a1e-9c1a-1e4b0c2d3f40",
  };

  it("names both sides, the fee and the entry the row came from", () => {
    const table = transferRegisterTable([row], "toman");
    expect(table.columns.map((column) => column.key)).toContain("journalEntryId");
    expect(table.rows[0].transferNumber).toBe("TR-000042");
    expect(table.rows[0].sourceAccountName).toBe("صندوق مرکزی");
    expect(table.rows[0].transferDate).toBe("۱۴۰۵/۰۱/۳۱");
    expect(table.rows[0].amount).toBe(1500000);
    expect(table.rows[0].status).toBe("ثبت‌شده");
    expect(table.rows[0].referenceNumber).toBe("");
  });

  it("renders an empty register as a table with no rows, not as a crash", () => {
    const table = transferRegisterTable([], "rial");
    expect(table.rows).toEqual([]);
    expect(table.columns.length).toBeGreaterThan(0);
  });
});

describe("the balance summary as a file", () => {
  const rows = [
    {
      kind: "bank" as const,
      name: "حساب جاری ملت",
      code: "BANK-1",
      glAccountCode: "1110",
      glAccountName: "بانک",
      branchName: "شعبهٔ مرکزی",
      currencyCode: "IRR",
      isDefault: true,
      isActive: true,
      balance: "56000000",
    },
    {
      kind: "cash" as const,
      name: "صندوق مرکزی",
      code: null,
      glAccountCode: "1100",
      glAccountName: "صندوق",
      branchName: "کسب‌وکار",
      currencyCode: "IRR",
      isDefault: false,
      isActive: false,
      balance: "4000000",
    },
  ];

  it("totals the column exactly and closes with a جمع کل row", () => {
    const table = balanceSummaryTable(rows, "toman");
    const last = table.rows[table.rows.length - 1];
    expect(last.name).toBe("جمع کل");
    expect(last.balance).toBe(6000000);
    expect(table.rows[0].kind).toBe("حساب بانکی");
    expect(table.rows[0].isDefault).toBe("بله");
    expect(table.rows[1].status).toBe("بایگانی");
  });

  it("sums a total no float could hold, and hands it over as text", () => {
    const huge = balanceSummaryTable(
      [{ ...rows[0], balance: "9223372036854775807" }, { ...rows[1], balance: "1" }],
      "rial",
    );
    const last = huge.rows[huge.rows.length - 1];
    expect(last.balance).toBe("9223372036854775808");
    expect(typeof last.balance).toBe("string");
  });

  it("still prints a total for an empty register", () => {
    const table = balanceSummaryTable([], "toman");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].balance).toBe(0);
  });
});

describe("download filenames", () => {
  it("names the report, its scope and its day", () => {
    expect(financialReportFilename("transfer-register", "csv", { from: "2026-04-01", to: "2026-04-30" })).toBe(
      "financial-transfer-register-20260430.csv",
    );
    expect(financialReportFilename("account-card", "xlsx", { accountCode: "1110", to: "2026-04-30" })).toBe(
      "financial-account-card-1110-20260430.xlsx",
    );
    expect(financialReportFilename("balance-summary", "csv")).toBe("financial-account-balances.csv");
  });

  it("falls back to the start of the range when there is no end", () => {
    expect(financialReportFilename("balance-summary", "csv", { from: "2026-04-01" })).toBe(
      "financial-account-balances-20260401.csv",
    );
  });
});
