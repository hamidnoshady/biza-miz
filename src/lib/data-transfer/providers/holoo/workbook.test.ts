import { describe, expect, it } from "vitest";
import type { ParsedWorkbookSheet } from "../../codecs";
import { HOLOO_DATA_TRANSFER_PROFILE } from "./profile";
import { analyzeHolooWorkbook, holooWorkbookToBaseInput, holooWorkbookToImportInput } from "./workbook";

function sheet(scope: string, rows: string[][]): ParsedWorkbookSheet {
  const definition = HOLOO_DATA_TRANSFER_PROFILE.sheets.find((candidate) => candidate.scope === scope)!;
  return { name: definition.sheetName, columns: definition.columns.map((column) => column.externalName), rows };
}

describe("Holoo workbook profile", () => {
  it("recognizes exact versioned sheets, preserves per-sheet rows and counts", () => {
    const workbook = analyzeHolooWorkbook([
      sheet("goods", [["G-1", "چای", "0001", "120", "بسته", "1404-01-01"]]),
      sheet("persons", [["P-1", "علی", "0912", "تهران", "0", "1404-01-01"]]),
      sheet("accounts", [["101", "صندوق", "debit", "", "1404-01-01"]]),
    ]);
    expect(workbook.profileKey).toBe("holoo-generic-v1");
    expect(workbook.profileVersion).toBe(1);
    expect(workbook.rowCounts).toEqual({ goods: 1, persons: 1, accounts: 1 });
    expect(workbook.issues).toEqual([]);
  });

  it("refuses lookalike or reordered headers rather than guessing", () => {
    const wrongHeader = sheet("goods", [["G-1", "چای", "0001", "120", "بسته", "1404-01-01"]]);
    wrongHeader.columns = [...wrongHeader.columns].reverse();
    const result = analyzeHolooWorkbook([wrongHeader]);
    expect(result.profileKey).toBeNull();
    expect(result.issues).toContainEqual({ code: "header_mismatch", sheetName: "Goods" });
  });

  it("requires stable external IDs and reports invalid source rows", () => {
    const result = analyzeHolooWorkbook([sheet("goods", [["", "چای", "0001", "120", "بسته", ""]])]);
    expect(result.profileKey).toBe("holoo-generic-v1");
    expect(result.issues).toContainEqual({ code: "missing_external_id", sheetName: "Goods", rowNumber: 2 });
    expect(() => holooWorkbookToBaseInput(result, ["goods"], "rial")).toThrow("holoo_workbook_has_errors");
  });

  it("uses existing Holoo mappers for exact money conversion and enforces dependencies", () => {
    const result = analyzeHolooWorkbook([
      sheet("goods", [["G-1", "چای", "0001", "120", "بسته", ""]]),
      sheet("openingInventory", [["S-1", "", "G-1", "3", "200", ""]]),
    ]);
    const imported = holooWorkbookToBaseInput(result, ["goods", "openingInventory"], "toman");
    expect(imported.input.goods[0].priceRial).toBe(1200n);
    expect(imported.input.openingInventory?.[0]).toMatchObject({
      remoteId: "S-1",
      goodsRemoteId: "G-1",
      quantity: "3",
      unitCostRial: 2000n,
    });
    expect(imported.unresolvedGoodsReferences).toEqual([]);
    expect(() => holooWorkbookToBaseInput(result, ["openingInventory"], "toman")).toThrow("holoo_scope_dependency_missing:openingInventory");
  });

  it("reports unresolved stock references for preview instead of inventing a fuzzy match", () => {
    const result = analyzeHolooWorkbook([
      sheet("goods", [["G-1", "چای", "0001", "120", "بسته", ""]]),
      sheet("openingInventory", [["S-1", "", "missing-goods", "3", "200", ""]]),
    ]);
    const imported = holooWorkbookToBaseInput(result, ["goods", "openingInventory"], "rial");
    expect(imported.unresolvedGoodsReferences).toEqual([{ stockRemoteId: "S-1", goodsRemoteId: "missing-goods" }]);
  });

  it("recognizes but refuses row-level application of unsupported transaction sheets", () => {
    const result = analyzeHolooWorkbook([sheet("sales", [["I-1", "2025-01-01", "P-1", "500", ""]])]);
    expect(result.profileKey).toBe("holoo-generic-v1");
    expect(() => holooWorkbookToBaseInput(result, ["sales"], "rial")).toThrow("holoo_scope_not_supported");
  });

  it("groups voucher lines by header and converts large Toman amounts to exact Rial", () => {
    const result = analyzeHolooWorkbook([
      sheet("accounts", [["101", "صندوق", "debit", "", ""], ["201", "سرمایه", "credit", "", ""]]),
      sheet("journal", [["J-1", "2025-01-01", "افتتاحیه", ""]]),
      sheet("journalLines", [
        ["J-1", "101", "900719925474099.3", "0"],
        ["J-1", "201", "0", "900719925474099.3"],
      ]),
    ]);
    const imported = holooWorkbookToImportInput(result, ["accounts", "journal", "journalLines"], "toman");
    expect(imported.input.accounts).toHaveLength(2);
    expect(imported.journals).toEqual([{
      remoteId: "J-1",
      entryDate: "2025-01-01",
      memo: "افتتاحیه",
      lines: [
        { accountCode: "101", debitRial: "9007199254740993", creditRial: "0" },
        { accountCode: "201", debitRial: "0", creditRial: "9007199254740993" },
      ],
    }]);
  });

  it("rejects lines with no matching header, duplicate identities, and non-ISO dates", () => {
    const header = sheet("journal", [["J-1", "2025-01-01", "", ""]]);
    const accounts = sheet("accounts", [["101", "صندوق", "debit", "", ""]]);
    const goodLines = sheet("journalLines", [["J-1", "101", "100", "0"]]);
    const missingHeader = analyzeHolooWorkbook([accounts, header, sheet("journalLines", [["J-2", "101", "100", "0"]])]);
    expect(() => holooWorkbookToImportInput(missingHeader, ["accounts", "journal", "journalLines"], "rial"))
      .toThrow("holoo_journal_line_reference_missing");

    const duplicateLines = analyzeHolooWorkbook([accounts, header, sheet("journalLines", [
      ["J-1", "101", "100", "0"],
      ["J-1", "101", "0", "100"],
    ])]);
    expect(() => holooWorkbookToImportInput(duplicateLines, ["accounts", "journal", "journalLines"], "rial"))
      .toThrow("duplicate_holoo_remote_id:journalLines");

    const invalidDate = analyzeHolooWorkbook([accounts, sheet("journal", [["J-1", "1404/01/01", "", ""]]), goodLines]);
    expect(() => holooWorkbookToImportInput(invalidDate, ["accounts", "journal", "journalLines"], "rial"))
      .toThrow("invalid_holoo_date");
  });
});
