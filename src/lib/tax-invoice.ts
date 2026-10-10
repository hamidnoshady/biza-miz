/**
 * Issue #866 — taxpayer e-invoicing (سامانه مودیان): the client-safe pure half.
 *
 * Statuses, the transition table, the register's views, the actions each record
 * offers, and the Persian words for all of them. Framework-free and free of Node
 * imports, so the Accounting screen and the server share one definition.
 *
 * The transition table is also written in SQL (`tax_status_transition_allowed`
 * in migration 0216) and the two are compared in tests. Change one, change both.
 */

export const TAX_KINDS = ["sale", "amendment", "cancellation"] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export const TAX_STATUSES = [
  "prepared",
  "queued",
  "sending",
  "submitted",
  "awaiting_inquiry",
  "accepted",
  "rejected",
  "error",
  "cancelled",
] as const;
export type TaxStatus = (typeof TAX_STATUSES)[number];

export const TAX_ENVIRONMENTS = ["sandbox", "production"] as const;
export type TaxEnvironment = (typeof TAX_ENVIRONMENTS)[number];

/**
 * Every legal status move. Anything not listed is refused — by the service
 * before it writes, and by the database trigger if a bug gets past the service.
 *
 *   prepared → queued → sending → submitted → accepted | rejected
 *   sending → awaiting_inquiry   the request may have reached the authority
 *   sending → queued             it certainly did not; retry after a backoff
 *   awaiting_inquiry → queued    the authority says it never received it, so a
 *                                resend with the same uid is safe
 *   error → queued               an operator asked for another attempt
 *   accepted → cancelled         a cancellation record was accepted
 */
export const TAX_STATUS_TRANSITIONS: Readonly<Record<TaxStatus, readonly TaxStatus[]>> = {
  prepared: ["queued"],
  queued: ["sending"],
  sending: ["submitted", "awaiting_inquiry", "queued", "rejected", "error"],
  submitted: ["accepted", "rejected", "awaiting_inquiry"],
  awaiting_inquiry: ["submitted", "accepted", "rejected", "queued", "error"],
  error: ["queued"],
  accepted: ["cancelled"],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: TaxStatus, to: TaxStatus): boolean {
  return TAX_STATUS_TRANSITIONS[from].includes(to);
}

/** Thrown for an illegal move. The code is what the API returns to the screen. */
export class TaxTransitionError extends Error {
  readonly code = "tax_invalid_transition";
  constructor(
    readonly from: TaxStatus,
    readonly to: TaxStatus,
  ) {
    super(`tax_invalid_transition: ${from} -> ${to}`);
  }
}

export function assertTransition(from: TaxStatus, to: TaxStatus): void {
  if (!canTransition(from, to)) throw new TaxTransitionError(from, to);
}

/**
 * A live record still stands for its document: it is neither rejected nor
 * cancelled. Mirrors the partial unique indexes in migration 0216, which allow
 * one live sale per order and one live correction per accepted record.
 */
export function isLiveStatus(status: TaxStatus): boolean {
  return status !== "rejected" && status !== "cancelled";
}

/** The three views the register opens on — «ارسال‌نشده»، «ارسال‌شده» and «خطا». */
export const TAX_VIEWS = ["unsent", "sent", "error"] as const;
export type TaxView = (typeof TAX_VIEWS)[number];

const VIEW_STATUSES: Readonly<Record<TaxView, readonly TaxStatus[]>> = {
  unsent: ["prepared", "queued"],
  sent: ["sending", "submitted", "awaiting_inquiry", "accepted", "cancelled"],
  error: ["error", "rejected"],
};

export function statusesForView(view: TaxView): readonly TaxStatus[] {
  return VIEW_STATUSES[view];
}

export function viewForStatus(status: TaxStatus): TaxView {
  for (const view of TAX_VIEWS) {
    if (VIEW_STATUSES[view].includes(status)) return view;
  }
  return "sent";
}

/** Records whose outcome is not yet known — the queue the inquiry button drains. */
export const TAX_PENDING_RESULT_STATUSES: readonly TaxStatus[] = ["submitted", "awaiting_inquiry"];

export const TAX_STATUS_LABELS: Readonly<Record<TaxStatus, string>> = {
  prepared: "آماده ارسال",
  queued: "در صف ارسال",
  sending: "در حال ارسال",
  submitted: "ارسال‌شده، در انتظار نتیجه",
  awaiting_inquiry: "در انتظار استعلام",
  accepted: "پذیرفته‌شده",
  rejected: "رد‌شده",
  error: "خطا",
  cancelled: "ابطال‌شده",
};

export const TAX_KIND_LABELS: Readonly<Record<TaxKind, string>> = {
  sale: "صدور",
  amendment: "اصلاح",
  cancellation: "ابطال",
};

export const TAX_VIEW_LABELS: Readonly<Record<TaxView, string>> = {
  unsent: "ارسال‌نشده",
  sent: "ارسال‌شده",
  error: "خطا و رد‌شده",
};

/**
 * «آزمایشی» is said out loud on every record it touches. A sandbox record is
 * accepted by a simulator, not by the tax authority, and must never read like
 * a real receipt.
 */
export const TAX_ENVIRONMENT_LABELS: Readonly<Record<TaxEnvironment, string>> = {
  sandbox: "آزمایشی (بدون ارسال به سازمان)",
  production: "عملیاتی",
};

export function taxStatusTone(status: TaxStatus): "active" | "positive" | "neutral" | "danger" {
  if (status === "accepted") return "positive";
  if (status === "error" || status === "rejected") return "danger";
  if (status === "sending" || status === "submitted" || status === "awaiting_inquiry") return "active";
  return "neutral";
}

/** What an operator can do to one record. The service re-checks each one. */
export type TaxAction = "send" | "inquire" | "retry" | "resubmit" | "amend" | "cancel";

export const TAX_ACTION_LABELS: Readonly<Record<TaxAction, string>> = {
  send: "ارسال",
  inquire: "استعلام",
  retry: "تلاش مجدد",
  resubmit: "صدور مجدد",
  amend: "اصلاح",
  cancel: "ابطال",
};

/**
 * The actions a record offers, from its status and kind alone. A worker's move
 * (`queued`, `sending`) offers nothing: it is already in someone else's hands.
 */
export function availableTaxActions(record: { status: TaxStatus; kind: TaxKind }): TaxAction[] {
  switch (record.status) {
    case "prepared":
      return ["send"];
    case "submitted":
    case "awaiting_inquiry":
      return ["inquire"];
    case "error":
      return ["retry"];
    case "rejected":
      return ["resubmit"];
    case "accepted":
      // Mirrors the service: an accepted cancellation is final, an amendment can
      // be corrected again, and only the sale itself can be withdrawn in full.
      if (record.kind === "cancellation") return [];
      return record.kind === "sale" ? ["amend", "cancel"] : ["amend"];
    default:
      return [];
  }
}

/** The authority's own record number shape: a UUID, sent lower-case. */
export const TAX_UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A reference number is sent to the authority verbatim: letters, digits and dashes. */
export const TAX_REFERENCE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** The thirteen-digit «شناسه کالا/خدمت» every sold product needs before it can be reported. */
export const TAX_ITEM_CODE_PATTERN = /^[0-9]{13}$/;
