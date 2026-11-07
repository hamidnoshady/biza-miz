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
/* The business-level presentation policy (§D)                                 */
/* ------------------------------------------------------------------------- */

/**
 * The presentation a cost gets when the business has chosen no policy and the
 * member chose nothing on the row.
 *
 * This is a **fallback for determinacy, not a recommendation**. Every cost row
 * has to land in one of two accounts, so something has to answer when nobody
 * has; `net` is the answer because it is the one that does not claim money the
 * agency may not have earned. Under `net` a client's media buy sits in 1270 as a
 * claim until it is recharged, so the agency's revenue is never overstated.
 * Under `gross` the same buy is the agency's own cost of sale and the recharge is
 * its revenue, which is a real position — but one a business has to have
 * *adopted*, and §D says that adoption "must follow chosen business accounting
 * policy and must not be inferred solely from spend".
 *
 * Which is why this constant is the floor and not the answer: the answer is
 * `SETTING_KEYS.agencyCostPolicy`, and a screen shows the fallback as «not
 * chosen yet» rather than as a selection.
 */
export const AGENCY_DEFAULT_PRESENTATION: AgencyPassThroughPresentation = "net";

/** The stored shape of `SETTING_KEYS.agencyCostPolicy`. */
export interface AgencyCostPolicySetting {
  /** The presentation new reimbursable costs default to. */
  presentation: AgencyPassThroughPresentation;
  /** ISO time of the last save, or null while nothing has been stored. */
  updatedAt: string | null;
}

/**
 * Pure: reads the stored jsonb defensively and returns null when there is
 * nothing usable, so a caller can tell "never saved" from "saved".
 *
 * An unrecognised presentation string is **not** coerced to the default, for the
 * reason `parseAgencyProfileSetting` gives: a value this code does not know was
 * written by a newer version or by hand, and answering `net` would let the next
 * save overwrite a decision nobody meant to reverse. Here the stakes are higher
 * than a blueprint ordering, because the value decides which account money lands
 * in — so the caller reports the default separately and says it was not stored.
 *
 * `agency-reimbursable-cost-service.ts` uses this same parser to validate a save
 * request, so a shape the reader accepts is a shape the writer can store.
 */
export function parseAgencyCostPolicySetting(raw: unknown): AgencyCostPolicySetting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isAgencyPassThroughPresentation(value.presentation)) return null;
  return {
    presentation: value.presentation,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
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

/* ------------------------------------------------------------------------- */
/* Recharged — derived, never stored (migration 0284)                         */
/* ------------------------------------------------------------------------- */

/** The order status that means an invoice no longer asks anybody for anything. */
export const VOIDED_ORDER_STATUS = "voided";

/**
 * Whether a cost has actually been recharged.
 *
 * Derived from the invoice's live status rather than stored, and 0284 asserts that
 * no `recharged`, `recharged_at` or `recharge_status` column exists. The reason is
 * that `retail-invoice-void-service.ts` does not delete an invoice — it flips
 * `orders.status` to `voided` and writes a reversing entry, leaving the original in
 * place — so the ledger has *already* put the money back into 1270 by the time
 * anybody looks. A stored flag would be a second answer to a question the order
 * answers, and the two would disagree the first time somebody voided an invoice.
 *
 * A missing order status counts as not recharged, which is the safe direction: it
 * makes a cost billable again rather than silently writing off a claim on a client.
 */
export function isCostRecharged(input: {
  rechargedOrderId: string | null;
  orderStatus: string | null | undefined;
}): boolean {
  if (!input.rechargedOrderId) return false;
  if (typeof input.orderStatus !== "string" || input.orderStatus.length === 0) return false;
  return input.orderStatus !== VOIDED_ORDER_STATUS;
}

/* ------------------------------------------------------------------------- */
/* Settled — derived, never stored (migration 0287)                           */
/* ------------------------------------------------------------------------- */

/**
 * Whether a cost has actually been settled out of the vendor payable.
 *
 * The same shape as `isCostRecharged` and for the same reason: reversing a payment
 * writes a reversing entry and stamps the document, so the ledger has already put the
 * money back into 2140 by the time anybody looks, and a stored `settled` column would
 * be a second answer that disagrees with it.
 *
 * ## The unknown direction is the *opposite* of the recharge's, deliberately
 *
 * `isCostRecharged` treats a missing order as **not** recharged, because that makes a
 * cost billable again rather than silently writing off a claim on a client. Here an
 * unreadable reversal state counts as **still settled**, because the two failure modes
 * are not symmetric: leaving a payable open costs an investigation, while freeing a cost
 * that was in fact paid lets the same media buy be paid a second time. Only a reversal
 * this function can positively read frees the row.
 */
export function isCostSettled(input: {
  settlementId: string | null;
  /** The settlement document's `reversed_at`, when the caller read it. */
  reversedAt?: string | null;
}): boolean {
  if (!input.settlementId) return false;
  return !(typeof input.reversedAt === "string" && input.reversedAt.length > 0);
}

/* ------------------------------------------------------------------------- */
/* The vendor settlement: how the payable is paid down                        */
/* ------------------------------------------------------------------------- */

/**
 * How the agency pays a vendor down, which is the settlement entry's credit side.
 *
 * Two values and not the register's three: `payable` is what *created* the balance in
 * 2140, so offering it here would debit the account and credit it in one entry — a
 * payment to oneself that clears nothing and looks like it did.
 */
export const VENDOR_SETTLEMENT_METHODS = ["cash", "bank"] as const;

export type VendorSettlementMethod = (typeof VENDOR_SETTLEMENT_METHODS)[number];

export const VENDOR_SETTLEMENT_METHOD_LABELS: Record<VendorSettlementMethod, string> = {
  cash: "نقدی (صندوق)",
  bank: "بانکی (حساب بانکی)",
};

/** The credit account each method implies — the same two the register's own cash and bank settlements use. */
export const VENDOR_SETTLEMENT_METHOD_ACCOUNTS: Record<VendorSettlementMethod, string> = {
  cash: AGENCY_COST_SETTLEMENT_ACCOUNTS.cash,
  bank: AGENCY_COST_SETTLEMENT_ACCOUNTS.bank,
};

export function isVendorSettlementMethod(value: unknown): value is VendorSettlementMethod {
  return typeof value === "string" && (VENDOR_SETTLEMENT_METHODS as readonly string[]).includes(value);
}

/** `VS-` from the shared register numbering, per business. */
export const SETTLEMENT_NUMBER_PREFIX = "VS";

/**
 * The two accounts a vendor settlement touches.
 *
 * The debit is always 2140 — that is the whole of what 0287 exists to do, since the
 * account had been credited in exactly one place and debited in none. Exported beside
 * `reimbursableCostAccounts` so the pair of functions reads as the two halves of one
 * loop: the cost puts money into the payable, the settlement takes it out.
 */
export function vendorSettlementAccounts(method: VendorSettlementMethod): {
  debitCode: string;
  creditCode: string;
} {
  return {
    debitCode: AGENCY_COST_SETTLEMENT_ACCOUNTS.payable,
    creditCode: VENDOR_SETTLEMENT_METHOD_ACCOUNTS[method],
  };
}
