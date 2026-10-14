/**
 * Issue #799 §9 and §12 — the document-control domain's pure half: document
 * types, disciplines, issue purposes, revision and transmittal statuses, the
 * transition rules, and the two small pieces of arithmetic a drawing register
 * needs (what the next revision is called, and whether everybody who must sign
 * for a transmittal has signed).
 *
 * Everything here is data or a small function over it, with no database and no
 * framework, for the same reason `aec.ts` and `aec-boq.ts` are pure: the client
 * panel needs the labels and the same rules the service applies, and it must not
 * drag `pg` in with them.
 *
 * ## Two decisions worth reading twice
 *
 *   * **A discipline is an AEC specialty, not a second vocabulary.** §9's
 *     "discipline" is exactly the set of disciplines a business already declares
 *     in `AEC_SPECIALTIES` (architecture, structural, MEP, surveying, …), so the
 *     labels are imported rather than restated. A second list would be a second
 *     place to forget one.
 *   * **The revision code is a label, the revision number is the order.** A
 *     drawing office writes «01», «A» or «C2» in the title block, and the two
 *     are genuinely different choices; the register keeps both, orders by the
 *     number, and suggests a letter only as a default.
 */

import {
  AEC_SPECIALTY_LABELS,
  isAecSpecialty,
  type AecSpecialty,
} from "./aec";

/* ---------------------------------------------------------------------------
 * The register entry
 * ------------------------------------------------------------------------- */

export const DOCUMENT_TYPES = [
  "drawing",
  "specification",
  "report",
  "calculation",
  "shop_drawing",
  "method_statement",
  "as_built",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  drawing: "نقشه",
  specification: "مشخصات فنی",
  report: "گزارش",
  calculation: "دفترچهٔ محاسبات",
  shop_drawing: "نقشهٔ کارگاهی",
  method_statement: "روش اجرا",
  as_built: "چون‌ساخت (As-Built)",
  other: "سایر",
};

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function isDocumentDiscipline(value: string): boolean {
  return isAecSpecialty(value);
}

/** The label a register row shows for a discipline, falling back to «—». */
export function disciplineLabel(value: string | null): string {
  if (!value || !isAecSpecialty(value)) return "—";
  return AEC_SPECIALTY_LABELS[value];
}

/* ---------------------------------------------------------------------------
 * Issue purposes (§9)
 * ------------------------------------------------------------------------- */

export const ISSUE_PURPOSES = [
  "wip",
  "for_review",
  "for_approval",
  "for_tender",
  "for_construction",
  "as_built",
  "for_information",
] as const;
export type IssuePurpose = (typeof ISSUE_PURPOSES)[number];

/**
 * §9's suggested list, verbatim in its order, with the two labels the issue
 * writes in English expanded rather than transliterated: a drawing that says
 * «جهت اجرا» in the corner is what a site team in Iran reads, not «For
 * Construction».
 */
export const ISSUE_PURPOSE_LABELS: Record<IssuePurpose, string> = {
  wip: "در دست تهیه (WIP)",
  for_review: "جهت بررسی",
  for_approval: "جهت تأیید",
  for_tender: "جهت مناقصه",
  for_construction: "جهت اجرا",
  as_built: "چون‌ساخت",
  for_information: "جهت اطلاع",
};

export function isIssuePurpose(value: string): value is IssuePurpose {
  return (ISSUE_PURPOSES as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------------
 * Revision status
 * ------------------------------------------------------------------------- */

export const REVISION_STATUSES = ["draft", "issued", "superseded"] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const REVISION_STATUS_LABELS: Record<RevisionStatus, string> = {
  draft: "پیش‌نویس",
  issued: "صادرشده",
  superseded: "منسوخ",
};

/**
 * Forward only. `draft → issued` is the issue act; `issued → superseded` is what
 * happens to a revision when the next one is issued. There is deliberately no
 * way back: §9 says an issued revision is immutable, and a revision that should
 * not have gone out is corrected by issuing the next one, which is what a
 * drawing register does with a real mistake.
 */
const REVISION_TRANSITIONS: Record<RevisionStatus, readonly RevisionStatus[]> = {
  draft: ["issued"],
  issued: ["superseded"],
  superseded: [],
};

export function canTransitionRevision(from: RevisionStatus, to: RevisionStatus): boolean {
  return REVISION_TRANSITIONS[from].includes(to);
}

/** Only a draft accepts edits — the rule migration 0197 makes structural. */
export function isEditableRevision(status: RevisionStatus): boolean {
  return status === "draft";
}

export function isRevisionStatus(value: string): value is RevisionStatus {
  return (REVISION_STATUSES as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------------
 * Transmittals (§12)
 * ------------------------------------------------------------------------- */

export const TRANSMITTAL_STATUSES = ["draft", "issued", "acknowledged"] as const;
export type TransmittalStatus = (typeof TRANSMITTAL_STATUSES)[number];

export const TRANSMITTAL_STATUS_LABELS: Record<TransmittalStatus, string> = {
  draft: "پیش‌نویس",
  issued: "صادرشده",
  acknowledged: "رسید تأییدشده",
};

const TRANSMITTAL_TRANSITIONS: Record<TransmittalStatus, readonly TransmittalStatus[]> = {
  draft: ["issued"],
  issued: ["acknowledged"],
  acknowledged: [],
};

export function canTransitionTransmittal(
  from: TransmittalStatus,
  to: TransmittalStatus,
): boolean {
  return TRANSMITTAL_TRANSITIONS[from].includes(to);
}

/**
 * A draft is editable in full, an issued transmittal only through its
 * recipients' acknowledgements, and an acknowledged one not at all.
 */
export function isEditableTransmittal(status: TransmittalStatus): boolean {
  return status === "draft";
}

export function isTransmittalStatus(value: string): value is TransmittalStatus {
  return (TRANSMITTAL_STATUSES as readonly string[]).includes(value);
}

/** The part of a recipient row the acknowledgement rule needs. */
export interface AcknowledgementState {
  requiresAcknowledgement: boolean;
  acknowledgedAt: string | null;
}

/** §12's "acknowledgement/receipt where required", as a count. */
export function pendingAcknowledgements(
  recipients: readonly AcknowledgementState[],
): number {
  return recipients.filter(
    (recipient) => recipient.requiresAcknowledgement && !recipient.acknowledgedAt,
  ).length;
}

/** True when every recipient who must sign has signed. */
export function isFullyAcknowledged(recipients: readonly AcknowledgementState[]): boolean {
  return recipients.length > 0 && pendingAcknowledgements(recipients) === 0;
}

/* ---------------------------------------------------------------------------
 * Revision numbering
 * ------------------------------------------------------------------------- */

/**
 * The default code for the nth revision (1-based): A, B, … Z, AA, AB, …
 *
 * This is only ever a *suggestion* the form starts with. Real registers use
 * numbers, letters, or a client's own convention («C1» for a construction
 * issue), which is why the code is free text in the database and this function
 * never validates what a person typed.
 */
export function revisionCodeFor(revisionNo: number): string {
  if (!Number.isInteger(revisionNo) || revisionNo < 1) return "A";
  let remaining = revisionNo;
  let code = "";
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    code = String.fromCharCode(65 + index) + code;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return code;
}

/** The next revision number of a document, from the numbers already used. */
export function nextRevisionNumber(existing: readonly number[]): number {
  const highest = existing.reduce((max, value) => (value > max ? value : max), 0);
  return highest + 1;
}

/**
 * The next revision code: the sequence's default, unless a previous revision
 * already used it — in which case the sequence keeps advancing until it finds a
 * free one. A register whose codes are «01», «02» simply gets «C» as a starting
 * suggestion and the person overwrites it; the point is never to suggest a code
 * that would collide with an existing row.
 */
export function suggestRevisionCode(existingCodes: readonly string[]): string {
  const used = new Set(existingCodes.map((code) => code.trim().toUpperCase()));
  for (let n = 1; n <= 702; n += 1) {
    const candidate = revisionCodeFor(n);
    if (!used.has(candidate)) return candidate;
  }
  return `R${existingCodes.length + 1}`;
}
