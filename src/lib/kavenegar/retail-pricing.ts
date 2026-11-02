/**
 * Issue #902 §4 — the retail price of one managed message.
 *
 * Two prices describe one SMS and they must never be confused:
 *
 *   * **wholesale** — what the provider charges the platform (per child tariff,
 *     reported back per message as `cost`);
 *   * **retail** — what the business pays out of its ONE platform wallet.
 *
 * `pricing-service.ts` quotes both and computes the margin between them. This
 * module is the *policy* the retail price comes from, and it is pure: no
 * database, no clock of its own, no provider call. Everything here is an
 * integer Rial decision that a test can pin down.
 *
 * The pricing model, in the order it applies:
 *
 *   1. **base**      — `unit × quantity`, from Billing's own rate
 *                      (`platform_message_config`). Never derived here.
 *   2. **slab**      — the volume tier for this business's segments in the
 *                      current month REPLACES the version's markup/surcharge.
 *   3. **override**  — channel, then business, then business+channel; each row
 *                      overrides only the fields it sets, so the most specific
 *                      exception wins and the rest of the price stands.
 *   4. **markup**    — `floor(base × markupBps / 10000)`.
 *   5. **surcharge** — a flat Rial handling fee, ONCE per message (not per
 *                      segment). A message fully covered by the free allowance
 *                      costs nothing at all.
 *   6. **discount**  — a promotion, `floor(gross × discountBps / 10000)`, only
 *                      while the promotion window is open.
 *   7. **tax**       — `floor(taxable × taxBps / 10000)`, on the discounted
 *                      amount, rounded down like every other Rial figure in
 *                      this codebase.
 *
 * Every step floors and every step is clamped at zero, so the result is always a
 * safe non-negative integer and the same inputs always produce the same price.
 * Nothing here reads a provider tariff: retail must not move when wholesale
 * does.
 */

/** A channel the platform can bill for. */
export type RetailChannel = "sms" | "email";

/**
 * What a *failed* send costs the tenant.
 *
 * The issue is explicit that this is a policy, not an assumption: "define
 * whether the supplier bills accepted-but-undelivered messages; reconcile and
 * refund ONLY according to actual billing policy, not an assumption that failed
 * delivery always costs zero".
 *
 *   * `refund` — no acceptance, no charge. The reservation is refunded in full.
 *   * `charge` — the attempt is billed (only where the supplier actually bills
 *                it, e.g. an accepted-but-undelivered message).
 *
 * The default is `refund`; turning it on is an explicit Superadmin publish.
 */
export type FailedSendPolicy = "refund" | "charge";

/** One volume tier. `minMonthlySegments` is inclusive. */
export interface RetailPriceSlab {
  minMonthlySegments: number;
  markupBps: number;
  fixedSurchargeRial: number;
}

/** One exception row. `null` on a field means "keep whatever the slab says". */
export interface RetailPriceOverride {
  scope: "channel" | "business" | "business_channel";
  /** Set for business scopes; absent/null for a channel-wide row. */
  businessId?: string | null;
  /** Set for channel scopes; absent/null for a business-wide row. */
  channel?: RetailChannel | null;
  markupBps: number | null;
  fixedSurchargeRial: number | null;
  note?: string | null;
}

/** A published (or default) price policy. */
export interface RetailPriceVersion {
  /** `null` for the built-in default, which is never persisted. */
  id: string | null;
  /** 0 for the built-in default. */
  version: number;
  effectiveFrom: string | null;
  effectiveUntil?: string | null;
  /** Basis points; 100 bps = 1%. */
  markupBps: number;
  fixedSurchargeRial: number;
  discountBps: number;
  /** ISO timestamp; `null` = the promotion never ends. */
  discountUntil?: string | null;
  taxBps: number;
  freeAllowanceSegments: number;
  failedSendPolicy: FailedSendPolicy;
  note?: string | null;
  createdBy?: string | null;
  slabs: RetailPriceSlab[];
  overrides: RetailPriceOverride[];
}

/**
 * The price policy that applies when Superadmin has published nothing: charge
 * exactly the Billing base rate. This is why shipping §4 cannot change an
 * existing tenant's bill until an operator deliberately publishes a version.
 */
export const DEFAULT_RETAIL_PRICE_VERSION: RetailPriceVersion = {
  id: null,
  version: 0,
  effectiveFrom: null,
  effectiveUntil: null,
  markupBps: 0,
  fixedSurchargeRial: 0,
  discountBps: 0,
  discountUntil: null,
  taxBps: 0,
  freeAllowanceSegments: 0,
  failedSendPolicy: "refund",
  note: null,
  createdBy: null,
  slabs: [],
  overrides: [],
};

function money(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

function bps(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(10_000, Math.trunc(n));
}

/** `floor(amount × bps / 10000)` — the one rounding rule, in one place. */
export function applyBps(amountRial: number, rateBps: number): number {
  if (amountRial <= 0 || rateBps <= 0) return 0;
  return Math.floor((amountRial * rateBps) / 10_000);
}

export interface ResolvedRetailTerms {
  markupBps: number;
  fixedSurchargeRial: number;
  /** The tier that matched, for the console and the audit trail. */
  slabMinMonthlySegments: number | null;
  /** Which exception rows applied, most general first. */
  appliedOverrides: ("channel" | "business" | "business_channel")[];
}

/**
 * Slab + override resolution. Precedence, deliberately, is
 * slab → channel → business → business_channel: an exception row is a
 * commercial agreement and must beat a volume tier, and the narrowest
 * agreement wins over the broader one.
 */
export function resolveRetailTerms(
  version: RetailPriceVersion,
  input: { businessId: string; channel: RetailChannel; monthlySegments: number },
): ResolvedRetailTerms {
  const monthly = money(input.monthlySegments);
  let markupBps = bps(version.markupBps);
  let fixedSurchargeRial = money(version.fixedSurchargeRial);
  let slabMinMonthlySegments: number | null = null;

  const matching = [...version.slabs]
    .filter((slab) => money(slab.minMonthlySegments) <= monthly)
    .sort((a, b) => money(b.minMonthlySegments) - money(a.minMonthlySegments))[0];
  if (matching) {
    markupBps = bps(matching.markupBps);
    fixedSurchargeRial = money(matching.fixedSurchargeRial);
    slabMinMonthlySegments = money(matching.minMonthlySegments);
  }

  const appliedOverrides: ResolvedRetailTerms["appliedOverrides"] = [];
  const order: RetailPriceOverride["scope"][] = ["channel", "business", "business_channel"];
  for (const scope of order) {
    const row = version.overrides.find((override) => {
      if (override.scope !== scope) return false;
      if (scope === "channel") return override.channel === input.channel;
      if (scope === "business") return override.businessId === input.businessId;
      return override.businessId === input.businessId && override.channel === input.channel;
    });
    if (!row) continue;
    if (row.markupBps !== null && row.markupBps !== undefined) markupBps = bps(row.markupBps);
    if (row.fixedSurchargeRial !== null && row.fixedSurchargeRial !== undefined) {
      fixedSurchargeRial = money(row.fixedSurchargeRial);
    }
    appliedOverrides.push(scope);
  }

  return { markupBps, fixedSurchargeRial, slabMinMonthlySegments, appliedOverrides };
}

/** Segments of the monthly allowance still unused. Never negative. */
export function remainingFreeAllowance(
  version: RetailPriceVersion,
  monthlySegmentsUsed: number,
): number {
  return Math.max(0, money(version.freeAllowanceSegments) - money(monthlySegmentsUsed));
}

/** Is the promotion window open at `at`? */
export function discountIsActive(version: RetailPriceVersion, at: Date): boolean {
  if (bps(version.discountBps) <= 0) return false;
  if (!version.discountUntil) return true;
  const until = Date.parse(version.discountUntil);
  if (!Number.isFinite(until)) return false;
  return at.getTime() < until;
}

export interface RetailChargeQuote {
  channel: RetailChannel;
  /** Units the message is billed for (segments for SMS, 1 for email). */
  quantity: number;
  /** Units actually paid for after the free allowance. */
  billableUnits: number;
  freeUnits: number;
  baseRial: number;
  markupRial: number;
  surchargeRial: number;
  discountRial: number;
  taxRial: number;
  /** What the wallet is charged. Always `base + markup + surcharge − discount + tax`. */
  totalRial: number;
  priceVersionId: string | null;
  priceVersion: number;
  markupBps: number;
  fixedSurchargeRial: number;
  slabMinMonthlySegments: number | null;
  taxBps: number;
  discountBps: number;
}

/**
 * Price one message.
 *
 * `freeAllowanceRemaining` is passed in rather than looked up: a batch must
 * consume the monthly allowance in a defined order, so the caller walks it down
 * as it prices each message. That keeps the quote a pure function and makes the
 * batch total equal to the sum of its parts — the property the reservation and
 * the settlement both depend on.
 */
export function quoteRetailCharge(input: {
  channel: RetailChannel;
  /** Rial per unit at the Billing base rate. */
  unitPriceRial: number;
  /** Segments for SMS, 1 for email. Minimum 1 — a send is never free-form. */
  quantity: number;
  businessId: string;
  monthlySegments: number;
  freeAllowanceRemaining: number;
  version: RetailPriceVersion;
  /** Defaults to now; injected so the promotion window is testable. */
  at?: Date;
}): RetailChargeQuote {
  const at = input.at ?? new Date();
  const unitPrice = money(input.unitPriceRial);
  const quantity = Math.max(1, money(input.quantity));
  const terms = resolveRetailTerms(input.version, {
    businessId: input.businessId,
    channel: input.channel,
    monthlySegments: input.monthlySegments,
  });

  // The allowance is a messaging allowance: it covers SMS segments, and only
  // SMS is billed per segment. Email keeps its own flat price.
  const freeUnits =
    input.channel === "sms"
      ? Math.min(quantity, Math.max(0, money(input.freeAllowanceRemaining)))
      : 0;
  const billableUnits = quantity - freeUnits;
  const baseRial = unitPrice * billableUnits;
  const markupRial = applyBps(baseRial, terms.markupBps);
  // A fully covered message is free; a partially covered one still carries the
  // one-time handling fee.
  const surchargeRial = billableUnits > 0 ? terms.fixedSurchargeRial : 0;
  const grossRial = baseRial + markupRial + surchargeRial;
  const discountBps = discountIsActive(input.version, at) ? bps(input.version.discountBps) : 0;
  const discountRial = Math.min(grossRial, applyBps(grossRial, discountBps));
  const taxableRial = grossRial - discountRial;
  const taxRial = Math.min(
    taxableRial,
    applyBps(taxableRial, Math.min(10_000, money(input.version.taxBps))),
  );

  return {
    channel: input.channel,
    quantity,
    billableUnits,
    freeUnits,
    baseRial,
    markupRial,
    surchargeRial,
    discountRial,
    taxRial,
    totalRial: taxableRial + taxRial,
    priceVersionId: input.version.id,
    priceVersion: input.version.version,
    markupBps: terms.markupBps,
    fixedSurchargeRial: terms.fixedSurchargeRial,
    slabMinMonthlySegments: terms.slabMinMonthlySegments,
    taxBps: money(input.version.taxBps),
    discountBps,
  };
}

/**
 * Price a whole batch in order, consuming the monthly allowance as it goes.
 * Returns the per-message quotes and the total the wallet must reserve.
 */
export function quoteRetailBatch(input: {
  businessId: string;
  monthlySegments: number;
  version: RetailPriceVersion;
  messages: { channel: RetailChannel; unitPriceRial: number; quantity: number }[];
  at?: Date;
}): { quotes: RetailChargeQuote[]; totalRial: number; freeUnitsUsed: number } {
  let allowance = remainingFreeAllowance(input.version, input.monthlySegments);
  let freeUnitsUsed = 0;
  let totalRial = 0;
  const quotes = input.messages.map((message) => {
    const quote = quoteRetailCharge({
      ...message,
      businessId: input.businessId,
      monthlySegments: input.monthlySegments,
      freeAllowanceRemaining: allowance,
      version: input.version,
      at: input.at,
    });
    allowance -= quote.freeUnits;
    freeUnitsUsed += quote.freeUnits;
    totalRial += quote.totalRial;
    return quote;
  });
  return { quotes, totalRial, freeUnitsUsed };
}

// ---------------------------------------------------------------------------
// Validation — the route and the service share one parser so a version that
// cannot be quoted can never be published.
// ---------------------------------------------------------------------------

export interface RetailPriceVersionInput {
  markupBps: number;
  fixedSurchargeRial: number;
  discountBps: number;
  discountUntil: string | null;
  taxBps: number;
  freeAllowanceSegments: number;
  failedSendPolicy: FailedSendPolicy;
  note: string | null;
  effectiveFrom: string | null;
  slabs: RetailPriceSlab[];
  overrides: RetailPriceOverride[];
}

export type RetailPriceVersionInputResult =
  | { ok: true; value: RetailPriceVersionInput }
  | { ok: false; error: string };

const CHANNELS: RetailChannel[] = ["sms", "email"];

function integerInRange(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed =
    typeof value === "string" ? Number(value.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))) : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/**
 * Parse and normalise a publish request. Rejects rather than clamps: a markup of
 * -5% or a surcharge of "abc" is a mistake the operator must see, not a silent
 * price change.
 */
export function parseRetailPriceVersionInput(body: unknown): RetailPriceVersionInputResult {
  if (!body || typeof body !== "object") return { ok: false, error: "bad_request" };
  const input = body as Record<string, unknown>;

  const markupBps = integerInRange(input.markupBps ?? 0, 0, 100_000);
  if (markupBps === null) return { ok: false, error: "invalid_markup" };
  const fixedSurchargeRial = integerInRange(input.fixedSurchargeRial ?? 0, 0, 100_000_000_000);
  if (fixedSurchargeRial === null) return { ok: false, error: "invalid_surcharge" };
  const discountBps = integerInRange(input.discountBps ?? 0, 0, 10_000);
  if (discountBps === null) return { ok: false, error: "invalid_discount" };
  const taxBps = integerInRange(input.taxBps ?? 0, 0, 10_000);
  if (taxBps === null) return { ok: false, error: "invalid_tax" };
  const freeAllowanceSegments = integerInRange(input.freeAllowanceSegments ?? 0, 0, 10_000_000);
  if (freeAllowanceSegments === null) return { ok: false, error: "invalid_free_allowance" };

  const failedSendPolicy = input.failedSendPolicy ?? "refund";
  if (failedSendPolicy !== "refund" && failedSendPolicy !== "charge") {
    return { ok: false, error: "invalid_failed_send_policy" };
  }

  let discountUntil: string | null = null;
  if (input.discountUntil !== undefined && input.discountUntil !== null && input.discountUntil !== "") {
    const parsed = Date.parse(String(input.discountUntil));
    if (!Number.isFinite(parsed)) return { ok: false, error: "invalid_discount_until" };
    discountUntil = new Date(parsed).toISOString();
  }
  let effectiveFrom: string | null = null;
  if (input.effectiveFrom !== undefined && input.effectiveFrom !== null && input.effectiveFrom !== "") {
    const parsed = Date.parse(String(input.effectiveFrom));
    if (!Number.isFinite(parsed)) return { ok: false, error: "invalid_effective_from" };
    effectiveFrom = new Date(parsed).toISOString();
  }

  const rawSlabs = Array.isArray(input.slabs) ? input.slabs : [];
  if (rawSlabs.length > 20) return { ok: false, error: "too_many_slabs" };
  const slabs: RetailPriceSlab[] = [];
  for (const raw of rawSlabs) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_slab" };
    const slab = raw as Record<string, unknown>;
    const min = integerInRange(slab.minMonthlySegments, 0, 1_000_000_000);
    const slabMarkup = integerInRange(slab.markupBps, 0, 100_000);
    const slabSurcharge = integerInRange(slab.fixedSurchargeRial ?? 0, 0, 100_000_000_000);
    if (min === null || slabMarkup === null || slabSurcharge === null) {
      return { ok: false, error: "invalid_slab" };
    }
    if (slabs.some((existing) => existing.minMonthlySegments === min)) {
      return { ok: false, error: "duplicate_slab" };
    }
    slabs.push({ minMonthlySegments: min, markupBps: slabMarkup, fixedSurchargeRial: slabSurcharge });
  }

  const rawOverrides = Array.isArray(input.overrides) ? input.overrides : [];
  if (rawOverrides.length > 50) return { ok: false, error: "too_many_overrides" };
  const overrides: RetailPriceOverride[] = [];
  for (const raw of rawOverrides) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_override" };
    const row = raw as Record<string, unknown>;
    const scope = row.scope;
    if (scope !== "channel" && scope !== "business" && scope !== "business_channel") {
      return { ok: false, error: "invalid_override_scope" };
    }
    const businessId =
      scope === "channel" ? null : typeof row.businessId === "string" && row.businessId.trim() ? row.businessId.trim() : null;
    if (scope !== "channel" && !businessId) return { ok: false, error: "invalid_override_business" };
    if (businessId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) {
      return { ok: false, error: "invalid_override_business" };
    }
    const channel = scope === "business" ? null : (row.channel as RetailChannel | null | undefined);
    if (scope !== "business" && (!channel || !CHANNELS.includes(channel))) {
      return { ok: false, error: "invalid_override_channel" };
    }
    const overrideMarkup =
      row.markupBps === undefined || row.markupBps === null || row.markupBps === ""
        ? null
        : integerInRange(row.markupBps, 0, 100_000);
    const overrideSurcharge =
      row.fixedSurchargeRial === undefined || row.fixedSurchargeRial === null || row.fixedSurchargeRial === ""
        ? null
        : integerInRange(row.fixedSurchargeRial, 0, 100_000_000_000);
    if (overrideMarkup === null && overrideSurcharge === null) {
      return { ok: false, error: "empty_override" };
    }
    const duplicate = overrides.some(
      (existing) =>
        existing.scope === scope &&
        existing.businessId === businessId &&
        existing.channel === (channel ?? null),
    );
    if (duplicate) return { ok: false, error: "duplicate_override" };
    overrides.push({
      scope,
      businessId,
      channel: channel ?? null,
      markupBps: overrideMarkup,
      fixedSurchargeRial: overrideSurcharge,
      note: typeof row.note === "string" ? row.note.slice(0, 500) : null,
    });
  }

  return {
    ok: true,
    value: {
      markupBps,
      fixedSurchargeRial,
      discountBps,
      discountUntil,
      taxBps,
      freeAllowanceSegments,
      failedSendPolicy,
      note: typeof input.note === "string" ? input.note.slice(0, 500) : null,
      effectiveFrom,
      slabs,
      overrides,
    },
  };
}
