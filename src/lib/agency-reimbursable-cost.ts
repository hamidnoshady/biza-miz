/**
 * Issue #1128 §D — the vocabulary of money an agency spends on a client's behalf,
 * and the one place that choice becomes two accounts.
 *
 * ## Why the account map lives here and not in the posting rule
 *
 * `presentation` and `settledBy` together decide which two accounts an entry lands
 * in, and that decision is the whole of §D's gross-versus-net requirement. Writing
 * it inside a posting rule would leave it readable only by someone tracing an
 * entry backwards from the ledger; writing it here means the rule, the screen that
 * explains the choice to a member, and the tests that pin it all read the same
 * function. A mis-stated presentation is not a cosmetic bug — it moves money
 * between cost of sales and a claim on a client — so the mapping is exported
 * rather than inlined.
 *
 * Pure and framework-free, like every other agency vocabulary module, so the panel
 * may import it and the browser's explanation of a choice cannot drift from the
 * server's application of it.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { isValidIsoDate } from "./iso-date";

/* ------------------------------------------------------------------------- */
/* Presentation: §D's gross-versus-net choice                                 */
/* ------------------------------------------------------------------------- */

/**
 * The two presentations §D asks a business to choose between.
 *
 * `net` is the default, and the reason is that it keeps the agency's own revenue
 * honest: an unchosen line landing in 5197 overstates cost of sales *and*, at
 * recharge, revenue, and a pair of errors in opposite directions is harder to see
 * than one. §D's requirement is that the choice is made rather than inferred from
 * the spend — which is why this is a stored field and not something computed from
 * the size of a line or the presence of a vendor invoice.
 */
export const AGENCY_PASS_THROUGH_PRESENTATIONS = ["net", "gross"] as const;

export type AgencyPassThroughPresentation = (typeof AGENCY_PASS_THROUGH_PRESENTATIONS)[number];

export const AGENCY_PASS_THROUGH_PRESENTATION_LABELS: Record<AgencyPassThroughPresentation, string> = {
  // The client's money, handled: it is never the agency's cost of sale and never
  // its revenue, so it sits as a claim on the client until it is recharged.
  net: "قابل بازدریافت از کارفرما (خالص) — به حساب ۱۲۷۰",
  // The agency's own buy: it is cost of sales, and the recharge is its revenue.
  gross: "هزینهٔ خود آژانس (ناخالص) — به حساب ۵۱۹۷",
};

/** What each presentation means, in the words a member chooses between. */
export const AGENCY_PASS_THROUGH_PRESENTATION_HINTS: Record<AgencyPassThroughPresentation, string> = {
  net: "پول کارفرما را خرج کرده‌ایم و از او پس می‌گیریم؛ نه درآمد ماست نه هزینهٔ ما.",
  gross: "رسانه را خودمان خریده و به کارفرما فروخته‌ایم؛ هزینهٔ ما و درآمد ماست.",
};

export function isAgencyPassThroughPresentation(
  value: unknown,
): value is AgencyPassThroughPresentation {
  return typeof value === "string" && (AGENCY_PASS_THROUGH_PRESENTATIONS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------- */
/* Settlement: the credit side                                                */
/* ------------------------------------------------------------------------- */

/**
 * How the agency settled the spend, which is the entry's credit side.
 *
 * `payable` is the default because a platform charge arrives before it is paid far
 * more often than an agency settles one at the counter — and because it is the seam
 * §D's vendor chain will use: it credits 2140, which `account-classification.ts`
 * already classifies as a trade payable, so the day the quote → purchase → payable
 * → settlement chain exists it settles *this* row rather than duplicating it.
 */
export const AGENCY_COST_SETTLEMENTS = ["cash", "bank", "payable"] as const;

export type AgencyCostSettlement = (typeof AGENCY_COST_SETTLEMENTS)[number];

export const AGENCY_COST_SETTLEMENT_LABELS: Record<AgencyCostSettlement, string> = {
  cash: "نقدی (صندوق)",
  bank: "بانکی (حساب بانکی)",
  payable: "پرداختنی به رسانه/چاپ/تولید (۲۱۴۰)",
};

export function isAgencyCostSettlement(value: unknown): value is AgencyCostSettlement {
  return typeof value === "string" && (AGENCY_COST_SETTLEMENTS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------- */
/* The choice, as two accounts                                                */
/* ------------------------------------------------------------------------- */

/** The credit account each settlement implies. */
export const AGENCY_COST_SETTLEMENT_ACCOUNTS: Record<AgencyCostSettlement, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  payable: WELL_KNOWN_CODES.agencyMediaVendorPayable,
};

/** The debit account each presentation implies. */
export const AGENCY_PASS_THROUGH_DEBIT_ACCOUNTS: Record<AgencyPassThroughPresentation, string> = {
  net: WELL_KNOWN_CODES.agencyReimbursableClientCost,
  gross: WELL_KNOWN_CODES.agencyMediaCost,
};

export interface ReimbursableCostAccounts {
  /** Debited: 1270 on net, 5197 on gross. */
  debitCode: string;
  /** Credited: the cash, bank-clearing or media-payable account. */
  creditCode: string;
}

/**
 * The two accounts one reimbursable cost lands in.
 *
 * Deliberately total and side-effect free: it takes the two stored choices and
 * returns the pair, so the posting rule cannot invent a third combination and a
 * test can pin the four that exist. Note what it does *not* return — no VAT and no
 * revenue account. A cost the agency paid on somebody's behalf is not a sale, and
 * the recharge that turns it into money for the client is a separate document with
 * its own entry.
 */
export function reimbursableCostAccounts(input: {
  presentation: AgencyPassThroughPresentation;
  settledBy: AgencyCostSettlement;
}): ReimbursableCostAccounts {
  return {
    debitCode: AGENCY_PASS_THROUGH_DEBIT_ACCOUNTS[input.presentation],
    creditCode: AGENCY_COST_SETTLEMENT_ACCOUNTS[input.settledBy],
  };
}

/**
 * Whether 1270 is the account this cost touches.
 *
 * Exported because it is the question §D's reporting has to be able to ask without
 * re-deriving the map: "how much have we spent on clients' behalf that is not our
 * own cost of sales" is `net`, and the answer is a filter over this predicate
 * rather than a second copy of the account codes.
 */
export function isPassThroughToClient(presentation: AgencyPassThroughPresentation): boolean {
  return presentation === "net";
}

/* ------------------------------------------------------------------------- */
/* Posted, and therefore frozen                                               */
/* ------------------------------------------------------------------------- */

/**
 * Whether the ledger already carries this cost.
 *
 * The predicate is the entry id rather than a status column, so "recorded but not
 * yet posted" is a real state and not a failure: a locked fiscal period routes an
 * auto-posted entry to the human-approval queue rather than refusing the spend.
 * Everything 0280 freezes keys off this one fact, because the reason to freeze is
 * that the books carry the figure — not that a human saw it, which is the reason
 * 0274, 0276 and 0278 freeze theirs.
 */
export function isReimbursableCostPosted(entryId: string | null | undefined): boolean {
  return typeof entryId === "string" && entryId.length > 0;
}

/* ------------------------------------------------------------------------- */
/* Limits and normalisers                                                     */
/* ------------------------------------------------------------------------- */

export const COST_NUMBER_PREFIX = "RC";

export const AGENCY_COST_DESCRIPTION_LIMIT = 300;
export const AGENCY_COST_VENDOR_NAME_LIMIT = 200;
export const AGENCY_COST_NOTE_LIMIT = 4000;

/**
 * A cost is a claim on a client, so it has to be a positive amount of something.
 *
 * Zero is refused rather than stored: a zero-rial pass-through is not a claim on
 * anybody, and it would sit in 1270 as a row that can never clear. The bound is
 * `bigint` in 0280, and this is what keeps a pasted figure inside it.
 */
export const AGENCY_COST_AMOUNT_MAX = 9_000_000_000_000_000n;

export interface NormalizedText {
  present: boolean;
  value: string;
  tooLong: boolean;
}

/** Required free text: trimmed, length-checked, and never silently truncated. */
export function normalizeAgencyCostText(value: unknown, limit: number): NormalizedText {
  if (typeof value !== "string") return { present: false, value: "", tooLong: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { present: false, value: "", tooLong: false };
  if ([...trimmed].length > limit) return { present: true, value: trimmed, tooLong: true };
  return { present: true, value: trimmed, tooLong: false };
}

/** Optional free text, where an empty string is a clear rather than a refusal. */
export function normalizeAgencyCostOptionalText(value: unknown, limit: number): NormalizedText {
  if (value === undefined || value === null) return { present: false, value: "", tooLong: false };
  if (typeof value !== "string") return { present: false, value: "", tooLong: false };
  const trimmed = value.trim();
  if ([...trimmed].length > limit) return { present: true, value: trimmed, tooLong: true };
  return { present: true, value: trimmed, tooLong: false };
}

/**
 * A Gregorian calendar year range, not a Jalali one.
 *
 * `isValidIsoDate` is calendar-*aware* — it knows February has 28 or 29 days — but
 * it is shape-based about the year, so a Jalali date such as `1406-03-01` passes it.
 * The bounds are what turn "is this a well-formed date" into "is this a date a
 * member could have meant", and they are the same pair every agency register uses
 * rather than a fifth opinion about what a year is.
 */
export const AGENCY_COST_DATE_YEAR_MIN = 1970;
export const AGENCY_COST_DATE_YEAR_MAX = 2200;

/**
 * The day the money was spent, which is the day the entry is dated.
 *
 * Kept apart from `created_at` because a member records a platform invoice days
 * after the platform charged the card, and the cost belongs to the day it was
 * incurred — the same distinction `businessToday` exists to serve.
 */
export function normalizeAgencyCostDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!isValidIsoDate(trimmed)) return null;
  const year = Number(trimmed.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  if (year < AGENCY_COST_DATE_YEAR_MIN || year > AGENCY_COST_DATE_YEAR_MAX) return null;
  return trimmed;
}

/**
 * The amount, as an integer rial.
 *
 * A string is accepted because `bigint` and `numeric` arrive from Postgres as
 * strings and a form's money input hands back digits; anything fractional is
 * refused rather than rounded, because silently rounding a figure that is about to
 * be posted to the ledger is how a register and its books start to disagree.
 */
export function normalizeAgencyCostAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value.trim() : value;
  if (typeof text === "number") {
    if (!Number.isFinite(text) || !Number.isInteger(text) || text <= 0) return null;
    return BigInt(text) > AGENCY_COST_AMOUNT_MAX ? null : text;
  }
  if (typeof text !== "string" || !/^\d+$/.test(text)) return null;
  const parsed = BigInt(text);
  if (parsed <= 0n || parsed > AGENCY_COST_AMOUNT_MAX) return null;
  return Number(parsed);
}
