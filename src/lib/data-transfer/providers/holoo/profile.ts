import { HOLOO_GENERIC_V1 } from "@/lib/integrations/holoo/schema-profile";
import type { DataTransferProviderProfile, ProviderProfileColumn } from "../../types";

function column(
  key: string,
  externalName: string,
  type: ProviderProfileColumn["type"],
  options: Partial<Pick<ProviderProfileColumn, "required" | "identity" | "aliases" | "exportDefaultValue">> = {},
): ProviderProfileColumn {
  return {
    key,
    externalName,
    label: externalName,
    type,
    required: options.required ?? false,
    identity: options.identity ?? false,
    aliases: options.aliases,
    exportDefaultValue: options.exportDefaultValue,
  };
}

function sheet(
  scope: string,
  tableName: string,
  dependencies: readonly string[],
  identityFields: readonly string[],
  columns: readonly ProviderProfileColumn[],
  importSupported = false,
  exportSupported = false,
): DataTransferProviderProfile["sheets"][number] {
  return {
    scope,
    tableName,
    sheetName: tableName,
    dependencies,
    identityFields,
    columns,
    importSupported,
    exportSupported,
  };
}

/**
 * The file-transfer adapter for the repository's internal Holoo v1 contract.
 * It is intentionally versioned and narrow; other editions/layouts are
 * diagnosed as unknown instead of being fuzzily coerced into this profile.
 */
export const HOLOO_DATA_TRANSFER_PROFILE: DataTransferProviderProfile = {
  provider: "holoo",
  profileKey: HOLOO_GENERIC_V1.key,
  profileVersion: HOLOO_GENERIC_V1.profileVersion,
  label: HOLOO_GENERIC_V1.label,
  directions: ["both"],
  sourceFormats: ["xlsx", "connected_sql"],
  dateRepresentation: "native_sql_date",
  moneyRepresentation: "connection_setting",
  sheets: [
    sheet("goods", "Goods", [], ["Code"], [
      column("Code", "Code", "text", { required: true, identity: true }),
      column("Name", "Name", "text", { required: true }),
      column("BarCode", "BarCode", "text", { exportDefaultValue: "" }),
      column("SellPrice", "SellPrice", "money", { exportDefaultValue: "" }),
      column("UnitName", "UnitName", "text", { exportDefaultValue: "" }),
      column("ModifiedDate", "ModifiedDate", "date", { exportDefaultValue: "" }),
    ], true, true),
    sheet("persons", "Person", [], ["Code"], [
      column("Code", "Code", "text", { required: true, identity: true }),
      column("Name", "Name", "text", { required: true }),
      column("Tel", "Tel", "phone", { exportDefaultValue: "" }),
      column("Address", "Address", "longtext", { exportDefaultValue: "" }),
      column("IsSupplier", "IsSupplier", "boolean", { exportDefaultValue: "0" }),
      column("ModifiedDate", "ModifiedDate", "date", { exportDefaultValue: "" }),
    ], true, true),
    sheet("accounts", "Account", [], ["Code"], [
      column("Code", "Code", "text", { required: true, identity: true }),
      column("Name", "Name", "text", { required: true }),
      column("Nature", "Nature", "text", { exportDefaultValue: "" }),
      column("ParentCode", "ParentCode", "text", { exportDefaultValue: "" }),
      column("ModifiedDate", "ModifiedDate", "date", { exportDefaultValue: "" }),
    ], true, true),
    sheet("sales", "Invoice", ["goods", "persons"], ["Code"], [
      column("Code", "Code", "text", { required: true, identity: true }),
      column("Date", "Date", "date", { required: true }),
      column("PersonCode", "PersonCode", "text"),
      column("TotalPrice", "TotalPrice", "money", { required: true }),
      column("ModifiedDate", "ModifiedDate", "date"),
    ]),
    sheet("saleLines", "InvoiceItem", ["sales", "goods"], ["InvoiceCode", "GoodsCode"], [
      column("InvoiceCode", "InvoiceCode", "text", { required: true }),
      column("GoodsCode", "GoodsCode", "text", { required: true }),
      column("Quantity", "Quantity", "number", { required: true }),
      column("TotalPrice", "TotalPrice", "money", { required: true }),
    ]),
    sheet("purchases", "BuyInvoice", ["goods", "persons"], ["Code"], [
      column("Code", "Code", "text", { required: true, identity: true }),
      column("Date", "Date", "date", { required: true }),
      column("PersonCode", "PersonCode", "text"),
      column("TotalPrice", "TotalPrice", "money", { required: true }),
      column("ModifiedDate", "ModifiedDate", "date"),
    ]),
    sheet("receiptPayment", "ReceivePay", ["persons"], ["Code"], [
      column("Code", "Code", "text", { required: true, identity: true }),
      column("Date", "Date", "date", { required: true }),
      column("PersonCode", "PersonCode", "text"),
      column("Amount", "Amount", "money", { required: true }),
      column("Type", "Type", "text", { required: true }),
      column("ModifiedDate", "ModifiedDate", "date"),
    ]),
    sheet("openingInventory", "Stock", ["goods"], ["Code"], [
      column("Code", "Code", "text", { required: true, identity: true }),
      column("Date", "Date", "date"),
      column("GoodsCode", "GoodsCode", "text", { required: true }),
      column("Quantity", "Quantity", "number", { required: true }),
      column("UnitCost", "UnitCost", "money"),
      column("ModifiedDate", "ModifiedDate", "date"),
    ], true),
    sheet("journal", "Sanad", [], ["Code"], [
      column("Code", "Code", "text", { required: true, identity: true }),
      column("Date", "Date", "date", { required: true }),
      column("Description", "Description", "longtext"),
      column("ModifiedDate", "ModifiedDate", "date"),
    ], true),
    sheet("journalLines", "SanadRow", ["journal"], ["SanadCode", "AccountCode"], [
      column("SanadCode", "SanadCode", "text", { required: true }),
      column("AccountCode", "AccountCode", "text", { required: true }),
      column("Debit", "Debit", "money", { required: true }),
      column("Credit", "Credit", "money", { required: true }),
    ], true),
  ],
  capabilities: {
    readScopes: [...HOLOO_GENERIC_V1.capabilities.read],
    workbookImportScopes: [...HOLOO_GENERIC_V1.capabilities.read, "journal", "journalLines"],
    exportScopes: ["goods", "persons", "accounts"],
    connectedWriteScopes: ["sales", "purchases", "receiptPayment"],
    directSqlWrite: false,
    rollback: HOLOO_GENERIC_V1.capabilities.rollback,
  },
  applyService: "src/lib/integrations/holoo/import-service.ts",
};

export function holooTransferSheet(scope: string) {
  return HOLOO_DATA_TRANSFER_PROFILE.sheets.find((entry) => entry.scope === scope) ?? null;
}
