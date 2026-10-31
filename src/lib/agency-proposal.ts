/**
 * §A's proposals/quotes — the offer, priced. §D calls the same document an
 * "estimate"; §B's stage list settles which one it is and that there is only one:
 * "brief → discovery → proposal/quote → contract → kickoff".
 *
 * This module is the *pure* half: vocabularies, the status chain, the arithmetic
 * that turns lines into a total, and the normalisation of whatever an HTTP body
 * hands us. It imports only other pure modules, so a client component may import
 * it. The half that talks to Postgres is `agency-proposal-service.ts`, kept apart
 * for the reason `media-review.ts` and `media-review-service.ts` are: a panel that
 * imports the service drags `pg` into the browser bundle.
 *
 * Every rule here has a matching constraint in `0276_agency_proposals.sql`, with
 * two deliberate exceptions, both of which are noted where they occur: a discount
 * larger than the offer it discounts, and accepting an offer whose validity has
 * run out. Neither is expressible as a CHECK, because both need another row's
 * figure or the current date.
 *
 * THE INTERNAL / CLIENT BOUNDARY. A line carries `costRial` and `passThrough`,
 * and neither may ever reach a client. That rule is structural here rather than
 * advisory: `agencyProposalClientLines()` returns a type in which those fields do
 * not exist, so a screen built on it cannot render what it cannot name. A comment
 * saying "do not show the cost" survives one refactor; an absent property does not
 * need to.
 */

import { SERVICE_REVENUE_ACCOUNTS, type ServiceRevenueAccount } from "./service-invoice";

// ---------------------------------------------------------------------------
// Status and the chain between them
// ---------------------------------------------------------------------------

export const AGENCY_PROPOSAL_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const;

export type AgencyProposalStatus = (typeof AGENCY_PROPOSAL_STATUSES)[number];

export const AGENCY_PROPOSAL_STATUS_LABELS: Record<AgencyProposalStatus, string> = {
  draft: "پیش‌نویس",
  sent: "ارسال‌شده به کارفرما",
  accepted: "پذیرفته‌شده",
  declined: "ردشده",
  expired: "منقضی‌شده",
  withdrawn: "کنارگذاشته",
};

export const AGENCY_PROPOSAL_STATUS_TONES: Record<
  AgencyProposalStatus,
  "active" | "positive" | "neutral" | "danger"
> = {
  draft: "neutral",
  sent: "active",
  accepted: "positive",
  declined: "danger",
  expired: "neutral",
  withdrawn: "danger",
};

export const AGENCY_PROPOSAL_ACTIONS = [
  "send",
  "withdraw",
  "accept",
  "decline",
  "expire",
  "reopen",
] as const;

export type AgencyProposalAction = (typeof AGENCY_PROPOSAL_ACTIONS)[number];

export const AGENCY_PROPOSAL_ACTION_LABELS: Record<AgencyProposalAction, string> = {
  send: "ارسال به کارفرما",
  withdraw: "کنارگذاشتن",
  accept: "ثبت پذیرش کارفرما",
  decline: "ثبت رد کارفرما",
  expire: "ثبت انقضا",
  reopen: "بازگرداندن به پیش‌نویس",
};

/**
 * Where each status can go next.
 *
 * `accepted`, `declined` and `expired` are terminal, and that is a consequence of
 * the freeze rather than a separate choice: the price is closed the moment the
 * offer is sent, so there is nothing left to revise in place. The client who
 * declines at ۶۵۰٬۰۰۰٬۰۰۰ and is then offered ۵۵۰٬۰۰۰٬۰۰۰ gets a *new* proposal
 * in the same series, and the declined one stays on the record as the offer that
 * was actually refused. Reopening it would destroy the only evidence of what the
 * client said no to.
 *
 * `withdrawn` returns to `draft`, exactly as a withdrawn brief does: an offer
 * taken back before anyone decided was never a fact about the client, so
 * reopening it costs nothing and saves a number in the series.
 */
const AGENCY_PROPOSAL_TRANSITIONS: Record<
  AgencyProposalStatus,
  readonly AgencyProposalStatus[]
> = {
  draft: ["sent", "withdrawn"],
  sent: ["accepted", "declined", "expired", "withdrawn"],
  accepted: [],
  declined: [],
  expired: [],
  withdrawn: ["draft"],
};

const AGENCY_PROPOSAL_ACTION_TARGETS: Record<AgencyProposalAction, AgencyProposalStatus> = {
  send: "sent",
  withdraw: "withdrawn",
  accept: "accepted",
  decline: "declined",
  expire: "expired",
  reopen: "draft",
};

export function isAgencyProposalStatus(value: unknown): value is AgencyProposalStatus {
  return (
    typeof value === "string" &&
    (AGENCY_PROPOSAL_STATUSES as readonly string[]).includes(value)
  );
}

export function isAgencyProposalAction(value: unknown): value is AgencyProposalAction {
  return (
    typeof value === "string" &&
    (AGENCY_PROPOSAL_ACTIONS as readonly string[]).includes(value)
  );
}

export function agencyProposalActionTarget(action: AgencyProposalAction): AgencyProposalStatus {
  return AGENCY_PROPOSAL_ACTION_TARGETS[action];
}

export function canTransitionAgencyProposal(
  from: AgencyProposalStatus,
  to: AgencyProposalStatus,
): boolean {
  return AGENCY_PROPOSAL_TRANSITIONS[from].includes(to);
}

export function canPerformAgencyProposalAction(
  status: AgencyProposalStatus,
  action: AgencyProposalAction,
): boolean {
  return canTransitionAgencyProposal(status, AGENCY_PROPOSAL_ACTION_TARGETS[action]);
}

/**
 * The actions a proposal in this status accepts, in the order the panel renders
 * them. The UI is rendered from this list rather than from the status, so a
 * button can never appear that the route would refuse.
 */
export function agencyProposalActionsFrom(status: AgencyProposalStatus): AgencyProposalAction[] {
  return AGENCY_PROPOSAL_ACTIONS.filter((action) =>
    canPerformAgencyProposalAction(status, action),
  );
}

/**
 * Whether the offer is frozen — including its lines.
 *
 * Earlier than a brief's freeze, which waits for `confirmed`. A brief records
 * what was asked and can be tidied while the client reads it; a proposal states a
 * *price*, and a client who reads one figure and returns to find another has been
 * given a reason to distrust every later figure. So everything but `draft` is
 * closed, and the correction is a new number in the series.
 *
 * `contract_id` is not part of the frozen substance: it records what the offer
 * became, which by definition happens afterwards.
 */
export function isAgencyProposalFrozen(status: AgencyProposalStatus): boolean {
  return status !== "draft";
}

/** Whether lines may still be added, priced or removed. */
export function isAgencyProposalEditable(status: AgencyProposalStatus): boolean {
  return status === "draft";
}

/** Whether the offer is still live rather than a closed record. */
export function isAgencyProposalOpen(status: AgencyProposalStatus): boolean {
  return status === "draft" || status === "sent";
}

/** Only a draft may be deleted; anything the client saw is a record. */
export function isAgencyProposalDeletable(status: AgencyProposalStatus): boolean {
  return status === "draft";
}

/**
 * Whether recording this action needs a name attached.
 *
 * §A asks that the stakeholder/approver be recorded. The client has no user row
 * and must never get one — §B rules out a second identity system — so a decision
 * is attributed by name, and an unattributed acceptance is an assertion rather
 * than a record. Mirrors `agency_proposals_decision_check`.
 */
export function agencyProposalDecisionNeedsName(action: AgencyProposalAction): boolean {
  return action === "accept" || action === "decline";
}

// ---------------------------------------------------------------------------
// Validity — a fact computed from the date, not a status somebody maintains
// ---------------------------------------------------------------------------

/**
 * Whether an offer's clock has run out.
 *
 * Distinct from the stored `expired` status, and deliberately so. `expired` is a
 * *decision* somebody recorded; lapsing is a *fact* about a date, true the moment
 * the date passes whether or not anyone has looked. A list that showed only the
 * stored status would keep offering a quote that lapsed three weeks ago, because
 * nothing had got round to marking it — so screens read this, and the status is
 * there for the member who wants the record closed.
 *
 * `validUntilIso` is inclusive: "valid until ۱۴۰۶/۰۳/۰۱" means that day still
 * counts, so the offer lapses on the day after.
 *
 * @param now - Injected rather than read, so a screen and a test agree about
 *   which day it is.
 */
export function isAgencyProposalLapsed(
  status: AgencyProposalStatus,
  validUntilIso: string | null,
  now: Date,
): boolean {
  // Only a live offer can lapse. A decided one is history, and telling a member
  // that an accepted proposal has "lapsed" is a statement about a date nobody is
  // acting on any more.
  if (status !== "sent") return false;
  if (!validUntilIso) return false;
  if (!AGENCY_PROPOSAL_DATE_PATTERN.test(validUntilIso)) return false;
  const end = Date.parse(validUntilIso + "T23:59:59.999Z");
  if (!Number.isFinite(end)) return false;
  return now.getTime() > end;
}

/**
 * Why an action may not be recorded, or `null` when it may.
 *
 * Accepting a lapsed offer is refused, and this is one of the two rules the
 * database does not enforce: `valid_until < now()` is not an immutable
 * expression, so no CHECK can express it. Leaving it unenforced anywhere would
 * mean a client could accept a six-month-old quote at the old price — the exact
 * mistake a validity date exists to prevent — so it lives here and the service
 * refuses with `proposal_lapsed`.
 *
 * Declining and expiring are *not* refused. Recording that a client turned down
 * an offer that had already lapsed, or formally closing one, are both accurate
 * statements about the past.
 */
export function agencyProposalActionBlocked(
  action: AgencyProposalAction,
  status: AgencyProposalStatus,
  validUntilIso: string | null,
  now: Date,
): "proposal_lapsed" | null {
  if (action !== "accept") return null;
  return isAgencyProposalLapsed(status, validUntilIso, now) ? "proposal_lapsed" : null;
}

// ---------------------------------------------------------------------------
// Revenue accounts — read from the trade's own list, never restated
// ---------------------------------------------------------------------------

/**
 * The accounts a proposal line may credit, in chart order, so the first is the
 * default. Read from `service-invoice.ts` rather than copied, which is what keeps
 * the offer, the invoice screen and the ledger describing the same four things:
 * a line priced as media (۴۶۶۰) is invoiced as media, and the campaign P&L can
 * read agency fees and media separately instead of inferring the split from the
 * size of a line.
 */
export const AGENCY_PROPOSAL_REVENUE_ACCOUNTS: readonly ServiceRevenueAccount[] =
  SERVICE_REVENUE_ACCOUNTS.advertising_agency;

export function isAgencyProposalRevenueCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    AGENCY_PROPOSAL_REVENUE_ACCOUNTS.some((account) => account.code === value)
  );
}

/** The account a line credits when the operator does not choose one. */
export function defaultAgencyProposalRevenueCode(): string {
  return AGENCY_PROPOSAL_REVENUE_ACCOUNTS[0].code;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export const PROPOSAL_NUMBER_PREFIX = "PR";

export const AGENCY_PROPOSAL_TITLE_MAX_LENGTH = 200;
/** Scope of work is prose a client reads and disputes, so it gets room. */
export const AGENCY_PROPOSAL_SCOPE_MAX_LENGTH = 8000;
export const AGENCY_PROPOSAL_TERMS_MAX_LENGTH = 4000;
export const AGENCY_PROPOSAL_NAME_MAX_LENGTH = 200;
export const AGENCY_PROPOSAL_LINE_NOTE_MAX_LENGTH = 1000;

/** Enough for a real engagement; small enough that the offer stays readable. */
export const AGENCY_PROPOSAL_LINE_LIMIT = 60;
export const AGENCY_PROPOSAL_LINE_DESCRIPTION_MAX_LENGTH = 300;

/**
 * Quantity carries three decimals, because agency work is sold in halves and
 * thirds: ۱٫۵ روز مدیریت هنری, ۰٫۵ ماه ریتینر. An integer column would have
 * forced every such line to be rounded up and quietly overcharged for it.
 */
export const AGENCY_PROPOSAL_QUANTITY_DECIMALS = 3;
export const AGENCY_PROPOSAL_QUANTITY_MAX = 10_000;

/**
 * Ceilings chosen so the derived figures stay inside a JS safe integer: a line
 * cannot exceed ۱۰٬۰۰۰ × ۱۰٬۰۰۰٬۰۰۰٬۰۰۰ = ۱۰^۱۴, and ۶۰ such lines total ۶×۱۰^۱۵,
 * under `Number.MAX_SAFE_INTEGER`. Beyond that a total would be a rounded guess
 * presented as an exact figure — the worst failure mode a quote has.
 */
export const AGENCY_PROPOSAL_UNIT_PRICE_MAX = 10_000_000_000;
export const AGENCY_PROPOSAL_TAX_MAX = 1_000_000_000_000;

/** `YYYY-MM-DD`, the shape `valid_until` is stored in. */
const AGENCY_PROPOSAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The years a validity date may fall in.
 *
 * Narrower than "any date the calendar supports", and the reason is specific to
 * this column: a Jalali year (۱۴۰۶) has exactly the same shape as a Gregorian
 * one, parses happily, and stores as the year 1406 — an offer that lapsed six
 * centuries ago. On a brief that is a cosmetic oddity; here it silently disables
 * the offer, because `agencyProposalActionBlocked` would refuse every acceptance
 * of it and nothing on screen would say why. The two calendars' plausible ranges
 * do not overlap, so a range is enough to tell them apart.
 */
export const AGENCY_PROPOSAL_DATE_YEAR_MIN = 1970;
export const AGENCY_PROPOSAL_DATE_YEAR_MAX = 2200;

/**
 * A line's amount, and the one place in TypeScript that must agree with the
 * database. `0276`'s trigger computes `round(quantity * unit_price)`; Postgres
 * rounds `numeric` half away from zero and `Math.round` rounds half up, which for
 * the non-negative figures allowed here are the same rule. The integration suite
 * asserts both sides on a `.5` case, because a one-rial disagreement between the
 * screen and the stored row is invisible in review and maddening in an audit.
 */
export function agencyProposalLineAmountRial(quantity: number, unitPriceRial: number): number {
  return Math.round(quantity * unitPriceRial);
}

/**
 * Trim a text column, or `null` when it is not usable.
 *
 * Length is refused rather than truncated: cutting a scope of work to fit would
 * change what the client is being offered, which is the one thing this table
 * exists not to do.
 */
export function normalizeAgencyProposalText(input: unknown, maxLength: number): string | null {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Normalise a whole-rial figure that may legitimately be zero: a discount, a tax
 * or a cost.
 *
 * `undefined`, `null` and `""` all mean *absent* and return `null`, which the
 * caller reads as "leave the column alone" on a PATCH and as the default on a
 * create. Zero is a real value and is preserved — an offer with no discount is
 * the common case, and collapsing zero into absent would make the two
 * indistinguishable in exactly the place where the difference matters.
 */
export function normalizeAgencyProposalRial(input: unknown, max: number): number | null {
  if (input === undefined || input === null || input === "") return null;
  const value = typeof input === "string" ? Number(input) : input;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > max) return null;
  return rounded;
}

/**
 * Normalise a quantity: positive, at most three decimals, inside the ceiling.
 *
 * Rounding to three decimals is the one coercion this module performs silently,
 * and it is safe because it is the column's own scale — a fourth decimal could
 * not be stored in any case, and refusing the request would turn a browser's
 * floating-point artefact (`0.1 + 0.2`) into an error the member cannot fix.
 */
export function normalizeAgencyProposalQuantity(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return 1;
  const value = typeof input === "string" ? Number(input) : input;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value > AGENCY_PROPOSAL_QUANTITY_MAX) return null;
  const scale = 10 ** AGENCY_PROPOSAL_QUANTITY_DECIMALS;
  const rounded = Math.round(value * scale) / scale;
  if (rounded <= 0) return null;
  return rounded;
}

/**
 * Normalise a validity date.
 *
 * Only `YYYY-MM-DD` is accepted, and it is returned unchanged. Anything else —
 * including a full ISO timestamp — is refused rather than parsed, because
 * `valid_until` is a `date`: a caller sending a Tehran-morning timestamp would
 * have it silently truncated to the previous day in UTC, and an offer that lapses
 * a day early is a dispute with no visible cause.
 */
export function normalizeAgencyProposalDate(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!AGENCY_PROPOSAL_DATE_PATTERN.test(trimmed)) return null;
  const parsed = new Date(trimmed + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime())) return null;
  // A date that round-trips is a date that exists: `2027-02-30` parses and then
  // resolves to 1 March, which is not the day that was typed.
  if (parsed.toISOString().slice(0, 10) !== trimmed) return null;
  const year = parsed.getUTCFullYear();
  if (year < AGENCY_PROPOSAL_DATE_YEAR_MIN || year > AGENCY_PROPOSAL_DATE_YEAR_MAX) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * What one line of an offer says. This is the *internal* shape: it carries the
 * cost and the pass-through decision, and must not be handed to a client screen.
 * See `agencyProposalClientLines` for the shape that may.
 */
export interface AgencyProposalLine {
  id: string;
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceRial: number;
  amountRial: number;
  revenueCode: string;
  costRial: number | null;
  passThrough: boolean;
  note: string;
}

/** A line as a request body states it, before anything is validated. */
export interface AgencyProposalLineInput {
  description: string;
  quantity: number;
  unitPriceRial: number;
  revenueCode: string;
  costRial: number | null;
  passThrough: boolean;
  note: string;
}

/**
 * The loose candidate `normalizeAgencyProposalLines` accepts.
 *
 * Deliberately looser than `AgencyProposalLineInput`: every field is optional and
 * every value is `unknown`, so the type guard describes what a body *might* look
 * like rather than what it must. Guarding on the strict shape instead would make
 * the narrowing a no-op and the cast below an assertion the compiler cannot check.
 */
export interface AgencyProposalLineCandidate {
  description?: unknown;
  quantity?: unknown;
  unitPriceRial?: unknown;
  revenueCode?: unknown;
  costRial?: unknown;
  passThrough?: unknown;
  note?: unknown;
}

export function isAgencyProposalLineCandidate(
  value: unknown,
): value is AgencyProposalLineCandidate {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalise a body's lines, or return `null` if any of them is unusable.
 *
 * `null` means the caller should refuse with `invalid_line` rather than drop the
 * offending row: an offer that silently lost a line would understate its own
 * price, and the member would send it believing it was complete.
 *
 * Lines are renumbered 1…n in the order given. `line_number` is the printed
 * order, so it is the array's shape and not a value the caller owns — a body that
 * renumbers them itself would be able to produce two lines called ۳.
 */
export function normalizeAgencyProposalLines(input: unknown): AgencyProposalLineInput[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > AGENCY_PROPOSAL_LINE_LIMIT) return null;

  const lines: AgencyProposalLineInput[] = [];
  for (const entry of input) {
    if (!isAgencyProposalLineCandidate(entry)) return null;

    const description = normalizeAgencyProposalText(
      entry.description,
      AGENCY_PROPOSAL_LINE_DESCRIPTION_MAX_LENGTH,
    );
    if (description === null || description === "") return null;

    const quantity = normalizeAgencyProposalQuantity(entry.quantity);
    if (quantity === null) return null;

    // An absent price is zero, not an error: "included at no charge" is a real
    // line on a real offer, and refusing it would push the member into writing a
    // figure they then have to explain away in the note.
    const unitPriceRial =
      entry.unitPriceRial === undefined || entry.unitPriceRial === null || entry.unitPriceRial === ""
        ? 0
        : normalizeAgencyProposalRial(entry.unitPriceRial, AGENCY_PROPOSAL_UNIT_PRICE_MAX);
    if (unitPriceRial === null) return null;

    const revenueCode =
      entry.revenueCode === undefined || entry.revenueCode === null || entry.revenueCode === ""
        ? defaultAgencyProposalRevenueCode()
        : entry.revenueCode;
    if (!isAgencyProposalRevenueCode(revenueCode)) return null;

    const passThrough =
      entry.passThrough === undefined || entry.passThrough === null
        ? false
        : entry.passThrough;
    if (typeof passThrough !== "boolean") return null;

    const costRial = normalizeAgencyProposalRial(entry.costRial, AGENCY_PROPOSAL_UNIT_PRICE_MAX);
    // `agency_proposal_lines_pass_through_needs_cost`: a recharge of an unknown
    // amount is a promise to book the client's money without knowing how much of
    // it there is, so the pair is refused together rather than half-stored.
    if (passThrough && costRial === null) return null;

    const note = normalizeAgencyProposalText(entry.note, AGENCY_PROPOSAL_LINE_NOTE_MAX_LENGTH);
    if (note === null) return null;

    lines.push({ description, quantity, unitPriceRial, revenueCode, costRial, passThrough, note });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Totals — derived, never stored
// ---------------------------------------------------------------------------

/** What the client is offered. Every figure here is computed from the lines. */
export interface AgencyProposalTotals {
  subtotalRial: number;
  discountRial: number;
  taxRial: number;
  totalRial: number;
}

/**
 * The offer's figures, from the lines and the two policy inputs on the header.
 *
 * Nothing here is stored, and that is the point: `0276` keeps `discount_rial` and
 * `tax_rial` because they are *inputs* somebody chose, and derives everything
 * else. A stored total is a second answer to "how much", and the only way to keep
 * two answers agreeing is a trigger whose whole job is bookkeeping. One answer
 * cannot disagree with itself.
 *
 * Tax is added after the discount, which is the order the tax authority's figure
 * is calculated in: a discount reduces what is being sold, and the tax is on what
 * is actually sold.
 */
export function agencyProposalTotals(
  lines: readonly Pick<AgencyProposalLine, "amountRial">[],
  discountRial: number,
  taxRial: number,
): AgencyProposalTotals {
  const subtotalRial = lines.reduce((sum, line) => sum + line.amountRial, 0);
  const discount = Math.min(discountRial, subtotalRial);
  const taxable = subtotalRial - discount;
  return {
    subtotalRial,
    discountRial: discount,
    taxRial,
    totalRial: taxable + taxRial,
  };
}

/**
 * Whether a discount is allowed on this offer.
 *
 * The second rule the database does not enforce, and for the same kind of reason:
 * it compares two rows' worth of figures, which no CHECK on one row can see. A
 * discount larger than the subtotal would make the total negative — the agency
 * paying the client to accept the work — so it is refused as `invalid_discount`.
 *
 * A discount *equal* to the subtotal is allowed. Zero-rial work is a real thing
 * an agency offers: a pro-bono campaign, a first month free to win a retainer.
 * What is not real is a negative one.
 */
export function agencyProposalDiscountAllowed(subtotalRial: number, discountRial: number): boolean {
  return discountRial >= 0 && discountRial <= subtotalRial;
}

/**
 * The internal view of the same offer: what it costs the agency, and what is
 * therefore actually being earned.
 *
 * Extends the client totals rather than restating them, so the two cannot drift —
 * a margin screen that recomputed the subtotal differently from the offer would
 * be the more dangerous kind of wrong, because it would look like agreement.
 */
export interface AgencyProposalMargin extends AgencyProposalTotals {
  /** Sum of the lines' costs; only the lines that state one contribute. */
  costRial: number;
  /** Subtotal less discount less cost. Tax is collected, not earned. */
  marginRial: number;
  /** How much of the subtotal is the client's own money moving past us. */
  passThroughRial: number;
  lineCount: number;
  /** Lines stating a cost. A margin over an uncosted offer is a guess. */
  costedLineCount: number;
}

/**
 * INTERNAL — never render this on a client-facing screen.
 *
 * The margin is computed *before* the offer is sent, which is the whole reason
 * `cost_rial` exists: an agency that cannot see its own margin on a media buy is
 * guessing at whether the work is worth taking.
 *
 * `marginRial` is subtotal − discount − cost. Tax is deliberately excluded from
 * both sides: it is collected on behalf of the authority and is neither revenue
 * nor cost, so including it would inflate every margin by the same dishonest
 * amount. The discount *is* subtracted, because a discount is a real reduction in
 * what the agency earns and ignoring it would overstate the margin on exactly the
 * offers where the margin is thinnest.
 *
 * `passThroughRial` answers §D's gross-versus-net question for this offer: how
 * much of the figure is the agency's own revenue and how much is the client's
 * money passing through. Nothing here posts it and account ۱۲۷۰ is still
 * unreached — but the decision is made and recorded at offer time, which is the
 * only moment anybody actually knows the answer.
 */
export function agencyProposalMargin(
  lines: readonly Pick<AgencyProposalLine, "amountRial" | "costRial" | "passThrough">[],
  discountRial: number,
  taxRial: number,
): AgencyProposalMargin {
  const totals = agencyProposalTotals(lines, discountRial, taxRial);
  let costRial = 0;
  let passThroughRial = 0;
  let costedLineCount = 0;
  for (const line of lines) {
    if (typeof line.costRial === "number") {
      costRial += line.costRial;
      costedLineCount += 1;
    }
    if (line.passThrough) passThroughRial += line.amountRial;
  }
  return {
    ...totals,
    costRial,
    marginRial: totals.subtotalRial - totals.discountRial - costRial,
    passThroughRial,
    lineCount: lines.length,
    costedLineCount,
  };
}

// ---------------------------------------------------------------------------
// The client boundary
// ---------------------------------------------------------------------------

/**
 * One line as a client may see it.
 *
 * There is no `costRial`, no `passThrough` and no `revenueCode` here, and that
 * absence is the enforcement. The revenue code is excluded too, though it is not
 * secret: it is an internal account number from the agency's own chart, and
 * printing «۴۶۶۰» on a client's quote is noise that invites a question about the
 * agency's bookkeeping.
 */
export interface AgencyProposalClientLine {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceRial: number;
  amountRial: number;
  note: string;
}

/**
 * The offer as the client is entitled to see it, and the only shape that may
 * cross to a client-facing screen: the future review portal (§A's P2 "customer
 * review portal as a separately permissioned feature") and #1127's proposal and
 * service-quote print templates both render from this.
 *
 * `status` is absent on purpose. A print template renders the *offer*; what the
 * agency's records say later happened to it is the agency's business, and a
 * printed quote marked «ردشده» would be a document the client never saw.
 */
export interface AgencyProposalClientView {
  proposalNumber: string;
  title: string;
  agencyName: string;
  clientName: string;
  scopeOfWork: string;
  terms: string;
  /** `null` when the offer is open until the agency says otherwise. */
  validUntilIso: string | null;
  lines: AgencyProposalClientLine[];
  totals: AgencyProposalTotals;
}

export function agencyProposalClientLines(
  lines: readonly AgencyProposalLine[],
): AgencyProposalClientLine[] {
  return lines.map((line) => ({
    lineNumber: line.lineNumber,
    description: line.description,
    quantity: line.quantity,
    unitPriceRial: line.unitPriceRial,
    amountRial: line.amountRial,
    note: line.note,
  }));
}

/** What the projection needs from a proposal row — no internal field is asked for. */
export interface AgencyProposalClientSource {
  proposalNumber: string;
  title: string;
  scopeOfWork: string;
  terms: string;
  validUntilIso: string | null;
  discountRial: number;
  taxRial: number;
  clientName: string;
  agencyName: string;
}

export function agencyProposalClientView(
  proposal: AgencyProposalClientSource,
  lines: readonly AgencyProposalLine[],
): AgencyProposalClientView {
  return {
    proposalNumber: proposal.proposalNumber,
    title: proposal.title,
    agencyName: proposal.agencyName,
    clientName: proposal.clientName,
    scopeOfWork: proposal.scopeOfWork,
    terms: proposal.terms,
    validUntilIso: proposal.validUntilIso,
    lines: agencyProposalClientLines(lines),
    totals: agencyProposalTotals(lines, proposal.discountRial, proposal.taxRial),
  };
}
