/**
 * The campaign as it ran — its lifecycle, its channels, and the arithmetic §C
 * asks for (issue #1128 §A "concurrent campaigns", §C "spend/reach/CPL/CPA/ROAS
 * with defensible attribution").
 *
 * Pure, like `agency-brief.ts` and `agency-proposal.ts`: no `db`, no `next/*`, no
 * clock. Everything here is a decision about words and arithmetic that a screen,
 * a service and a test all need to agree on, so it lives in one place that can be
 * tested without a database.
 *
 * ## Not `growth_campaigns`, and the reason is worth repeating here
 *
 * That table is #901's retail cashback automation — trigger `pos_sale_settled`,
 * reward `cashback`, basis `net_paid`. The party in it is the shopper earning
 * money back, not a client an agency serves. Migration 0278's header records the
 * full argument; the short version is that giving `growth_campaigns` a client
 * column would have made one column mean two things in two trades.
 *
 * ## The metrics are derived here and never stored
 *
 * CTR, CPL, CPA and ROAS are ratios of figures that *are* stored. Computing them
 * in the database or persisting them would create a second copy that can disagree
 * with the first, and a report that shows a CPL the spend and lead count do not
 * produce is worse than no CPL. So the columns hold counts and money; this module
 * holds the division.
 *
 * ## A ratio with no denominator is `null`, not `0`
 *
 * That is the single most important rule here. A campaign with 400,000 rials of
 * spend and no recorded leads has no CPL — it does not have a CPL of zero, which
 * would read as "the cheapest leads anyone has ever bought". §C demands
 * *defensible* attribution, and the first defence is refusing to invent a number
 * the inputs do not support. Every metric below returns `null` when its
 * denominator is zero, and the screen renders «—» for it.
 */

import {
  AGENCY_BRIEF_CHANNEL_LIMIT,
  AGENCY_BRIEF_CHANNELS,
  AGENCY_BRIEF_CHANNEL_LABELS,
  isAgencyBriefChannel,
  type AgencyBriefChannel,
} from "./agency-brief";
import { isValidIsoDate } from "./iso-date";

/**
 * The channels a campaign ran on are the channels a brief could ask for.
 *
 * Re-exported rather than re-listed, because a campaign that ran on a channel its
 * brief never named is a conversation a member needs to be able to have — and two
 * vocabularies would make that comparison impossible to write. Anything an
 * individual agency calls a channel that is not here goes in `other` plus the
 * note, which is 0274's rule and costs a line rather than a migration.
 */
export const AGENCY_CAMPAIGN_CHANNELS = AGENCY_BRIEF_CHANNELS;
export type AgencyCampaignChannel = AgencyBriefChannel;
export const AGENCY_CAMPAIGN_CHANNEL_LABELS = AGENCY_BRIEF_CHANNEL_LABELS;
export const AGENCY_CAMPAIGN_CHANNEL_LIMIT = AGENCY_BRIEF_CHANNEL_LIMIT;
export const isAgencyCampaignChannel = isAgencyBriefChannel;

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

export const AGENCY_CAMPAIGN_STATUSES = [
  "planned",
  "running",
  "paused",
  "completed",
  "cancelled",
] as const;

export type AgencyCampaignStatus = (typeof AGENCY_CAMPAIGN_STATUSES)[number];

export const AGENCY_CAMPAIGN_STATUS_LABELS: Record<AgencyCampaignStatus, string> = {
  planned: "برنامه‌ریزی‌شده",
  running: "در حال اجرا",
  paused: "متوقف موقت",
  completed: "پایان‌یافته",
  cancelled: "لغوشده",
};

/** Tones for `StatusBadge`, matching the register the other agency screens use. */
export const AGENCY_CAMPAIGN_STATUS_TONES: Record<
  AgencyCampaignStatus,
  "neutral" | "active" | "positive" | "danger"
> = {
  planned: "neutral",
  running: "active",
  paused: "neutral",
  completed: "positive",
  cancelled: "danger",
};

export const AGENCY_CAMPAIGN_ACTIONS = ["start", "pause", "resume", "complete", "cancel"] as const;

export type AgencyCampaignAction = (typeof AGENCY_CAMPAIGN_ACTIONS)[number];

export const AGENCY_CAMPAIGN_ACTION_LABELS: Record<AgencyCampaignAction, string> = {
  start: "آغاز اجرا",
  pause: "توقف موقت",
  resume: "ادامه",
  complete: "پایان",
  cancel: "لغو",
};

/**
 * Which status each action lands on, and from where it may be taken.
 *
 * `completed` and `cancelled` are terminal and appear as no action's *target* from
 * themselves. 0278 enforces this too, because a status change that reopens a
 * closed campaign makes every report that cited its figures wrong and — unlike a
 * proposal — there is no client-facing document to supersede. A correction is a
 * new campaign that points at the old one.
 */
export const AGENCY_CAMPAIGN_TRANSITIONS: Record<
  AgencyCampaignStatus,
  readonly AgencyCampaignAction[]
> = {
  planned: ["start", "cancel"],
  running: ["pause", "complete", "cancel"],
  paused: ["resume", "cancel"],
  completed: [],
  cancelled: [],
};

export const AGENCY_CAMPAIGN_ACTION_TARGET: Record<AgencyCampaignAction, AgencyCampaignStatus> = {
  start: "running",
  pause: "paused",
  resume: "running",
  complete: "completed",
  cancel: "cancelled",
};

export function isAgencyCampaignStatus(value: unknown): value is AgencyCampaignStatus {
  return (
    typeof value === "string" &&
    (AGENCY_CAMPAIGN_STATUSES as readonly string[]).includes(value)
  );
}

export function isAgencyCampaignAction(value: unknown): value is AgencyCampaignAction {
  return (
    typeof value === "string" &&
    (AGENCY_CAMPAIGN_ACTIONS as readonly string[]).includes(value)
  );
}

export function campaignStatusLabel(status: AgencyCampaignStatus): string {
  return AGENCY_CAMPAIGN_STATUS_LABELS[status];
}

export function campaignStatusTone(status: AgencyCampaignStatus) {
  return AGENCY_CAMPAIGN_STATUS_TONES[status];
}

/** Closed means its figures were reported and can no longer change. */
export function isAgencyCampaignClosed(status: AgencyCampaignStatus): boolean {
  return status === "completed" || status === "cancelled";
}

/** Editable is everything that is not closed — 0278's freeze boundary. */
export function isAgencyCampaignEditable(status: AgencyCampaignStatus): boolean {
  return !isAgencyCampaignClosed(status);
}

/** Only a campaign that never ran may be deleted; 0278 refuses the rest. */
export function isAgencyCampaignDeletable(status: AgencyCampaignStatus): boolean {
  return status === "planned";
}

/**
 * Carrying money or attention right now.
 *
 * A paused campaign is still live: its budget is committed, its channels are
 * booked, and un-pausing it is one click. Excluding it would understate what the
 * agency has going, which is the number a member is asking for when they ask how
 * much is in flight.
 */
export function isAgencyCampaignInFlight(status: AgencyCampaignStatus): boolean {
  return status === "running" || status === "paused";
}

/** What a status change needs from the member before it may happen. */
export function campaignActionRequiresWindow(action: AgencyCampaignAction): "start" | "end" | null {
  // 0278 CHECKs these, so the screen can say it in words first: a member who
  // clicks «آغاز اجرا» on a campaign with no start date otherwise gets a
  // database error for what is simply an unfinished record.
  if (action === "start" || action === "resume") return "start";
  if (action === "complete") return "end";
  return null;
}

export function agencyCampaignActions(status: AgencyCampaignStatus): AgencyCampaignAction[] {
  return [...AGENCY_CAMPAIGN_TRANSITIONS[status]];
}

/* -------------------------------------------------------------------------- */
/* Metrics source                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where the figures came from, and deliberately only two answers.
 *
 * §C forbids "fake campaign performance or integrations", and no ad-platform
 * connection exists in this codebase — so there is no `platform` value, because
 * there is no platform to have come from. `manual` is a member typing what a
 * platform's dashboard showed them; `imported` is a member pasting or uploading
 * that platform's own export. The difference matters for trust, and the CHECK in
 * 0278 is the one place the vocabulary cannot drift out of date.
 */
export const AGENCY_CAMPAIGN_METRICS_SOURCES = ["manual", "imported"] as const;

export type AgencyCampaignMetricsSource = (typeof AGENCY_CAMPAIGN_METRICS_SOURCES)[number];

export const AGENCY_CAMPAIGN_METRICS_SOURCE_LABELS: Record<AgencyCampaignMetricsSource, string> = {
  manual: "ثبت دستی",
  imported: "ورود از گزارش پلتفرم",
};

export function isAgencyCampaignMetricsSource(
  value: unknown,
): value is AgencyCampaignMetricsSource {
  return (
    typeof value === "string" &&
    (AGENCY_CAMPAIGN_METRICS_SOURCES as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Derived metrics                                                             */
/* -------------------------------------------------------------------------- */

export interface AgencyCampaignMetricInputs {
  spendRial: number;
  budgetRial: number | null;
  impressions: number;
  clicks: number;
  leadsGenerated: number;
  conversions: number;
  revenueRial: number | null;
}

export interface AgencyCampaignMetrics {
  /** Click-through rate in percent, or `null` with no impressions to click on. */
  ctrPct: number | null;
  /** Cost per lead in rial, or `null` when no lead is recorded. */
  cplRial: number | null;
  /** Cost per conversion in rial, or `null` when no conversion is recorded. */
  cpaRial: number | null;
  /** Attributed revenue over spend, or `null` when either side is missing. */
  roas: number | null;
}

/**
 * The four ratios §C names, from the stored counts and money.
 *
 * Every one is `null` when its denominator is zero. See the header: a CPL of 0
 * for a campaign that recorded no leads would read as the best result the agency
 * ever had, and §C's word for that is "fake". `null` renders as «—», which is the
 * honest picture of a figure nobody has.
 *
 * ROAS needs *both* sides: attributed revenue is nullable because "we do not know
 * yet" and "zero" are different claims, and a campaign with no revenue claim has
 * no ROAS rather than a ROAS of zero.
 */
export function agencyCampaignMetrics(input: AgencyCampaignMetricInputs): AgencyCampaignMetrics {
  const { spendRial, impressions, clicks, leadsGenerated, conversions, revenueRial } = input;
  return {
    ctrPct: impressions > 0 ? round2((clicks / impressions) * 100) : null,
    cplRial: leadsGenerated > 0 ? Math.round(spendRial / leadsGenerated) : null,
    cpaRial: conversions > 0 ? Math.round(spendRial / conversions) : null,
    roas:
      spendRial > 0 && revenueRial !== null && revenueRial > 0
        ? round2(revenueRial / spendRial)
        : null,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** How a campaign's spend sits against the budget the client agreed. */
export type AgencyCampaignBudgetState = "unbudgeted" | "under" | "at" | "over";

export interface AgencyCampaignBudget {
  state: AgencyCampaignBudgetState;
  /** What is left, or — when over — how far past. Always a non-negative rial. */
  differenceRial: number;
  /** 0–100+ when a budget exists, so a bar can be drawn without re-deriving it. */
  percentOfBudget: number | null;
}

export const AGENCY_CAMPAIGN_BUDGET_STATE_LABELS: Record<AgencyCampaignBudgetState, string> = {
  unbudgeted: "بدون بودجهٔ ثبت‌شده",
  under: "زیر بودجه",
  at: "روی بودجه",
  over: "فراتر از بودجه",
};

/**
 * Spend against budget.
 *
 * 0278 deliberately does **not** CHECK `spend_rial <= budget_rial`, because a
 * campaign that overran its media budget did so and refusing the true figure
 * would push it into a note where no report can see it. So the overrun is a state
 * this function reports and the screen flags, not a row the database rejects — and
 * "over" is a first-class answer here rather than an error case.
 */
export function agencyCampaignBudget(
  budgetRial: number | null,
  spendRial: number,
): AgencyCampaignBudget {
  if (budgetRial === null || budgetRial <= 0) {
    return { state: "unbudgeted", differenceRial: 0, percentOfBudget: null };
  }
  const percentOfBudget = round2((spendRial / budgetRial) * 100);
  if (spendRial > budgetRial) {
    return { state: "over", differenceRial: spendRial - budgetRial, percentOfBudget };
  }
  if (spendRial === budgetRial) return { state: "at", differenceRial: 0, percentOfBudget };
  return { state: "under", differenceRial: budgetRial - spendRial, percentOfBudget };
}

/* -------------------------------------------------------------------------- */
/* The window                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Is this campaign on air on a given day?
 *
 * Inclusive at both ends, so a campaign that starts today is current today and one
 * that ends today is still current today — the calendar a member reads says
 * «running» on the first and last day, not the day after. A campaign with no
 * window cannot be current whatever its status: `running` without a start date is
 * refused by 0278, and `planned` with no dates has nothing to be current *on*.
 */
export function isAgencyCampaignCurrent(
  status: AgencyCampaignStatus,
  startDateIso: string | null,
  endDateIso: string | null,
  todayIso: string,
): boolean {
  if (!isAgencyCampaignInFlight(status)) return false;
  if (!startDateIso) return false;
  if (startDateIso > todayIso) return false;
  if (endDateIso && endDateIso < todayIso) return false;
  return true;
}

/**
 * A window whose end precedes its start, or `null` when it is usable.
 *
 * 0278 CHECKs this, but the service validates first so the member gets «تاریخ
 * پایان پیش از تاریخ آغاز» rather than a database refusal — the same split the
 * proposal service uses, where the CHECK is the structural backstop and the words
 * live in code.
 */
export function agencyCampaignWindowProblem(
  startDateIso: string | null,
  endDateIso: string | null,
): "window_reversed" | null {
  if (!startDateIso || !endDateIso) return null;
  return endDateIso < startDateIso ? "window_reversed" : null;
}

/* -------------------------------------------------------------------------- */
/* Numbers and words                                                           */
/* -------------------------------------------------------------------------- */

export const CAMPAIGN_NUMBER_PREFIX = "CA";

export const AGENCY_CAMPAIGN_TITLE_LIMIT = 200;
export const AGENCY_CAMPAIGN_OBJECTIVE_LIMIT = 2000;
export const AGENCY_CAMPAIGN_NOTE_LIMIT = 4000;
export const AGENCY_CAMPAIGN_METRICS_NOTE_LIMIT = 2000;
export const AGENCY_CAMPAIGN_OWNER_NAME_LIMIT = 200;

/** Counters are bigint/integer in 0278; these keep a pasted figure inside them. */
export const AGENCY_CAMPAIGN_IMPRESSIONS_MAX = 1_000_000_000_000;
export const AGENCY_CAMPAIGN_CLICKS_MAX = 1_000_000_000_000;
export const AGENCY_CAMPAIGN_COUNT_MAX = 1_000_000_000;
export const AGENCY_CAMPAIGN_RIAL_MAX = 1_000_000_000_000;

/**
 * The Jalali-year guard 0276 introduced, and the reason it is not in `iso-date.ts`.
 *
 * `isValidIsoDate` is calendar-correct and shared, so it is reused rather than
 * re-derived — but `1406-03-01` is a *valid Gregorian date* and passes it, while
 * being an obviously Jalali year typed into a Gregorian field. That silently
 * stores a window seven centuries off, and unlike a bad total it survives every
 * downstream check. So the shared validator answers "is this a date" and this
 * answers "is this a date somebody meant".
 */
export const AGENCY_CAMPAIGN_DATE_YEAR_MIN = 1970;
export const AGENCY_CAMPAIGN_DATE_YEAR_MAX = 2200;

/** A required text field: trimmed, or `null` when it is not usable. */
export function normalizeAgencyCampaignText(
  input: unknown,
  maxLength: number,
): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) return null;
  return trimmed;
}

/** An optional text field: `undefined` and blank both mean "clear it". */
export function normalizeAgencyCampaignOptionalText(
  input: unknown,
  maxLength: number,
): string | null {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Money and counters: a non-negative integer, or `null` when not usable.
 *
 * Strings are accepted because `bigint` and `numeric` arrive from node-postgres as
 * strings and a browser form field is a string too; a float is *rounded*, not
 * refused, because rial is the integer unit and a member typing 1000.4 means 1000.
 * `absentIsZero` distinguishes "not supplied" from "supplied as empty", which is
 * the difference between a PATCH that leaves a figure alone and one that clears it.
 */
export function normalizeAgencyCampaignNumber(
  input: unknown,
  max: number,
  options: { absentIsZero?: boolean; allowFraction?: boolean } = {},
): number | null {
  const absentIsZero = options.absentIsZero ?? false;
  if (input === undefined || input === null || input === "") return absentIsZero ? 0 : null;
  if (typeof input === "boolean") return null;
  const raw = typeof input === "string" ? input.trim() : input;
  if (raw === "") return absentIsZero ? 0 : null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  const integer = options.allowFraction ? value : Math.round(value);
  if (integer > max) return null;
  return integer;
}

/**
 * A nullable money column: `undefined` means "leave it alone", an empty string
 * means "clear it", and a figure means the figure.
 *
 * The distinction is the one 0276 learned the hard way — a normaliser that
 * returned `null` for an absent field turned "omitted" into "refused", and a
 * PATCH that sent only a title would have cleared the budget.
 */
export function normalizeAgencyCampaignNullableRial(
  input: unknown,
  max: number,
): { present: boolean; value: number | null } {
  if (input === undefined) return { present: false, value: null };
  if (input === null || input === "") return { present: true, value: null };
  const value = normalizeAgencyCampaignNumber(input, max);
  return { present: true, value };
}

/** A date: valid on the calendar, and inside the years somebody could mean. */
export function normalizeAgencyCampaignDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!isValidIsoDate(trimmed)) return null;
  const year = Number(trimmed.slice(0, 4));
  if (year < AGENCY_CAMPAIGN_DATE_YEAR_MIN || year > AGENCY_CAMPAIGN_DATE_YEAR_MAX) return null;
  return trimmed;
}

/** A nullable date, with `undefined` meaning "leave it alone". */
export function normalizeAgencyCampaignNullableDate(
  input: unknown,
): { present: boolean; value: string | null } {
  if (input === undefined) return { present: false, value: null };
  if (input === null || input === "") return { present: true, value: null };
  return { present: true, value: normalizeAgencyCampaignDate(input) };
}

/**
 * The channel list: vocabulary-checked, de-duplicated, order preserved, capped.
 *
 * Returns `null` — a refusal, never a silent drop — when any entry is outside the
 * vocabulary or the list is too long. Dropping an unrecognised channel would
 * record a campaign that ran on fewer channels than it did, which is the same
 * class of quiet falsehood as a zero CPL. Order is the member's, because the
 * channel they listed first is usually the one that mattered.
 */
export function normalizeAgencyCampaignChannels(input: unknown): AgencyCampaignChannel[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > AGENCY_CAMPAIGN_CHANNEL_LIMIT) return null;
  const seen = new Set<AgencyCampaignChannel>();
  for (const entry of input) {
    if (!isAgencyCampaignChannel(entry)) return null;
    seen.add(entry);
  }
  // De-duplicate while keeping first-mention order: a member selecting «شبکه‌های
  // اجتماعی» twice means it once, and storing it twice would double-count it in
  // every channel-mix report §C asks for.
  return [...seen];
}
