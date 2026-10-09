/**
 * Fiscal opening balances and carry-forward — the pure half (issue #867).
 *
 * An opening set is a reviewed proposal for one fiscal year's starting
 * position. Posting it writes ONE ordinary journal entry, so the journal stays
 * the only ledger. This module decides what a valid set is, and how a carried
 * balance is classified; the database half (`opening-balance-service.ts`)
 * only persists and posts what this module has approved.
 *
 * Rules, in one place:
 *  - Only balance-sheet accounts (asset, liability, equity). Revenue and
 *    expense are the year's result, which the year-end close moves into
 *    retained earnings. Carrying them forward as openings would double count.
 *  - Integer Rial, exactly one side per line.
 *  - An A/R line is an asset account attributed to a customer; an A/P line is a
 *    liability attributed to a supplier. Unattributed A/R or A/P cannot post.
 *  - The set must balance, and a carry-forward must reconcile to the prior
 *    year's closing balance account by account. A difference is a finding,
 *    never something to plug with an «تراز افتتاحیه» line.
 */
import { WELL_KNOWN_CODES } from "./coa-template";

export const OPENING_SET_KINDS = ["opening", "carry_forward"] as const;
export type OpeningSetKind = (typeof OPENING_SET_KINDS)[number];

export const OPENING_SET_STATUSES = ["draft", "in_review", "approved", "posted", "reversed"] as const;
export type OpeningSetStatus = (typeof OPENING_SET_STATUSES)[number];

export const OPENING_PROVENANCES = [
  "gl",
  "cash_bank",
  "ar",
  "ap",
  "cheque",
  "inventory",
  "fixed_asset",
  "equity",
  "other",
] as const;
export type OpeningProvenance = (typeof OPENING_PROVENANCES)[number];

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export const BALANCE_SHEET_TYPES: readonly AccountType[] = ["asset", "liability", "equity"];

export function isBalanceSheetType(type: string): type is "asset" | "liability" | "equity" {
  return (BALANCE_SHEET_TYPES as readonly string[]).includes(type);
}

export interface OpeningLineInput {
  accountId: string;
  accountType: AccountType;
  debit: number;
  credit: number;
  provenance: OpeningProvenance;
  customerId?: string | null;
  supplierId?: string | null;
  sourceRef?: string | null;
}

export type OpeningLineError =
  | "revenue_expense_not_allowed"
  | "invalid_amount"
  | "one_side_per_line"
  | "missing_account"
  | "unknown_provenance"
  | "provenance_account_type_mismatch"
  | "customer_on_non_ar_line"
  | "supplier_on_non_ap_line"
  | "duplicate_unattributed_account";

export interface OpeningLinesValidation {
  errors: OpeningLineError[];
  /** The lines that carry an amount. Zero lines are dropped, as the journal drops them. */
  activeLines: OpeningLineInput[];
}

/** Shape and business rules for one set's lines. Pure: the caller resolves accounts and parties. */
export function validateOpeningLines(lines: OpeningLineInput[]): OpeningLinesValidation {
  const errors = new Set<OpeningLineError>();
  const activeLines = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  const unattributedAccounts = new Set<string>();

  for (const line of activeLines) {
    if (!line.accountId) errors.add("missing_account");
    if (!isBalanceSheetType(line.accountType)) errors.add("revenue_expense_not_allowed");
    if (
      !Number.isSafeInteger(line.debit) ||
      !Number.isSafeInteger(line.credit) ||
      line.debit < 0 ||
      line.credit < 0
    ) {
      errors.add("invalid_amount");
    } else if ((line.debit === 0) === (line.credit === 0)) {
      // Both sides non-zero, or both zero (already filtered above, so only the first).
      errors.add("one_side_per_line");
    }
    if (!(OPENING_PROVENANCES as readonly string[]).includes(line.provenance)) {
      errors.add("unknown_provenance");
    }
    if (line.provenance === "ar" && line.accountType !== "asset") errors.add("provenance_account_type_mismatch");
    if (line.provenance === "ap" && line.accountType !== "liability") errors.add("provenance_account_type_mismatch");
    if (line.customerId && line.provenance !== "ar") errors.add("customer_on_non_ar_line");
    if (line.supplierId && line.provenance !== "ap") errors.add("supplier_on_non_ap_line");

    const attributed = Boolean(line.customerId || line.supplierId);
    if (!attributed && (line.provenance === "ar" || line.provenance === "ap")) {
      // An A/R or A/P account may carry one unattributed remainder, not a
      // second one: two blank lines on the same account are just one balance
      // typed twice, and that is exactly the mistake this rule catches.
      if (unattributedAccounts.has(line.accountId)) errors.add("duplicate_unattributed_account");
      unattributedAccounts.add(line.accountId);
    }
  }
  return { errors: [...errors], activeLines };
}

export interface BalanceTotals {
  totalDebit: number;
  totalCredit: number;
  /** debit − credit; zero means balanced. */
  difference: number;
  balanced: boolean;
}

export function balanceTotals(lines: { debit: number; credit: number }[]): BalanceTotals {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }
  const difference = totalDebit - totalCredit;
  return { totalDebit, totalCredit, difference, balanced: difference === 0 };
}

/**
 * The provenance an account's opening balance is reported under. Derived from
 * the account's well-known code and type, so a carried balance says where it
 * came from without the accountant re-typing it.
 */
export function classifyOpeningProvenance(account: { code: string; type: string }): OpeningProvenance {
  const { code, type } = account;
  if (code === WELL_KNOWN_CODES.accountsReceivable) return "ar";
  if (code === WELL_KNOWN_CODES.accountsPayable) return "ap";
  if (code === WELL_KNOWN_CODES.chequesOnHand || code === WELL_KNOWN_CODES.chequesPayable) return "cheque";
  if (code === WELL_KNOWN_CODES.cash || code === WELL_KNOWN_CODES.bank || code === WELL_KNOWN_CODES.bankClearing) {
    return "cash_bank";
  }
  if (code === WELL_KNOWN_CODES.inventory) return "inventory";
  if (type === "equity") return "equity";
  // Fixed-asset cost and accumulated depreciation live in the 15xx block.
  if (type === "asset" && /^15\d\d$/.test(code)) return "fixed_asset";
  return "gl";
}

export interface PriorCloseBalance {
  accountId: string;
  /** Signed: debit − credit. */
  balance: number;
}

export interface ReconciliationRow {
  accountId: string;
  priorClose: number;
  opening: number;
  difference: number;
}

/**
 * Account-by-account comparison of an opening set against the prior year's
 * closing balances. `reconciled` is true only when every account matches to
 * the Rial. A missing account on either side counts as a zero, which is the
 * honest reading: an account the close did not have is not an opening balance.
 */
export function reconcileToPriorClose(
  priorClose: PriorCloseBalance[],
  opening: { accountId: string; debit: number; credit: number }[],
): { reconciled: boolean; rows: ReconciliationRow[] } {
  const priorByAccount = new Map<string, number>();
  for (const p of priorClose) priorByAccount.set(p.accountId, (priorByAccount.get(p.accountId) ?? 0) + p.balance);

  const openingByAccount = new Map<string, number>();
  for (const l of opening) {
    openingByAccount.set(l.accountId, (openingByAccount.get(l.accountId) ?? 0) + (l.debit - l.credit));
  }

  const accountIds = new Set([...priorByAccount.keys(), ...openingByAccount.keys()]);
  const rows: ReconciliationRow[] = [];
  for (const accountId of accountIds) {
    const priorValue = priorByAccount.get(accountId) ?? 0;
    const openingValue = openingByAccount.get(accountId) ?? 0;
    const difference = openingValue - priorValue;
    if (difference !== 0 || priorValue !== 0) {
      rows.push({ accountId, priorClose: priorValue, opening: openingValue, difference });
    }
  }
  rows.sort((a, b) => a.accountId.localeCompare(b.accountId));
  return { reconciled: rows.every((r) => r.difference === 0), rows };
}

/** Where a set may move next. Anything else is refused before the database is touched. */
const NEXT_STATUSES: Record<OpeningSetStatus, OpeningSetStatus[]> = {
  draft: ["in_review"],
  in_review: ["draft", "approved"],
  approved: ["posted", "draft"],
  posted: ["reversed"],
  reversed: [],
};

export function canMoveOpeningSet(from: OpeningSetStatus, to: OpeningSetStatus): boolean {
  return NEXT_STATUSES[from].includes(to);
}

/** Lines are editable only while the set is a draft. */
export function isOpeningSetEditable(status: OpeningSetStatus): boolean {
  return status === "draft";
}

/** Human-facing Persian labels for every error code, so the UI never shows a raw code. */
export const OPENING_ERROR_MESSAGES: Record<string, string> = {
  opening_would_duplicate_ledger: "پیش از تاریخ مانده افتتاحیه، در دفتر کل گردش ترازنامه‌ای ثبت شده است؛ ثبت دوباره آن مانده را دوبرابر می‌کند. به‌جای مانده افتتاحیه، از اصلاح سند استفاده کنید.",
  carry_forward_not_reversible: "مانده انتقالی سال بعد ثبت دفتری ندارد و برگشت‌پذیر نیست. پیش‌نویس تازه‌ای از روی بستن سال قبل بسازید.",
  revenue_expense_not_allowed: "حساب‌های درآمد و هزینه را نمی‌توان به‌عنوان مانده افتتاحیه ثبت کرد.",
  invalid_amount: "مبلغ‌ها باید عدد صحیح و نامنفی باشند.",
  one_side_per_line: "هر سطر باید فقط بدهکار یا فقط بستانکار باشد.",
  missing_account: "سطری بدون حساب وجود دارد.",
  unknown_provenance: "منبع مانده نامعتبر است.",
  provenance_account_type_mismatch: "منبع مانده با نوع حساب سازگار نیست (حساب دریافتنی دارایی و حساب پرداختنی بدهی است).",
  customer_on_non_ar_line: "فقط سطر حساب دریافتنی می‌تواند به مشتری وصل شود.",
  supplier_on_non_ap_line: "فقط سطر حساب پرداختنی می‌تواند به تأمین‌کننده وصل شود.",
  duplicate_unattributed_account: "برای هر حساب دریافتنی/پرداختنی فقط یک سطر بدون طرف حساب مجاز است.",
  opening_not_balanced: "مجموع بدهکار و بستانکار مانده افتتاحیه برابر نیست.",
  unattributed_party_lines: "برای سطرهای حساب دریافتنی/پرداختنی باید مشتری یا تأمین‌کننده مشخص شود.",
  carry_forward_does_not_reconcile: "مانده افتتاحیه با مانده پایان سال قبل مطابقت ندارد.",
  no_lines: "حداقل یک سطر با مبلغ لازم است.",
};
