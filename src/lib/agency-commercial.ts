/**
 * Issue #1128 §D — an agency's commercial registers, as a pure catalogue.
 *
 * §D asks for the money side of a client engagement: estimates and invoices,
 * milestones and deposits, fixed-price engagements, retainers, hourly work,
 * change requests, and a campaign/project P&L that keeps booked figures apart
 * from posted ones. The *invoice* half shipped with the trade itself — a service
 * invoice (`service-invoice.ts`) whose lines are described services crediting
 * the agency's own four revenue accounts. This module is the half that decides
 * **what gets billed, when, and for how much**: a billing schedule on the
 * engagement, and the change requests that move its value.
 *
 * It follows `aec-commercial.ts` (#799 §15–§20) because that file already
 * answered the same questions for a construction contract, and because §D's
 * "never direct ad hoc journal entries" plus #839 §7's "no duplicate accounting
 * semantics" mean one thing here: an agency milestone is not a second kind of
 * money. Four rules are therefore stated once, in this file, and the migration's
 * CHECKs are the backstop rather than a second opinion:
 *
 *   * **Approving a change request moves the *revised* value; it never rewrites
 *     the contract.** The signed number stays on `workspace_contracts.value_rial`
 *     and `revisedContractValueRial` is the only expression that adds approved
 *     requests to it — the same rule §15 states for a variation, for the same
 *     reason: "somebody changed the scope" must never be confusable with
 *     "somebody edited the contract".
 *   * **A milestone is a plan to bill, not a payment.** Nothing here stores a
 *     collected, paid or outstanding balance. Issuing one writes a real service
 *     invoice through `createRetailInvoice` and remembers the order id;
 *     receipts, receivables and cost are read from the ledger by
 *     `commercialReport`, which is what makes the register and the books unable
 *     to disagree.
 *   * **Booked is not posted.** The report keeps the two apart *in its shape* —
 *     `booked` for what the schedule and the change requests say, `posted` for
 *     what the ledger holds — because §D's P&L is only defensible if a reader
 *     can see which half a number came from. A figure that is not known is
 *     `null`, never `0`: "no cost posted yet" and "no cost at all" are different
 *     claims about a campaign.
 *   * **A generated schedule adds up exactly.** Splitting a contract value into
 *     a deposit and three deliverables is a division with a remainder, and the
 *     remainder goes on the last line rather than being spread as rounding dust:
 *     a schedule whose percents sum to 99.99 is a schedule that cannot be
 *     reconciled with its own contract.
 *
 * Framework-free like `agency.ts` and `service-invoice.ts`: no `pg`, no Next and
 * no clock in the arithmetic (dates arrive as arguments), so a panel previews
 * the same figures the service stores. Nothing here decides a permission — but
 * it does say which acts are *determinations*, so the routes can gate those
 * apart from ordinary edits (§24's rule, which an agency's invoice inherits).
 */
import { toPersianDigits } from "./digits";
import { SERVICE_REVENUE_ACCOUNTS, type ServiceRevenueAccount } from "./service-invoice";

/* ===========================================================================
 * §D's engagement shapes — how the client agreed to pay
 * -------------------------------------------------------------------------
 * These are vocabulary, not structure: the register below expresses all four
 * with the same milestone rows, because a fixed-price engagement is a schedule
 * of one or two deliverables, a retainer is twelve periods, and hourly work is
 * a period billed from tracked time. What the base decides is which schedule
 * `draftScheduleForBase` lays out.
 * ======================================================================== */

export const AGENCY_BILLING_BASES = ["fixed_price", "milestone", "retainer", "hourly"] as const;
export type AgencyBillingBase = (typeof AGENCY_BILLING_BASES)[number];

export const AGENCY_BILLING_BASE_LABELS: Record<AgencyBillingBase, string> = {
  fixed_price: "قیمت ثابت",
  milestone: "پرداخت مرحله‌ای",
  retainer: "رتینر دوره‌ای",
  hourly: "ساعتی و مواد مصرفی",
};

export const AGENCY_BILLING_BASE_DESCRIPTIONS: Record<AgencyBillingBase, string> = {
  fixed_price:
    "یک مبلغ مشخص برای کل کار، معمولاً با پیش‌دریافت و تسویهٔ نهایی هنگام تحویل.",
  milestone:
    "ارزش قرارداد بین مرحله‌های تحویل تقسیم می‌شود و هر مرحله جداگانه صورتحساب می‌شود.",
  retainer:
    "مبلغ ثابت دوره‌ای (ماهانه) برای کار پیوسته؛ هر دوره یک صورتحساب دارد.",
  hourly:
    "بر پایهٔ ساعت کار و هزینه‌های مصرفی؛ دوره‌ها پس از ثبت زمان و هزینه صورتحساب می‌شوند.",
};

export function isAgencyBillingBase(value: unknown): value is AgencyBillingBase {
  return typeof value === "string" && (AGENCY_BILLING_BASES as readonly string[]).includes(value);
}

/**
 * The revenue accounts a billed milestone may credit — the trade's own four,
 * read from `service-invoice.ts` rather than restated here, so the schedule, the
 * invoice screen and the ledger cannot drift apart. Media recharges belong in
 * 4660 and agency fees in 4640; that split is §D's whole point, and it is
 * decided when the milestone is written, not inferred from the amount.
 */
export const AGENCY_MILESTONE_REVENUE_ACCOUNTS: readonly ServiceRevenueAccount[] =
  SERVICE_REVENUE_ACCOUNTS.advertising_agency;

/* ===========================================================================
 * The billing schedule — §D's milestones and deposits
 * ======================================================================== */

export const AGENCY_MILESTONE_KINDS = [
  "deposit",
  "deliverable",
  "retainer_period",
  "final",
] as const;
export type AgencyMilestoneKind = (typeof AGENCY_MILESTONE_KINDS)[number];

export const AGENCY_MILESTONE_KIND_LABELS: Record<AgencyMilestoneKind, string> = {
  deposit: "پیش‌دریافت",
  deliverable: "مرحلهٔ تحویل",
  retainer_period: "دورهٔ رتینر",
  final: "تسویهٔ نهایی",
};

export const AGENCY_MILESTONE_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "invoiced",
  "rejected",
  "cancelled",
] as const;
export type AgencyMilestoneStatus = (typeof AGENCY_MILESTONE_STATUSES)[number];

export const AGENCY_MILESTONE_STATUS_LABELS: Record<AgencyMilestoneStatus, string> = {
  draft: "پیش‌نویس",
  submitted: "در انتظار تأیید",
  approved: "تأییدشده — قابل صدور",
  invoiced: "صورتحساب صادر شد",
  rejected: "رد‌شده",
  cancelled: "لغوشده",
};

const MILESTONE_TRANSITIONS: Record<AgencyMilestoneStatus, readonly AgencyMilestoneStatus[]> = {
  // A draft is the plan being written; asking to bill it is the first act.
  draft: ["submitted", "cancelled"],
  // Decided through the workspace's own approvals queue (`billing_milestone`),
  // under `workspace.approve` — never by the person who wrote the schedule.
  submitted: ["approved", "rejected", "cancelled"],
  // Only `billMilestone` may write `invoiced`, and only from here.
  approved: ["invoiced", "cancelled"],
  // A rejected milestone is re-priced and re-submitted; the refusal stays on the
  // row, because the conversation about it is the record.
  rejected: ["draft", "cancelled"],
  // Terminal: from here the *invoice* owns the money — it is amended or voided
  // in Accounting, and this register reads the outcome rather than duplicating
  // it. A voided invoice leaves the milestone `invoiced` with its order id, and
  // the report shows the reversal as the ledger's fact.
  invoiced: [],
  cancelled: [],
};

/** Pure: may a milestone move from one status to another at all? */
export function canTransitionMilestone(
  from: AgencyMilestoneStatus,
  to: AgencyMilestoneStatus,
): boolean {
  return MILESTONE_TRANSITIONS[from].includes(to);
}

/** The transitions a screen offers, for a status. */
export function milestoneTransitionsFrom(
  from: AgencyMilestoneStatus,
): readonly AgencyMilestoneStatus[] {
  return MILESTONE_TRANSITIONS[from];
}

/**
 * Pure: may a milestone's own fields still be edited?
 *
 * Only while nobody has decided on it. A submitted milestone is what an approver
 * is reading and an approved one is what an invoice will be written from, so
 * editing either would quietly change the thing somebody else agreed to — the
 * way to correct one is the chain's own reopening (a rejected milestone goes
 * back to draft).
 */
export function isEditableMilestone(status: AgencyMilestoneStatus): boolean {
  return status === "draft" || status === "rejected";
}

/** Pure: is this milestone ready to become an invoice? Only an approved one is. */
export function isBillableMilestone(status: AgencyMilestoneStatus): boolean {
  return status === "approved";
}

export function isAgencyMilestoneKind(value: unknown): value is AgencyMilestoneKind {
  return typeof value === "string" && (AGENCY_MILESTONE_KINDS as readonly string[]).includes(value);
}

export function isAgencyMilestoneStatus(value: unknown): value is AgencyMilestoneStatus {
  return (
    typeof value === "string" && (AGENCY_MILESTONE_STATUSES as readonly string[]).includes(value)
  );
}

/** Milestones are numbered per project, like every other register (`MS-001`). */
export const MILESTONE_NUMBER_PREFIX = "MS";

/* ---------------------------------------------------------------------------
 * The amount of a milestone — stated once
 * -------------------------------------------------------------------------
 * Either a percentage of the engagement's *revised* value (so a 30% deposit
 * follows a change request that moved the value) or a fixed Rial amount (a
 * retainer period, an hourly period billed from tracked time). Exactly one: a
 * milestone carrying both would have two answers, and one carrying neither
 * would bill nothing.
 * ------------------------------------------------------------------------ */

/** The percent bounds; the migration CHECKs the same range. */
export const AGENCY_MILESTONE_PERCENT_MIN = 0;
export const AGENCY_MILESTONE_PERCENT_MAX = 100;

export interface AgencyMilestoneAmount {
  /** Percent of the revised contract value, or null when the amount is fixed. */
  percent: number | null;
  /** Whole Rial, or null when the milestone is a percentage of the contract. */
  amountRial: number | null;
}

/** Pure: whole, non-negative Rial that survives a JSON round trip. */
export function isSafeRial(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Pure: exactly one of percent/fixed, each within its own bounds. */
export function isValidMilestoneAmount(amount: AgencyMilestoneAmount): boolean {
  const hasPercent = amount.percent !== null && amount.percent !== undefined;
  const hasFixed = amount.amountRial !== null && amount.amountRial !== undefined;
  if (hasPercent === hasFixed) return false; // both, or neither
  if (hasPercent) {
    const percent = amount.percent as number;
    return (
      typeof percent === "number" &&
      Number.isFinite(percent) &&
      percent > AGENCY_MILESTONE_PERCENT_MIN &&
      percent <= AGENCY_MILESTONE_PERCENT_MAX
    );
  }
  return isSafeRial(amount.amountRial) && (amount.amountRial as number) > 0;
}

/**
 * Pure: what a milestone bills, in whole Rial — or `null` when it cannot be
 * known yet.
 *
 * A percentage of a contract with no value on it is `null`, not `0`: an
 * engagement whose `value_rial` nobody filled in has no amount to bill, and
 * answering zero would let a milestone be issued for nothing instead of being
 * refused with a sentence. The rounding is stated here once — nearest whole
 * Rial, halves away from zero — and the migration's stored figure is written
 * from this expression rather than computed a second time in a panel.
 */
export function milestoneAmountRial(
  amount: AgencyMilestoneAmount,
  revisedContractValueRial: number | null,
): number | null {
  if (!isValidMilestoneAmount(amount)) return null;
  if (amount.amountRial !== null && amount.amountRial !== undefined) return amount.amountRial;
  if (revisedContractValueRial === null || !isSafeRial(revisedContractValueRial)) return null;
  return Math.round((revisedContractValueRial * (amount.percent as number)) / 100);
}

/**
 * Pure: split whole Rial into `parts` shares, with the remainder on the last one.
 *
 * `splitAmountRial(100, 3)` is `[33, 33, 34]`, never `[33.33, 33.33, 33.34]`
 * and never `[33, 33, 33]` with a Rial lost. Money in this product is integer
 * Rial, so a division that does not come out even has to decide where the
 * remainder goes, and deciding it here means a generated schedule, a panel's
 * preview and the stored rows all agree.
 */
export function splitAmountRial(totalRial: number, parts: number): number[] {
  if (!isSafeRial(totalRial) || !Number.isSafeInteger(parts) || parts <= 0) return [];
  const base = Math.floor(totalRial / parts);
  const shares = Array.from({ length: parts }, () => base);
  shares[parts - 1] = totalRial - base * (parts - 1);
  return shares;
}

/**
 * Pure: split 100% into `parts` percents, remainder on the last one, so a
 * schedule's percents always sum to exactly 100.
 *
 * Two decimals are allowed (a 33.33 / 33.33 / 33.34 split of the balance) and
 * the sum is exact rather than approximate, which is what lets the service
 * refuse a schedule that does not add up to its own contract.
 */
export function splitPercent(parts: number): number[] {
  if (!Number.isSafeInteger(parts) || parts <= 0) return [];
  const base = Math.floor(10_000 / parts) / 100;
  const shares = Array.from({ length: parts }, () => base);
  const used = shares.slice(0, parts - 1).reduce((sum, value) => sum + value, 0);
  shares[parts - 1] = Math.round((100 - used) * 100) / 100;
  return shares;
}

/* ---------------------------------------------------------------------------
 * Laying a schedule out from the engagement's base
 * -------------------------------------------------------------------------
 * §D names four ways a client agrees to pay. They are not four tables: they are
 * four schedules of the same milestone rows, and generating one is arithmetic
 * rather than a judgement call, so it lives here where a panel can preview it
 * and the person can still edit every line before anything is stored.
 * ------------------------------------------------------------------------ */

/** A milestone as `draftScheduleForBase` proposes it — nothing is stored yet. */
export interface AgencyMilestoneDraft {
  kind: AgencyMilestoneKind;
  title: string;
  percent: number | null;
  amountRial: number | null;
  /** Months after the engagement's start; 0 = the start itself. */
  dueOffsetMonths: number;
}

export interface AgencyScheduleInput {
  /** The engagement's value — its *revised* one when change requests exist. */
  contractValueRial: number | null;
  /** Retainer: how many periods to lay out (1–60). */
  periods?: number;
  /** Retainer: the amount per period, when it is not the value ÷ periods. */
  periodAmountRial?: number | null;
  /** Fixed price / milestone: the deposit percent, or null/0 for none. */
  depositPercent?: number | null;
  /** Milestone: how many delivery stages the balance is split across (1–24). */
  deliverables?: number;
}

export const AGENCY_SCHEDULE_MAX_PERIODS = 60;
export const AGENCY_SCHEDULE_MAX_DELIVERABLES = 24;

/**
 * Pure: the schedule an engagement's billing base implies, as drafts.
 *
 * Deliberately a *proposal* and never a write: the person editing it may change
 * every line, and a generated schedule that could not be edited would be a
 * template pretending to be a decision. The two invariants it holds are the ones
 * a schedule must hold to be billable — the percents sum to exactly 100 and the
 * amounts sum to exactly the contract value — because both are what the service
 * later checks against the contract, and a preview that broke them would be a
 * preview of a refusal.
 */
export function draftScheduleForBase(
  base: AgencyBillingBase,
  input: AgencyScheduleInput,
): AgencyMilestoneDraft[] {
  const value = isSafeRial(input.contractValueRial) ? input.contractValueRial : null;

  if (base === "retainer") {
    const periods = clampCount(input.periods, 1, AGENCY_SCHEDULE_MAX_PERIODS, 12);
    // An explicit period amount wins — a retainer is usually a number the client
    // agreed to per month, not a division of a total. Without one, the value is
    // split by `splitAmountRial`, which puts the remainder on the *last* period:
    // twelve equal shares of a value that does not divide by twelve would either
    // lose Rial or overbill, and a schedule that does not sum to its own
    // engagement is a schedule the report cannot reconcile.
    const explicit =
      isSafeRial(input.periodAmountRial) && (input.periodAmountRial as number) > 0
        ? (input.periodAmountRial as number)
        : null;
    const shares = explicit === null && value !== null ? splitAmountRial(value, periods) : [];
    return Array.from({ length: periods }, (_, index) => ({
      kind: "retainer_period" as const,
      title: `${AGENCY_MILESTONE_KIND_LABELS.retainer_period} — ${toPersianOrdinal(index + 1)}`,
      percent: null,
      amountRial: explicit !== null ? explicit : (shares[index] ?? null),
      dueOffsetMonths: index,
    }));
  }

  if (base === "hourly") {
    // Nothing to lay out in advance: an hourly engagement bills a period once
    // the time and the pass-through cost in it are known, so the register starts
    // empty and the first draft is written from the tracked period. Laying out
    // twelve empty periods would be twelve rows with no amount, which is exactly
    // the "booked figure with nothing behind it" the report refuses to show.
    return [];
  }

  const depositPercent =
    typeof input.depositPercent === "number" &&
    Number.isFinite(input.depositPercent) &&
    input.depositPercent > 0 &&
    input.depositPercent < AGENCY_MILESTONE_PERCENT_MAX
      ? Math.round(input.depositPercent * 100) / 100
      : null;

  if (base === "fixed_price") {
    const drafts: AgencyMilestoneDraft[] = [];
    if (depositPercent !== null) {
      drafts.push({
        kind: "deposit",
        title: `${AGENCY_MILESTONE_KIND_LABELS.deposit} ${formatPercent(depositPercent)}`,
        percent: depositPercent,
        amountRial: null,
        dueOffsetMonths: 0,
      });
    }
    drafts.push({
      kind: "final",
      title: AGENCY_MILESTONE_KIND_LABELS.final,
      percent: depositPercent === null ? 100 : round2(100 - depositPercent),
      amountRial: null,
      dueOffsetMonths: 1,
    });
    return drafts;
  }

  // `milestone`: the deposit (if any) plus the delivery stages, with the
  // remainder of the value on the last stage so the schedule sums to 100%.
  const stages = clampCount(input.deliverables, 1, AGENCY_SCHEDULE_MAX_DELIVERABLES, 3);
  const drafts: AgencyMilestoneDraft[] = [];
  let remainingPercent = 100;
  if (depositPercent !== null) {
    remainingPercent = round2(remainingPercent - depositPercent);
    drafts.push({
      kind: "deposit",
      title: `${AGENCY_MILESTONE_KIND_LABELS.deposit} ${formatPercent(depositPercent)}`,
      percent: depositPercent,
      amountRial: null,
      dueOffsetMonths: 0,
    });
  }
  const stagePercents = splitPercentOf(remainingPercent, stages);
  stagePercents.forEach((percent, index) => {
    const isLast = index === stagePercents.length - 1;
    drafts.push({
      kind: isLast ? "final" : "deliverable",
      title: isLast
        ? AGENCY_MILESTONE_KIND_LABELS.final
        : `${AGENCY_MILESTONE_KIND_LABELS.deliverable} ${toPersianOrdinal(index + 1)}`,
      percent,
      amountRial: null,
      // A stage is due after the work, so the first one lands a month in.
      dueOffsetMonths: index + 1,
    });
  });
  return drafts;
}

/** Pure: split an arbitrary percent total into `parts`, remainder on the last. */
export function splitPercentOf(total: number, parts: number): number[] {
  if (!Number.isFinite(total) || total <= 0 || !Number.isSafeInteger(parts) || parts <= 0) {
    return [];
  }
  const scaled = Math.round(total * 100);
  const base = Math.floor(scaled / parts);
  const shares = Array.from({ length: parts }, () => base);
  shares[parts - 1] = scaled - base * (parts - 1);
  return shares.map((value) => value / 100);
}

/**
 * Pure: what a schedule comes to, so a panel can refuse one that does not add up
 * to its own engagement before anybody stores it.
 *
 * `unallocatedPercent` is what is left of 100 once every percentage milestone is
 * counted; `fixedTotalRial` is the sum of the fixed ones. A schedule mixing the
 * two is legitimate (a fixed retainer period beside a percentage deposit is
 * unusual but not wrong), so this reports both rather than judging them.
 */
export function scheduleTotals(drafts: readonly AgencyMilestoneDraft[]): {
  unallocatedPercent: number;
  fixedTotalRial: number;
  count: number;
} {
  let percent = 0;
  let fixed = 0;
  for (const draft of drafts) {
    if (draft.percent !== null) percent += draft.percent;
    else if (draft.amountRial !== null) fixed += draft.amountRial;
  }
  return { unallocatedPercent: round2(100 - percent), fixedTotalRial: fixed, count: drafts.length };
}

/* ---------------------------------------------------------------------------
 * Dates — a retainer's periods, without a clock in the arithmetic
 * ------------------------------------------------------------------------ */

/**
 * Pure: add calendar months to an ISO date, clamping the day to the month's
 * last day (31 Farvardin-equivalents aside, `2026-01-31` + 1 month is
 * `2026-02-28`). A retainer period that slips to the 1st of March because
 * February has no 31st would bill the client on a date nobody agreed to.
 */
export function addMonthsIso(iso: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match || !Number.isSafeInteger(months)) return iso;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const paddedMonth = String(targetMonth).padStart(2, "0");
  const paddedDay = String(Math.min(day, lastDay)).padStart(2, "0");
  return `${targetYear}-${paddedMonth}-${paddedDay}`;
}

/** One period of a retainer: the day it starts and the day before the next one. */
export interface AgencyRetainerPeriod {
  index: number;
  startIso: string;
  endIso: string;
}

/**
 * Pure: the periods a retainer covers, from its start date.
 *
 * A period is a month long and ends the day before the next begins, so twelve
 * periods from `1405-01-01`'s ISO equivalent cover exactly a year with no gap
 * and no overlap — the thing a client disputes first about a retainer invoice.
 */
export function retainerPeriods(startIso: string, count: number): AgencyRetainerPeriod[] {
  const periods = clampCount(count, 1, AGENCY_SCHEDULE_MAX_PERIODS, 0);
  if (periods === 0) return [];
  return Array.from({ length: periods }, (_, index) => ({
    index: index + 1,
    startIso: addMonthsIso(startIso, index),
    endIso: addDaysIso(addMonthsIso(startIso, index + 1), -1),
  }));
}

/** Pure: add days to an ISO date (UTC, so a Shamsi day cannot shift). */
export function addDaysIso(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms) || !Number.isSafeInteger(days)) return iso;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/* ===========================================================================
 * §D's change requests — the agency's variation
 * ======================================================================== */

export const AGENCY_CHANGE_REQUEST_STATUSES = [
  "draft",
  "priced",
  "submitted",
  "approved",
  "rejected",
  "implemented",
  "withdrawn",
] as const;
export type AgencyChangeRequestStatus = (typeof AGENCY_CHANGE_REQUEST_STATUSES)[number];

export const AGENCY_CHANGE_REQUEST_STATUS_LABELS: Record<AgencyChangeRequestStatus, string> = {
  draft: "پیش‌نویس",
  priced: "قیمت‌گذاری‌شده",
  submitted: "ارسال‌شده به کارفرما",
  approved: "تأییدشده",
  rejected: "رد‌شده",
  implemented: "اعمال‌شده",
  withdrawn: "پس‌گرفته‌شده",
};

const CHANGE_REQUEST_TRANSITIONS: Record<
  AgencyChangeRequestStatus,
  readonly AgencyChangeRequestStatus[]
> = {
  draft: ["priced", "withdrawn"],
  priced: ["submitted", "withdrawn"],
  submitted: ["approved", "rejected", "withdrawn"],
  approved: ["implemented"],
  rejected: ["priced", "withdrawn"],
  implemented: [],
  withdrawn: [],
};

export function canTransitionChangeRequest(
  from: AgencyChangeRequestStatus,
  to: AgencyChangeRequestStatus,
): boolean {
  return CHANGE_REQUEST_TRANSITIONS[from].includes(to);
}

export function changeRequestTransitionsFrom(
  from: AgencyChangeRequestStatus,
): readonly AgencyChangeRequestStatus[] {
  return CHANGE_REQUEST_TRANSITIONS[from];
}

/**
 * Pure: may a change request's own fields still be edited?
 *
 * Draft, priced and rejected — the three states where nobody outside the agency
 * has committed to the number. Once it is submitted the client is reading it,
 * and once it is approved it has moved the contract's revised value, so editing
 * either would rewrite a decision after the fact. A rejected request is re-priced
 * and re-submitted; the refusal stays on the row.
 */
export function isEditableChangeRequest(status: AgencyChangeRequestStatus): boolean {
  return status === "draft" || status === "priced" || status === "rejected";
}

/**
 * Pure: which statuses move the engagement's revised value.
 *
 * Approved and implemented — and only those. A priced request is an intention
 * and a submitted one is a question; counting either would report revenue the
 * client has not agreed to, which is the exact mistake §D's "distinguish
 * booked/forecast metrics from posted accounting facts" is about.
 */
export function changeRequestMovesContractValue(status: AgencyChangeRequestStatus): boolean {
  return status === "approved" || status === "implemented";
}

export function isAgencyChangeRequestStatus(value: unknown): value is AgencyChangeRequestStatus {
  return (
    typeof value === "string" &&
    (AGENCY_CHANGE_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

/** Change requests are numbered per project (`CR-001`). */
export const CHANGE_REQUEST_NUMBER_PREFIX = "CR";

/**
 * An amount that may be negative: a change request that descopes a deliverable
 * reduces the engagement, and forcing that into a positive number plus a
 * separate "credit" flag is how a register ends up with two columns that must
 * agree. Zero is refused — a change worth nothing is not a change.
 */
export function isSignedRial(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
}

/**
 * Pure: what the engagement is worth now.
 *
 * The original value plus the approved change requests — the one expression, so
 * the register, the report, the panel and the migration's stored figure cannot
 * disagree. `null` in, `null` out: an engagement nobody priced has no revised
 * value either, and answering `0` would make a percentage milestone billable
 * for nothing.
 */
export function revisedContractValueRial(
  originalRial: number | null,
  approvedAmountsRial: readonly number[],
): number | null {
  if (originalRial === null || !isSafeRial(originalRial)) return null;
  const change = approvedAmountsRial.reduce((sum, value) => sum + value, 0);
  const revised = originalRial + change;
  // A descope larger than the contract is a data error, not a negative
  // engagement: refuse to report a value below zero rather than letting every
  // percentage milestone in the schedule silently become a credit.
  return revised < 0 ? null : revised;
}

/* ===========================================================================
 * The actions each chain offers, and which of them are determinations
 * -------------------------------------------------------------------------
 * §24's rule, inherited rather than restated: writing a register is ordinary
 * project work (`workspace.manage`), and *deciding* — submitting for approval,
 * approving, rejecting, issuing an invoice — is `workspace.approve`, the key no
 * role below manager holds by preset. The routes read this list, so the split is
 * stated once here rather than in six handlers.
 *
 * Issuing an invoice is a determination **and** a money act: the route gates it
 * on `workspace.approve` plus the same permissions the invoice screen itself
 * requires (`canUsePos`), so a project manager who cannot take payments cannot
 * issue an invoice through the workspace door instead.
 * ======================================================================== */

export interface AgencyCommercialAction {
  action: string;
  label: string;
  target: AgencyMilestoneStatus | AgencyChangeRequestStatus;
  /** True when the act is a decision rather than an edit. */
  determination: boolean;
  /**
   * The statuses this act is offered from, when the target alone does not say.
   *
   * Only one pair needs it: `price` and `reprice` both land on `priced`, and
   * without an origin a draft change request would offer two buttons for the
   * same move — one of them worded «قیمت‌گذاری دوباره» on a request that was
   * never priced. The act is the same; the sentence a person reads is not, and
   * the sentence is the reason both exist.
   */
  from?: readonly (AgencyMilestoneStatus | AgencyChangeRequestStatus)[];
}

export const AGENCY_MILESTONE_ACTIONS: readonly AgencyCommercialAction[] = [
  { action: "submit", label: "ارسال برای تأیید", target: "submitted", determination: true },
  { action: "approve", label: "تأیید مرحله", target: "approved", determination: true },
  { action: "reject", label: "رد مرحله", target: "rejected", determination: true },
  { action: "invoice", label: "صدور صورتحساب", target: "invoiced", determination: true },
  { action: "reopen", label: "بازگردانی به پیش‌نویس", target: "draft", determination: false },
  { action: "cancel", label: "لغو مرحله", target: "cancelled", determination: true },
];

export const AGENCY_CHANGE_REQUEST_ACTIONS: readonly AgencyCommercialAction[] = [
  { action: "price", label: "قیمت‌گذاری", target: "priced", determination: false, from: ["draft"] },
  { action: "submit", label: "ارسال به کارفرما", target: "submitted", determination: true },
  { action: "approve", label: "تأیید تغییر", target: "approved", determination: true },
  { action: "reject", label: "رد تغییر", target: "rejected", determination: true },
  { action: "implement", label: "اعمال تغییر", target: "implemented", determination: false },
  {
    action: "reprice",
    label: "قیمت‌گذاری دوباره",
    target: "priced",
    determination: false,
    from: ["rejected"],
  },
  { action: "withdraw", label: "پس‌گرفتن", target: "withdrawn", determination: true },
];

/** The actions that need `workspace.approve` rather than `workspace.manage`. */
export function agencyCommercialDeterminationActions(
  actions: readonly AgencyCommercialAction[],
): string[] {
  return actions.filter((entry) => entry.determination).map((entry) => entry.action);
}

/**
 * The acts a milestone can take from where it is, as the catalogue's own rows.
 *
 * Derived from the transition table rather than kept beside it: a screen's
 * buttons and the service's refusal then cannot disagree, and a status added to
 * the chain needs no second list updating. An `invoiced` or `cancelled`
 * milestone answers with none, which is what makes the end of the chain visible
 * instead of merely enforced.
 */
export function milestoneActionsFrom(status: AgencyMilestoneStatus): AgencyCommercialAction[] {
  if (!isAgencyMilestoneStatus(status)) return [];
  return actionsAvailable(AGENCY_MILESTONE_ACTIONS, status, milestoneTransitionAllows);
}

/** The acts a change request can take from where it is. Same derivation. */
export function changeRequestActionsFrom(
  status: AgencyChangeRequestStatus,
): AgencyCommercialAction[] {
  if (!isAgencyChangeRequestStatus(status)) return [];
  return actionsAvailable(AGENCY_CHANGE_REQUEST_ACTIONS, status, changeRequestTransitionAllows);
}

/** Whether one chain allows a move, asked of two plain strings. */
type TransitionAllows = (from: string, to: string) => boolean;

/**
 * The two chains share four status names — `draft`, `submitted`, `approved` and
 * `rejected` mean the same thing in both — so *which* chain a status belongs to
 * cannot be inferred from the status. Asking `isAgencyMilestoneStatus("draft")`
 * answers true for a change request's draft too, and an act would then be
 * checked against the wrong table: a draft change request would offer the
 * milestone chain's `submit`, skipping the pricing step that is the whole
 * reason `priced` exists between them. The chain is therefore named by the
 * caller, and each predicate guards its own types.
 */
const milestoneTransitionAllows: TransitionAllows = (from, to) =>
  isAgencyMilestoneStatus(from) && isAgencyMilestoneStatus(to) && canTransitionMilestone(from, to);

const changeRequestTransitionAllows: TransitionAllows = (from, to) =>
  isAgencyChangeRequestStatus(from) &&
  isAgencyChangeRequestStatus(to) &&
  canTransitionChangeRequest(from, to);

/**
 * The one rule both derivations use: this chain allows the move, and — for the
 * two acts that share a target — the act is offered from this status.
 */
function actionsAvailable(
  actions: readonly AgencyCommercialAction[],
  status: string,
  allows: TransitionAllows,
): AgencyCommercialAction[] {
  return actions.filter(
    (entry) => allows(status, entry.target) && (entry.from === undefined || entry.from.includes(status as AgencyMilestoneStatus)),
  );
}

/** Route-body guards: is this one of the acts this register knows? */
export function isAgencyMilestoneAction(value: unknown): value is string {
  return typeof value === "string" && AGENCY_MILESTONE_ACTIONS.some((entry) => entry.action === value);
}

export function isAgencyChangeRequestAction(value: unknown): value is string {
  return (
    typeof value === "string" &&
    AGENCY_CHANGE_REQUEST_ACTIONS.some((entry) => entry.action === value)
  );
}

/**
 * Whether one act needs `workspace.approve` rather than `workspace.manage` —
 * §24's rule, asked by a route that has already validated the name.
 */
export function agencyCommercialActionNeedsApproval(
  actions: readonly AgencyCommercialAction[],
  action: string,
): boolean {
  return actions.some((entry) => entry.action === action && entry.determination);
}

/* ===========================================================================
 * §D's campaign/project P&L — booked apart from posted
 * ======================================================================== */

/**
 * What the registers say: the engagement's value and the plan against it. Every
 * figure here is a *booked* one — it exists because somebody wrote a schedule or
 * approved a change, not because money moved.
 */
export interface AgencyCommercialBooked {
  /** The signed value, as it was written. A change request never rewrites it. */
  contractedRial: number | null;
  /** The sum of the approved and implemented change requests, signed. */
  approvedChangeRial: number;
  /** `contractedRial + approvedChangeRial`, or null when the contract is unpriced. */
  revisedContractRial: number | null;
  /** Approved milestones that have not been invoiced yet — the next money. */
  scheduledRial: number;
  /** Milestones already invoiced, at the amount each was issued for. */
  invoicedRial: number;
  /** What the revised value leaves that the schedule does not yet account for. */
  unscheduledRial: number | null;
}

/**
 * What the ledger says: posted facts, read by project rather than stored here.
 * Each is `null` when nothing has posted yet — never `0`, because "no revenue
 * posted on this campaign yet" and "this campaign earned nothing" are different
 * claims, and a P&L that cannot tell them apart is a P&L nobody can defend.
 */
export interface AgencyCommercialPosted {
  /** Revenue posted to this project's invoices (the agency's four 46xx accounts). */
  revenueRial: number | null;
  /** Collected against them: receipts and settlements, not promises. */
  collectedRial: number | null;
  /** Still open with the client on this project. */
  receivableRial: number | null;
  /** Direct client cost tagged to the project (the chart's 5196–5199). */
  actualCostRial: number | null;
}

export interface AgencyCommercialReport {
  booked: AgencyCommercialBooked;
  posted: AgencyCommercialPosted;
  /** Posted revenue minus posted cost; null until the ledger knows both. */
  grossMarginRial: number | null;
  /** Margin as a percent of posted revenue; null when either is unknown. */
  grossMarginPercent: number | null;
}

/**
 * Pure: gross margin from the two *posted* figures.
 *
 * Deliberately not from the booked ones: a margin computed from a schedule is a
 * forecast, and §D requires the two to be distinguishable. A report that wants a
 * forecast margin computes it from `booked` and says so in its own label.
 */
export function commercialMargin(
  revenueRial: number | null,
  actualCostRial: number | null,
): { grossMarginRial: number | null; grossMarginPercent: number | null } {
  if (revenueRial === null || actualCostRial === null) {
    return { grossMarginRial: null, grossMarginPercent: null };
  }
  const margin = revenueRial - actualCostRial;
  // A zero revenue base has no margin *rate*; reporting 0% would claim the
  // campaign broke even rather than that it has not billed.
  const percent = revenueRial === 0 ? null : Math.round((margin / revenueRial) * 10_000) / 100;
  return { grossMarginRial: margin, grossMarginPercent: percent };
}

/**
 * Pure: what the schedule leaves unallocated against the revised value.
 *
 * `null` when either side is unknown — the same discipline as the margin, so a
 * panel never shows "۰ ریال باقی‌مانده" for an engagement nobody priced.
 */
export function unscheduledValueRial(
  revisedContractRial: number | null,
  scheduledAndInvoicedRial: number,
): number | null {
  if (revisedContractRial === null) return null;
  return revisedContractRial - scheduledAndInvoicedRial;
}

/* ---------------------------------------------------------------------------
 * Small shared helpers
 * ------------------------------------------------------------------------ */

/**
 * One rule for a count of periods or stages, so a schedule is always the one a
 * person asked for: a count within the bound is honoured, a count above it is
 * cut to it, and anything else — missing, zero, negative, not a whole number —
 * means "no count was asked for" and takes the default.
 *
 * Clamping a zero *up* to the minimum is what this avoids: it would turn "I
 * asked for no delivery stages" into a one-stage engagement, a schedule nobody
 * wrote, and it is the reason `retainerPeriods(…, 0)` answers with a default of
 * zero rather than with a period.
 */
function clampCount(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) return fallback;
  return Math.min(max, value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * «۳۰٪» — the percent as a person reads it, with the Persian percent sign.
 *
 * The decimal separator is Persian too: a Latin full stop between Persian
 * digits («۳۳.۳۳٪») is what a half-translated screen looks like, and this
 * module's own percent shares are two-decimal numbers, so the copy it prints
 * has to be right where it is read.
 */
export function formatPercent(percent: number): string {
  return `${toPersianDigits(String(round2(percent))).replace(".", "٫")}٪`;
}

/** «۱»/«۲»/… as an ordinal word for a schedule line («دورهٔ رتینر — ۳»). */
export function toPersianOrdinal(value: number): string {
  return toPersianDigits(String(value));
}
