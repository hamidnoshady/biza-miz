/**
 * §A's client briefs — what the client actually asked for, written down before
 * anybody prices it or builds it.
 *
 * This module is the *pure* half of the feature: vocabularies, the status chain
 * and the normalisation of whatever an HTTP body hands us. It imports nothing but
 * types and §E's format vocabulary, so it is safe to import from a client
 * component. The half that talks to Postgres lives in `agency-brief-service.ts`,
 * and the two are kept apart for the same reason `media-review.ts` and
 * `media-review-service.ts` are: a panel that imports the service drags `pg` into
 * the browser bundle.
 *
 * Every rule here has a matching constraint in `0274_agency_client_briefs.sql`.
 * That duplication is deliberate and it is not drift-prone in the way it looks:
 * the database decides what is *possible* and this module decides what is
 * *offered*, so a refusal reaches the member as a Persian sentence from here and
 * as a `23514` from there. If the two ever disagree, the database wins and the
 * integration suite says so.
 */

import { isAgencyMediaFormat, type AgencyMediaFormat } from "./media-review";

// ---------------------------------------------------------------------------
// Status and the chain between them
// ---------------------------------------------------------------------------

export const AGENCY_BRIEF_STATUSES = [
  "draft",
  "sent",
  "confirmed",
  "superseded",
  "withdrawn",
] as const;

export type AgencyBriefStatus = (typeof AGENCY_BRIEF_STATUSES)[number];

export const AGENCY_BRIEF_ACTIONS = [
  "send",
  "withdraw",
  "confirm",
  "supersede",
  "reopen",
] as const;

export type AgencyBriefAction = (typeof AGENCY_BRIEF_ACTIONS)[number];

export const AGENCY_BRIEF_STATUS_LABELS: Record<AgencyBriefStatus, string> = {
  draft: "پیش‌نویس",
  sent: "ارسال‌شده به کارفرما",
  confirmed: "تأییدشده",
  superseded: "جایگزین‌شده",
  withdrawn: "کنارگذاشته",
};

export const AGENCY_BRIEF_STATUS_TONES: Record<
  AgencyBriefStatus,
  "active" | "positive" | "neutral" | "danger"
> = {
  draft: "neutral",
  sent: "active",
  confirmed: "positive",
  superseded: "neutral",
  withdrawn: "danger",
};

export const AGENCY_BRIEF_ACTION_LABELS: Record<AgencyBriefAction, string> = {
  send: "ارسال به کارفرما",
  withdraw: "کنارگذاشتن",
  confirm: "ثبت تأیید کارفرما",
  supersede: "جایگزینی با بریف تازه",
  reopen: "بازگرداندن به پیش‌نویس",
};

/**
 * Where each status can go next.
 *
 * `withdrawn` may return to `draft` and nothing else may go backwards: a brief
 * that was merely taken back before anyone confirmed it was never a fact about
 * the client, so reopening it costs nothing and saves a number. A brief the
 * client *confirmed* cannot be reopened, un-confirmed or edited — the only move
 * left is `superseded`, which is how a correction keeps the trail the original
 * confirmation deserves.
 */
const AGENCY_BRIEF_TRANSITIONS: Record<AgencyBriefStatus, readonly AgencyBriefStatus[]> = {
  draft: ["sent", "withdrawn"],
  sent: ["confirmed", "withdrawn"],
  confirmed: ["superseded"],
  superseded: [],
  withdrawn: ["draft"],
};

/** The status an action moves a brief to. */
const AGENCY_BRIEF_ACTION_TARGETS: Record<AgencyBriefAction, AgencyBriefStatus> = {
  send: "sent",
  withdraw: "withdrawn",
  confirm: "confirmed",
  supersede: "superseded",
  reopen: "draft",
};

export function isAgencyBriefStatus(value: unknown): value is AgencyBriefStatus {
  return typeof value === "string" && (AGENCY_BRIEF_STATUSES as readonly string[]).includes(value);
}

export function isAgencyBriefAction(value: unknown): value is AgencyBriefAction {
  return typeof value === "string" && (AGENCY_BRIEF_ACTIONS as readonly string[]).includes(value);
}

export function agencyBriefActionTarget(action: AgencyBriefAction): AgencyBriefStatus {
  return AGENCY_BRIEF_ACTION_TARGETS[action];
}

export function canTransitionAgencyBrief(
  from: AgencyBriefStatus,
  to: AgencyBriefStatus,
): boolean {
  return AGENCY_BRIEF_TRANSITIONS[from].includes(to);
}

export function canPerformAgencyBriefAction(
  status: AgencyBriefStatus,
  action: AgencyBriefAction,
): boolean {
  return canTransitionAgencyBrief(status, AGENCY_BRIEF_ACTION_TARGETS[action]);
}

/**
 * The actions a brief in this status accepts, in the order the panel renders
 * them.
 *
 * The UI is rendered from this list rather than from the status, so a button can
 * never appear that the route would refuse. That is §E's decision 30 applied
 * here: two sides of one contract, and the member-facing side is derived.
 */
export function agencyBriefActionsFrom(status: AgencyBriefStatus): AgencyBriefAction[] {
  return AGENCY_BRIEF_ACTIONS.filter((action) => canPerformAgencyBriefAction(status, action));
}

/**
 * Whether a brief's substance is frozen.
 *
 * `sent` is deliberately not frozen — the client has been shown it but has not
 * agreed to it, and correcting a draft before anyone relies on it is ordinary
 * work. From `confirmed` onwards the substance is history: a proposal priced it
 * and a project may be delivering against it. The pointer to that project is
 * *not* part of the substance and stays writable, because it is normally written
 * after confirmation.
 */
export function isAgencyBriefFrozen(status: AgencyBriefStatus): boolean {
  return status === "confirmed" || status === "superseded";
}

/** Whether a brief is still live work rather than a closed record. */
export function isAgencyBriefOpen(status: AgencyBriefStatus): boolean {
  return status === "draft" || status === "sent";
}

/** Only a draft may be deleted; anything the client saw is a record. */
export function isAgencyBriefDeletable(status: AgencyBriefStatus): boolean {
  return status === "draft";
}

/**
 * Whether the objective must be filled in.
 *
 * Mirrors `agency_client_briefs_objective_check`: sending a client a brief with
 * no objective asks them to confirm nothing, so the requirement starts at `sent`
 * rather than at `draft`. A draft may be empty — being half-written is what a
 * draft is for.
 */
export function agencyBriefObjectiveRequired(status: AgencyBriefStatus): boolean {
  return status === "sent" || status === "confirmed" || status === "superseded";
}

/**
 * Whether confirming this brief needs a name attached.
 *
 * §A asks that the stakeholder/approver be recorded. A confirmation nobody is
 * attributed to is an assertion, not a record, so the service refuses one without
 * a name — which is also what the database's own CHECK demands.
 */
export function agencyBriefConfirmationNeedsName(action: AgencyBriefAction): boolean {
  return action === "confirm";
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Where the client wants the work to appear.
 *
 * A vocabulary rather than free text, and a modest one: the point is that "which
 * briefs are for outdoor?" is answerable, and that a proposal can be built from
 * the same list. Keys are stable identifiers; the Persian labels are what members
 * see. Anything a particular agency calls a channel that is not here goes in
 * `other` plus the brief's note, which is a smaller cost than a migration.
 */
export const AGENCY_BRIEF_CHANNELS = [
  "social",
  "search",
  "display",
  "outdoor",
  "print",
  "broadcast",
  "influencer",
  "event",
  "pr",
  "email",
  "content",
  "other",
] as const;

export type AgencyBriefChannel = (typeof AGENCY_BRIEF_CHANNELS)[number];

export const AGENCY_BRIEF_CHANNEL_LABELS: Record<AgencyBriefChannel, string> = {
  social: "شبکه‌های اجتماعی",
  search: "جست‌وجو",
  display: "بنر و نمایش",
  outdoor: "تبلیغات محیطی",
  print: "چاپ",
  broadcast: "رادیو و تلویزیون",
  influencer: "اینفلوئنسر",
  event: "رویداد",
  pr: "روابط عمومی",
  email: "ایمیل",
  content: "محتوا",
  other: "سایر",
};

/** A brief naming more channels than this is not a brief, it is a wish list. */
export const AGENCY_BRIEF_CHANNEL_LIMIT = 12;

export function isAgencyBriefChannel(value: unknown): value is AgencyBriefChannel {
  return (
    typeof value === "string" && (AGENCY_BRIEF_CHANNELS as readonly string[]).includes(value)
  );
}

export function agencyBriefChannelLabel(channel: AgencyBriefChannel): string {
  return AGENCY_BRIEF_CHANNEL_LABELS[channel];
}

/**
 * Normalise a request body's channels, or return `null` if they are not usable.
 *
 * `null` is the interesting case: it means the caller should refuse the write
 * with `invalid_channel` rather than quietly dropping a key nobody recognises. A
 * typo that vanished would leave the brief describing less than the client asked
 * for, and nobody would ever know.
 */
export function normalizeAgencyBriefChannels(input: unknown): AgencyBriefChannel[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > AGENCY_BRIEF_CHANNEL_LIMIT) return null;
  const seen = new Set<AgencyBriefChannel>();
  for (const entry of input) {
    if (!isAgencyBriefChannel(entry)) return null;
    seen.add(entry);
  }
  // Vocabulary order, not the caller's: two briefs asking for the same channels
  // then compare equal, and the array never grows as it is re-saved.
  return AGENCY_BRIEF_CHANNELS.filter((channel) => seen.has(channel));
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

/**
 * One thing the client is asking for.
 *
 * `format` reuses §E's `AGENCY_MEDIA_FORMATS` on purpose, and that vocabulary
 * already contains `brief`: what a brief asks for and what a client later
 * approves in a review round are then described in one language, so a deliverable
 * can be matched to the round that carried it without a mapping table.
 */
export interface AgencyBriefDeliverable {
  title: string;
  format: AgencyMediaFormat | null;
  quantity: number | null;
}

/** Enough for a real campaign, small enough that the JSON stays reviewable. */
export const AGENCY_BRIEF_DELIVERABLE_LIMIT = 40;
export const AGENCY_BRIEF_DELIVERABLE_TITLE_MAX_LENGTH = 200;
export const AGENCY_BRIEF_QUANTITY_MAX = 999;

/**
 * What a request body's deliverable may look like: `format` and `quantity` are
 * optional in transit and `null` at rest, so validation narrows to *this* rather
 * than to `AgencyBriefDeliverable` and normalisation is what fills the gaps in.
 */
export interface AgencyBriefDeliverableCandidate {
  title: string;
  format?: AgencyMediaFormat | null;
  quantity?: number | null;
}

export function isAgencyBriefDeliverable(
  value: unknown,
): value is AgencyBriefDeliverableCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.title !== "string" || candidate.title.trim() === "") return false;
  if (candidate.title.trim().length > AGENCY_BRIEF_DELIVERABLE_TITLE_MAX_LENGTH) return false;
  if (candidate.format !== null && candidate.format !== undefined && !isAgencyMediaFormat(candidate.format)) {
    return false;
  }
  if (candidate.quantity !== null && candidate.quantity !== undefined) {
    if (typeof candidate.quantity !== "number" || !Number.isInteger(candidate.quantity)) return false;
    if (candidate.quantity < 1 || candidate.quantity > AGENCY_BRIEF_QUANTITY_MAX) return false;
  }
  return true;
}

/**
 * Normalise a request body's deliverables, or return `null` if they are not
 * usable — the same contract as `normalizeAgencyBriefChannels`, and for the same
 * reason: a dropped deliverable is a promise quietly unmade.
 */
export function normalizeAgencyBriefDeliverables(
  input: unknown,
): AgencyBriefDeliverable[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > AGENCY_BRIEF_DELIVERABLE_LIMIT) return null;
  const out: AgencyBriefDeliverable[] = [];
  for (const entry of input) {
    if (!isAgencyBriefDeliverable(entry)) return null;
    out.push({
      title: entry.title.trim(),
      format: entry.format ?? null,
      quantity: entry.quantity ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text and money
// ---------------------------------------------------------------------------

export const BRIEF_NUMBER_PREFIX = "BR";
export const AGENCY_BRIEF_TITLE_MAX_LENGTH = 200;
export const AGENCY_BRIEF_TEXT_MAX_LENGTH = 4000;
export const AGENCY_BRIEF_NOTE_MAX_LENGTH = 2000;
export const AGENCY_BRIEF_NAME_MAX_LENGTH = 200;

/**
 * A budget in rial, or `null`.
 *
 * `null` means the client would not say, which is common and is not the same as
 * zero: zero would read as "they offered nothing". Mirrors the table's
 * `budget_rial > 0` CHECK, and `undefined` is treated as absent rather than as an
 * attempt to clear a figure — clearing is the PATCH's job and it says so
 * explicitly.
 */
export function normalizeAgencyBriefBudget(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return null;
  const value = typeof input === "string" ? Number(input) : input;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1) return null;
  return rounded;
}

/**
 * Trim a text column, or `null` when it is too long.
 *
 * Length is refused rather than truncated: cutting a client's acceptance criteria
 * to fit would change what they agreed to, which is the one thing this table
 * exists not to do.
 */
export function normalizeAgencyBriefText(
  input: unknown,
  maxLength: number,
): string | null {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length > maxLength) return null;
  return trimmed;
}
