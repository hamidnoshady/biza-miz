/**
 * Phase 27 Wave 10 — the printed repair estimate (pure).
 *
 * A repair estimate is a numbered document the customer reads and signs
 * before work starts, so it renders as plain text — the same shape the
 * receipt pipeline prints — rather than only living in the dashboard.
 */
import { formatMoney, type MoneyUnit } from "./money";
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";

export interface RepairEstimateInput {
  ticketNumber: number;
  itemDescription: string;
  reportedIssue: string | null;
  /** The labour portion of the estimate (Rial, whole). */
  laborCharge: number;
  /** The parts portion of the estimate (Rial, whole). */
  partsCharge: number;
  /** Agreed reduction before VAT (Rial, whole) — issue #795 item 11. */
  discountRial?: number;
  /** VAT at the ticket's own rate (Rial, whole) — issue #795 item 11. */
  vatRial?: number;
  estimatedTotalRial: number;
  todayIso: string;
  customerName?: string | null;
  /** The business's display unit; defaults to Toman for callers that don't know it. */
  unit?: MoneyUnit;
}

/**
 * A customer-facing, signable estimate: ticket number, piece, amount broken
 * out into labour and parts, date, approval line. The breakdown matters — a
 * customer approves a document that says what the work and the parts each
 * cost, not a bare total.
 */
export function renderRepairEstimate(input: RepairEstimateInput): string {
  const unit = input.unit ?? "toman";
  const lines = [
    "───── برآورد هزینهٔ تعمیر ─────",
    `شماره: ${toPersianDigits(String(input.ticketNumber))}`,
    `کالا: ${input.itemDescription}`,
  ];
  if (input.reportedIssue) lines.push(`مشکل اعلامی: ${input.reportedIssue}`);
  if (input.customerName) lines.push(`مشتری: ${input.customerName}`);
  lines.push(`تاریخ: ${toPersianDigits(formatJalali(input.todayIso))}`);
  lines.push("");
  lines.push(`اجرت: ${formatMoney(input.laborCharge, unit)}`);
  lines.push(`قطعات: ${formatMoney(input.partsCharge, unit)}`);
  // The signable document carries the WHOLE financial picture (issue #795
  // item 11): what comes off, what tax adds, and the final payable number.
  if (input.discountRial && input.discountRial > 0) {
    lines.push(`تخفیف: ${formatMoney(input.discountRial, unit)}−`);
  }
  if (input.vatRial != null) {
    lines.push(`مالیات بر ارزش افزوده: ${formatMoney(input.vatRial, unit)}`);
  }
  lines.push(`برآورد کل: ${formatMoney(input.estimatedTotalRial, unit)}`);
  lines.push("");
  lines.push("امضای تأیید مشتری: ____________");
  lines.push("پس از تأیید، کار شروع می‌شود.");
  return lines.join("\n");
}
