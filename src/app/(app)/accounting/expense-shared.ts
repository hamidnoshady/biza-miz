/**
 * The shapes and words the Expenses register shares with its detail panel.
 *
 * Its own module for the same reason every other `*-shared.ts` in this repo
 * exists: the register list, the detail drawer and the reversal state all speak
 * one vocabulary, and a label or a field defined twice is a label that drifts.
 */

import { EXPENSE_SETTLEMENT_LABELS, type ExpenseSettlement } from "@/lib/payables-input";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";

/** Where a row stands in the register (issue #832 §1) — mirrors `ExpenseRegisterStatus`. */
export type ExpenseStatus = "active" | "reversed" | "reversal";

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  active: "فعال",
  reversed: "برگشت خورده",
  reversal: "سند برگشت",
};

/** The register's filter options: «همه» plus the three states. */
export const EXPENSE_STATUS_FILTERS: readonly { value: "" | ExpenseStatus; label: string }[] = [
  { value: "", label: "همهٔ وضعیت‌ها" },
  { value: "active", label: EXPENSE_STATUS_LABELS.active },
  { value: "reversed", label: EXPENSE_STATUS_LABELS.reversed },
  { value: "reversal", label: EXPENSE_STATUS_LABELS.reversal },
];

/** One row of the register — the JSON of `GET /api/ledger/expenses`. */
export interface ExpenseRow {
  id: string;
  reference: string | null;
  expenseDate: string;
  accountCode: string;
  accountName: string;
  paymentAccountCode: string;
  paymentAccountName: string;
  /** Gross Rial that left the payment account. */
  amount: number;
  /** The input-VAT part of `amount`. */
  vatAmount: number;
  netAmount: number;
  vendor: string | null;
  partyId: string | null;
  partyName: string | null;
  locationId: string | null;
  locationName: string | null;
  memo: string;
  createdByName: string | null;
  createdAt: string;
  /** Migration 0177; null both when none was attached and when it was later purged. */
  receiptAssetId: string | null;
  /** Snapshot of the receipt file's name, kept so a purged asset still reads as «حذف شده». */
  receiptFileName: string | null;
  /** Audit F11 — `paid` settled from a cash-shaped account, `credit` owed to a supplier (A/P). */
  settlement?: ExpenseSettlement;
  supplierId?: string | null;
  supplierName?: string | null;
  dueDate?: string | null;
  status: ExpenseStatus;
  reversedAt: string | null;
  reversedByName: string | null;
  reversalExpenseId: string | null;
  reversalReference: string | null;
  reversesExpenseId: string | null;
  reversesExpenseReference: string | null;
  journalEntryId: string | null;
}

export interface ExpenseJournalLine {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

/** `GET /api/ledger/expenses/[id]` — the row plus the entry it posted. */
export interface ExpenseDetailResponse {
  expense: ExpenseRow;
  journalLines: ExpenseJournalLine[];
}

export interface ExpenseListResponse {
  expenses: ExpenseRow[];
  hasMore?: boolean;
  /** `{date}|{created_at}|{id}` — the keyset position the next page starts at. */
  nextCursor?: string | null;
  /** What the same filtered set still owes suppliers, gross. */
  totalOwedAmount?: number;
  totalAmount?: number;
  totalVatAmount?: number;
  totalPaidAmount?: number;
  totalCount?: number;
}

/**
 * What «پرداخت از» shows for one row — the single place that answers it, so the
 * desktop table, the mobile cards and the detail drawer cannot describe the same
 * posting three different ways.
 *
 * A paid row names the account that lost the money. An owed row has no such
 * account: what it did was credit Accounts Payable for a supplier, and printing
 * 2100's code there would read like a payment that never happened — so the row
 * says «پرداخت بعدی», names the supplier, and adds the due date when the
 * accountant recorded one (audit F11).
 */
export function expenseSettlementText(
  row: Pick<ExpenseRow, "paymentAccountCode" | "paymentAccountName" | "settlement" | "supplierName" | "dueDate">,
): string {
  if (row.settlement !== "credit") {
    return `${toPersianDigits(row.paymentAccountCode)} ${row.paymentAccountName}`;
  }
  // `formatJalali` already renders Persian digits; wrapping it again would be a
  // conversion of a conversion.
  const due = row.dueDate ? ` (سررسید ${formatJalali(row.dueDate)})` : "";
  return `${EXPENSE_SETTLEMENT_LABELS.credit} — ${row.supplierName ?? "تأمین‌کننده"}${due}`;
}
