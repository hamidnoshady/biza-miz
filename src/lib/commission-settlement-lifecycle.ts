/**
 * The commission settlement run's lifecycle, as pure rules (issue #869).
 *
 * One table decides which action a status allows, which permission an action
 * needs, and what a payout does to the status. The service enforces it inside
 * the transaction, and the screen reads the same table to decide which buttons
 * to show, so a button can never be offered that the server would refuse.
 *
 *   draft ─calculate─▶ calculated ─review─▶ reviewed ─approve─▶ approved
 *                                                             │ release
 *                                                             ▼
 *   closed ◀─close── partially_paid ◀──payout── payable ◀─────┘
 *                              │                   ▲
 *                              └──payout──▶ paid ──┘ reverse payout (back down)
 *
 * `reject` returns a run to draft before any money has left; `void` ends a run
 * before any money has left. Both release the accruals the run claimed.
 */
import { PERMISSIONS } from "./permissions";

export const COMMISSION_RUN_STATUSES = [
  "draft",
  "calculated",
  "reviewed",
  "approved",
  "payable",
  "partially_paid",
  "paid",
  "closed",
  "voided",
] as const;

export type CommissionRunStatus = (typeof COMMISSION_RUN_STATUSES)[number];

export const COMMISSION_RUN_ACTIONS = [
  "calculate",
  "review",
  "approve",
  "reject",
  "release",
  "void",
  "pay",
  "reverse_payout",
  "close",
] as const;

export type CommissionRunAction = (typeof COMMISSION_RUN_ACTIONS)[number];

/**
 * Policy: a run that has not paid anyone may go back to draft (its lines are
 * purged and its accruals released) so that a reviewer can send it back for
 * correction. Once money has left, it can only be reversed payout by payout.
 */
export const REJECT_TO_DRAFT_ALLOWED = true;

/** The longest free-text note a status change, a payout or a reversal may carry. */
export const MAX_RUN_NOTE_LENGTH = 500;

export const COMMISSION_RUN_STATUS_LABELS: Record<CommissionRunStatus, string> = {
  draft: "پیش‌نویس",
  calculated: "محاسبه‌شده",
  reviewed: "بازبینی‌شده",
  approved: "تأییدشده",
  payable: "آماده پرداخت",
  partially_paid: "پرداخت بخشی",
  paid: "پرداخت‌شده",
  closed: "بسته‌شده",
  voided: "ابطال‌شده",
};

export const COMMISSION_RUN_ACTION_LABELS: Record<CommissionRunAction, string> = {
  calculate: "محاسبهٔ پورسانت‌ها",
  review: "بازبینی",
  approve: "تأیید",
  reject: "بازگشت به پیش‌نویس",
  release: "آزادسازی برای پرداخت",
  void: "ابطال",
  pay: "ثبت پرداخت",
  reverse_payout: "ابطال پرداخت",
  close: "بستن دوره",
};

/** Statuses in which the run still owes its members money (lines exist, the run is not closed or voided). */
export const COMMISSION_RUN_OPEN_STATUSES: readonly CommissionRunStatus[] = [
  "calculated",
  "reviewed",
  "approved",
  "payable",
  "partially_paid",
  "paid",
];

export function isCommissionRunStatus(value: unknown): value is CommissionRunStatus {
  return typeof value === "string" && (COMMISSION_RUN_STATUSES as readonly string[]).includes(value);
}

/** The permission an action needs in a given status. Voiding a run that is still draft or calculated is calculation work; voiding a later one is approval work. */
export function requiredPermissionFor(action: CommissionRunAction, status: CommissionRunStatus): string {
  switch (action) {
    case "calculate":
      return PERMISSIONS.commissionCalculate;
    case "review":
    case "approve":
    case "reject":
      return PERMISSIONS.commissionApprove;
    case "release":
    case "pay":
    case "close":
      return PERMISSIONS.commissionPayout;
    case "reverse_payout":
      return PERMISSIONS.commissionReverse;
    case "void":
      return status === "draft" || status === "calculated"
        ? PERMISSIONS.commissionCalculate
        : PERMISSIONS.commissionApprove;
  }
}

/**
 * Whether the status allows the action at all, ignoring who asks. `paidTotal`
 * is the net amount paid so far (reversals already subtracted).
 */
export function actionAllowedInStatus(
  action: CommissionRunAction,
  status: CommissionRunStatus,
  paidTotal: bigint,
): boolean {
  const nothingPaid = paidTotal === 0n;
  switch (action) {
    case "calculate":
      return status === "draft";
    case "review":
      return status === "calculated";
    case "approve":
      return status === "reviewed";
    case "reject":
      return (
        REJECT_TO_DRAFT_ALLOWED &&
        nothingPaid &&
        (status === "calculated" || status === "reviewed" || status === "approved" || status === "payable")
      );
    case "release":
      return status === "approved";
    case "void":
      return (
        nothingPaid &&
        (status === "draft" ||
          status === "calculated" ||
          status === "reviewed" ||
          status === "approved" ||
          status === "payable")
      );
    case "pay":
      return status === "payable" || status === "partially_paid";
    case "reverse_payout":
      return (status === "partially_paid" || status === "paid") && !nothingPaid;
    case "close":
      return (status === "paid" || status === "partially_paid") && !nothingPaid;
  }
}

/** The actions a person holding `has(permission)` may take on a run in this status, in lifecycle order. */
export function availableRunActions(
  status: CommissionRunStatus,
  paidTotal: bigint,
  has: (permission: string) => boolean,
): CommissionRunAction[] {
  return COMMISSION_RUN_ACTIONS.filter(
    (action) => actionAllowedInStatus(action, status, paidTotal) && has(requiredPermissionFor(action, status)),
  );
}

/**
 * Separation of duties: the person who calculated a run may not approve it.
 * No owner exemption — the owner's own calculation still goes to someone else.
 * A null calculator (the account was removed) cannot be the approver.
 */
export function mayApproveRun(calculatedBy: string | null, actorId: string): boolean {
  return calculatedBy === null || calculatedBy !== actorId;
}

/** The status a run is in once its net paid total is `paidTotal`. Used after a payout and after a reversal alike. */
export function statusForPaidTotal(paidTotal: bigint, commissionTotal: bigint): CommissionRunStatus {
  if (paidTotal <= 0n) return "payable";
  return paidTotal >= commissionTotal ? "paid" : "partially_paid";
}
