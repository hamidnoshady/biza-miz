/**
 * Unsaved money edits, kept safe across a display-unit change — issue #835 §2.
 *
 * A payroll amount box (a wage, an allowance, a deduction, this month's
 * overtime, an advance) is a text box in the business's money unit (تومان or
 * ریال). The screen used to keep the *text* a person typed across a unit switch
 * and parse it with whatever unit was current at save time, so «10,000,000»
 * typed as Rial and saved after the business switched to Toman became ten times
 * the intended amount — in the one field where that costs real money.
 *
 * A draft therefore remembers the unit its text was typed in. The amount it
 * stands for is always read through that unit (`draftRial`), never through
 * whichever unit happens to be current, and what the box *displays* after a
 * switch is derived from that canonical Rial (`draftDisplayText`). Conversion
 * happens exactly once, at render time; the stored draft is never rewritten, so
 * a Rial amount that Toman cannot show exactly (15 Rial) still saves as 15.
 *
 * A member's pay is four standing terms (`PayTerm`); `TermDrafts` holds the
 * ones somebody has touched, and `termsBody` turns them into the PATCH body from
 * the digits themselves — an amount never passes through `Number` on its way to
 * the server.
 *
 * Pure and framework-free: everything is `string`/`BigInt`, no `Number` on a
 * money value anywhere.
 */
import { moneyToInputText, parseToRialText, type MoneyUnit } from "./money";
import { PAY_TERMS, type PayTerm, type StaffWage } from "./payroll-types";

/** What a person typed into one amount box, and the unit they typed it in. */
export interface AmountDraft {
  /** ASCII digits as the numeric input hands them over; "" means "nothing entered". */
  text: string;
  unit: MoneyUnit;
}

/**
 * The largest amount a JSON number carries exactly (2^53 − 1). The pay-term and
 * advance routes take a JSON number, so the screen refuses a bigger amount
 * itself, naming the field, instead of sending a value the transport would round.
 */
export const MAX_JSON_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

/** A draft the person has typed that is not an amount (`"-"`, `"1.5"`, `"abc"`). */
export const INVALID_DRAFT = "invalid" as const;

/**
 * The Rial a draft stands for: `null` for «nothing entered» (an empty box), the
 * canonical integer text otherwise, or `INVALID_DRAFT` when the text is not a
 * non-negative whole amount.
 */
export function draftRial(draft: AmountDraft): string | null | typeof INVALID_DRAFT {
  if (draft.text.trim() === "") return null;
  try {
    const rial = parseToRialText(draft.text, draft.unit);
    // `parseToRialText` accepts a leading minus; none of these amounts is ever negative.
    return rial.startsWith("-") ? INVALID_DRAFT : rial;
  } catch {
    return INVALID_DRAFT;
  }
}

/** True when the amount cannot be sent as a JSON number without rounding. */
export function exceedsJsonAmount(rial: string): boolean {
  return BigInt(rial) > MAX_JSON_AMOUNT;
}

/**
 * The text an amount box should show for a draft, in the unit the screen is in
 * *now*. The same unit: exactly what was typed. A different unit: the same
 * amount, converted from the unit it was typed in.
 */
export function draftDisplayText(draft: AmountDraft, unit: MoneyUnit): string {
  if (draft.unit === unit) return draft.text;
  const rial = draftRial(draft);
  if (rial === null) return "";
  // Nothing sensible to convert: leave the person's own text where it is.
  if (rial === INVALID_DRAFT) return draft.text;
  return moneyToInputText(rial, unit);
}

/**
 * Has this box been edited away from what the server holds?
 *
 * Compared as canonical Rial, not as text — so typing the stored value back in,
 * or switching the display unit, does not make a row «ذخیره‌نشده», while a
 * malformed draft always does (it must be fixed or discarded before leaving).
 */
export function isDraftDirty(draft: AmountDraft | undefined, savedRial: string | null): boolean {
  if (!draft) return false;
  const rial = draftRial(draft);
  if (rial === INVALID_DRAFT) return true;
  return rial !== savedRial;
}

// ---------------------------------------------------------------------------
// A member's standing pay terms
// ---------------------------------------------------------------------------

/** The terms somebody has typed into, each with the unit it was typed in. */
export type TermDrafts = Partial<Record<PayTerm, AmountDraft>>;

/**
 * What the server holds for a term. Only the wage can be «not set» (`null`);
 * an allowance or a deduction is an amount, with zero meaning none.
 */
function savedTerm(staff: StaffWage, term: PayTerm): string | null {
  return staff[term];
}

/**
 * The canonical amount a draft stands for, as the server reads it: for the wage,
 * `null` means «no wage»; for every other term an empty box means 0 — so a box
 * left empty on a member with no allowance is not a change.
 */
function termRial(term: PayTerm, draft: AmountDraft): string | null | typeof INVALID_DRAFT {
  const rial = draftRial(draft);
  if (rial === INVALID_DRAFT) return INVALID_DRAFT;
  return term === "monthlyWage" ? rial : (rial ?? "0");
}

/** Has this term's box been edited away from what is saved? */
export function isTermDirty(term: PayTerm, draft: AmountDraft | undefined, staff: StaffWage): boolean {
  if (!draft) return false;
  const rial = termRial(term, draft);
  if (rial === INVALID_DRAFT) return true;
  return rial !== savedTerm(staff, term);
}

/** Which of a member's terms have unsaved edits — in the order the screen lists them. */
export function dirtyTerms(drafts: TermDrafts | undefined, staff: StaffWage): PayTerm[] {
  if (!drafts) return [];
  return PAY_TERMS.filter((term) => isTermDirty(term, drafts[term], staff));
}

/**
 * What a term's box shows: the draft converted to the unit the screen is in
 * now, else the saved amount in it. A saved zero allowance shows as an empty box
 * (the placeholder reads «۰»), as every optional money field does.
 */
export function termDisplayText(term: PayTerm, draft: AmountDraft | undefined, staff: StaffWage, unit: MoneyUnit): string {
  if (draft) return draftDisplayText(draft, unit);
  const saved = savedTerm(staff, term);
  if (saved === null || (term !== "monthlyWage" && saved === "0")) return "";
  return moneyToInputText(saved, unit);
}

export type TermsBody =
  | { ok: true; json: string; terms: PayTerm[] }
  | { ok: false; term: PayTerm; reason: "invalid" | "too_large" };

/**
 * The PATCH body for a member's edited terms — only the terms that changed, so
 * saving one cannot overwrite another with a stale value — written from the
 * canonical digits. Refuses a malformed amount or one a JSON number would round,
 * naming the term, rather than send it.
 */
export function termsBody(drafts: TermDrafts, staff: StaffWage): TermsBody {
  const terms = dirtyTerms(drafts, staff);
  const members: string[] = [];
  for (const term of terms) {
    const rial = termRial(term, drafts[term]!);
    if (rial === INVALID_DRAFT) return { ok: false, term, reason: "invalid" };
    if (rial !== null && exceedsJsonAmount(rial)) return { ok: false, term, reason: "too_large" };
    members.push(`"${term}":${rial === null ? "null" : rial}`);
  }
  return { ok: true, json: `{${members.join(",")}}`, terms };
}
