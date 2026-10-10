/**
 * Multicurrency accounting — the pure half (issue #863).
 *
 * Everything here is exact and side-effect-free, for the same reason
 * `manual-journal.ts` and `inventory-exact.ts` are: the posting service, the
 * reports and the API layer must never disagree about how a foreign amount
 * becomes a base amount, and pure functions are what the unit suite can pin
 * down. The DB-touching half is `multicurrency-service.ts` (posting, rates,
 * settlement, revaluation) and `multicurrency-reports-service.ts` (reads).
 *
 * THE MODEL IN ONE PARAGRAPH
 *
 * Every business has one explicit base currency (`businesses.base_currency_code`,
 * default `IRR` — the platform stores base money as integer smallest-unit Rial,
 * see `src/lib/money.ts`). A financial document may be denominated in one
 * *transaction currency* ≠ base. Posting it freezes an immutable rate
 * snapshot: which rate row it used, the numeric rate value itself, and the
 * base currency it converted into. Each journal line then carries the foreign
 * debit/credit (integer minor units of the transaction currency — cents for
 * USD) beside the base debit/credit every line already carried, so the ledger
 * stays balanced in base exactly as before while the foreign side reconciles
 * on its own. Historical postings are never recalculated: rates are
 * append-only, snapshots are copied onto the entry, and nothing in this module
 * reads "the current rate" to explain a posted figure.
 *
 * THE RATE
 *
 * One rate per (business, currency, effective instant), always quoted the same
 * way: **base minor units per one major unit of the foreign currency**
 * ($1 = ۶۰۰٬۰۰۰ ریال → rate `600000`). A single direction removes the
 * multiply-or-divide ambiguity and the triangular-conversion trap. The value
 * is a canonical decimal with at most `RATE_MAX_SCALE` fraction digits, so
 * conversions are exact Decimal multiplications rounded once, by policy.
 *
 * THE ROUNDING POLICY (versioned — see `ROUNDING_POLICY_VERSION`)
 *
 * Policy v1: per line, base = round-half-up(foreign × rate ÷ 10^precision) in
 * base minor units. Because each line rounds independently, the base sides of
 * an otherwise foreign-balanced document can disagree by a few minor units;
 * the residual is absorbed greedily on the largest converted lines so the GL
 * balances exactly, and the total absorbed difference is stamped on the entry
 * as `rounding_delta`. The residual must be within `roundingTolerance` — a
 * larger residual is not rounding, it is a document whose explicit base-only
 * line (a realized gain/loss, a base-currency charge) does not match what the
 * foreign lines converted to, and the service refuses it rather than
 * "repairing" it.
 */
import Decimal from "decimal.js";
import { isUuid } from "./uuid";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });

/** A currency's minor-unit precision — the ISO 4217 exponent, 0..6. */
export const CURRENCY_PRECISION_MAX = 6;
/** Fraction digits accepted on a rate value (`600000.123456` is meaningful; more is noise). */
export const RATE_MAX_SCALE = 12;

/** Policy v1 — the version stamped on every foreign-currency entry. */
export const ROUNDING_POLICY_VERSION = 1;

export const ROUNDING_POLICY_LABEL = "half_up_per_line_largest_lines_absorb";

export type CurrencyCode = string; // canonical: exactly 3 uppercase A-Z letters

export function isValidCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

export function isValidCurrencyPrecision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= CURRENCY_PRECISION_MAX;
}

/**
 * A rate must arrive as a canonical unsigned decimal (no sign, no exponent,
 * no leading zeros, no trailing garbage) above zero, with bounded scale. The
 * canonical-text rule is shared with every other money-adjacent field so an
 * API cannot smuggle in `1e9`, `+1`, or `0.0000000000001`.
 */
export function isValidRateText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(value)) return false;
  const d = new Decimal(value);
  return d.gt(0) && d.lte("1e20");
}

/** Strips meaningless trailing zeros from a valid rate (`600000.00` → `600000`). */
export function rateToCanonical(value: string): string {
  if (!isValidRateText(value)) throw new Error("invalid_rate");
  const trimmed = value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

/** Foreign minor units → base minor units under policy v1. Exact: Decimal multiply, one half-up rounding. */
export function convertToBaseMinor(foreignMinor: bigint, rate: string, precision: number): bigint {
  if (foreignMinor < 0n) throw new Error("negative_foreign_amount");
  if (!isValidRateText(rate)) throw new Error("invalid_rate");
  if (!isValidCurrencyPrecision(precision)) throw new Error("invalid_currency_precision");
  const exact = new Decimal(foreignMinor.toString())
    .mul(new Decimal(rate))
    .div(new Decimal(10).pow(precision));
  return BigInt(exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/**
 * The residual a document may legitimately need absorbed.
 *
 * Each line's posted base is within half a minor unit of its exact value, and
 * the half-up rule's worst case (an exact `.5` landing upward) is reachable
 * only downward, so the base residual of a foreign-balanced document is
 * strictly below `n/2` for n converted lines — an integer, therefore at most
 * ⌊(n−1)/2⌋. A residual beyond this is not rounding: something else is
 * unbalanced, and the document is refused.
 */
export function roundingTolerance(convertedLineCount: number): number {
  if (!Number.isInteger(convertedLineCount) || convertedLineCount < 0) throw new Error("invalid_line_count");
  if (convertedLineCount === 0) return 0;
  return Math.floor((convertedLineCount - 1) / 2);
}

// ---------------------------------------------------------------------------
// Document building
// ---------------------------------------------------------------------------

/** One requested line of a foreign-currency document, before conversion. */
export interface MulticurrencyLineInput {
  accountId: string;
  /** Which side of the ledger this line lands on. */
  side: "debit" | "credit";
  /**
   * Foreign amount in minor units (unsigned). Zero = a base-only line (an FX
   * gain/loss, a base-currency charge), taken as given — that is precisely how
   * a document may value some legs at a *different* effective rate while
   * staying exact.
   */
  foreignMinor?: bigint;
  /**
   * The line's base amount when it is *not* simply foreign × rate:
   *  - with `foreignMinor === 0`: a base-only line;
   *  - with `foreignMinor > 0`: an explicit **booked-base release** — the
   *    classic settlement case, where the A/R leg leaves the books at the
   *    value it was *booked* at (its own historical snapshot), not at today's
   *    snapshot. The difference between the legs then lands on the explicit
   *    FX gain/loss line the caller posts beside them.
   */
  baseMinor?: bigint;
  /** Optional subledger attribution (foreign customer/supplier balances). */
  partyId?: string | null;
}

export interface MulticurrencyDocumentLine {
  accountId: string;
  /** base debit/credit in base minor units — what `journal_lines` has always stored. */
  baseDebit: bigint;
  baseCredit: bigint;
  /** foreign debit/credit in the transaction currency's minor units. */
  foreignDebit: bigint;
  foreignCredit: bigint;
  partyId: string | null;
  /** True when this line's base amount was adjusted to absorb the rounding residual. */
  absorbedRounding: boolean;
}

export interface MulticurrencyDocument {
  lines: MulticurrencyDocumentLine[];
  /** Total base minor units added to (positive) / removed from (negative) the converted lines for rounding. */
  roundingDelta: bigint;
  /** Foreign debit total = foreign credit total, in minor units. */
  foreignTotal: bigint;
  /** Base debit total = base credit total, in base minor units. */
  baseTotal: bigint;
}

export type MulticurrencyDocumentProblem =
  | "no_lines"
  | "invalid_account"
  | "invalid_party"
  | "invalid_amount"
  | "neither_foreign_nor_base"
  | "no_foreign_lines"
  | "foreign_unbalanced"
  | "fx_residual_unexplained";

/** The one Persian message per problem, so the service and any screen cannot drift. */
export function multicurrencyDocumentProblemMessage(problem: MulticurrencyDocumentProblem): string {
  switch (problem) {
    case "no_lines":
      return "حداقل یک سطر با مبلغ لازم است.";
    case "invalid_account":
      return "سطری بدون حساب وجود دارد.";
    case "invalid_party":
      return "شناسه طرف حساب نامعتبر است.";
    case "invalid_amount":
      return "مبلغ‌ها باید عدد صحیح و نامنفی باشند.";
    case "neither_foreign_nor_base":
      return "سطر بدون مبلغ مجاز نیست.";
    case "no_foreign_lines":
      return "سند ارزی به دست‌کم یک سطر ارزی نیاز دارد.";
    case "foreign_unbalanced":
      return "مجموع بدهکار و بستانکار ارزی باید برابر باشد.";
    case "fx_residual_unexplained":
      return "اختلاف سمت پایه با سیاست گرد کردن توضیح داده نمی‌شود؛ سطر سود/زیان تسعیر را بازبینی کنید.";
  }
}

/**
 * Builds a balanced multicurrency document from requested lines.
 *
 * Base-only lines pass through untouched; foreign lines convert at `rate`
 * under policy v1 — except a line that also carries an explicit base amount,
 * which releases at that booked value (settlement). The base residual is
 * absorbed greedily on the largest converted lines when it is within
 * `roundingTolerance`, and refused as `fx_residual_unexplained` when it is
 * not — a residual beyond rounding means the caller's explicit lines (an FX
 * gain/loss, a booked-base release) disagree with the foreign side, and the
 * GL must not be asked to paper over an unexplained difference.
 */
export function buildMulticurrencyDocument(
  inputs: MulticurrencyLineInput[],
  rate: string,
  precision: number,
): { ok: true; value: MulticurrencyDocument } | { ok: false; problem: MulticurrencyDocumentProblem } {
  if (inputs.length === 0) return { ok: false, problem: "no_lines" };
  interface Converted {
    line: MulticurrencyDocumentLine;
    side: "debit" | "credit";
    baseValue: bigint;
  }
  const converted: Converted[] = [];
  const baseOnly: MulticurrencyDocumentLine[] = [];
  for (const input of inputs) {
    if (typeof input.accountId !== "string" || input.accountId === "") {
      return { ok: false, problem: "invalid_account" };
    }
    if (input.partyId != null && !isUuid(input.partyId)) return { ok: false, problem: "invalid_party" };
    if (input.side !== "debit" && input.side !== "credit") return { ok: false, problem: "invalid_amount" };
    const foreign = input.foreignMinor ?? 0n;
    const base = input.baseMinor ?? 0n;
    if (typeof foreign !== "bigint" || typeof base !== "bigint" || foreign < 0n || base < 0n) {
      return { ok: false, problem: "invalid_amount" };
    }
    if (foreign === 0n && base === 0n) return { ok: false, problem: "neither_foreign_nor_base" };
    if (foreign > 0n) {
      // foreign × rate, unless the caller releases the line at its booked base
      // (foreign + explicit base together) — the settlement case.
      const baseValue = base > 0n ? base : convertToBaseMinor(foreign, rate, precision);
      converted.push({
        side: input.side,
        baseValue,
        line: {
          accountId: input.accountId,
          baseDebit: 0n,
          baseCredit: 0n,
          foreignDebit: input.side === "debit" ? foreign : 0n,
          foreignCredit: input.side === "credit" ? foreign : 0n,
          partyId: input.partyId ?? null,
          absorbedRounding: false,
        },
      });
    } else {
      baseOnly.push({
        accountId: input.accountId,
        baseDebit: input.side === "debit" ? base : 0n,
        baseCredit: input.side === "credit" ? base : 0n,
        foreignDebit: 0n,
        foreignCredit: 0n,
        partyId: input.partyId ?? null,
        absorbedRounding: false,
      });
    }
  }
  if (converted.length === 0) return { ok: false, problem: "no_foreign_lines" };

  let foreignDebit = 0n;
  let foreignCredit = 0n;
  for (const c of converted) {
    foreignDebit += c.line.foreignDebit;
    foreignCredit += c.line.foreignCredit;
  }
  if (foreignDebit !== foreignCredit) return { ok: false, problem: "foreign_unbalanced" };

  // Default conversion: every converted line lands its rounded value on its own side.
  for (const c of converted) {
    if (c.side === "debit") c.line.baseDebit = c.baseValue;
    else c.line.baseCredit = c.baseValue;
  }
  let baseDebit = 0n;
  let baseCredit = 0n;
  for (const c of converted) {
    baseDebit += c.line.baseDebit;
    baseCredit += c.line.baseCredit;
  }
  for (const l of baseOnly) {
    baseDebit += l.baseDebit;
    baseCredit += l.baseCredit;
  }

  let residual = baseDebit - baseCredit;
  const tolerance = BigInt(roundingTolerance(converted.length));
  if (residual < 0n) residual = -residual;
  if (residual > tolerance) return { ok: false, problem: "fx_residual_unexplained" };

  // Absorb greedily, largest converted line first: shrink a line on the
  // over-side where possible, otherwise grow a line on the under-side. The
  // bound above keeps this a handful of minor units; the walk exists so even
  // a document of sub-unit dust lines (each rounding to zero) can close.
  let remaining = residual;
  const ordered = [...converted].sort((a, b) => (b.baseValue > a.baseValue ? 1 : b.baseValue < a.baseValue ? -1 : 0));
  const overSide = baseDebit > baseCredit ? "debit" : "credit";
  const underSide = overSide === "debit" ? "credit" : "debit";
  for (const c of ordered) {
    if (remaining === 0n) break;
    if (c.side === overSide) {
      const take = c.baseValue < remaining ? c.baseValue : remaining;
      if (take === 0n) continue;
      if (c.side === "debit") c.line.baseDebit -= take;
      else c.line.baseCredit -= take;
      remaining -= take;
      c.line.absorbedRounding = true;
    }
  }
  for (const c of ordered) {
    if (remaining === 0n) break;
    if (c.side === underSide) {
      if (c.side === "debit") c.line.baseDebit += remaining;
      else c.line.baseCredit += remaining;
      remaining = 0n;
      c.line.absorbedRounding = true;
    }
  }
  if (remaining !== 0n) return { ok: false, problem: "fx_residual_unexplained" };

  // A base-zeroed line is NOT a drop: its foreign leg still moves value
  // between accounts (a dust line whose base rounds to nothing is exactly the
  // case the absorption walk exists for). Only a line with neither side
  // carrying anything is empty.
  const lines = [...converted.map((c) => c.line), ...baseOnly].filter(
    (l) => l.baseDebit !== 0n || l.baseCredit !== 0n || l.foreignDebit !== 0n || l.foreignCredit !== 0n,
  );
  let finalDebit = 0n;
  let finalCredit = 0n;
  let finalForeignDebit = 0n;
  let finalForeignCredit = 0n;
  for (const l of lines) {
    finalDebit += l.baseDebit;
    finalCredit += l.baseCredit;
    finalForeignDebit += l.foreignDebit;
    finalForeignCredit += l.foreignCredit;
  }
  return {
    ok: true,
    value: {
      lines,
      roundingDelta: residual,
      foreignTotal: finalForeignDebit,
      baseTotal: finalDebit,
    },
  };
}

// ---------------------------------------------------------------------------
// Foreign open-item settlement (realized FX)
// ---------------------------------------------------------------------------

/** An open foreign receivable/payable slice: what is still unsettled, and at what booked base value. */
export interface ForeignOpenLot {
  /** The journal line id the lot lives on. */
  lineId: string;
  /** The entry that posted the lot (the invoice document). */
  entryId: string;
  /** The posting date of the lot's document — FIFO reads oldest first. */
  entryDate: string;
  /** Remaining foreign amount in minor units. */
  foreignRemaining: bigint;
  /** Booked base value of the *remaining* slice, in base minor units. */
  baseRemaining: bigint;
}

export interface ForeignLotApplication {
  lineId: string;
  entryId: string;
  foreignApplied: bigint;
  baseApplied: bigint;
}

export type ConsumptionProblem = "invalid_amount" | "insufficient_open_balance";

/**
 * Consumes open lots FIFO, allocating base value exactly.
 *
 * A lot's base value is consumed in proportion to the foreign amount taken,
 * rounded half-up — except the slice that empties a lot, which takes the lot's
 * whole remaining base. That last-slice rule is what makes the arithmetic
 * *exact by construction*: across however many settlements it takes to close a
 * lot, the base value applied always sums to the lot's booked base, so the
 * realized gain/loss over the lot's life sums to exactly
 * (settled base at settlement rates − booked base) with no drift.
 */
export function consumeOpenLots(
  lots: ForeignOpenLot[],
  amountForeign: bigint,
): { ok: true; value: ForeignLotApplication[] } | { ok: false; problem: ConsumptionProblem } {
  if (typeof amountForeign !== "bigint" || amountForeign <= 0n) return { ok: false, problem: "invalid_amount" };
  let remaining = amountForeign;
  const applications: ForeignLotApplication[] = [];
  for (const lot of lots) {
    if (remaining === 0n) break;
    if (lot.foreignRemaining <= 0n || lot.baseRemaining < 0n) continue;
    const takeForeign = lot.foreignRemaining < remaining ? lot.foreignRemaining : remaining;
    const emptiesLot = takeForeign === lot.foreignRemaining;
    const takeBase = emptiesLot
      ? lot.baseRemaining
        : BigInt(
            new Decimal(lot.baseRemaining.toString())
              .mul(new Decimal(takeForeign.toString()))
              .div(new Decimal(lot.foreignRemaining.toString()))
              .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
              .toFixed(0),
          );
    applications.push({ lineId: lot.lineId, entryId: lot.entryId, foreignApplied: takeForeign, baseApplied: takeBase });
    remaining -= takeForeign;
  }
  if (remaining !== 0n) return { ok: false, problem: "insufficient_open_balance" };
  return { ok: true, value: applications };
}

/**
 * The realized FX result of settling foreign value that was booked at
 * `baseApplied` (historic snapshot) and is now worth `settlementBase`
 * (settlement rate). Positive = gain (the foreign unit strengthened between
 * booking and settlement, on a receivable); negative = loss. The *sign
 * convention for a payable* flips economically — the service decides which FX
 * account receives the figure; this function only computes the difference.
 */
export function realizedFxDifference(settlementBase: bigint, baseApplied: bigint): bigint {
  return settlementBase - baseApplied;
}

// ---------------------------------------------------------------------------
// Unrealized revaluation
// ---------------------------------------------------------------------------

export interface RevaluationOutcome {
  /** The account's restated base value at the new rate. */
  newValue: bigint;
  /** newValue − bookBase, in the account's own (asset-normal) direction. */
  difference: bigint;
  /** The gain the revaluation recognizes (0 when it is a loss). */
  gain: bigint;
  /** The loss the revaluation recognizes (0 when it is a gain). */
  loss: bigint;
}

/**
 * Restates a foreign-currency account's balance at a new rate.
 *
 * `difference` is asset-normal: positive means the account's base value rose.
 * `gain`/`loss` already flip for a liability-normal account — a foreign
 * payable that grows in base terms is a *loss*, not a gain — so the posting
 * side never re-derives this.
 */
export function restateForeignBalance(input: {
  foreignBalanceMinor: bigint;
  bookBaseMinor: bigint;
  rate: string;
  precision: number;
  /** The account type's normal side: asset/expense = debit-normal. */
  debitNormal: boolean;
}): RevaluationOutcome {
  // A foreign account CAN stand negative — an overdraft on an FX bank, a net
  // short position. Restating follows the sign (restateSigned): negating the
  // magnitude, converting, negating back. convertToBaseMinor refuses
  // negatives by contract, so passing a negative balance through it would
  // crash the whole revaluation instead of flipping to the other side of the
  // 4935/5875 pair.
  const newValue =
    input.foreignBalanceMinor < 0n
      ? -convertToBaseMinor(-input.foreignBalanceMinor, input.rate, input.precision)
      : convertToBaseMinor(input.foreignBalanceMinor, input.rate, input.precision);
  const raw = newValue - input.bookBaseMinor;
  const signedByNormal = input.debitNormal ? raw : -raw;
  return {
    newValue,
    difference: raw,
    gain: signedByNormal > 0n ? signedByNormal : 0n,
    loss: signedByNormal < 0n ? -signedByNormal : 0n,
  };
}

// ---------------------------------------------------------------------------
// API payloads — parse here, once, so the routes only map problems to status
// codes. Amounts cross the wire as canonical integer *text* (minor units):
// JS numbers silently lose precision past 2^53, and every other amount in
// this codebase's API surface is exact text for exactly that reason.
// ---------------------------------------------------------------------------

export type MulticurrencyPayloadProblem =
  | "bad_request"
  | "invalid_currency"
  | "invalid_rate_id"
  | "invalid_rate"
  | "invalid_entry_date"
  | "invalid_memo"
  | "invalid_line"
  | "invalid_account_id"
  | "invalid_party_id"
  | "invalid_amount"
  | "invalid_side"
  | "too_many_lines"
  | "invalid_idempotency_key"
  | "invalid_location_id"
  | "invalid_project_id";

/** Caps on one document — mirrors the manual journal's caps. */
export const MULTICURRENCY_LINES_MAX = 200;
export const MULTICURRENCY_MEMO_MAX = 500;
export const MULTICURRENCY_IDEMPOTENCY_KEY_MAX = 128;

export interface MulticurrencyEntryPayload {
  currencyCode: CurrencyCode;
  /** Pin the snapshot to a specific rate row; `null` = resolve the current rate at posting time. */
  rateId: string | null;
  entryDate: string | null;
  memo: string;
  locationId: string | null;
  /** The project dimension, carried onto the entry like the manual journal carries it. */
  projectId: string | null;
  lines: MulticurrencyLineInput[];
  idempotencyKey: string | null;
}

function parseMinorAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function parseMulticurrencyEntryPayload(body: unknown):
  | { ok: true; value: MulticurrencyEntryPayload }
  | { ok: false; problem: MulticurrencyPayloadProblem } {
  if (typeof body !== "object" || body === null) return { ok: false, problem: "bad_request" };
  const b = body as Record<string, unknown>;
  if (!isValidCurrencyCode(b.currencyCode)) return { ok: false, problem: "invalid_currency" };
  if (b.rateId != null && !isUuid(b.rateId)) return { ok: false, problem: "invalid_rate_id" };
  if (b.entryDate != null && (typeof b.entryDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.entryDate))) {
    return { ok: false, problem: "invalid_entry_date" };
  }
  if (b.memo != null && (typeof b.memo !== "string" || b.memo.length > MULTICURRENCY_MEMO_MAX)) {
    return { ok: false, problem: "invalid_memo" };
  }
  if (b.locationId != null && !isUuid(b.locationId)) return { ok: false, problem: "invalid_location_id" };
  if (b.projectId != null && !isUuid(b.projectId)) return { ok: false, problem: "invalid_project_id" };
  if (b.idempotencyKey != null && (typeof b.idempotencyKey !== "string" || b.idempotencyKey.length === 0 || b.idempotencyKey.length > MULTICURRENCY_IDEMPOTENCY_KEY_MAX)) {
    return { ok: false, problem: "invalid_idempotency_key" };
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) return { ok: false, problem: "invalid_line" };
  if (b.lines.length > MULTICURRENCY_LINES_MAX) return { ok: false, problem: "too_many_lines" };
  const lines: MulticurrencyLineInput[] = [];
  for (const raw of b.lines) {
    if (typeof raw !== "object" || raw === null) return { ok: false, problem: "invalid_line" };
    const l = raw as Record<string, unknown>;
    if (typeof l.accountId !== "string" || !isUuid(l.accountId)) return { ok: false, problem: "invalid_account_id" };
    if (l.side !== "debit" && l.side !== "credit") return { ok: false, problem: "invalid_side" };
    if (l.partyId != null && !isUuid(l.partyId)) return { ok: false, problem: "invalid_party_id" };
    const hasForeign = l.foreignAmount != null;
    const hasBase = l.baseAmount != null;
    const hasOverride = l.baseOverrideAmount != null;
    if (hasForeign === hasBase) return { ok: false, problem: "invalid_line" };
    if (hasOverride && !hasForeign) return { ok: false, problem: "invalid_line" };
    let foreignMinor: bigint | undefined;
    let baseMinor: bigint | undefined;
    if (hasForeign) {
      const parsed = parseMinorAmount(l.foreignAmount);
      if (parsed === null) return { ok: false, problem: "invalid_amount" };
      foreignMinor = parsed;
      if (hasOverride) {
        const override = parseMinorAmount(l.baseOverrideAmount);
        if (override === null) return { ok: false, problem: "invalid_amount" };
        baseMinor = override;
      }
    } else {
      const parsed = parseMinorAmount(l.baseAmount);
      if (parsed === null) return { ok: false, problem: "invalid_amount" };
      baseMinor = parsed;
    }
    lines.push({
      accountId: l.accountId,
      side: l.side,
      foreignMinor,
      baseMinor,
      partyId: (l.partyId as string | null) ?? null,
    });
  }
  return {
    ok: true,
    value: {
      currencyCode: b.currencyCode,
      rateId: (b.rateId as string | null) ?? null,
      entryDate: (b.entryDate as string | null) ?? null,
      memo: typeof b.memo === "string" ? b.memo : "",
      locationId: (b.locationId as string | null) ?? null,
      projectId: (b.projectId as string | null) ?? null,
      lines,
      idempotencyKey: (b.idempotencyKey as string | null) ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Rate payloads
// ---------------------------------------------------------------------------

export interface RatePayload {
  currencyCode: CurrencyCode;
  /** Canonical rate text: base minor units per one major foreign unit. */
  rate: string;
  /** ISO timestamp the rate becomes effective at; `null` = now. */
  effectiveFrom: string | null;
}

export function parseRatePayload(body: unknown): { ok: true; value: RatePayload } | { ok: false; problem: MulticurrencyPayloadProblem } {
  if (typeof body !== "object" || body === null) return { ok: false, problem: "bad_request" };
  const b = body as Record<string, unknown>;
  if (!isValidCurrencyCode(b.currencyCode)) return { ok: false, problem: "invalid_currency" };
  if (typeof b.rate !== "string" || !isValidRateText(b.rate)) return { ok: false, problem: "invalid_rate" };
  if (
    b.effectiveFrom != null &&
    (typeof b.effectiveFrom !== "string" || Number.isNaN(Date.parse(b.effectiveFrom)))
  ) {
    return { ok: false, problem: "bad_request" };
  }
  return {
    ok: true,
    value: {
      currencyCode: b.currencyCode,
      rate: rateToCanonical(b.rate),
      effectiveFrom: (b.effectiveFrom as string | null) ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Settlement payloads
// ---------------------------------------------------------------------------

export type SettlementDirection = "receivable" | "payable";

export interface SettlementPayload {
  direction: SettlementDirection;
  partyId: string;
  currencyCode: CurrencyCode;
  /** Pin the settlement rate row; `null` = resolve the current rate. */
  rateId: string | null;
  /** The account the foreign value settles into/out of (a foreign-currency bank, typically). */
  settlementAccountId: string;
  /** FIFO by default; explicit open items when the caller picks them. */
  autoAmount: string | null;
  items: { entryId: string; amount: string }[];
  entryDate: string | null;
  memo: string;
  /** Optional project dimension for the settlement document itself. */
  projectId: string | null;
  idempotencyKey: string | null;
}

export function parseSettlementPayload(body: unknown):
  | { ok: true; value: SettlementPayload }
  | { ok: false; problem: MulticurrencyPayloadProblem } {
  if (typeof body !== "object" || body === null) return { ok: false, problem: "bad_request" };
  const b = body as Record<string, unknown>;
  if (b.direction !== "receivable" && b.direction !== "payable") return { ok: false, problem: "bad_request" };
  if (typeof b.partyId !== "string" || !isUuid(b.partyId)) return { ok: false, problem: "invalid_party_id" };
  if (!isValidCurrencyCode(b.currencyCode)) return { ok: false, problem: "invalid_currency" };
  if (b.rateId != null && !isUuid(b.rateId)) return { ok: false, problem: "invalid_rate_id" };
  if (typeof b.settlementAccountId !== "string" || !isUuid(b.settlementAccountId)) {
    return { ok: false, problem: "invalid_account_id" };
  }
  const items: { entryId: string; amount: string }[] = [];
  if (b.items != null) {
    if (!Array.isArray(b.items)) return { ok: false, problem: "bad_request" };
    for (const raw of b.items) {
      if (typeof raw !== "object" || raw === null) return { ok: false, problem: "bad_request" };
      const item = raw as Record<string, unknown>;
      if (typeof item.entryId !== "string" || !isUuid(item.entryId)) return { ok: false, problem: "bad_request" };
      const amount = parseMinorAmount(item.amount);
      if (amount === null || amount <= 0n) return { ok: false, problem: "invalid_amount" };
      items.push({ entryId: item.entryId, amount: item.amount as string });
    }
  }
  const autoAmount = b.autoAmount != null ? parseMinorAmount(b.autoAmount) : null;
  if (b.autoAmount != null && (autoAmount === null || autoAmount <= 0n)) return { ok: false, problem: "invalid_amount" };
  if (items.length === 0 && autoAmount === null) return { ok: false, problem: "bad_request" };
  if (items.length > 0 && autoAmount !== null) return { ok: false, problem: "bad_request" };
  if (
    b.entryDate != null &&
    (typeof b.entryDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.entryDate))
  ) {
    return { ok: false, problem: "invalid_entry_date" };
  }
  if (b.memo != null && (typeof b.memo !== "string" || b.memo.length > MULTICURRENCY_MEMO_MAX)) {
    return { ok: false, problem: "invalid_memo" };
  }
  if (b.projectId != null && !isUuid(b.projectId)) return { ok: false, problem: "invalid_project_id" };
  if (
    b.idempotencyKey != null &&
    (typeof b.idempotencyKey !== "string" || b.idempotencyKey.length === 0 || b.idempotencyKey.length > MULTICURRENCY_IDEMPOTENCY_KEY_MAX)
  ) {
    return { ok: false, problem: "invalid_idempotency_key" };
  }
  return {
    ok: true,
    value: {
      direction: b.direction,
      partyId: b.partyId,
      currencyCode: b.currencyCode,
      rateId: (b.rateId as string | null) ?? null,
      settlementAccountId: b.settlementAccountId,
      autoAmount: b.autoAmount as string | null,
      items,
      entryDate: (b.entryDate as string | null) ?? null,
      memo: typeof b.memo === "string" ? b.memo : "",
      projectId: (b.projectId as string | null) ?? null,
      idempotencyKey: (b.idempotencyKey as string | null) ?? null,
    },
  };
}

/** Foreign minor units → the currency's major-unit decimal text (cents → `12.34`). */
export function minorToMajorText(minor: bigint, precision: number): string {
  if (!isValidCurrencyPrecision(precision)) throw new Error("invalid_currency_precision");
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const text = abs.toString().padStart(precision + 1, "0");
  const major = precision === 0 ? text : `${text.slice(0, -precision)}.${text.slice(-precision)}`;
  return negative ? `-${major}` : major;
}
