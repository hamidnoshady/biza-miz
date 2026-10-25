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
import { CONDITION_GRADE_LABELS, type ReceiptData, type ReceiptLine } from "../receipt-template";
import { formatJalali } from "../jalali";
import { formatPersianNumericText, toPersianDigits } from "../digits";
import { formatMoney } from "../money";

/**
 * Everything the business identity contributes to a printed page. Loaded
 * server-side per job by `loadPrintBranding()`; the fields a document already
 * carries (a receipt's own business name, its branch address) win, and the
 * branding fills whatever the document does not know.
 */
export interface PrintBranding {
  name?: string | null;
  branchName?: string | null;
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
    const goldParts: string[] = [];
    const goldAttributes = [
      gold.purity ? `عیار ${toPersianDigits(gold.purity)}` : null,
      gold.netWeight ? `${formatPersianNumericText(gold.netWeight, { grouping: false })} گرم` : null,
    ].filter(Boolean);
    if (goldAttributes.length) goldParts.push(goldAttributes.join(" · "));
    goldParts.push(
      `طلا ${formatMoney(gold.metalValue, "toman", { withUnit: false })} · اجرت ${formatMoney(gold.makingCharge, "toman", { withUnit: false })} · سود ${formatMoney(gold.profit, "toman", { withUnit: false })}`,
    );
    parts.push(goldParts.join(" · "));
  }
  if (line.batch) {
    parts.push(line.batch.expiryDate
      ? `${line.batch.batchNumber} · انقضا ${toPersianDigits(formatJalali(line.batch.expiryDate))}`
      : line.batch.batchNumber);
  }
  if (line.serialProvenance) {
    const grade = line.serialProvenance.conditionGrade;
    const label = grade ? CONDITION_GRADE_LABELS[grade] ?? grade : "کالای کارکرده";
    parts.push(`وضعیت ${label}${line.serialProvenance.boxAndPapers ? " · همراه جعبه و مدارک" : " · بدون جعبه و مدارک"}`);
  }
  if (line.serial && !line.vehicle) {
    const warranty = line.serial.warrantyMonths
      ? ` · گارانتی ${toPersianDigits(line.serial.warrantyMonths)} ماهه${line.serial.warrantyEndDate ? ` تا ${toPersianDigits(formatJalali(line.serial.warrantyEndDate))}` : ""}`
      : "";
    parts.push(`سریال ${line.serial.serialNumber}${warranty}`);
  }
  if (line.vehicle) {
    const vehicle = line.vehicle;
    const fields = [
      `شماره موجودی ${vehicle.stockNumber}`,
      vehicle.vin ? `VIN ${vehicle.vin}` : null,
      vehicle.chassisNumber ? `شاسی ${vehicle.chassisNumber}` : null,
      vehicle.plateNumber ? `پلاک ${vehicle.plateNumber}` : null,
    ].filter(Boolean);
    parts.push(fields.join(" · "));
  }
  return parts.length > 0 ? parts.join(" — ") : null;
}

export function receiptToPrintDocument(receipt: ReceiptData, branding: PrintBranding = {}): PrintDocumentData {
  return {
    business: {
      name: receipt.business.name || branding.name || "",
      branchName: branding.branchName ?? null,
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
      branchName: branding.branchName ?? null,
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
