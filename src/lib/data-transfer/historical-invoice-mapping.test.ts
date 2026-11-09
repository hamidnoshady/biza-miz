import { describe, expect, it } from "vitest";
import { mapHistoricalInvoiceRows } from "./historical-invoice-mapping";
import type { ImportMapping } from "./types";

const columns = ["id", "date", "customer", "total", "product", "quantity", "price"];
const mapping: ImportMapping = { columns: [
  { field: "externalInvoiceId", column: 0 }, { field: "invoiceDate", column: 1 },
  { field: "externalCustomerCode", column: 2 }, { field: "total", column: 3 },
  { field: "lineName", column: 4 }, { field: "quantity", column: 5 }, { field: "unitPrice", column: 6 },
] };
const rows = [
  { rowNumber: 2, raw: { id: "00001", date: "۱۴۰۳/۱/۱", customer: "00002", total: "9007199254740993", product: "A", quantity: "1", price: "9007199254740993" } },
  { rowNumber: 3, raw: { id: "00001", date: "", customer: "", total: "", product: "B", quantity: "1", price: "0" } },
];

describe("historical invoice mapping", () => {
  it("preserves original strings and repeated header blanks", () => {
    const before = structuredClone(rows);
    expect(mapHistoricalInvoiceRows(columns, rows, mapping)).toEqual([
      { rowNumber: 2, externalInvoiceId: "00001", invoiceDate: "۱۴۰۳/۱/۱", externalCustomerCode: "00002", total: "9007199254740993", lineName: "A", quantity: "1", unitPrice: "9007199254740993" },
      { rowNumber: 3, externalInvoiceId: "00001", invoiceDate: "", externalCustomerCode: "", total: "", lineName: "B", quantity: "1", unitPrice: "0" },
    ]);
    expect(rows).toEqual(before);
  });
  it("refuses lossy transforms, constants and missing required mappings", () => {
    expect(() => mapHistoricalInvoiceRows(columns, rows, { columns: mapping.columns.map((column) => column.field === "total" ? { ...column, transform: "toman_to_rial" } : column) })).toThrow("unsafe_mapping_transform");
    expect(() => mapHistoricalInvoiceRows(columns, rows, { columns: mapping.columns.map((column) => column.field === "total" ? { ...column, constant: "1" } : column) })).toThrow("unsafe_mapping_transform");
    expect(() => mapHistoricalInvoiceRows(columns, rows, { columns: mapping.columns.filter((column) => column.field !== "total") })).toThrow("missing_required_fields");
  });
  it("rejects ambiguous, out-of-range and unknown column assignments", () => {
    expect(() => mapHistoricalInvoiceRows(["id", "id"], [], mapping)).toThrow("duplicate_source_columns");
    expect(() => mapHistoricalInvoiceRows(columns, rows, { columns: [...mapping.columns, { field: "status", column: 0 }] })).toThrow("invalid_mapping_column");
    expect(() => mapHistoricalInvoiceRows(columns, rows, { columns: [...mapping.columns, { field: "status", column: 100 }] })).toThrow("invalid_mapping_column");
    expect(() => mapHistoricalInvoiceRows(columns, rows, { columns: [...mapping.columns, { field: "unexpected", column: 4 }] })).toThrow("invalid_mapping_field");
  });
  it("does not accept coerced numbers as source text", () => {
    const bad = [{ rowNumber: 2, raw: { ...rows[0].raw, total: 9007199254740993 as unknown as string } }];
    expect(() => mapHistoricalInvoiceRows(columns, bad, mapping)).toThrow("invalid_source_value");
  });
});
