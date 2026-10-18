/**
 * Issue #1007 — the vocabulary behind «حذف عضو» (hard membership removal).
 *
 * A membership with **no business history** — a wrong person, a test member, a
 * duplicate — can be deleted outright: the row, the login-identity link and the
 * empty personnel file. A membership that has *acted* in the business cannot:
 * orders, shifts, journal entries and the audit trail all attribute their work
 * to it, and every foreign key to `users` is `ON DELETE SET NULL`, so a hard
 * delete would silently orphan "who opened this order" throughout the ledger —
 * exactly why Phase 13 chose offboarding instead of deletion.
 *
 * This module holds the pure half: which flags exist, their Persian labels, and
 * the "does any of them block deletion" predicate. It is deliberately free of
 * `node:crypto` and database imports so the Team screen (a `"use client"`
 * component) can render the same labels the server refuses with — one copy of
 * the catalogue, the arrangement `roles.ts` and `pin-policy.ts` already follow.
 *
 * The DB reads that fill the flags live in `team-service.ts`
 * (`memberHistoryFlags`), and the refusal order (self / last owner / history)
 * lives in `team.ts` (`hardDeleteRefusal`) beside its sibling `checkLastOwner`.
 */

/**
 * Why a member cannot be hard-deleted. One flag per kind of business history
 * the issue names, plus the two the removal itself would destroy something
 * through: payroll money owed to the person, and a personnel file that carries
 * its own financial record (only an *empty* file is deleted with the member).
 */
export interface MemberHistoryFlags {
  /** POS orders the member opened or closed, and payments they received. */
  orders: boolean;
  /** Shifts they worked (or force-closed). */
  shifts: boolean;
  /** Journal entries they posted to the ledger. */
  journal: boolean;
  /** Payroll runs they are on, and advances granted to (or by) them. */
  payroll: boolean;
  /**
   * Audited *business* actions attributed to them. The membership's own
   * account lifecycle (`team.*`) and sign-in security events do not count:
   * those rows are the bookkeeping of an account that is what the delete
   * removes — counting them would make every member undeletable from birth,
   * because creating one writes `team.member_created`.
   */
  audit: boolean;
  /** Their personnel file has financial history (orders, receipts, points…). */
  file: boolean;
}

/** Persian name of each flag — the words the refusal sentence strings together. */
export const MEMBER_HISTORY_LABELS: Record<keyof MemberHistoryFlags, string> = {
  orders: "سفارش‌ها و پرداخت‌های ثبت‌شده",
  shifts: "شیفت‌های کاری",
  journal: "اسناد حسابداری",
  payroll: "سوابق حقوق و دستمزد",
  audit: "فعالیت‌های ثبت‌شده در گزارش حسابرسی",
  file: "سوابق مالیِ پروندهٔ پرسنلی",
};

/** The flag order the UI and the refusal sentence list things in. */
export const MEMBER_HISTORY_KEYS = Object.keys(MEMBER_HISTORY_LABELS) as (keyof MemberHistoryFlags)[];

/** True when any flag blocks a hard delete. */
export function memberHasHistory(history: MemberHistoryFlags): boolean {
  return MEMBER_HISTORY_KEYS.some((key) => history[key]);
}

/** The labels of the flags that are set, in catalogue order. */
export function memberHistoryLabels(history: MemberHistoryFlags): string[] {
  return MEMBER_HISTORY_KEYS.filter((key) => history[key]).map((key) => MEMBER_HISTORY_LABELS[key]);
}
