/**
 * The one customer-price calculation. Callers pass a quantity, the allowance
 * still remaining, and the price version that was effective when the usage
 * happened. They do not invent a rate.
 */

export interface PriceVersionPoint {
  id?: string;
  version: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  unitAmountRial: number;
  unitSize: number;
}

export interface RateInput {
  quantity: number;
  /** Allowance still unused. Null means the meter has no included quantity. */
  includedRemaining: number | null;
  overageEnabled: boolean;
  /** Absolute quantity cap for the period, including the allowance. Null = no cap. */
  hardLimit: number | null;
  /** Null when no price version covers the usage instant — never treated as free. */
  price: { unitAmountRial: number; unitSize: number } | null;
  rounding: "ceil" | "floor";
}

export interface RateResult {
  includedConsumed: number;
  overageQuantity: number;
  amountRial: number;
  blocked: boolean;
  blockReason: "hard_limit" | "overage_disabled" | "no_price" | null;
}

export function selectPriceVersion<T extends PriceVersionPoint>(versions: readonly T[], atIso: string): T | null {
  const at = new Date(atIso).getTime();
  if (Number.isNaN(at)) return null;
  const eligible = versions.filter((version) => {
    const from = new Date(version.effectiveFrom).getTime();
    const until = version.effectiveUntil ? new Date(version.effectiveUntil).getTime() : Number.POSITIVE_INFINITY;
    return from <= at && at < until;
  });
  eligible.sort((a, b) => b.version - a.version || b.effectiveFrom.localeCompare(a.effectiveFrom));
  return eligible[0] ?? null;
}

export function roundMoney(raw: number, rounding: "ceil" | "floor" = "ceil"): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return rounding === "floor" ? Math.floor(raw) : Math.ceil(raw);
}

/**
 * Rate one integer quantity. Included units are free. Overage is priced from
 * the selected version. A missing price blocks the charge instead of billing zero.
 */
export function rateQuantity(input: RateInput): RateResult {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) {
    throw new Error("invalid_quantity");
  }
  const includedRemaining = input.includedRemaining == null ? 0 : Math.max(0, Math.floor(input.includedRemaining));
  if (input.hardLimit != null && input.quantity > input.hardLimit) {
    return {
      includedConsumed: 0,
      overageQuantity: 0,
      amountRial: 0,
      blocked: true,
      blockReason: "hard_limit",
    };
  }
  const includedConsumed = Math.min(input.quantity, includedRemaining);
  const overageQuantity = input.quantity - includedConsumed;
  if (overageQuantity === 0) {
    return { includedConsumed, overageQuantity: 0, amountRial: 0, blocked: false, blockReason: null };
  }
  if (!input.overageEnabled) {
    return { includedConsumed, overageQuantity, amountRial: 0, blocked: true, blockReason: "overage_disabled" };
  }
  if (!input.price) {
    return { includedConsumed, overageQuantity, amountRial: 0, blocked: true, blockReason: "no_price" };
  }
  const unitSize = Math.max(1, Math.floor(input.price.unitSize));
  const amountRial = roundMoney(
    (overageQuantity / unitSize) * Math.max(0, Math.floor(input.price.unitAmountRial)),
    input.rounding,
  );
  return { includedConsumed, overageQuantity, amountRial, blocked: false, blockReason: null };
}

export interface StorageDayTariff {
  billingEnabled: boolean;
  dailyFlatRial: number;
  dailyPerGbRial: number;
  freeQuotaMb: number;
}

export interface StorageDayRate {
  flatRial: number;
  perGbRial: number;
  totalRial: number;
  billableBytes: number;
  /** bytes × 24 — the auditable quantity for `media.storage_byte_hour`. */
  byteHours: number;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * One local day's storage, priced from the tariff that was effective that day.
 * The flat component is a fixed daily fee; bytes above the quota are pro-rated
 * per GiB and rounded according to the commercial rounding rule (default ceil).
 * The byte-hour quantity is what the usage ledger stores.
 */
export function rateStorageDay(
  storedBytes: number,
  tariff: StorageDayTariff,
  rounding: "ceil" | "floor" = "ceil",
): StorageDayRate {
  const bytes = Math.max(0, Math.floor(storedBytes));
  const byteHours = bytes * 24;
  if (!tariff.billingEnabled || bytes === 0) {
    return { flatRial: 0, perGbRial: 0, totalRial: 0, billableBytes: 0, byteHours };
  }
  const flatRial = Math.max(0, Math.floor(tariff.dailyFlatRial));
  const billableBytes = Math.max(0, bytes - Math.max(0, Math.floor(tariff.freeQuotaMb)) * MB);
  const perGbRial =
    billableBytes > 0 && tariff.dailyPerGbRial > 0
      ? roundMoney((billableBytes / GB) * tariff.dailyPerGbRial, rounding)
      : 0;
  return { flatRial, perGbRial, totalRial: flatRial + perGbRial, billableBytes, byteHours };
}

export interface TaxAndRoundingResult {
  subtotalRial: number;
  discountRial: number;
  netSubtotalRial: number;
  taxRateBps: number;
  taxRial: number;
  totalRial: number;
  rounding: "ceil" | "floor";
}

/**
 * Apply commercial discount, tax (in basis points, 100 bps = 1%) and rounding
 * (`ceil` or `floor`) to an integer Rial subtotal.
 */
export function applyTaxAndRounding(input: {
  subtotalRial: number;
  discountRial?: number;
  taxRateBps?: number;
  rounding?: "ceil" | "floor";
}): TaxAndRoundingResult {
  const rounding = input.rounding === "floor" ? "floor" : "ceil";
  const subtotalRial = Math.max(0, Math.floor(input.subtotalRial));
  const discountRial = Math.min(subtotalRial, Math.max(0, Math.floor(input.discountRial ?? 0)));
  const netSubtotalRial = subtotalRial - discountRial;
  const taxRateBps = Math.max(0, Math.min(10_000, Math.floor(input.taxRateBps ?? 0)));
  const taxRial = taxRateBps > 0 ? roundMoney((netSubtotalRial * taxRateBps) / 10_000, rounding) : 0;
  return {
    subtotalRial,
    discountRial,
    netSubtotalRial,
    taxRateBps,
    taxRial,
    totalRial: netSubtotalRial + taxRial,
    rounding,
  };
}

export interface CommercialQuoteAddonLine {
  featureKey: string;
  description: string;
  amountRial: number;
}

export type CommercialQuoteInput =
  | {
      kind: "plan";
      basePlanRial: number;
      addons?: CommercialQuoteAddonLine[];
      discountRial?: number;
      taxRateBps?: number;
      rounding?: "ceil" | "floor";
    }
  | {
      kind: "topup";
      amountRial: number;
      creditRial?: number;
      minimumTopUpRial?: number;
      isPackage?: boolean;
      taxRateBps?: number;
      rounding?: "ceil" | "floor";
    }
  | {
      kind: "addon";
      amountRial: number;
      discountRial?: number;
      taxRateBps?: number;
      rounding?: "ceil" | "floor";
    }
  | {
      kind: "meter";
      quantity: number;
      includedRemaining?: number | null;
      overageEnabled?: boolean;
      hardLimit?: number | null;
      price: { unitAmountRial: number; unitSize: number } | null;
      taxRateBps?: number;
      rounding?: "ceil" | "floor";
    }
  | {
      kind: "storage_day";
      storedBytes: number;
      tariff: StorageDayTariff;
      taxRateBps?: number;
      rounding?: "ceil" | "floor";
    };

export interface CommercialQuoteResult {
  kind: CommercialQuoteInput["kind"];
  valid: boolean;
  error:
    | "invalid_amount"
    | "below_minimum_top_up"
    | "hard_limit"
    | "overage_disabled"
    | "no_price"
    | null;
  baseRial: number;
  addonRial: number;
  subtotalRial: number;
  discountRial: number;
  taxRateBps: number;
  taxRial: number;
  totalRial: number;
  creditRial: number;
  rounding: "ceil" | "floor";
  lines: { kind: string; description: string; amountRial: number; featureKey?: string }[];
  meterBreakdown?: RateResult;
  storageBreakdown?: StorageDayRate;
}

/**
 * Unified commercial quote calculator used across initial purchase, renewal,
 * metered rating and the superadmin quote preview calculator.
 */
export function calculateCommercialQuote(input: CommercialQuoteInput): CommercialQuoteResult {
  const rounding = input.rounding === "floor" ? "floor" : "ceil";
  const taxRateBps = Math.max(0, Math.min(10_000, Math.floor(input.taxRateBps ?? 0)));

  if (input.kind === "plan") {
    if (!Number.isSafeInteger(input.basePlanRial) || input.basePlanRial < 0) {
      return invalidQuote("plan", "invalid_amount", rounding, taxRateBps);
    }
    const baseRial = input.basePlanRial;
    const addons = input.addons ?? [];
    const addonRial = addons.reduce((sum, a) => sum + Math.max(0, Math.floor(a.amountRial)), 0);
    const subtotalRial = baseRial + addonRial;
    const taxed = applyTaxAndRounding({
      subtotalRial,
      discountRial: input.discountRial,
      taxRateBps,
      rounding,
    });
    return {
      kind: "plan",
      valid: true,
      error: null,
      baseRial,
      addonRial,
      subtotalRial: taxed.subtotalRial,
      discountRial: taxed.discountRial,
      taxRateBps: taxed.taxRateBps,
      taxRial: taxed.taxRial,
      totalRial: taxed.totalRial,
      creditRial: 0,
      rounding,
      lines: [
        { kind: "plan", description: "حق اشتراک پلن", amountRial: baseRial },
        ...addons.map((a) => ({
          kind: "addon",
          description: a.description,
          amountRial: Math.max(0, Math.floor(a.amountRial)),
          featureKey: a.featureKey,
        })),
      ],
    };
  }

  if (input.kind === "topup") {
    if (!Number.isSafeInteger(input.amountRial) || input.amountRial <= 0) {
      return invalidQuote("topup", "invalid_amount", rounding, taxRateBps);
    }
    const minTopUp = Math.max(0, Math.floor(input.minimumTopUpRial ?? 0));
    if (!input.isPackage && minTopUp > 0 && input.amountRial < minTopUp) {
      return invalidQuote("topup", "below_minimum_top_up", rounding, taxRateBps);
    }
    const creditRial =
      input.creditRial !== undefined && Number.isSafeInteger(input.creditRial) && input.creditRial > 0
        ? input.creditRial
        : input.amountRial;
    const taxed = applyTaxAndRounding({
      subtotalRial: input.amountRial,
      taxRateBps,
      rounding,
    });
    return {
      kind: "topup",
      valid: true,
      error: null,
      baseRial: input.amountRial,
      addonRial: 0,
      subtotalRial: taxed.subtotalRial,
      discountRial: 0,
      taxRateBps: taxed.taxRateBps,
      taxRial: taxed.taxRial,
      totalRial: taxed.totalRial,
      creditRial,
      rounding,
      lines: [{ kind: "credit", description: "شارژ اعتبار کیف پول", amountRial: input.amountRial }],
    };
  }

  if (input.kind === "addon") {
    if (!Number.isSafeInteger(input.amountRial) || input.amountRial < 0) {
      return invalidQuote("addon", "invalid_amount", rounding, taxRateBps);
    }
    const taxed = applyTaxAndRounding({
      subtotalRial: input.amountRial,
      discountRial: input.discountRial,
      taxRateBps,
      rounding,
    });
    return {
      kind: "addon",
      valid: true,
      error: null,
      baseRial: 0,
      addonRial: input.amountRial,
      subtotalRial: taxed.subtotalRial,
      discountRial: taxed.discountRial,
      taxRateBps: taxed.taxRateBps,
      taxRial: taxed.taxRial,
      totalRial: taxed.totalRial,
      creditRial: 0,
      rounding,
      lines: [{ kind: "addon", description: "خرید افزونه", amountRial: input.amountRial }],
    };
  }

  if (input.kind === "meter") {
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) {
      return invalidQuote("meter", "invalid_amount", rounding, taxRateBps);
    }
    const rated = rateQuantity({
      quantity: input.quantity,
      includedRemaining: input.includedRemaining ?? null,
      overageEnabled: input.overageEnabled ?? true,
      hardLimit: input.hardLimit ?? null,
      price: input.price,
      rounding,
    });
    if (rated.blocked) {
      return {
        ...invalidQuote("meter", rated.blockReason ?? "no_price", rounding, taxRateBps),
        meterBreakdown: rated,
      };
    }
    const taxed = applyTaxAndRounding({
      subtotalRial: rated.amountRial,
      taxRateBps,
      rounding,
    });
    return {
      kind: "meter",
      valid: true,
      error: null,
      baseRial: rated.amountRial,
      addonRial: 0,
      subtotalRial: taxed.subtotalRial,
      discountRial: 0,
      taxRateBps: taxed.taxRateBps,
      taxRial: taxed.taxRial,
      totalRial: taxed.totalRial,
      creditRial: 0,
      rounding,
      lines: [{ kind: "usage", description: "مصرف کنتور", amountRial: rated.amountRial }],
      meterBreakdown: rated,
    };
  }

  // storage_day
  if (!Number.isSafeInteger(input.storedBytes) || input.storedBytes < 0) {
    return invalidQuote("storage_day", "invalid_amount", rounding, taxRateBps);
  }
  const storage = rateStorageDay(input.storedBytes, input.tariff, rounding);
  const taxed = applyTaxAndRounding({
    subtotalRial: storage.totalRial,
    taxRateBps,
    rounding,
  });
  return {
    kind: "storage_day",
    valid: true,
    error: null,
    baseRial: storage.flatRial,
    addonRial: storage.perGbRial,
    subtotalRial: taxed.subtotalRial,
    discountRial: 0,
    taxRateBps: taxed.taxRateBps,
    taxRial: taxed.taxRial,
    totalRial: taxed.totalRial,
    creditRial: 0,
    rounding,
    lines: [
      { kind: "usage", description: "هزینهٔ پایهٔ روزانهٔ فضا", amountRial: storage.flatRial },
      { kind: "usage", description: "هزینهٔ حجم مازاد بر سهمیه", amountRial: storage.perGbRial },
    ],
    storageBreakdown: storage,
  };
}

function invalidQuote(
  kind: CommercialQuoteInput["kind"],
  error: NonNullable<CommercialQuoteResult["error"]>,
  rounding: "ceil" | "floor",
  taxRateBps: number,
): CommercialQuoteResult {
  return {
    kind,
    valid: false,
    error,
    baseRial: 0,
    addonRial: 0,
    subtotalRial: 0,
    discountRial: 0,
    taxRateBps,
    taxRial: 0,
    totalRial: 0,
    creditRial: 0,
    rounding,
    lines: [],
  };
}
