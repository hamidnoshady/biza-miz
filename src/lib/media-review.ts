/**
 * Issue #1128 §E — the shape of client media review, as pure data.
 *
 * §E asks that the shared Media Library stay the single file store and grow
 * three things it does not have: a **review state** a client can move, an
 * **audit trail** of who moved it, and **short-lived scoped links** for a
 * client who is not a member of the tenant. This module is the vocabulary those
 * three are built from. It holds no query, no permission and no crypto — the
 * service owns those — so a client bundle can import the labels and a test can
 * assert the chains without touching a database.
 *
 * Four decisions are worth reading before the code:
 *
 *   * **A round, not a column.** Review state lives on a *review round* — a
 *     bundle of assets sent to one client — and never on `media_assets`. That
 *     table belongs to every trade in the product (a restaurant's menu photos,
 *     a dealership's vehicle shots, an expense receipt), so an agency-specific
 *     column there would be a burden on twelve industries for one trade's
 *     workflow. A round also holds the history a column cannot: the same
 *     creative sent to two clients, or re-sent after revisions, is two rounds
 *     over one asset.
 *   * **`ai_status` is not this.** `media_assets.ai_status` already carries
 *     'pending_review', and it is tempting to reuse the word. It records
 *     whether an operator confirmed the *AI's proposed labels* — an internal
 *     housekeeping state with no client in it. Overloading it would make one
 *     column answer two unrelated questions.
 *   * **A format is a label, not a `kind`.** §E lists copy, static creatives,
 *     logos, video, print-ready files, ad variants, briefs, contracts and
 *     reports. `media_assets.kind` is `image | video | document` and widening
 *     it would touch every upload path in the product, so formats are a
 *     vocabulary over the `category` column the library already has.
 *   * **Versions are rounds, not a new table.** The library already tracks
 *     lineage (`variant`, `source_asset_id`, `/api/media/[id]/lineage`). A
 *     client-facing version is the next round over the same asset, so version
 *     history is read from the rounds rather than stored twice.
 */
import { toPersianDigits } from "./digits";

/* ===========================================================================
 * Round states
 * ======================================================================== */

export const MEDIA_REVIEW_ROUND_STATUSES = [
  "draft",
  "sent",
  "approved",
  "changes_requested",
  "rejected",
  "withdrawn",
] as const;

export type MediaReviewRoundStatus = (typeof MEDIA_REVIEW_ROUND_STATUSES)[number];

export const MEDIA_REVIEW_ROUND_STATUS_LABELS: Record<MediaReviewRoundStatus, string> = {
  draft: "پیش‌نویس",
  sent: "ارسال‌شده",
  approved: "تأییدشده",
  changes_requested: "درخواست اصلاح",
  rejected: "ردشده",
  withdrawn: "پس‌گرفته‌شده",
};

/**
 * Which round states a client may still decide.
 *
 * A withdrawn round is one the agency pulled back — its link must stop working
 * even before it expires, which is the whole point of revocation being a state
 * and not just a timestamp.
 */
export const MEDIA_REVIEW_DECIDABLE_STATUSES: readonly MediaReviewRoundStatus[] = ["sent"];

/** States whose rounds are history: nothing may be added to or decided on them. */
export const MEDIA_REVIEW_SETTLED_STATUSES: readonly MediaReviewRoundStatus[] = [
  "approved",
  "rejected",
];

/**
 * The round chain.
 *
 * `approved` is deliberately terminal. A client who changes their mind after
 * approving does not un-approve — the agency sends a new round, so the record
 * keeps both facts instead of overwriting the first. That is also what makes
 * rounds usable as versions.
 *
 * `rejected` and `changes_requested` both return to `sent`: a refusal is
 * feedback, not an ending, and re-sending the revised work is the normal path.
 */
const REVIEW_ROUND_TRANSITIONS: Record<MediaReviewRoundStatus, readonly MediaReviewRoundStatus[]> = {
  draft: ["sent"],
  sent: ["approved", "changes_requested", "rejected", "withdrawn"],
  approved: [],
  changes_requested: ["sent"],
  rejected: ["sent"],
  withdrawn: ["sent"],
};

export function canTransitionReviewRound(
  from: MediaReviewRoundStatus,
  to: MediaReviewRoundStatus,
): boolean {
  return REVIEW_ROUND_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Every legal move out of one state, for a caller that must not guess. */
export function reviewRoundTargetsFrom(
  from: MediaReviewRoundStatus,
): readonly MediaReviewRoundStatus[] {
  return REVIEW_ROUND_TRANSITIONS[from] ?? [];
}

export function isReviewRoundStatus(value: unknown): value is MediaReviewRoundStatus {
  return typeof value === "string" && (MEDIA_REVIEW_ROUND_STATUSES as readonly string[]).includes(value);
}

/** Whether a round may still take assets. Only a draft is being assembled. */
export function isReviewRoundOpenForItems(status: MediaReviewRoundStatus): boolean {
  return status === "draft" || status === "changes_requested" || status === "rejected";
}

/** Whether a round's contents are frozen — sent, settled or pulled back. */
export function isReviewRoundFrozen(status: MediaReviewRoundStatus): boolean {
  return !isReviewRoundOpenForItems(status);
}

/* ===========================================================================
 * Item states
 * ======================================================================== */

export const MEDIA_REVIEW_ITEM_STATUSES = [
  "pending",
  "approved",
  "changes_requested",
  "rejected",
] as const;

export type MediaReviewItemStatus = (typeof MEDIA_REVIEW_ITEM_STATUSES)[number];

export const MEDIA_REVIEW_ITEM_STATUS_LABELS: Record<MediaReviewItemStatus, string> = {
  pending: "در انتظار بررسی",
  approved: "تأییدشده",
  changes_requested: "درخواست اصلاح",
  rejected: "ردشده",
};

export function isReviewItemStatus(value: unknown): value is MediaReviewItemStatus {
  return typeof value === "string" && (MEDIA_REVIEW_ITEM_STATUSES as readonly string[]).includes(value);
}

/**
 * The round's state, derived from its items — but only as a *proposal*.
 *
 * A client decides the round; the per-item states are the detail behind that
 * decision. Deriving the round state anyway is useful for pre-filling the
 * decision form, and it is the rule an agency expects: one refusal makes the
 * batch "changes requested", never "approved".
 *
 * Returns null when nothing has been decided yet, so a caller cannot mistake
 * "no decisions" for "approved".
 */
export function reviewRoundStateFromItems(
  itemStatuses: readonly MediaReviewItemStatus[],
): MediaReviewRoundStatus | null {
  if (itemStatuses.length === 0) return null;
  if (itemStatuses.some((status) => status === "pending")) return null;
  if (itemStatuses.some((status) => status === "rejected")) return "rejected";
  if (itemStatuses.some((status) => status === "changes_requested")) return "changes_requested";
  if (itemStatuses.every((status) => status === "approved")) return "approved";
  return null;
}

/* ===========================================================================
 * Link purposes
 * ======================================================================== */

export const MEDIA_REVIEW_LINK_PURPOSES = ["review", "download"] as const;

export type MediaReviewLinkPurpose = (typeof MEDIA_REVIEW_LINK_PURPOSES)[number];

export const MEDIA_REVIEW_LINK_PURPOSE_LABELS: Record<MediaReviewLinkPurpose, string> = {
  review: "بررسی",
  download: "بررسی و دریافت",
};

export function isReviewLinkPurpose(value: unknown): value is MediaReviewLinkPurpose {
  return typeof value === "string" && (MEDIA_REVIEW_LINK_PURPOSES as readonly string[]).includes(value);
}

/**
 * Whether a purpose lets the holder take bytes.
 *
 * Review alone means look and decide: a client approving a print-ready file
 * does not automatically get a copy of it, because the file is often the
 * deliverable the agency is still owed money for. Download is a separate,
 * deliberate grant.
 */
export function reviewLinkPurposeAllowsDownload(purpose: MediaReviewLinkPurpose): boolean {
  return purpose === "download";
}

/* ===========================================================================
 * Formats — §E's list, over the library's existing `category` column
 * ======================================================================== */

export const AGENCY_MEDIA_FORMATS = [
  "copy",
  "static_creative",
  "logo",
  "video",
  "print_ready",
  "ad_variant",
  "brief",
  "contract",
  "report",
] as const;

export type AgencyMediaFormat = (typeof AGENCY_MEDIA_FORMATS)[number];

export const AGENCY_MEDIA_FORMAT_LABELS: Record<AgencyMediaFormat, string> = {
  copy: "متن تبلیغاتی",
  static_creative: "طرح گرافیکی",
  logo: "لوگو",
  video: "ویدیو",
  print_ready: "فایل آمادهٔ چاپ",
  ad_variant: "نسخهٔ تبلیغ",
  brief: "بریف",
  contract: "قرارداد",
  report: "گزارش",
};

export function isAgencyMediaFormat(value: unknown): value is AgencyMediaFormat {
  return typeof value === "string" && (AGENCY_MEDIA_FORMATS as readonly string[]).includes(value);
}

/**
 * The formats a client is meant to *approve*, as opposed to the ones an agency
 * merely files.
 *
 * A contract or a report is shared for information; a creative is shared for a
 * decision. The review screen leads with the second group so a client is not
 * asked to approve their own contract.
 */
export const AGENCY_MEDIA_APPROVABLE_FORMATS: readonly AgencyMediaFormat[] = [
  "copy",
  "static_creative",
  "logo",
  "video",
  "print_ready",
  "ad_variant",
];

/* ===========================================================================
 * Link lifetime
 * ======================================================================== */

/**
 * How long a client link lives, in days.
 *
 * §E requires *short-lived* access and never says how short, so the default is
 * the shortest window that survives a real approval cycle — a client who is
 * away for a weekend — and the ceiling is one campaign's flight. Both are
 * clamped server-side; a caller asking for a year gets a month.
 */
export const MEDIA_REVIEW_LINK_TTL_DAYS = {
  default: 7,
  min: 1,
  max: 30,
} as const;

export function clampReviewLinkTtlDays(value: unknown): number {
  // Nothing supplied means "the default", never "zero days". The distinction is
  // not academic: `Number("")` is 0, which is finite, so coercing an omitted or
  // blank TTL straight to a number clamps it to the one-day minimum and quietly
  // hands a client a link that dies overnight instead of the week that was
  // intended. Garbage of any other shape takes the same route to the default.
  if (value === null || value === undefined) return MEDIA_REVIEW_LINK_TTL_DAYS.default;
  if (typeof value === "string" && value.trim() === "") return MEDIA_REVIEW_LINK_TTL_DAYS.default;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return MEDIA_REVIEW_LINK_TTL_DAYS.default;
  const days = Math.floor(parsed);
  if (days < MEDIA_REVIEW_LINK_TTL_DAYS.min) return MEDIA_REVIEW_LINK_TTL_DAYS.min;
  if (days > MEDIA_REVIEW_LINK_TTL_DAYS.max) return MEDIA_REVIEW_LINK_TTL_DAYS.max;
  return days;
}

/** The instant a link minted now expires, as an ISO timestamp. */
export function reviewLinkExpiresAt(now: Date, ttlDays: number): string {
  const expiry = new Date(now.getTime() + clampReviewLinkTtlDays(ttlDays) * 86_400_000);
  return expiry.toISOString();
}

/**
 * Whether a link is live.
 *
 * Both halves matter and neither implies the other: an unexpired link can have
 * been revoked, and a revoked link's row outlives its revocation for the audit
 * trail. A route that checked only `expires_at` would keep serving a client the
 * agency had deliberately cut off.
 */
export function isReviewLinkLive(
  link: { expiresAt: string | Date; revokedAt: string | Date | null },
  now: Date = new Date(),
): boolean {
  if (link.revokedAt) return false;
  const expiresAt = link.expiresAt instanceof Date ? link.expiresAt : new Date(link.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt.getTime() > now.getTime();
}

/**
 * Why a link is not live, as a code a screen can translate.
 *
 * Split out from `isReviewLinkLive` so a refused client is told whether to ask
 * for a new link (expired) or to ask the agency (revoked) — "this link does not
 * work" is not an answer either of them can act on.
 */
export function reviewLinkRefusal(
  link: { expiresAt: string | Date; revokedAt: string | Date | null },
  now: Date = new Date(),
): "revoked" | "expired" | null {
  if (link.revokedAt) return "revoked";
  return isReviewLinkLive(link, now) ? null : "expired";
}

/* ===========================================================================
 * Token shape
 * ======================================================================== */

/**
 * Namespaces a client review link, so a pasted API key or pairing code is
 * rejected before any lookup.
 *
 * Mirrors `API_KEY_PREFIX` in api-key-format.ts, and for the same reason the
 * crypto lives elsewhere: this module is on a browser bundle's import path, so
 * it must not reach `node:crypto`. The service mints and hashes; this file only
 * describes the shape.
 */
export const MEDIA_REVIEW_TOKEN_PREFIX = "bmrl_";

/**
 * How much of a token is safe to persist and show: the prefix plus a little,
 * never enough to authenticate. A review link is shorter-lived than an API key
 * but the rule is the same — the dashboard shows which link is which, and the
 * plaintext is shown exactly once, at minting.
 */
export const MEDIA_REVIEW_TOKEN_DISPLAY_LENGTH = 16;

export function mediaReviewTokenDisplayPrefix(token: string): string {
  return token.slice(0, MEDIA_REVIEW_TOKEN_DISPLAY_LENGTH);
}

/** Format only — never an authentication decision. */
export function looksLikeMediaReviewToken(raw: string): boolean {
  return raw.trim().startsWith(MEDIA_REVIEW_TOKEN_PREFIX);
}

/* ===========================================================================
 * Acts
 * ======================================================================== */

export const MEDIA_REVIEW_ROUND_ACTIONS = [
  "send",
  "withdraw",
  "approve",
  "request_changes",
  "reject",
] as const;

export type MediaReviewRoundAction = (typeof MEDIA_REVIEW_ROUND_ACTIONS)[number];

export const MEDIA_REVIEW_ROUND_ACTION_LABELS: Record<MediaReviewRoundAction, string> = {
  send: "ارسال برای کارفرما",
  withdraw: "پس‌گرفتن",
  approve: "تأیید",
  request_changes: "درخواست اصلاح",
  reject: "رد",
};

export function isReviewRoundAction(value: unknown): value is MediaReviewRoundAction {
  return (
    typeof value === "string" &&
    (MEDIA_REVIEW_ROUND_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Which acts are the *client's*, and which are the agency's.
 *
 * The split is what keeps a link from being a management console: a client may
 * decide, and only the agency may send or pull back. `send` and `withdraw` are
 * therefore never reachable through a token route, whatever the token says.
 */
const REVIEW_ROUND_CLIENT_ACTIONS: readonly MediaReviewRoundAction[] = [
  "approve",
  "request_changes",
  "reject",
];

export function isClientReviewAction(action: MediaReviewRoundAction): boolean {
  return REVIEW_ROUND_CLIENT_ACTIONS.includes(action);
}

const REVIEW_ROUND_ACTION_TARGETS: Record<MediaReviewRoundAction, MediaReviewRoundStatus> = {
  send: "sent",
  withdraw: "withdrawn",
  approve: "approved",
  request_changes: "changes_requested",
  reject: "rejected",
};

export function reviewRoundActionTarget(action: MediaReviewRoundAction): MediaReviewRoundStatus {
  return REVIEW_ROUND_ACTION_TARGETS[action];
}

/**
 * The acts a round offers, from its state alone.
 *
 * Deliberately includes both sides' acts; a caller filters by who is asking.
 * That is the same shape §D's registers use, and it is why the split above
 * exists — one list of acts, two doors.
 */
export function reviewRoundActionsFrom(
  status: MediaReviewRoundStatus,
): readonly MediaReviewRoundAction[] {
  switch (status) {
    case "draft":
      return ["send"];
    case "sent":
      return ["approve", "request_changes", "reject", "withdraw"];
    case "changes_requested":
    case "rejected":
    case "withdrawn":
      return ["send"];
    case "approved":
      return [];
  }
}

/** The acts a *client* holding a live link may take on this round. */
export function clientReviewActionsFrom(
  status: MediaReviewRoundStatus,
): readonly MediaReviewRoundAction[] {
  if (!MEDIA_REVIEW_DECIDABLE_STATUSES.includes(status)) return [];
  return reviewRoundActionsFrom(status).filter(isClientReviewAction);
}

/* ===========================================================================
 * Small shared helpers
 * ======================================================================== */

/** «۳ از ۵» — how far a client has got through a round, in Persian digits. */
export function formatReviewProgress(decided: number, total: number): string {
  return toPersianDigits(`${Math.max(0, decided)} از ${Math.max(0, total)}`);
}

/** Whether every item in a round has been decided. */
export function isReviewRoundFullyDecided(
  itemStatuses: readonly MediaReviewItemStatus[],
): boolean {
  return itemStatuses.length > 0 && !itemStatuses.some((status) => status === "pending");
}

/**
 * The note a decision must carry, or a refusal.
 *
 * "Changes requested" with nothing written is not actionable: the agency would
 * have to ask what to change, which is the round the client just refused. An
 * approval needs no note, because there is nothing to do next.
 */
export function reviewDecisionNoteRequired(action: MediaReviewRoundAction): boolean {
  return action === "request_changes" || action === "reject";
}

/** Caps a client's note, so a decision cannot smuggle a document into a column. */
export const MEDIA_REVIEW_NOTE_MAX_LENGTH = 2000;

export function trimReviewNote(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MEDIA_REVIEW_NOTE_MAX_LENGTH);
}
