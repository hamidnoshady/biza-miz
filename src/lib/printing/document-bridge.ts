/**
 * Turns the documents the till already builds (receipts, kitchen tickets,
 * labels) into the one print-template data model. Operational printing
 * renders that model — the same function the designer preview uses, filled
 * with the same branding the server resolved for the branch.
 *
 * The bridges are pure and take the resolved `PrintBranding` as an argument:
 * no bridge reaches for a business identity of its own, which is what used to
 * let a preview show a logo and a legal footer that production printing
 * silently dropped.
 */
import type { KitchenTicketData } from "../kitchen-ticket-template";
import type { LabelData } from "../label-template";
import type { PrintDocumentData } from "../print-template";
import type { ReceiptData, ReceiptLine } from "../receipt-template";
import { formatMoney } from "../money";

/**
 * Everything the business identity contributes to a printed page. Loaded
 * server-side per job by `loadPrintBranding()`; the fields a document already
 * carries (a receipt's own business name, its branch address) win, and the
 * branding fills whatever the document does not know.
 */
export interface PrintBranding {
  name?: string | null;
  legalName?: string | null;
  address?: string | null;
  phone?: string | null;
  taxId?: string | null;
  email?: string | null;
  website?: string | null;
  footer?: string | null;
  logoDataUrl?: string | null;
}

function lineDetail(line: ReceiptLine): string | null {
  const parts: string[] = [];
  if (line.modifiersLabel) parts.push(line.modifiersLabel);
  if (line.goldBreakdown) {
    const gold = line.goldBreakdown;
    parts.push(
      `طلا ${formatMoney(gold.metalValue, "toman", { withUnit: false })} · اجرت ${formatMoney(gold.makingCharge, "toman", { withUnit: false })} · سود ${formatMoney(gold.profit, "toman", { withUnit: false })}`,
    );
  }
  if (line.batch) {
    parts.push(line.batch.expiryDate ? `${line.batch.batchNumber} · ${line.batch.expiryDate}` : line.batch.batchNumber);
  }
  if (line.serialProvenance) {
    const grade = line.serialProvenance.conditionGrade;
    parts.push(grade ? `وضعیت ${grade}` : "کالای کارکرده");
    if (line.serialProvenance.boxAndPapers) parts.push("با جعبه و مدارک");
  }
  return parts.length > 0 ? parts.join(" — ") : null;
}

export function receiptToPrintDocument(receipt: ReceiptData, branding: PrintBranding = {}): PrintDocumentData {
  return {
    business: {
      name: receipt.business.name || branding.name || "",
      legalName: branding.legalName ?? null,
      address: receipt.business.address ?? branding.address ?? null,
      phone: receipt.business.phone ?? branding.phone ?? null,
      taxId: branding.taxId ?? null,
      email: branding.email ?? null,
      website: branding.website ?? null,
      logoDataUrl: branding.logoDataUrl ?? null,
    },
    title: receipt.orderTypeLabel,
    number: receipt.orderLabel,
    subtitle: receipt.orderTypeLabel,
    issuedAt: receipt.issuedAt,
    customer: receipt.customerName ? { name: receipt.customerName } : null,
    cashierName: receipt.cashierName ?? null,
    lines: receipt.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      detail: lineDetail(line),
      lineTotal: line.lineTotal,
    })),
    subtotal: receipt.subtotal,
    discount: receipt.discount,
    tax: receipt.tax,
    total: receipt.total,
    tip: receipt.tip,
    payments: receipt.payments ?? null,
    footer: receipt.business.footerMessage?.trim() || branding.footer?.trim() || null,
    unit: receipt.unit,
  };
}

/**
 * A kitchen ticket as a template document. It carries the same identity a
 * receipt does — a ticket with no business name is a ticket two nearby
 * kitchens cannot tell apart — so the branch's own resolver supplies it.
 */
export function kitchenToPrintDocument(ticket: KitchenTicketData, branding: PrintBranding = {}): PrintDocumentData {
  return {
    business: {
      name: branding.name || "",
      legalName: branding.legalName ?? null,
      address: branding.address ?? null,
      phone: branding.phone ?? null,
      taxId: branding.taxId ?? null,
      website: branding.website ?? null,
      logoDataUrl: branding.logoDataUrl ?? null,
    },
    title: ticket.label,
    number: ticket.label,
    subtitle: ticket.orderTypeLabel,
    issuedAt: ticket.sentAt,
    lines: ticket.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      detail: [line.modifiersLabel, line.note].filter(Boolean).join(" — ") || null,
      lineTotal: 0,
    })),
    subtotal: 0,
    discount: 0,
    tax: 0,
    total: 0,
    note: ticket.orderNote ?? null,
  };
}

/**
 * A shelf/stock label as a template document — the general model's `label`
 * document type. The unified renderer draws it (business name, item name,
 * the trade's fields, real scannable bars), so a label template the shop
 * designed in «قالبها» is the one that prints; the label job no longer
 * bypasses the template pipeline with its own hand-written HTML.
 */
export function labelToPrintDocument(label: LabelData, branding: PrintBranding = {}): PrintDocumentData {
  return {
    business: {
      name: label.businessName || branding.name || "",
      logoDataUrl: branding.logoDataUrl ?? null,
    },
    title: label.itemName,
    number: label.code,
    barcodeValue: label.code,
    issuedAt: new Date(),
    lines: [],
    subtotal: 0,
    discount: 0,
    tax: 0,
    total: 0,
    labelFields: label.fields,
  };
}
