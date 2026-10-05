/**
 * Issue #799 §10 and §11 — the RFI and submittal domain's pure half: the two
 * status models with their transition rules, the submittal types, and the three
 * small predicates the screens, the assistant and the overdue scan all need
 * (is this RFI overdue, is this submittal waiting on somebody, is this revision
 * still editable).
 *
 * Pure, like `aec.ts`, `aec-boq.ts` and `aec-docs.ts`: the client panels need
 * the same labels and the same rules the service applies, and they must not drag
 * `pg` in with them. Nothing here decides a permission — that is the route's job
 * (§24) — and nothing here talks to a database.
 *
 * ## Two decisions worth reading twice
 *
 *   * **A submittal is a register entry with revisions, exactly like a
 *     drawing.** §11 lists "revision" among the fields to track and its workflow
 *     contains «Revise & Resubmit», which is the loop a site actually spends its
 *     week in. Storing the loop as "overwrite the row" would erase what a
 *     reviewer approved; storing it as a revision chain — `aec_submittals`
 *     → `aec_submittal_revisions`, the same shape as `aec_documents`
 *     → `aec_document_revisions` — keeps every submitted revision frozen with
 *     the decision it received, and makes "Revise & Resubmit" a new row rather
 *     than an edit of history.
 *   * **"Waiting" is derived from a status, never typed.** Three different
 *     screens ask "what is stuck?" (the cockpit KPI, the assistant's
 *     `list_pending_submittals`, the overdue notification scan), and they must
 *     give one answer. `isRfiWaiting` / `isSubmittalWaiting` are that answer.
 */

/* ---------------------------------------------------------------------------
 * RFIs (§10)
 * ------------------------------------------------------------------------ */

export const RFI_STATUSES = ["draft", "open", "answered", "closed", "cancelled"] as const;
export type RfiStatus = (typeof RFI_STATUSES)[number];

/** §10's status list, verbatim in its order. */
export const RFI_STATUS_LABELS: Record<RfiStatus, string> = {
  draft: "پیش‌نویس",
  open: "باز",
  answered: "پاسخ‌داده‌شده",
  closed: "بسته",
  cancelled: "لغوشده",
};

/**
 * §10's chain, with cancellation as the one branch off it. An RFI is raised,
 * answered and closed; it can be withdrawn before it is answered, because an
 * RFI that turned out to be unnecessary is a normal event and hiding it would
 * be worse than recording it.
 */
const RFI_TRANSITIONS: Record<RfiStatus, readonly RfiStatus[]> = {
  draft: ["open", "cancelled"],
  open: ["answered", "cancelled"],
  answered: ["closed"],
  closed: [],
  cancelled: [],
};

export function canTransitionRfi(from: RfiStatus, to: RfiStatus): boolean {
  return RFI_TRANSITIONS[from].includes(to);
}

export function isRfiStatus(value: string): value is RfiStatus {
  return (RFI_STATUSES as readonly string[]).includes(value);
}

/** The question is editable until it is asked; the response until it is closed. */
export function isEditableRfi(status: RfiStatus): boolean {
  return status === "draft";
}

/** §10 — "the system must clearly surface overdue RFIs". */
export function isRfiWaiting(status: RfiStatus): boolean {
  return status === "open";
}

/**
 * Overdue means "open, with a due date that has passed". An answered or closed
 * RFI is never overdue, however late it was: the register records the dates, and
 * calling history overdue only makes the queue useless.
 */
export function isRfiOverdue(
  rfi: { status: RfiStatus; dueDate: string | null },
  today: string,
): boolean {
  return isRfiWaiting(rfi.status) && !!rfi.dueDate && rfi.dueDate < today;
}

/* ---------------------------------------------------------------------------
 * Submittals (§11)
 * ------------------------------------------------------------------------ */

/** §11's submission types, in the issue's order. */
export const SUBMITTAL_TYPES = [
  "shop_drawing",
  "material_submission",
  "sample",
  "method_statement",
  "technical_data",
  "mockup",
  "calculation",
  "other",
] as const;
export type SubmittalType = (typeof SUBMITTAL_TYPES)[number];

export const SUBMITTAL_TYPE_LABELS: Record<SubmittalType, string> = {
  shop_drawing: "نقشهٔ کارگاهی",
  material_submission: "معرفی مصالح",
  sample: "نمونه",
  method_statement: "روش اجرا",
  technical_data: "دادهٔ فنی",
  mockup: "ماکت",
  calculation: "دفترچهٔ محاسبات",
  other: "سایر",
};

export function isSubmittalType(value: string): value is SubmittalType {
  return (SUBMITTAL_TYPES as readonly string[]).includes(value);
}

/**
 * §11's workflow, verbatim: Draft → Submitted → Under Review → Approved →
 * Approved with Comments → Revise & Resubmit → Rejected → Closed.
 *
 * The issue writes it as a line, but it is a tree: a review ends in exactly one
 * of four determinations (the first four of which are listed above), and only
 * then is the submittal closed. Modelling it as a line would let a submittal go
 * from Approved to Rejected.
 */
export const SUBMITTAL_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "approved_with_comments",
  "revise_and_resubmit",
  "rejected",
  "closed",
] as const;
export type SubmittalStatus = (typeof SUBMITTAL_STATUSES)[number];

export const SUBMITTAL_STATUS_LABELS: Record<SubmittalStatus, string> = {
  draft: "پیش‌نویس",
  submitted: "ارسال‌شده",
  under_review: "در حال بررسی",
  approved: "تأییدشده",
  approved_with_comments: "تأییدشده با نظر",
  revise_and_resubmit: "اصلاح و ارسال مجدد",
  rejected: "ردشده",
  closed: "بسته",
};

/** The four ways a review can end (§11's middle four statuses). */
export const SUBMITTAL_DECISIONS = [
  "approved",
  "approved_with_comments",
  "revise_and_resubmit",
  "rejected",
] as const;
export type SubmittalDecision = (typeof SUBMITTAL_DECISIONS)[number];

/**
 * Persian labels for those four, which the reviewer's dialog offers as four
 * buttons. The approvals queue can only express two of them (approve/reject), so
 * it maps onto the pair it can and the finer pair lives on the submittal screen.
 */
export const SUBMITTAL_DECISION_LABELS: Record<SubmittalDecision, string> = {
  approved: "تأیید",
  approved_with_comments: "تأیید با نظر",
  revise_and_resubmit: "اصلاح و ارسال مجدد",
  rejected: "رد",
};

export function isSubmittalDecision(value: string): value is SubmittalDecision {
  return (SUBMITTAL_DECISIONS as readonly string[]).includes(value);
}

const SUBMITTAL_TRANSITIONS: Record<SubmittalStatus, readonly SubmittalStatus[]> = {
  draft: ["submitted"],
  submitted: ["under_review"],
  under_review: SUBMITTAL_DECISIONS,
  // Forward only, like the drawing register: a revise request returns the work
  // to the author as a *new* revision (the service inserts revision n+1 in
  // draft), so the revision the reviewer saw keeps its determination forever and
  // §11's "approval history" is a read rather than a reconstruction. The one
  // move left is withdrawal — a submittal nobody is going to revise is closed.
  revise_and_resubmit: ["closed"],
  approved: ["closed"],
  approved_with_comments: ["closed"],
  rejected: ["closed"],
  closed: [],
};

export function canTransitionSubmittal(from: SubmittalStatus, to: SubmittalStatus): boolean {
  return SUBMITTAL_TRANSITIONS[from].includes(to);
}

export function isSubmittalStatus(value: string): value is SubmittalStatus {
  return (SUBMITTAL_STATUSES as readonly string[]).includes(value);
}

/** Only a draft revision is editable — the rule migration 0198 makes structural. */
export function isEditableSubmittal(status: SubmittalStatus): boolean {
  return status === "draft";
}

/**
 * A revision sitting with a reviewer. §22's «Submittals Waiting» and §23's
 * `list_pending_submittals` both mean this, and so does the overdue scan.
 */
export function isSubmittalWaiting(status: SubmittalStatus): boolean {
  return status === "submitted" || status === "under_review";
}

/**
 * The author's queue: something was sent back and the next revision has not
 * been created yet. The register's latest revision carries this status until
 * somebody adds revision n+1.
 */
export function isSubmittalWithAuthor(status: SubmittalStatus): boolean {
  return status === "revise_and_resubmit";
}

export function isSubmittalOverdue(
  submittal: { status: SubmittalStatus; dueDate: string | null },
  today: string,
): boolean {
  return isSubmittalWaiting(submittal.status) && !!submittal.dueDate && submittal.dueDate < today;
}

/** A decision that closes the review but not the record: it is still closable. */
export function isSubmittalDecided(status: SubmittalStatus): boolean {
  return status === "approved" || status === "approved_with_comments" || status === "rejected";
}
