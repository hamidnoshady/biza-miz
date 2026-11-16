/**
 * ESH-193 / #1378 — the canonical quote contract, stage 1.
 *
 * A quote is the one document every commercial path agrees on: the tenant
 * wizard, the super-admin preview, the payment route and the invoice. Before
 * this module each of those computed its own "total", which is how a 3-month
 * prepayment could be charged as 3 × monthly while the screen said −5%, and how
 * a stale price could be settled at yesterday's amount.
 *
 * The rules encoded here, in integer Rial (Toman is display-only):
 *
 *  1. **A term multiplies the recurring parts only.** Plan base and *monthly*
 *     add-ons are charged per month of the term; one-off add-ons are charged
 *     once, whatever the term.
 *  2. **Period arithmetic is calendar months**, never 30/90/365-day
 *     approximations, and a month-end start clamps (Jan 31 → Feb 28/29) rather
 *     than overflowing into the next month.
 *  3. **Discount applies to the recurring gross, before tax.** The rate is
 *     supplied by configuration — this module has no built-in 5%/15% default,
 *     because a hardcoded promotion is a promise nobody can turn off.
 *  4. **Tax applies after the discount**, on the discounted amount.
 *  5. **Every line cites its price version**, so a settled invoice can say
 *     which published price produced it. A line priced from a plain column
 *     (a plan feature's `price_rial`) cites `null` rather than pretending.
 *  6. **A quote carries a fingerprint and an expiry.** `isQuoteStale` is the
 *     payment boundary's check: a re-priced plan, a different term or an expired
 *     quote must be re-quoted, never settled.
 *
 * Pure and database-free on purpose: the resolver in `plan-quote-service.ts`
 * reads `billing_price_versions` and `billing_plan_features`, and the UI can
 * import this module's types for its itemisation without pulling a pool in.
 */

/** The only prepayment terms the commercial launch sells (ESH-193). */
export const PLAN_TERM_MONTHS = [1, 3, 12] as const;
export type PlanTermMonths = (typeof PLAN_TERM_MONTHS)[number];

export function isPlanTermMonths(value: unknown): value is PlanTermMonths {
  return typeof value === "number" && (PLAN_TERM_MONTHS as readonly number[]).includes(value);
}

/** The published price a line was built from — never a bare number. */
export interface QuotePriceVersion {
  /** `billing_price_versions.id`. */
  id: string;
  version: number;
}

export interface QuoteAddOn {
  key: string;
  /** The monthly amount for a recurring add-on, or the one-off amount. */
  amountRial: number;
  /** Present when a published version priced it; `null` for a plain column price. */
  priceVersion?: QuotePriceVersion | null;
}

export interface PlanQuoteRequest {
  planKey: string;
  termMonths: PlanTermMonths;
  /** The published monthly plan price (Rial). */
  monthlyBaseRial: number;
  basePriceVersion: QuotePriceVersion;
  recurringAddOns?: readonly QuoteAddOn[];
  oneOffAddOns?: readonly QuoteAddOn[];
  /**
   * The configured discount **rate** for this term (0.05 = 5%). Supplied by
   * configuration so a promotion is editable and disableable; never defaulted.
   */
  termDiscountRate: number;
  /** Tax rate applied after discounts (0.09 = 9%). */
  taxRate: number;
  /** When the quote was produced — the period starts here. */
  issuedAt: string;
  /** How long the quote may be paid at; defaults to 15 minutes. */
  validityMinutes?: number;
}

export type QuoteLineKind =
  | "plan_base"
  | "recurring_addon"
  | "one_off_addon"
  | "term_discount"
  | "tax";

export interface QuoteLine {
  kind: QuoteLineKind;
  key: string;
  label: string;
  /** Months for recurring lines, 1 for one-off and tax/discount lines. */
  quantity: number;
  unitAmountRial: number;
  grossRial: number;
  /** Only the discount line carries a non-zero amount here. */
  discountRial: number;
  netRial: number;
  /** `null` for the discount/tax lines and for a column-priced add-on. */
  priceVersion: QuotePriceVersion | null;
}

export interface PlanQuoteTotals {
  grossRial: number;
  discountRial: number;
  taxRial: number;
  netRial: number;
  /** What the term saved against paying monthly for every month. */
  savingsRial: number;
}

export interface PlanQuote {
  planKey: string;
  termMonths: PlanTermMonths;
  currency: "IRR";
  lines: QuoteLine[];
  totals: PlanQuoteTotals;
  period: { start: string; end: string };
  issuedAt: string;
  expiresAt: string;
  /** Deterministic identity of the priced facts; see `isQuoteStale`. */
  fingerprint: string;
  /** One Persian sentence the UI can show verbatim. */
  explanation: string;
}

/** What the payment boundary re-reads before settling. */
export interface QuotePriceFacts {
  planKey: string;
  termMonths: PlanTermMonths;
  netRial: number;
  basePriceVersionId: string;
  basePriceVersion: number;
}

/**
 * Calendar-month addition with month-end clamping.
 *
 * UTC arithmetic is deliberate: the value is an instant, the caller owns the
 * business timezone, and a quote must not change because the server's local
 * zone differs from the tenant's.
 */
export function addCalendarMonths(fromIso: string, months: number): string {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) throw new Error("invalid_quote_start");
  if (!Number.isInteger(months) || months <= 0) throw new Error("invalid_quote_term");
  const day = from.getUTCDate();
  const target = new Date(from.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return target.toISOString();
}

/**
 * Build the itemised quote.
 *
 * Throws a coded error for a programmer/configuration mistake (an unsupported
 * term, a non-integer amount, an out-of-range rate) rather than producing a
 * total that is merely wrong: a quote that silently rounds a bad rate is worse
 * than a failed request.
 */
export function buildPlanQuote(request: PlanQuoteRequest): PlanQuote {
  if (!isPlanTermMonths(request.termMonths)) throw new Error("invalid_quote_term");
  assertRial(request.monthlyBaseRial, "invalid_quote_base_price");
  assertRate(request.termDiscountRate, "invalid_quote_discount_rate");
  assertRate(request.taxRate, "invalid_quote_tax_rate");
  if (!request.planKey.trim()) throw new Error("invalid_quote_plan");

  const months = request.termMonths;
  const recurring = request.recurringAddOns ?? [];
  const oneOff = request.oneOffAddOns ?? [];
  for (const addOn of recurring) assertRial(addOn.amountRial, "invalid_quote_addon_price");
  for (const addOn of oneOff) assertRial(addOn.amountRial, "invalid_quote_addon_price");

  const lines: QuoteLine[] = [];

  const baseGross = request.monthlyBaseRial * months;
  lines.push({
    kind: "plan_base",
    key: request.planKey,
    label: `اشتراک ماهانهٔ پلن ${request.planKey}`,
    quantity: months,
    unitAmountRial: request.monthlyBaseRial,
    grossRial: baseGross,
    discountRial: 0,
    netRial: baseGross,
    priceVersion: request.basePriceVersion,
  });

  let recurringGross = baseGross;
  for (const addOn of recurring) {
    const gross = addOn.amountRial * months;
    recurringGross += gross;
    lines.push({
      kind: "recurring_addon",
      key: addOn.key,
      label: `افزونهٔ ماهانه: ${addOn.key}`,
      quantity: months,
      unitAmountRial: addOn.amountRial,
      grossRial: gross,
      discountRial: 0,
      netRial: gross,
      priceVersion: addOn.priceVersion ?? null,
    });
  }

  let oneOffGross = 0;
  for (const addOn of oneOff) {
    oneOffGross += addOn.amountRial;
    lines.push({
      kind: "one_off_addon",
      key: addOn.key,
      label: `افزونهٔ یک‌باره: ${addOn.key}`,
      quantity: 1,
      unitAmountRial: addOn.amountRial,
      grossRial: addOn.amountRial,
      discountRial: 0,
      netRial: addOn.amountRial,
      priceVersion: addOn.priceVersion ?? null,
    });
  }

  const grossRial = recurringGross + oneOffGross;
  // Half-up on integers; a term discount is never applied to a one-off add-on.
  const discountRial = Math.round(recurringGross * request.termDiscountRate);
  if (discountRial > 0) {
    lines.push({
      kind: "term_discount",
      key: `term_discount_${months}`,
      label: `تخفیف پرداخت ${months} ماهه`,
      quantity: 1,
      unitAmountRial: 0,
      grossRial: 0,
      discountRial,
      netRial: -discountRial,
      priceVersion: null,
    });
  }

  const netBeforeTax = grossRial - discountRial;
  const taxRial = Math.round(netBeforeTax * request.taxRate);
  if (request.taxRate > 0) {
    lines.push({
      kind: "tax",
      key: "tax",
      label: "مالیات بر ارزش افزوده",
      quantity: 1,
      unitAmountRial: 0,
      grossRial: taxRial,
      discountRial: 0,
      netRial: taxRial,
      priceVersion: null,
    });
  }
  const netRial = netBeforeTax + taxRial;

  const issuedAt = new Date(request.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) throw new Error("invalid_quote_start");
  const validityMinutes = request.validityMinutes ?? 15;
  if (!Number.isFinite(validityMinutes) || validityMinutes <= 0) {
    throw new Error("invalid_quote_validity");
  }

  const quote: PlanQuote = {
    planKey: request.planKey,
    termMonths: months,
    currency: "IRR",
    lines,
    totals: { grossRial, discountRial, taxRial, netRial, savingsRial: discountRial },
    period: {
      start: issuedAt.toISOString(),
      end: addCalendarMonths(issuedAt.toISOString(), months),
    },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + validityMinutes * 60_000).toISOString(),
    fingerprint: "",
    explanation: "",
  };

  quote.fingerprint = quoteFingerprint(quote);
  quote.explanation = quoteExplanation(quote);
  return quote;
}

/**
 * The priced facts, canonicalised. Sorted so two builds of the same quote in
 * either line order compare equal.
 */
export function quoteFingerprint(quote: PlanQuote): string {
  const priced = quote.lines
    .filter((line) => line.priceVersion !== null)
    .map((line) => `${line.kind}:${line.key}@${line.priceVersion!.id}#${line.priceVersion!.version}`)
    .sort();
  return [
    quote.planKey,
    `term=${quote.termMonths}`,
    `net=${quote.totals.netRial}`,
    ...priced,
  ].join("|");
}

/**
 * Has the world moved since this quote was produced?
 *
 * Called at the payment boundary with the facts re-read from the database. A
 * different net, term, plan or price version — or an expired quote — is stale
 * and must be re-quoted; settling a stale quote is how a customer pays
 * yesterday's price for today's plan.
 */
export function isQuoteStale(
  quote: PlanQuote,
  current: QuotePriceFacts,
  now: Date = new Date(),
): boolean {
  if (new Date(quote.expiresAt).getTime() <= now.getTime()) return true;
  if (current.planKey !== quote.planKey) return true;
  if (current.termMonths !== quote.termMonths) return true;
  if (current.netRial !== quote.totals.netRial) return true;
  return (
    current.basePriceVersionId !== quote.lines[0]?.priceVersion?.id ||
    current.basePriceVersion !== quote.lines[0]?.priceVersion?.version
  );
}

/** Persian one-liner for the confirmation step; amounts are Rial. */
function quoteExplanation(quote: PlanQuote): string {
  const { grossRial, discountRial, taxRial, netRial } = quote.totals;
  const parts = [
    `دورهٔ ${quote.termMonths} ماهه`,
    `${formatRial(grossRial)} ریال پیش از تخفیف`,
  ];
  if (discountRial > 0) parts.push(`${formatRial(discountRial)} ریال تخفیف`);
  if (taxRial > 0) parts.push(`${formatRial(taxRial)} ریال مالیات`);
  parts.push(`مبلغ قابل پرداخت ${formatRial(netRial)} ریال`);
  return `${parts.join("، ")}.`;
}

function formatRial(value: number): string {
  return value.toLocaleString("en-US");
}

function assertRial(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function assertRate(value: number, code: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(code);
}
