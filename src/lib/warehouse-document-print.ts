/**
 * The printable «سند انبار» — a warehouse receipt/issue rendered through the
 * platform's own print template engine (`print-template.ts`), so a warehouse
 * voucher prints on the same A4 sheet, with the same business identity, the
 * same Jalali dates and the same money unit as an invoice or a receipt.
 *
 * Issue #923's definition of done says *printable*. That is deliberately not
 * a bespoke layout: `renderPrintTemplate` is the single renderer every print
 * path in the product shares, and adding a second one here would immediately
 * drift from it (font scale, paper margins, Persian digits, the unit label).
 * The warehouse document maps onto the template's model instead:
 *
 *   title    → «رسید انبار» / «حواله انبار» (and «برگشتِ …» when it reverses)
 *   number   → the register's display identity (internal voucher, else external)
 *   customer → the supplier (receipt) or the recipient (issue)
 *   items    → the snapshotted line identity, quantity, unit cost, value
 *   total    → the document's exact carried value
 *
 * The route serves this as `text/html`; the browser's own print dialog turns it
 * into paper or a PDF, which is the platform's cut-sheet path (thermal rolls go
 * through the print agent). No PDF library is introduced: the PDF *is* the
 * printed page.
 *
 * Branch timezone: the sheet's date is the branch's date. `business_date` is
 * already branch-derived by the caller's query, and timestamps render in the
 * location's zone (`timeZone` on the print data, default untouched).
 */
import { query } from "./db";
import {
  builtInTemplate,
  renderPrintTemplate,
  type PrintDocumentData,
  type PrintLine,
} from "./print-template";
import { loadPrintIdentity } from "./printing/identity";
import { formatJalali } from "./jalali";
import { businessDateSql, type WarehouseRegisterFamily } from "./warehouse-document-register";

const TABLES: Record<WarehouseRegisterFamily, { header: string; lines: string; itemJoin: string; name: string }> = {
  fnb: {
    header: "warehouse_documents",
    lines: "warehouse_document_lines",
    itemJoin: "inventory_items",
    name: "item_name",
  },
  retail: {
    header: "retail_warehouse_documents",
    lines: "retail_warehouse_document_lines",
    itemJoin: "items",
    name: "item_name",
  },
};

export interface PrintableWarehouseDocument {
  id: string;
  kind: string;
  locationId: string;
  locationName: string;
  locationTimezone: string;
  supplierName: string | null;
  recipient: string | null;
  documentNumber: string | null;
  internalVoucherNumber: string | null;
  voucherNumber: string | null;
  businessDate: string;
  createdAt: string;
  createdByName: string | null;
  note: string | null;
  reversalReason: string | null;
  isReversal: boolean;
  reversedOfVoucher: string | null;
  totalValueRial: string;
  lines: Array<{
    name: string;
    unit: string | null;
    quantity: string;
    unitCost: string;
    valueRial: string;
    note: string | null;
  }>;
}

/**
 * `bigint` Rial text → the number the print template's money formatter takes.
 * The template model is number-based (it is shared with POS receipts, which are
 * small); a document value beyond 2^53 would lose precision here, which is the
 * same limit every other printed document in the product has.
 */
function toRialNumber(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

const KIND_LABELS: Record<string, string> = {
  receipt: "رسید انبار",
  issue: "حواله انبار",
  disposal: "سند امحا",
  internal_use: "سند مصرف داخلی",
};

export function warehouseDocumentKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? "سند انبار";
}

/**
 * Read one document with everything the sheet shows, or `null` when it is not
 * this business's (the caller authorizes the branch afterwards, using
 * `locationId` from the returned row — the same order the detail route uses).
 */
export async function loadPrintableWarehouseDocument(input: {
  businessId: string;
  documentId: string;
  family: WarehouseRegisterFamily;
}): Promise<PrintableWarehouseDocument | null> {
  const tables = TABLES[input.family];
  const { rows } = await query<{
    id: string;
    kind: string;
    location_id: string;
    location_name: string;
    location_timezone: string;
    supplier_name: string | null;
    recipient: string | null;
    document_number: string | null;
    internal_voucher_number: string | null;
    voucher_number: string | null;
    business_date: string;
    created_at: string;
    created_by_name: string | null;
    note: string | null;
    reversal_reason: string | null;
    is_reversal: boolean;
    reversed_of_voucher: string | null;
    total_value_rial: string;
  }>(
    `SELECT d.id, d.kind::text AS kind, d.location_id, l.name AS location_name, l.timezone AS location_timezone,
            ${input.family === "fnb" ? "COALESCE(p.name, s.name)" : "NULL::text"} AS supplier_name,
            d.recipient, d.document_number, d.internal_voucher_number,
            COALESCE(d.internal_voucher_number, d.document_number) AS voucher_number,
            ${businessDateSql("d", "l")}::text AS business_date,
            d.created_at,
            COALESCE(d.created_by_name, u.full_name) AS created_by_name,
            d.note, d.reversal_reason, d.is_reversal,
            orig.voucher_number AS reversed_of_voucher,
            COALESCE(d.total_value_rial, 0)::text AS total_value_rial
       FROM ${tables.header} d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN users u ON u.id = d.created_by
       ${input.family === "fnb" ? "LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = $1" : ""}
       LEFT JOIN (SELECT id, COALESCE(internal_voucher_number, document_number) AS voucher_number
                    FROM ${tables.header}) orig ON orig.id = d.reversed_of
      WHERE d.id = $2 AND d.business_id = $1`,
    [input.businessId, input.documentId],
  );
  const doc = rows[0];
  if (!doc) return null;

  const { rows: lineRows } = await query<{
    name: string;
    unit: string | null;
    quantity: string;
    unit_cost: string;
    value_rial: string;
    note: string | null;
  }>(
    `SELECT COALESCE(x.${tables.name}, i.name) AS name,
            ${input.family === "fnb" ? "COALESCE(x.item_unit, i.unit)" : "i.tracking::text"} AS unit,
            x.quantity::text AS quantity,
            COALESCE(x.unit_cost, 0)::text AS unit_cost,
            COALESCE(x.value_rial, 0)::text AS value_rial,
            ${input.family === "fnb" ? "x.note" : "NULL::text"} AS note
       FROM ${tables.lines} x
       JOIN ${tables.itemJoin} i ON i.id = x.${input.family === "fnb" ? "inventory_item_id" : "item_id"}
      WHERE x.document_id = $1
      ORDER BY x.${tables.name} NULLS LAST, x.id`,
    [doc.id],
  );

  return {
    id: doc.id,
    kind: doc.kind,
    locationId: doc.location_id,
    locationName: doc.location_name,
    locationTimezone: doc.location_timezone,
    supplierName: doc.supplier_name,
    recipient: doc.recipient,
    documentNumber: doc.document_number,
    internalVoucherNumber: doc.internal_voucher_number,
    voucherNumber: doc.voucher_number,
    businessDate: doc.business_date,
    createdAt: doc.created_at,
    createdByName: doc.created_by_name,
    note: doc.note,
    reversalReason: doc.reversal_reason,
    isReversal: doc.is_reversal,
    reversedOfVoucher: doc.reversed_of_voucher,
    totalValueRial: doc.total_value_rial,
    lines: lineRows.map((line) => ({
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unitCost: line.unit_cost,
      valueRial: line.value_rial,
      note: line.note,
    })),
  };
}

/** The template's data model, filled from a warehouse document. */
export function buildWarehousePrintData(input: {
  document: PrintableWarehouseDocument;
  business: PrintDocumentData["business"];
  unit: PrintDocumentData["unit"];
}): PrintDocumentData {
  const doc = input.document;
  const partyName = doc.kind === "receipt" ? (doc.supplierName ?? null) : (doc.recipient ?? null);
  const lines: PrintLine[] = doc.lines.map((line) => ({
    name: line.unit ? `${line.name} (${line.unit})` : line.name,
    quantity: Number(line.quantity),
    detail: line.note,
    unitPrice: toRialNumber(line.unitCost),
    lineTotal: toRialNumber(line.valueRial),
  }));
  const total = toRialNumber(doc.totalValueRial);
  const title = warehouseDocumentKindLabel(doc.kind);
  const subtitleParts = [doc.locationName];
  if (doc.isReversal) {
    subtitleParts.push(
      doc.reversedOfVoucher ? `برگشتِ سند ${doc.reversedOfVoucher}` : "سند برگشتی",
    );
  }
  return {
    business: input.business,
    title: doc.isReversal ? `${title} (برگشت)` : title,
    number: doc.voucherNumber ?? doc.id.slice(0, 8),
    subtitle: subtitleParts.join(" · "),
    // The document's date is a business *day*, not an instant. It is pinned at
    // noon UTC and formatted in UTC so no branch offset can move it, and the
    // sheet omits the clock — "09:00" would be a time nobody recorded. The
    // day itself is already the branch's (the query derived it with
    // `app_business_date`), so the printed day is the branch's day.
    issuedAt: `${doc.businessDate}T12:00:00Z`,
    timeZone: "UTC",
    showTime: false,
    customer: partyName ? { name: partyName } : null,
    cashierName: doc.createdByName,
    lines,
    subtotal: total,
    discount: 0,
    tax: 0,
    total,
    note: [doc.note, doc.reversalReason].filter(Boolean).join(" — ") || null,
    unit: input.unit,
  };
}

/**
 * Render the sheet. Returns the complete standalone HTML document the browser
 * prints — the same string the print agent would rasterise.
 */
export async function renderWarehouseDocumentHtml(input: {
  businessId: string;
  document: PrintableWarehouseDocument;
}): Promise<string> {
  const identity = await loadPrintIdentity(input.businessId, input.document.locationId);
  const template = builtInTemplate("a4-invoice");
  if (!template) throw new Error("print_template_missing");
  const data = buildWarehousePrintData({
    document: input.document,
    business: {
      name: identity.business.name,
      address: identity.business.address,
      phone: identity.business.phone,
    },
    unit: identity.currencyUnit,
  });
  return renderPrintTemplate(template, data);
}

/** The sheet's suggested filename, so "Save as PDF" is not `document.pdf`. */
export function warehouseDocumentPrintFilename(doc: PrintableWarehouseDocument): string {
  const identity = (doc.voucherNumber ?? doc.id).replace(/[^0-9A-Za-z._-]/g, "-");
  return `warehouse-${doc.kind}-${identity}.pdf`;
}

/** A short, human label for the printed business date (branch-local). */
export function warehouseDocumentDateLabel(doc: PrintableWarehouseDocument): string {
  return formatJalali(doc.businessDate, { withMonthName: true, timeZone: "UTC" });
}
