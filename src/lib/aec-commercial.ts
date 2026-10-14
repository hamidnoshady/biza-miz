/**
 * Issue #799 §15, §16, §17 and §20 — the commercial half of an AEC project, as
 * a pure catalogue.
 *
 * Four sections of the issue are one domain, and modelling them apart is how
 * construction software ends up with a change order in one module, a
 * certificate in another and two answers to "what is this contract worth now?":
 *
 *   * **§15 variations / change orders** — the formal record of a change the
 *     client asked for (or that the drawings made necessary), from a priced
 *     draft to an implemented instruction.
 *   * **§16 progress measurement and payment certificates** — the periodic
 *     claim: what was done, what is withheld, what is certified.
 *   * **§17 the AEC fields on an execution contract** — advance, retention,
 *     guarantees, the responsible manager.
 *   * **§20 the project's commercial cockpit** — the one screen that adds all
 *     of it up while keeping every figure with the system that owns it.
 *
 * ## Three rules this file exists to state once
 *
 *   * **Approving a variation moves the contract value; it never rewrites the
 *     contract.** §15 is explicit: an approved variation updates the *revised*
 *     contractual value and the forecast, and must **not** rewrite the original
 *     contract amount, the approved BOQ, or an old estimate revision. So the
 *     original value stays where it always was (`workspace_contracts.value_rial`)
 *     and the materialised `aec_contract_commercials.current_value_rial` is the
 *     original plus approved variations — recomputed from the variation rows,
 *     which stay the evidence.
 *   * **The arithmetic of a certificate is stated once.** Gross minus advance
 *     recovery, retention, other deductions and tax is what gets certified.
 *     `certificateTotals` here is the same expression migration 0200's CHECK
 *     enforces, so a live preview and a stored row cannot disagree.
 *   * **Accounting keeps the money that has actually moved.** Nothing here
 *     stores a paid or received balance: the certificate records what was
 *     *certified*, and receipts, payments, A/R and A/P are read from the ledger
 *     by project (`projectReport`), exactly as §20's source-of-truth table
 *     requires.
 *
 * Pure, like `aec-rfi.ts` and `aec-site.ts`: the client panels need the same
 * labels, the same transitions and the same arithmetic the service applies, and
 * they must not drag `pg` in with them. Nothing here decides a permission.
 */

/* ===========================================================================
 * §15 — variations / change orders
 * ======================================================================== */

/** §15's status list, verbatim in its order, plus the one branch off it. */
export const VARIATION_STATUSES = [
  "draft",
  "priced",
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "implemented",
  // §15 does not list a cancellation, and every other register in this module
  // has one: a change that is not going to happen must be *withdrawn and kept*,
  // because the conversation about it is the record. It is reachable only while
  // nobody has decided, and it never moves a contract value.
  "cancelled",
] as const;
export type VariationStatus = (typeof VARIATION_STATUSES)[number];

export const VARIATION_STATUS_LABELS: Record<VariationStatus, string> = {
  draft: "پیش‌نویس",
  priced: "قیمت‌گذاری‌شده",
  submitted: "ارسال‌شده",
  under_review: "در حال بررسی",
  approved: "تأییدشده",
  rejected: "رد‌شده",
  implemented: "اجراشده",
  cancelled: "لغوشده",
};

/**
 * §15's chain: Draft → Priced → Submitted → Under Review → Approved →
 * Implemented, with Rejected available from review and the two loops that are
 * real — a rejected change is normally re-priced and resubmitted, and a
 * submission the client has not looked at yet can be withdrawn to be re-priced.
 */
const VARIATION_TRANSITIONS: Record<VariationStatus, readonly VariationStatus[]> = {
  draft: ["priced", "cancelled"],
  // No way back to draft: a priced order is still editable, so "un-pricing" it
  // would be a move without a meaning.
  priced: ["submitted", "cancelled"],
  submitted: ["under_review", "priced", "cancelled"],
  under_review: ["approved", "rejected", "priced"],
  approved: ["implemented"],
  // A rejected order is not thrown away: the usual next step is to re-price it,
  // which then goes through the chain again. Nothing about the rejection is
  // lost — the event trail keeps it and the round-trip is visible in it.
  rejected: ["priced", "cancelled"],
  implemented: [],
  cancelled: [],
};

export function canTransitionVariation(from: VariationStatus, to: VariationStatus): boolean {
  return VARIATION_TRANSITIONS[from].includes(to);
}

export function isVariationStatus(value: string): value is VariationStatus {
  return (VARIATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Content is editable while the order is still being written or priced. From
 * `submitted` on, what the client was asked is frozen — the service refuses an
 * edit rather than letting a screen change a number somebody already received.
 */
export function isEditableVariation(status: VariationStatus): boolean {
  return status === "draft" || status === "priced";
}

/** An approved or implemented order is part of the contract value. */
export function isApprovedVariation(status: VariationStatus): boolean {
  return status === "approved" || status === "implemented";
}

/** Still moving through the chain — what a "changes in flight" queue lists. */
export function isOpenVariation(status: VariationStatus): boolean {
  return status !== "implemented" && status !== "cancelled";
}

/** §15's "source": where the change came from. Free text would hide the pattern. */
export const VARIATION_SOURCES = [
  "client_instruction",
  "design_change",
  "site_condition",
  "regulatory",
  "omission_correction",
  "other",
] as const;
export type VariationSource = (typeof VARIATION_SOURCES)[number];

export const VARIATION_SOURCE_LABELS: Record<VariationSource, string> = {
  client_instruction: "دستور کارفرما",
  design_change: "تغییر طراحی",
  site_condition: "شرایط کارگاه",
  regulatory: "الزام قانونی یا ضابطه",
  omission_correction: "اصلاح کسری و اشتباه",
  other: "سایر",
};

export function isVariationSource(value: string): value is VariationSource {
  return (VARIATION_SOURCES as readonly string[]).includes(value);
}

/** `VO-001` — «Variation Order», numbered per project by the service. */
export const VARIATION_NUMBER_PREFIX = "VO";

/* ===========================================================================
 * §16 — progress certificates
 * ======================================================================== */

/**
 * The two directions §16 asks for, and the reason one table carries both:
 *
 *   * `application` — a **contractor's payment application**: we did the work
 *     and claim for it. The client (or their consultant) certifies it.
 *   * `certificate` — a **progress certificate we issue**: we are the employer
 *     or the supervising consultant, and we certify what the contractor is owed.
 *
 * They share every field — period, work done, deductions, advance recovery,
 * retention, tax, approval — and differ in who owes whom. Two tables would be
 * two implementations of one subtraction.
 */
export const CERTIFICATE_KINDS = ["application", "certificate"] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];

export const CERTIFICATE_KIND_LABELS: Record<CertificateKind, string> = {
  application: "صورت‌وضعیت پیمانکار",
  certificate: "گواهی کارفرما / مشاور",
};

export function isCertificateKind(value: string): value is CertificateKind {
  return (CERTIFICATE_KINDS as readonly string[]).includes(value);
}

export const CERTIFICATE_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "certified",
  "rejected",
  "cancelled",
] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  draft: "پیش‌نویس",
  submitted: "ارسال‌شده",
  under_review: "در حال بررسی",
  certified: "تأییدشده",
  rejected: "رد‌شده",
  cancelled: "لغوشده",
};

const CERTIFICATE_TRANSITIONS: Record<CertificateStatus, readonly CertificateStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["under_review", "draft", "cancelled"],
  under_review: ["certified", "rejected"],
  // Rejected goes back to draft rather than dead: a claim is re-measured and
  // resubmitted far more often than it is abandoned.
  rejected: ["draft", "cancelled"],
  certified: [],
  cancelled: [],
};

export function canTransitionCertificate(
  from: CertificateStatus,
  to: CertificateStatus,
): boolean {
  return CERTIFICATE_TRANSITIONS[from].includes(to);
}

export function isCertificateStatus(value: string): value is CertificateStatus {
  return (CERTIFICATE_STATUSES as readonly string[]).includes(value);
}

/** Content is editable until the claim is sent. */
export function isEditableCertificate(status: CertificateStatus): boolean {
  return status === "draft";
}

/** Still moving — what "certificates waiting" lists. */
export function isOpenCertificate(status: CertificateStatus): boolean {
  return status !== "certified" && status !== "cancelled";
}

/** `PC-001` — «Payment Certificate», numbered per project by the service. */
export const CERTIFICATE_NUMBER_PREFIX = "PC";

export interface CertificateAmounts {
  /** Value of the work measured in this period, before anything is withheld. */
  grossRial: number;
  /** Advance the client already paid, recovered from this claim. */
  advanceRecoveryRial: number;
  /** §16's retention («حسن انجام کار») withheld from this claim. */
  retentionRial: number;
  /** Any other deduction (delay damages, materials supplied by the client, …). */
  otherDeductionsRial: number;
  /** Tax or levies where they apply to the claim. */
  taxRial: number;
}

/**
 * §16's arithmetic: gross minus advance recovery, retention, other deductions
 * and tax. `netRial` is what the claim asks to be paid, and what certification
 * approves.
 *
 * The same expression is a CHECK constraint in migration 0200, so the panel's
 * live preview and the row the database stores are one calculation. Negative
 * deductions are refused rather than interpreted: a "negative deduction" is an
 * addition, and it belongs in the gross figure where it can be seen.
 */
export function certificateTotals(amounts: CertificateAmounts): {
  netRial: number;
  withheldRial: number;
} {
  const withheld =
    amounts.advanceRecoveryRial +
    amounts.retentionRial +
    amounts.otherDeductionsRial +
    amounts.taxRial;
  return { netRial: amounts.grossRial - withheld, withheldRial: withheld };
}

/**
 * §16's "previous certified": the sum of what this contract's earlier certified
 * claims came to. Derived, never stored — the same rule as every balance in
 * this module, and the reason an edited or cancelled claim cannot leave a stale
 * total behind.
 */
export function previousCertifiedRial(certifiedNets: readonly number[]): number {
  return certifiedNets.reduce((sum, value) => sum + value, 0);
}

/* ===========================================================================
 * The actions each chain offers
 * ---------------------------------------------------------------------------
 * The statuses above are the data; these are the moves a screen offers and the
 * routes gate. They live in this file — pure, like the rest of it — because the
 * panels render the buttons and the routes decide who may press them, and
 * neither should be reading the service to learn the list.
 *
 * Which ones are *determinations* is §24's split, and it is stated here once so
 * the two status routes cannot disagree: writing a change order (`price`,
 * `submit`, `reopen`) is project work, while every act that decides somebody
 * else's numbers (`review`, `approve`, `reject`, `implement`, `cancel`) is an
 * approval and needs `workspace.approve` — a key no role below manager holds by
 * preset.
 * ======================================================================== */

export const VARIATION_ACTIONS = [
  "price",
  "submit",
  "review",
  "approve",
  "reject",
  "implement",
  "cancel",
  "reopen",
] as const;
export type VariationAction = (typeof VARIATION_ACTIONS)[number];

export const VARIATION_ACTION_TARGET: Record<VariationAction, VariationStatus> = {
  price: "priced",
  submit: "submitted",
  review: "under_review",
  approve: "approved",
  reject: "rejected",
  implement: "implemented",
  cancel: "cancelled",
  // A rejected change is normally re-priced: the reopening is the first step of
  // submitting it again, and it is the one transition that deliberately unlocks
  // the frozen content (migration 0200's guard allows exactly this one).
  reopen: "priced",
};

/** Button text, as the panel shows it. */
export const VARIATION_ACTION_LABELS: Record<VariationAction, string> = {
  price: "قیمت‌گذاری",
  submit: "ارسال برای تأیید",
  review: "شروع بررسی",
  approve: "تأیید",
  reject: "رد",
  implement: "ثبت اجرا",
  cancel: "لغو",
  reopen: "بازگشایی برای قیمت‌گذاری",
};

/** The past tense the trail and the activity feed record. */
export const VARIATION_ACTION_PAST_LABELS: Record<VariationAction, string> = {
  price: "قیمت‌گذاری شد",
  submit: "برای تأیید ارسال شد",
  review: "در حال بررسی قرار گرفت",
  approve: "تأیید شد",
  reject: "رد شد",
  implement: "اجرا شد",
  cancel: "لغو شد",
  reopen: "برای قیمت‌گذاری بازگشایی شد",
};

/** The event key each action writes to the commercial trail. */
export const VARIATION_ACTION_EVENTS: Record<VariationAction, string> = {
  price: "priced",
  submit: "submitted",
  review: "review_started",
  approve: "approved",
  reject: "rejected",
  implement: "implemented",
  cancel: "cancelled",
  reopen: "reopened",
};

export function isVariationAction(value: string): value is VariationAction {
  return (VARIATION_ACTIONS as readonly string[]).includes(value);
}

const VARIATION_WRITE_ACTIONS = new Set<VariationAction>(["price", "submit", "reopen"]);

export function variationActionNeedsApproval(action: VariationAction): boolean {
  return !VARIATION_WRITE_ACTIONS.has(action);
}

export const CERTIFICATE_ACTIONS = [
  "submit",
  "review",
  "certify",
  "reject",
  "cancel",
  "reopen",
] as const;
export type CertificateAction = (typeof CERTIFICATE_ACTIONS)[number];

export const CERTIFICATE_ACTION_TARGET: Record<CertificateAction, CertificateStatus> = {
  submit: "submitted",
  review: "under_review",
  certify: "certified",
  reject: "rejected",
  cancel: "cancelled",
  // Back to draft, where the figures are editable again — the way a claim that
  // was measured wrong is corrected (§16's own workflow).
  reopen: "draft",
};

export const CERTIFICATE_ACTION_LABELS: Record<CertificateAction, string> = {
  submit: "ارسال برای تأیید",
  review: "شروع بررسی",
  certify: "صدور گواهی",
  reject: "رد",
  cancel: "لغو",
  reopen: "بازگشت به پیش‌نویس",
};

export const CERTIFICATE_ACTION_PAST_LABELS: Record<CertificateAction, string> = {
  submit: "برای تأیید ارسال شد",
  review: "در حال بررسی قرار گرفت",
  certify: "تأیید شد",
  reject: "رد شد",
  cancel: "لغو شد",
  reopen: "برای اصلاح به پیش‌نویس بازگشت",
};

export const CERTIFICATE_ACTION_EVENTS: Record<CertificateAction, string> = {
  submit: "submitted",
  review: "review_started",
  certify: "certified",
  reject: "rejected",
  cancel: "cancelled",
  reopen: "reopened",
};

export function isCertificateAction(value: string): value is CertificateAction {
  return (CERTIFICATE_ACTIONS as readonly string[]).includes(value);
}

const CERTIFICATE_WRITE_ACTIONS = new Set<CertificateAction>(["submit", "reopen"]);

/**
 * Certification, review and rejection are determinations; submitting a claim is
 * the claimant's own act. `cancel` is a determination too — withdrawing a claim
 * the client is already looking at is not the claimant's alone to do.
 */
export function certificateActionNeedsApproval(action: CertificateAction): boolean {
  return !CERTIFICATE_WRITE_ACTIONS.has(action);
}

/* ===========================================================================
 * §20 — the project's commercial cockpit
 * ======================================================================== */

/**
 * The revised contractual value: the original contract amount plus the approved
 * variations. §15's own rule — the original is never rewritten, the revised
 * value is what it becomes.
 *
 * Exported and pure because three call sites need the same answer (the cockpit
 * card, the commercial read the assistant uses, and the test that proves an
 * approved variation moved the value), and because "add the approved ones up"
 * is exactly the kind of rule that drifts when written three times.
 */
export function revisedContractValueRial(
  originalRial: number,
  approvedVariationRial: readonly number[],
): number {
  return originalRial + approvedVariationRial.reduce((sum, value) => sum + value, 0);
}

/**
 * What is left of an advance: what was paid up front, less what later claims
 * have recovered. Never negative — a claim cannot recover more than was
 * advanced, and the service refuses one that tries.
 */
export function outstandingAdvanceRial(advanceRial: number, recoveredRial: number): number {
  return Math.max(0, advanceRial - recoveredRial);
}

/**
 * Retention held on one side of the contract. Direction matters and is the
 * caller's to state: retention withheld **by the client** on our applications
 * is an asset («حسن انجام کار» receivable); retention withheld **by us** on a
 * contractor's certificate is a liability. One number, two readings, and the
 * cockpit shows them apart rather than netting them into a figure nobody can
 * interpret.
 */
export function retentionTotalRial(amounts: readonly number[]): number {
  return amounts.reduce((sum, value) => sum + value, 0);
}

/* ===========================================================================
 * The capability behind each section
 * ======================================================================== */

/**
 * §24 wants the commercial screens behind a capability, not merely behind a
 * permission: a small architecture office has no progress claims at all, and
 * §18's rule for procurement ("should be able to disable/hide this entire
 * capability") is the same idea applied one wave earlier. These are the three
 * switches Wave 8 turns on in `AEC_LIVE_CAPABILITIES`.
 */
export const COMMERCIAL_CAPABILITY_FOR: Record<"variations" | "certificates" | "cockpit", string> = {
  variations: "variations",
  certificates: "progress_claims",
  cockpit: "financials",
};
