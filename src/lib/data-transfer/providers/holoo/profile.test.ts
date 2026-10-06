import { describe, expect, it } from "vitest";
import { HOLOO_DATA_TRANSFER_PROFILE as profile } from "./profile";

describe("Holoo Data Transfer profile dimensions", () => {
  it("pins the versioned file, date, money, and connected-write contract", () => {
    expect({
      provider: profile.provider,
      profileKey: profile.profileKey,
      profileVersion: profile.profileVersion,
      directions: profile.directions,
      sourceFormats: profile.sourceFormats,
      dateRepresentation: profile.dateRepresentation,
      moneyRepresentation: profile.moneyRepresentation,
      applyService: profile.applyService,
      capabilities: profile.capabilities,
    }).toEqual({
      provider: "holoo",
      profileKey: "holoo-generic-v1",
      profileVersion: 1,
      directions: ["both"],
      sourceFormats: ["xlsx", "connected_sql"],
      dateRepresentation: "native_sql_date",
      moneyRepresentation: "connection_setting",
      applyService: "src/lib/integrations/holoo/import-service.ts",
      capabilities: {
        readScopes: ["goods", "persons", "accounts", "openingInventory"],
        workbookImportScopes: ["goods", "persons", "accounts", "openingInventory", "journal", "journalLines"],
        exportScopes: ["goods", "persons", "accounts"],
        connectedWriteScopes: ["sales", "purchases", "receiptPayment"],
        directSqlWrite: false,
        rollback: true,
      },
    });
  });

  it("pins worksheet layout, relational identities, field types, requiredness, and export defaults", () => {
    const dimensions = profile.sheets.map((sheet) => ({
      scope: sheet.scope,
      sheetName: sheet.sheetName,
      dependencies: sheet.dependencies,
      identityFields: sheet.identityFields,
      importSupported: sheet.importSupported,
      exportSupported: sheet.exportSupported,
      columns: sheet.columns.map((column) => ({
        key: column.key,
        externalName: column.externalName,
        type: column.type,
        required: column.required,
        identity: column.identity ?? false,
        exportDefaultValue: column.exportDefaultValue ?? null,
      })),
    }));

    expect(dimensions).toEqual([
      {
        scope: "goods", sheetName: "Goods", dependencies: [], identityFields: ["Code"], importSupported: true, exportSupported: true,
        columns: [
          { key: "Code", externalName: "Code", type: "text", required: true, identity: true, exportDefaultValue: null },
          { key: "Name", externalName: "Name", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "BarCode", externalName: "BarCode", type: "text", required: false, identity: false, exportDefaultValue: "" },
          { key: "SellPrice", externalName: "SellPrice", type: "money", required: false, identity: false, exportDefaultValue: "" },
          { key: "UnitName", externalName: "UnitName", type: "text", required: false, identity: false, exportDefaultValue: "" },
          { key: "ModifiedDate", externalName: "ModifiedDate", type: "date", required: false, identity: false, exportDefaultValue: "" },
        ],
      },
      {
        scope: "persons", sheetName: "Person", dependencies: [], identityFields: ["Code"], importSupported: true, exportSupported: true,
        columns: [
          { key: "Code", externalName: "Code", type: "text", required: true, identity: true, exportDefaultValue: null },
          { key: "Name", externalName: "Name", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "Tel", externalName: "Tel", type: "phone", required: false, identity: false, exportDefaultValue: "" },
          { key: "Address", externalName: "Address", type: "longtext", required: false, identity: false, exportDefaultValue: "" },
          { key: "IsSupplier", externalName: "IsSupplier", type: "boolean", required: false, identity: false, exportDefaultValue: "0" },
          { key: "ModifiedDate", externalName: "ModifiedDate", type: "date", required: false, identity: false, exportDefaultValue: "" },
        ],
      },
      {
        scope: "accounts", sheetName: "Account", dependencies: [], identityFields: ["Code"], importSupported: true, exportSupported: true,
        columns: [
          { key: "Code", externalName: "Code", type: "text", required: true, identity: true, exportDefaultValue: null },
          { key: "Name", externalName: "Name", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "Nature", externalName: "Nature", type: "text", required: false, identity: false, exportDefaultValue: "" },
          { key: "ParentCode", externalName: "ParentCode", type: "text", required: false, identity: false, exportDefaultValue: "" },
          { key: "ModifiedDate", externalName: "ModifiedDate", type: "date", required: false, identity: false, exportDefaultValue: "" },
        ],
      },
      {
        scope: "sales", sheetName: "Invoice", dependencies: ["goods", "persons"], identityFields: ["Code"], importSupported: false, exportSupported: false,
        columns: [
          { key: "Code", externalName: "Code", type: "text", required: true, identity: true, exportDefaultValue: null },
          { key: "Date", externalName: "Date", type: "date", required: true, identity: false, exportDefaultValue: null },
          { key: "PersonCode", externalName: "PersonCode", type: "text", required: false, identity: false, exportDefaultValue: null },
          { key: "TotalPrice", externalName: "TotalPrice", type: "money", required: true, identity: false, exportDefaultValue: null },
          { key: "ModifiedDate", externalName: "ModifiedDate", type: "date", required: false, identity: false, exportDefaultValue: null },
        ],
      },
      {
        scope: "saleLines", sheetName: "InvoiceItem", dependencies: ["sales", "goods"], identityFields: ["InvoiceCode", "GoodsCode"], importSupported: false, exportSupported: false,
        columns: [
          { key: "InvoiceCode", externalName: "InvoiceCode", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "GoodsCode", externalName: "GoodsCode", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "Quantity", externalName: "Quantity", type: "number", required: true, identity: false, exportDefaultValue: null },
          { key: "TotalPrice", externalName: "TotalPrice", type: "money", required: true, identity: false, exportDefaultValue: null },
        ],
      },
      {
        scope: "purchases", sheetName: "BuyInvoice", dependencies: ["goods", "persons"], identityFields: ["Code"], importSupported: false, exportSupported: false,
        columns: [
          { key: "Code", externalName: "Code", type: "text", required: true, identity: true, exportDefaultValue: null },
          { key: "Date", externalName: "Date", type: "date", required: true, identity: false, exportDefaultValue: null },
          { key: "PersonCode", externalName: "PersonCode", type: "text", required: false, identity: false, exportDefaultValue: null },
          { key: "TotalPrice", externalName: "TotalPrice", type: "money", required: true, identity: false, exportDefaultValue: null },
          { key: "ModifiedDate", externalName: "ModifiedDate", type: "date", required: false, identity: false, exportDefaultValue: null },
        ],
      },
      {
        scope: "receiptPayment", sheetName: "ReceivePay", dependencies: ["persons"], identityFields: ["Code"], importSupported: false, exportSupported: false,
        columns: [
          { key: "Code", externalName: "Code", type: "text", required: true, identity: true, exportDefaultValue: null },
          { key: "Date", externalName: "Date", type: "date", required: true, identity: false, exportDefaultValue: null },
          { key: "PersonCode", externalName: "PersonCode", type: "text", required: false, identity: false, exportDefaultValue: null },
          { key: "Amount", externalName: "Amount", type: "money", required: true, identity: false, exportDefaultValue: null },
          { key: "Type", externalName: "Type", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "ModifiedDate", externalName: "ModifiedDate", type: "date", required: false, identity: false, exportDefaultValue: null },
        ],
      },
      {
        scope: "openingInventory", sheetName: "Stock", dependencies: ["goods"], identityFields: ["Code"], importSupported: true, exportSupported: false,
        columns: [
          { key: "Code", externalName: "Code", type: "text", required: true, identity: true, exportDefaultValue: null },
          { key: "Date", externalName: "Date", type: "date", required: false, identity: false, exportDefaultValue: null },
          { key: "GoodsCode", externalName: "GoodsCode", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "Quantity", externalName: "Quantity", type: "number", required: true, identity: false, exportDefaultValue: null },
          { key: "UnitCost", externalName: "UnitCost", type: "money", required: false, identity: false, exportDefaultValue: null },
          { key: "ModifiedDate", externalName: "ModifiedDate", type: "date", required: false, identity: false, exportDefaultValue: null },
        ],
      },
      {
        scope: "journal", sheetName: "Sanad", dependencies: [], identityFields: ["Code"], importSupported: true, exportSupported: false,
        columns: [
          { key: "Code", externalName: "Code", type: "text", required: true, identity: true, exportDefaultValue: null },
          { key: "Date", externalName: "Date", type: "date", required: true, identity: false, exportDefaultValue: null },
          { key: "Description", externalName: "Description", type: "longtext", required: false, identity: false, exportDefaultValue: null },
          { key: "ModifiedDate", externalName: "ModifiedDate", type: "date", required: false, identity: false, exportDefaultValue: null },
        ],
      },
      {
        scope: "journalLines", sheetName: "SanadRow", dependencies: ["journal"], identityFields: ["SanadCode", "AccountCode"], importSupported: true, exportSupported: false,
        columns: [
          { key: "SanadCode", externalName: "SanadCode", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "AccountCode", externalName: "AccountCode", type: "text", required: true, identity: false, exportDefaultValue: null },
          { key: "Debit", externalName: "Debit", type: "money", required: true, identity: false, exportDefaultValue: null },
          { key: "Credit", externalName: "Credit", type: "money", required: true, identity: false, exportDefaultValue: null },
        ],
      },
    ]);
  });
});
