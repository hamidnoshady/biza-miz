import { describe, expect, it } from "vitest";
import { xlsxToWorkbook } from "../../codecs";
import { holooWorkbookSheets, renderHolooWorkbook, type HolooWorkbookExportData } from "./export";
import { HOLOO_DATA_TRANSFER_PROFILE } from "./profile";

const data: HolooWorkbookExportData = {
  goods: [{ Code: "G-1", Name: "قهوه", BarCode: "123", SellPrice: "12000", UnitName: "عدد", ModifiedDate: "2026-10-05" }],
  persons: [{ Code: "P-1", Name: "مشتری", Tel: "09120000000", Address: "تهران", IsSupplier: "0", ModifiedDate: "" }],
  accounts: [{ Code: "100", Name: "بانک", Nature: "debit", ParentCode: "", ModifiedDate: "" }],
  skippedMultiRolePersons: 0,
};

describe("Holoo profile export", () => {
  it("emits exact worksheet names, field order and profile headers", () => {
    const sheets = holooWorkbookSheets(data, ["goods", "persons", "accounts"]);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Goods", "Person", "Account"]);
    expect(sheets.map((sheet) => sheet.columns.map((column) => column.label))).toEqual([
      ["Code", "Name", "BarCode", "SellPrice", "UnitName", "ModifiedDate"],
      ["Code", "Name", "Tel", "Address", "IsSupplier", "ModifiedDate"],
      ["Code", "Name", "Nature", "ParentCode", "ModifiedDate"],
    ]);
    expect(HOLOO_DATA_TRANSFER_PROFILE.capabilities.exportScopes).toEqual(["goods", "persons", "accounts"]);
    expect(holooWorkbookSheets(data, ["sales", "openingInventory"])).toEqual([]);
  });

  it("preserves profile cell types for money, booleans, and dates", () => {
    const sheets = holooWorkbookSheets(data, ["goods", "persons"]);
    expect(sheets[0].rows[0].SellPrice).toBe(12000);
    expect(sheets[0].rows[0].ModifiedDate).toBeInstanceOf(Date);
    expect(sheets[1].rows[0].IsSupplier).toBe(false);
  });

  it("uses profile-declared blank/default values and preserves over-precision money as text", () => {
    const sparse: HolooWorkbookExportData = {
      goods: [{ Code: "G-2", Name: "کالای بدون دادهٔ اختیاری", SellPrice: "1234567890123456" }],
      persons: [{ Code: "P-2", Name: "مشتری پیش‌فرض" }],
      accounts: [{ Code: "200", Name: "حساب پیش‌فرض" }],
      skippedMultiRolePersons: 0,
    };
    const [goods, persons, accounts] = holooWorkbookSheets(sparse, ["goods", "persons", "accounts"]);

    expect(goods.rows[0]).toMatchObject({ BarCode: "", SellPrice: "1234567890123456", UnitName: "", ModifiedDate: "" });
    expect(persons.rows[0]).toMatchObject({ Tel: "", Address: "", IsSupplier: false, ModifiedDate: "" });
    expect(accounts.rows[0]).toMatchObject({ Nature: "", ParentCode: "", ModifiedDate: "" });
  });

  it("round-trips a multi-sheet provider workbook without generic Persian headers", async () => {
    const bytes = await renderHolooWorkbook(data, ["goods", "persons", "accounts"]);
    const arrayBuffer = Uint8Array.from(bytes).buffer;
    const decoded = await xlsxToWorkbook(arrayBuffer);
    expect(decoded.map((sheet) => sheet.name)).toEqual(["Goods", "Person", "Account"]);
    expect(decoded[0].columns).toEqual(["Code", "Name", "BarCode", "SellPrice", "UnitName", "ModifiedDate"]);
    expect(decoded[0].rows[0]).toEqual(["G-1", "قهوه", "123", "12000", "عدد", "2026-10-05"]);
    expect(decoded[1].rows[0][4]).toBe("false");
  });
});
