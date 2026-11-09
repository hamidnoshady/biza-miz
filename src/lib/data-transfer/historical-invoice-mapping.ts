/**
 * Column mapping for document-shaped historical imports. This deliberately
 * bypasses the generic row coercer: money and identifiers must remain strings
 * until the exact-Rial document validator has examined the entire group.
 */
import type { ColumnMapping, ImportMapping } from "./types";
import type { HistoricalInvoiceRow } from "./historical-invoice-preview";

export const HISTORICAL_INVOICE_FIELDS = [
  "externalInvoiceId", "invoiceNumber", "invoiceDate", "externalCustomerCode", "sourceCustomerName", "sourceCustomerPhone", "sourceBranch", "currency",
  "total", "paid", "balance", "invoiceDiscount", "invoiceTax", "status", "paymentDetails", "reference",
  "lineName", "lineSku", "lineBarcode", "quantity", "unitPrice", "lineDiscount", "lineTax",
] as const;

const REQUIRED_FIELDS = ["externalInvoiceId", "invoiceDate", "externalCustomerCode", "total"] as const;
const fields = new Set<string>(HISTORICAL_INVOICE_FIELDS);

export class HistoricalMappingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HistoricalMappingError";
  }
}

/** A stored Data Transfer source row, still in its original text form. */
export interface HistoricalRawRow {
  rowNumber: number;
  raw: Record<string, string>;
}

/**
 * Validate an operator-reviewed mapping and map every row without numeric
 * coercion, auto-identification, rounding, or database writes. Constants and
 * numeric transforms are deliberately forbidden for financial evidence.
 */
export function mapHistoricalInvoiceRows(
  columns: readonly string[],
  rows: readonly HistoricalRawRow[],
  mapping: ImportMapping,
): HistoricalInvoiceRow[] {
  if (!mapping || !Array.isArray(mapping.columns)) throw new HistoricalMappingError("invalid_mapping");
  const rawKeys = columns.map((column, index) => column || `ستون ${index + 1}`);
  if (new Set(rawKeys).size !== rawKeys.length) throw new HistoricalMappingError("duplicate_source_columns");
  const usedFields = new Set<string>();
  const usedColumns = new Set<number>();
  for (const entry of mapping.columns as ColumnMapping[]) {
    if (!entry || !fields.has(entry.field) || usedFields.has(entry.field)) throw new HistoricalMappingError("invalid_mapping_field");
    if (!Number.isInteger(entry.column) || entry.column < 0 || entry.column >= columns.length || usedColumns.has(entry.column)) {
      throw new HistoricalMappingError("invalid_mapping_column");
    }
    if (entry.constant !== undefined || (entry.transform !== undefined && entry.transform !== "none" && entry.transform !== "trim")) {
      throw new HistoricalMappingError("unsafe_mapping_transform");
    }
    usedFields.add(entry.field);
    usedColumns.add(entry.column);
  }
  if (REQUIRED_FIELDS.some((field) => !usedFields.has(field))) throw new HistoricalMappingError("missing_required_fields");
  return rows.map(({ rowNumber, raw }) => {
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HistoricalMappingError("invalid_source_row");
    }
    const result: Record<string, string | number> = { rowNumber };
    for (const entry of mapping.columns) {
      const value = raw[rawKeys[entry.column]] ?? "";
      if (typeof value !== "string") throw new HistoricalMappingError("invalid_source_value");
      result[entry.field] = entry.transform === "trim" ? value.trim() : value;
    }
    return result as unknown as HistoricalInvoiceRow;
  });
}
