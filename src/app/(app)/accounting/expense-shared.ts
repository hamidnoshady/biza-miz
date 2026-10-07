/**
 * The shapes and words the Expenses register shares with its detail panel.
 *
 * Its own module for the same reason every other `*-shared.ts` in this repo
 * exists: the register list, the detail drawer and the reversal state all speak
 * one vocabulary, and a label or a field defined twice is a label that drifts.
 */

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
  totalAmount?: number;
  totalVatAmount?: number;
  totalPaidAmount?: number;
  totalCount?: number;
}
