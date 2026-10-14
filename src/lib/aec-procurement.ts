/**
 * Issue #799 §18 — procurement, the client-safe half.
 *
 * §18's flow is one chain of documents: Requirement → Material Request → RFQ →
 * Supplier Quotations → Comparison → Approval → Purchase Commitment → Delivery →
 * Invoice/Accounting. This file holds the part of it a screen, a route and the
 * database all have to agree on:
 *
 *   * the three status chains (a request, an RFQ and a commitment) and the
 *     quotation's four states, with their Persian labels;
 *   * `commitmentTotals` — the one place "committed cost" is defined, so the
 *     register, the project cockpit, the widget and the assistant all add the
 *     same rows up;
 *   * `commitmentDelayDays` / `isCommitmentDelayed` — §18's "delay warning" as
 *     one predicate, for the same reason;
 *   * `costForecast` — §20's cost-to-complete, forecast final cost and forecast
 *     margin, **with their basis in the signature**: the forecast is
 *     `actual + committed + the remaining approved estimate`, and it is `null`
 *     rather than zero when there is no approved estimate to forecast from. A
 *     forecast is an assumption; the one thing it must never be is silent about
 *     which one it made.
 *   * the action catalogues and their permission split: writing the register is
 *     `workspace.manage`, and approving, rejecting or cancelling an award is
 *     `workspace.approve` — §24's procurement half of "a high-risk commercial
 *     action must not inherit ordinary edit rights".
 *
 * Framework-free and side-effect-free, like the other five AEC pure modules:
 * no `pg` import, no SQL, no clock.
 */

/* ===========================================================================
 * §18's material request — the requirement
 * ======================================================================== */

export const MATERIAL_REQUEST_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "closed",
  "cancelled",
] as const;
export type MaterialRequestStatus = (typeof MATERIAL_REQUEST_STATUSES)[number];

export const MATERIAL_REQUEST_STATUS_LABELS: Record<MaterialRequestStatus, string> = {
  draft: "پیش‌نویس",
  submitted: "ارسال‌شده",
  approved: "تأییدشده",
  rejected: "رد‌شده",
  closed: "بسته‌شده",
  cancelled: "لغوشده",
};

const MATERIAL_REQUEST_TRANSITIONS: Record<MaterialRequestStatus, readonly MaterialRequestStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "rejected", "cancelled"],
  // An approved request is being procured; it closes when the award is placed,
  // and a request somebody has to revise goes back to draft from `rejected`
  // (the same deliberate reopening a change order has).
  approved: ["closed", "cancelled"],
  rejected: ["draft", "cancelled"],
  closed: [],
  cancelled: [],
};

export function canTransitionMaterialRequest(
  from: MaterialRequestStatus,
  to: MaterialRequestStatus,
): boolean {
  return MATERIAL_REQUEST_TRANSITIONS[from].includes(to);
}

export function isMaterialRequestStatus(value: string): value is MaterialRequestStatus {
  return (MATERIAL_REQUEST_STATUSES as readonly string[]).includes(value);
}

/** A request still being written or revised — the only state its content may change in. */
export function isEditableMaterialRequest(status: MaterialRequestStatus): boolean {
  return status === "draft" || status === "rejected";
}

/** Waiting on somebody: submitted for approval, or approved and being procured. */
export function isOpenMaterialRequest(status: MaterialRequestStatus): boolean {
  return status === "draft" || status === "submitted" || status === "approved";
}

export const MATERIAL_REQUEST_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type MaterialRequestPriority = (typeof MATERIAL_REQUEST_PRIORITIES)[number];

export const MATERIAL_REQUEST_PRIORITY_LABELS: Record<MaterialRequestPriority, string> = {
  low: "کم",
  normal: "عادی",
  high: "زیاد",
  urgent: "فوری",
};

export function isMaterialRequestPriority(value: string): value is MaterialRequestPriority {
  return (MATERIAL_REQUEST_PRIORITIES as readonly string[]).includes(value);
}

export const REQUEST_NUMBER_PREFIX = "MR";

/* ===========================================================================
 * §18's RFQ and the quotations that come back
 * ======================================================================== */

export const RFQ_STATUSES = ["draft", "issued", "closed", "cancelled"] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

export const RFQ_STATUS_LABELS: Record<RfqStatus, string> = {
  draft: "پیش‌نویس",
  issued: "ارسال‌شده به تأمین‌کنندگان",
  closed: "بسته‌شده",
  cancelled: "لغوشده",
};

const RFQ_TRANSITIONS: Record<RfqStatus, readonly RfqStatus[]> = {
  draft: ["issued", "cancelled"],
  // An issued RFQ closes when the award is placed (or when it lapses) and can be
  // cancelled outright; a closed one is history.
  issued: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};

export function canTransitionRfq(from: RfqStatus, to: RfqStatus): boolean {
  return RFQ_TRANSITIONS[from].includes(to);
}

export function isRfqStatus(value: string): value is RfqStatus {
  return (RFQ_STATUSES as readonly string[]).includes(value);
}

export function isEditableRfq(status: RfqStatus): boolean {
  return status === "draft";
}

export function isOpenRfq(status: RfqStatus): boolean {
  return status === "draft" || status === "issued";
}

export const RFQ_NUMBER_PREFIX = "RFQ";

export const QUOTATION_STATUSES = ["received", "shortlisted", "selected", "declined"] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const QUOTATION_STATUS_LABELS: Record<QuotationStatus, string> = {
  received: "دریافت‌شده",
  shortlisted: "در فهرست کوتاه",
  selected: "انتخاب‌شده",
  declined: "رد‌شده",
};

const QUOTATION_TRANSITIONS: Record<QuotationStatus, readonly QuotationStatus[]> = {
  // A quote arrives, is looked at, and either stays in the running or drops out.
  // `declined → received` exists because saying no is reversible while the
  // comparison is still open; `selected` is not — it is what the award was
  // raised from, and an award is frozen from submission.
  received: ["shortlisted", "declined"],
  shortlisted: ["selected", "declined"],
  declined: ["received"],
  selected: [],
};

export function canTransitionQuotation(from: QuotationStatus, to: QuotationStatus): boolean {
  return QUOTATION_TRANSITIONS[from].includes(to);
}

export function isQuotationStatus(value: string): value is QuotationStatus {
  return (QUOTATION_STATUSES as readonly string[]).includes(value);
}

/**
 * A quotation that has been decided on — shortlisted, selected or declined — is
 * the register's record of what a supplier offered, so its figures stop moving.
 * The database says the same thing in `aec_quotation_guard()`.
 *
 * `shortlisted` freezes it too, and deliberately: the comparison sheet is read
 * by the approver the moment a quote is shortlisted, so the figure they are
 * looking at cannot change afterwards.
 */
export function isQuotationDecided(status: QuotationStatus): boolean {
  return status !== "received";
}

/* ===========================================================================
 * §18's commitment — the award, and the money the cockpit counts
 * ======================================================================== */

export const COMMITMENT_KINDS = ["purchase", "subcontract"] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

export const COMMITMENT_KIND_LABELS: Record<CommitmentKind, string> = {
  purchase: "سفارش خرید",
  subcontract: "پیمان جزء",
};

/** One register, two kinds — the number prefix follows the kind. */
export const COMMITMENT_NUMBER_PREFIX: Record<CommitmentKind, string> = {
  purchase: "PO",
  subcontract: "SC",
};

/**
 * The capability each kind needs. The register itself is gated on
 * `procurement`; a *subcontract* award additionally needs `subcontractors`,
 * because a business that has switched subcontractor packages off has no
 * business writing one — the preset already ties the subcontractor participant
 * role to the same switch (Wave 2's rule, extended).
 */
export const COMMITMENT_CAPABILITY_FOR: Record<CommitmentKind, string> = {
  purchase: "procurement",
  subcontract: "subcontractors",
};

export function isCommitmentKind(value: string): value is CommitmentKind {
  return (COMMITMENT_KINDS as readonly string[]).includes(value);
}

export const COMMITMENT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "delivered",
  "closed",
  "cancelled",
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const COMMITMENT_STATUS_LABELS: Record<CommitmentStatus, string> = {
  draft: "پیش‌نویس",
  submitted: "در انتظار تأیید",
  approved: "تعهدشده",
  rejected: "رد‌شده",
  delivered: "تحویل‌شده",
  closed: "تسویه‌شده",
  cancelled: "لغوشده",
};

const COMMITMENT_TRANSITIONS: Record<CommitmentStatus, readonly CommitmentStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "rejected", "cancelled"],
  // Approved is the state that means money is committed. Delivery follows, then
  // the close-out, which is when the invoice and the payment are Accounting's.
  approved: ["delivered", "closed", "cancelled"],
  rejected: ["draft", "cancelled"],
  delivered: ["closed"],
  closed: [],
  cancelled: [],
};

export function canTransitionCommitment(from: CommitmentStatus, to: CommitmentStatus): boolean {
  return COMMITMENT_TRANSITIONS[from].includes(to);
}

export function isCommitmentStatus(value: string): value is CommitmentStatus {
  return (COMMITMENT_STATUSES as readonly string[]).includes(value);
}

export function isEditableCommitment(status: CommitmentStatus): boolean {
  return status === "draft" || status === "rejected";
}

/**
 * Statuses whose money is *committed*: the award has been decided (or the goods
 * have arrived) and the record is not closed out yet. `closed` is deliberately
 * absent — from there the cost is the ledger's (`journal_lines`), and counting
 * it here as well is how a cockpit double-counts the same rial.
 */
export function isCommittedStatus(status: CommitmentStatus): boolean {
  return status === "approved" || status === "delivered";
}

/** Waiting on somebody: being drafted, awaiting approval, or approved and undelivered. */
export function isOpenCommitment(status: CommitmentStatus): boolean {
  return status === "draft" || status === "submitted" || status === "approved";
}

export interface CommitmentTotals {
  /** The value of every commitment whose money is committed (§20's committed cost). */
  committedRial: number;
  /** Of that, the part whose goods have arrived and whose invoice is pending. */
  deliveredRial: number;
  /** Open commitments past their expected delivery date (§18's delay warning). */
  delayedCount: number;
  delayedRial: number;
}

/**
 * §20's "committed cost", defined once.
 *
 * A commitment counts from `approved` — the moment §18's flow calls it a
 * Purchase Commitment — until it is closed out. `cancelled` and `rejected` never
 * count, and a draft or submitted one is a proposal rather than money.
 *
 * The delay half is §18's "delay warning": an approved commitment whose expected
 * delivery date is behind the business's today. `null` dates never delay, which
 * is the same rule the delivery index in migration 0201 encodes.
 */
export function commitmentTotals(
  rows: ReadonlyArray<{
    status: CommitmentStatus;
    valueRial: number;
    expectedDeliveryDate?: string | null;
  }>,
  today: string,
): CommitmentTotals {
  let committedRial = 0;
  let deliveredRial = 0;
  let delayedCount = 0;
  let delayedRial = 0;
  for (const row of rows) {
    if (!isCommittedStatus(row.status)) continue;
    committedRial += row.valueRial;
    if (row.status === "delivered") deliveredRial += row.valueRial;
    const days = commitmentDelayDays(row.expectedDeliveryDate, today);
    if (days !== null && days > 0 && row.status === "approved") {
      delayedCount += 1;
      delayedRial += row.valueRial;
    }
  }
  return { committedRial, deliveredRial, delayedCount, delayedRial };
}

/**
 * How many days late a delivery is, or `null` when the question does not apply
 * (no promised date, or the date has not passed). Negative is "not yet due" —
 * the caller decides whether it cares.
 */
export function commitmentDelayDays(
  expectedDeliveryDate: string | null | undefined,
  today: string,
): number | null {
  if (!expectedDeliveryDate) return null;
  const expected = Date.parse(`${expectedDeliveryDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(expected) || !Number.isFinite(now)) return null;
  return Math.round((now - expected) / 86_400_000);
}

/** §18's "delay warning" as one predicate — the tab, the widget, the tool and the scan share it. */
export function isCommitmentDelayed(
  row: { status: CommitmentStatus; expectedDeliveryDate?: string | null },
  today: string,
): boolean {
  if (row.status !== "approved") return false;
  const days = commitmentDelayDays(row.expectedDeliveryDate, today);
  return days !== null && days > 0;
}

/* ===========================================================================
 * §20's forecast, from the registers that now exist
 * ======================================================================== */

/**
 * The Persian sentence the cockpit prints under the forecast. Exported rather
 * than written in the panel so the screen and the assistant cannot describe the
 * same number two ways.
 */
export const FORECAST_BASIS_LABEL =
  "بر پایهٔ هزینهٔ ثبت‌شده در حسابداری + تعهدات باز + باقی‌ماندهٔ برآورد مصوب";

export interface CostForecast {
  /** What is left to spend against the approved estimate: estimate − actual − committed. */
  costToCompleteRial: number;
  /** Actual + committed + cost to complete. */
  forecastFinalCostRial: number;
}

/**
 * §20's cost to complete and forecast final cost.
 *
 * The method is deliberately the simplest one that uses only numbers the
 * registers actually hold, and it is stated in the UI next to the figure: what
 * has been spent (the ledger), what has been committed (this wave's awards), and
 * whatever is left of the approved estimate covers the rest of the work. It
 * returns `null` — never zero — when there is no approved estimate to forecast
 * against, or when the caller may not read the ledger: a forecast built on a
 * missing half is not a forecast, it is a guess wearing a number.
 */
export function costForecast(input: {
  actualCostRial: number | null;
  committedRial: number;
  approvedEstimateRial: number | null;
}): CostForecast | null {
  const { actualCostRial, committedRial, approvedEstimateRial } = input;
  if (actualCostRial === null || approvedEstimateRial === null) return null;
  const remaining = approvedEstimateRial - actualCostRial - committedRial;
  const costToCompleteRial = Math.max(0, remaining);
  return {
    costToCompleteRial,
    forecastFinalCostRial: actualCostRial + committedRial + costToCompleteRial,
  };
}

/**
 * §20's estimated/forecast margin: the revised contract value less the forecast
 * final cost. `null` when either half is unknown — and it is a *forecast*, which
 * is the word the screen uses: recognised revenue and realised margin are
 * Accounting's, and a report of those is a different number on a different page.
 */
export function forecastMarginRial(
  revisedContractRial: number,
  forecastFinalCostRial: number | null,
): number | null {
  if (forecastFinalCostRial === null) return null;
  return revisedContractRial - forecastFinalCostRial;
}

/* ===========================================================================
 * The acts, and who may take them (§24)
 * ======================================================================== */

export const MATERIAL_REQUEST_ACTIONS = [
  "submit",
  "approve",
  "reject",
  "close",
  "cancel",
  "reopen",
] as const;
export type MaterialRequestAction = (typeof MATERIAL_REQUEST_ACTIONS)[number];

export const MATERIAL_REQUEST_ACTION_TARGET: Record<MaterialRequestAction, MaterialRequestStatus> = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  close: "closed",
  cancel: "cancelled",
  reopen: "draft",
};

export const MATERIAL_REQUEST_ACTION_LABELS: Record<MaterialRequestAction, string> = {
  submit: "ارسال برای تأیید",
  approve: "تأیید درخواست",
  reject: "رد درخواست",
  close: "بستن درخواست",
  cancel: "لغو درخواست",
  reopen: "بازگشت به پیش‌نویس",
};

export const MATERIAL_REQUEST_ACTION_PAST_LABELS: Record<MaterialRequestAction, string> = {
  submit: "ارسال شد",
  approve: "تأیید شد",
  reject: "رد شد",
  close: "بسته شد",
  cancel: "لغو شد",
  reopen: "به پیش‌نویس بازگشت",
};

export const MATERIAL_REQUEST_ACTION_EVENTS: Record<MaterialRequestAction, string> = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  close: "closed",
  cancel: "cancelled",
  reopen: "reopened",
};

export function isMaterialRequestAction(value: string): value is MaterialRequestAction {
  return (MATERIAL_REQUEST_ACTIONS as readonly string[]).includes(value);
}

/**
 * Approving a requirement decides what the firm will go and buy — the first act
 * in §18's flow that spends a decision rather than a keystroke — so it is
 * `workspace.approve`. Closing it after the award is placed is bookkeeping.
 */
export function materialRequestActionNeedsApproval(action: MaterialRequestAction): boolean {
  return action === "approve" || action === "reject";
}

export const RFQ_ACTIONS = ["issue", "close", "cancel"] as const;
export type RfqAction = (typeof RFQ_ACTIONS)[number];

export const RFQ_ACTION_TARGET: Record<RfqAction, RfqStatus> = {
  issue: "issued",
  close: "closed",
  cancel: "cancelled",
};

export const RFQ_ACTION_LABELS: Record<RfqAction, string> = {
  issue: "ارسال به تأمین‌کنندگان",
  close: "بستن استعلام",
  cancel: "لغو استعلام",
};

export const RFQ_ACTION_PAST_LABELS: Record<RfqAction, string> = {
  issue: "به تأمین‌کنندگان ارسال شد",
  close: "بسته شد",
  cancel: "لغو شد",
};

export const RFQ_ACTION_EVENTS: Record<RfqAction, string> = {
  issue: "issued",
  close: "closed",
  cancel: "cancelled",
};

export function isRfqAction(value: string): value is RfqAction {
  return (RFQ_ACTIONS as readonly string[]).includes(value);
}

/**
 * Issuing an RFQ puts the firm in front of suppliers; it is a register act on
 * `workspace.manage`, not a determination — nothing is committed by asking for
 * prices, which is exactly why §18's flow has an approval *after* the comparison.
 */
export function rfqActionNeedsApproval(): boolean {
  return false;
}

export const QUOTATION_ACTIONS = ["shortlist", "select", "decline", "reconsider"] as const;
export type QuotationAction = (typeof QUOTATION_ACTIONS)[number];

export const QUOTATION_ACTION_TARGET: Record<QuotationAction, QuotationStatus> = {
  shortlist: "shortlisted",
  select: "selected",
  decline: "declined",
  reconsider: "received",
};

export const QUOTATION_ACTION_LABELS: Record<QuotationAction, string> = {
  shortlist: "افزودن به فهرست کوتاه",
  select: "انتخاب",
  decline: "رد پیشنهاد",
  reconsider: "بازگشت به بررسی",
};

export const QUOTATION_ACTION_PAST_LABELS: Record<QuotationAction, string> = {
  shortlist: "به فهرست کوتاه اضافه شد",
  select: "انتخاب شد",
  decline: "رد شد",
  reconsider: "به بررسی بازگشت",
};

export const QUOTATION_ACTION_EVENTS: Record<QuotationAction, string> = {
  shortlist: "shortlisted",
  select: "selected",
  decline: "declined",
  reconsider: "updated",
};

export function isQuotationAction(value: string): value is QuotationAction {
  return (QUOTATION_ACTIONS as readonly string[]).includes(value);
}

/**
 * Deciding a quotation is a *register* act: what it records is which offers are
 * still in the running. The selection that spends money is the commitment's
 * approval, and that is where `workspace.approve` sits — so a member who may
 * shortlist three suppliers still cannot award the package.
 */
export function quotationActionNeedsApproval(): boolean {
  return false;
}

export const COMMITMENT_ACTIONS = [
  "submit",
  "approve",
  "reject",
  "deliver",
  "close",
  "cancel",
  "reopen",
] as const;
export type CommitmentAction = (typeof COMMITMENT_ACTIONS)[number];

export const COMMITMENT_ACTION_TARGET: Record<CommitmentAction, CommitmentStatus> = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  deliver: "delivered",
  close: "closed",
  cancel: "cancelled",
  reopen: "draft",
};

export const COMMITMENT_ACTION_LABELS: Record<CommitmentAction, string> = {
  submit: "ارسال برای تأیید",
  approve: "تأیید تعهد",
  reject: "رد تعهد",
  deliver: "ثبت تحویل کامل",
  close: "بستن (تسویه در حسابداری)",
  cancel: "لغو تعهد",
  reopen: "بازگشت به پیش‌نویس",
};

export const COMMITMENT_ACTION_PAST_LABELS: Record<CommitmentAction, string> = {
  submit: "ارسال شد",
  approve: "تأیید شد",
  reject: "رد شد",
  deliver: "تحویل شد",
  close: "بسته شد",
  cancel: "لغو شد",
  reopen: "به پیش‌نویس بازگشت",
};

export const COMMITMENT_ACTION_EVENTS: Record<CommitmentAction, string> = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  deliver: "delivered",
  close: "closed",
  cancel: "cancelled",
  reopen: "reopened",
};

export function isCommitmentAction(value: string): value is CommitmentAction {
  return (COMMITMENT_ACTIONS as readonly string[]).includes(value);
}

/**
 * §24 — the award is the high-risk act in this wave: it commits money to a
 * supplier or a subcontractor. Approving, rejecting and cancelling it are
 * determinations on `workspace.approve`; preparing it, recording the delivery,
 * closing it out and reopening a rejected one are `workspace.manage`.
 *
 * `cancel` is in the first group deliberately: cancelling an approved award
 * releases committed money, which is the same class of decision as committing
 * it in the first place.
 */
export function commitmentActionNeedsApproval(action: CommitmentAction): boolean {
  return action === "approve" || action === "reject" || action === "cancel";
}
