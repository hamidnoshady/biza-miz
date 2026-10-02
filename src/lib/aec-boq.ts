/**
 * Issue #799 §7 — the BOQ/estimate domain's pure half: statuses, units, the
 * transition rules and the price arithmetic.
 *
 * Everything here is data or a small function over it, with no database and no
 * framework, for the same reason `aec.ts` is pure: the client editor needs the
 * unit list and the live total preview, and it must not drag `pg` in with them.
 *
 * ## The one thing worth reading twice
 *
 * `computeBoqItemTotals` is a MIRROR, not the authority. The authority is the
 * `aec_boq_item_totals()` trigger in migration 0196 — the database recomputes
 * `unit_price_rial` and `total_rial` on every write, so a total can never
 * disagree with its own rate breakdown. This function exists so the form can
 * show the same number before the row is saved, and it is written in **exact
 * integer arithmetic** (BigInt basis points, no floating point) to match the
 * trigger's exact decimal arithmetic rather than approximately agree with it.
 * `integration/aec-boq.integration.test.ts` asserts the two agree on the same
 * inputs — a preview that quietly disagrees with the stored number would be
 * worse than no preview.
 */

export const ESTIMATE_VERSION_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "superseded",
] as const;
export type EstimateVersionStatus = (typeof ESTIMATE_VERSION_STATUSES)[number];

export const ESTIMATE_VERSION_STATUS_LABELS: Record<EstimateVersionStatus, string> = {
  draft: "پیش‌نویس",
  submitted: "ثبت‌شده برای بررسی",
  under_review: "در حال بررسی",
  approved: "تأییدشده",
  superseded: "منسوخ",
};

/**
 * The forward-only flow of §7, plus the two backward moves real reviewing
 * needs: a version can be returned to its author (to `draft`) from either
 * `submitted` or `under_review`, and an approved revision is retired by
 * approving a later one (`approved → superseded`) rather than by reverting it.
 *
 * `submitted → approved` is allowed because many offices review a revision and
 * approve it in one sitting; `under_review` is then bookkeeping the reviewer
 * may or may not fill in, never a gate to pass.
 */
const ESTIMATE_VERSION_TRANSITIONS: Record<EstimateVersionStatus, readonly EstimateVersionStatus[]> = {
  draft: ["submitted"],
  submitted: ["under_review", "approved", "draft"],
  under_review: ["approved", "draft"],
  approved: ["superseded"],
  superseded: [],
};

export function canTransitionEstimateVersion(
  from: EstimateVersionStatus,
  to: EstimateVersionStatus,
): boolean {
  return ESTIMATE_VERSION_TRANSITIONS[from].includes(to);
}

/** Only a draft accepts edits — the rule migration 0196 makes structural. */
export function isEditableEstimateVersion(status: EstimateVersionStatus): boolean {
  return status === "draft";
}

/** The actions `aec_estimate_events.action` records, with their Persian labels. */
export const ESTIMATE_EVENT_ACTIONS = [
  "created",
  "version_created",
  "updated",
  "submitted",
  "review_started",
  "approved",
  "returned",
  "superseded",
  "imported",
  "deleted",
] as const;
export type EstimateEventAction = (typeof ESTIMATE_EVENT_ACTIONS)[number];

export const ESTIMATE_EVENT_LABELS: Record<EstimateEventAction, string> = {
  created: "برآورد ایجاد شد",
  version_created: "نسخهٔ جدید ساخته شد",
  updated: "برآورد ویرایش شد",
  submitted: "برای بررسی ثبت شد",
  review_started: "بررسی آغاز شد",
  approved: "تأیید شد",
  returned: "به پیش‌نویس بازگشت",
  superseded: "منسوخ شد",
  imported: "ردیف‌ها از فایل وارد شد",
  deleted: "حذف شد",
};

/* ---------------------------------------------------------------------------
 * Units
 * ------------------------------------------------------------------------- */

export interface BoqUnitDef {
  key: string;
  label: string;
  /** Spellings an imported file may use. Matched case-insensitively. */
  aliases: readonly string[];
}

/**
 * The units a construction BOQ actually measures in. A catalogue rather than a
 * CHECK constraint, because an import should carry an unfamiliar unit through
 * rather than reject the row — the picker is where the list matters.
 */
export const BOQ_UNITS: readonly BoqUnitDef[] = [
  { key: "m2", label: "مترمربع", aliases: ["m2", "m²", "sqm", "متر مربع", "مترمربع", "م2"] },
  { key: "m3", label: "مترمکعب", aliases: ["m3", "m³", "cbm", "متر مکعب", "مترمکعب", "م3"] },
  { key: "m", label: "متر", aliases: ["m", "متر", "متر طول", "طول"] },
  { key: "kg", label: "کیلوگرم", aliases: ["kg", "kgs", "کیلو", "کیلوگرم"] },
  { key: "ton", label: "تن", aliases: ["ton", "tons", "t", "تن"] },
  { key: "no", label: "عدد", aliases: ["no", "num", "عدد", "عددی", "count"] },
  { key: "set", label: "دستگاه", aliases: ["set", "دستگاه", "مجموعه"] },
  { key: "ls", label: "جمع (مقطوع)", aliases: ["ls", "lump sum", "lumpsum", "جمع", "مقطوع"] },
  { key: "l", label: "لیتر", aliases: ["l", "lit", "لیتر"] },
  { key: "km", label: "کیلومتر", aliases: ["km", "کیلومتر"] },
  { key: "man_day", label: "نفر-روز", aliases: ["man day", "man-day", "manday", "نفر روز", "نفر-روز"] },
];

export const BOQ_UNIT_LABELS: Record<string, string> = Object.fromEntries(
  BOQ_UNITS.map((unit) => [unit.key, unit.label]),
);

function fold(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\u200c\u200f\u200e]/g, "") // ZWNJ / directional marks a Persian keyboard adds
    .replace(/\s+/g, " ");
}

/**
 * The stored form of a unit: the catalogue key when the text names one, the
 * trimmed text otherwise (an office's own unit, or one this release does not
 * know). Never throws — refuse the row over its unit and the import stops being
 * an import.
 */
export function normalizeBoqUnit(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const folded = fold(raw);
  for (const unit of BOQ_UNITS) {
    if (fold(unit.key) === folded || fold(unit.label) === folded) return unit.key;
    for (const alias of unit.aliases) {
      if (fold(alias) === folded) return unit.key;
    }
  }
  return raw.slice(0, 20);
}

/** What to show for a stored unit value: its Persian label, or the text itself. */
export function boqUnitLabel(value: string | null): string {
  if (!value) return "";
  return BOQ_UNIT_LABELS[value] ?? value;
}

/* ---------------------------------------------------------------------------
 * The arithmetic
 * ------------------------------------------------------------------------- */

export interface BoqItemRateInput {
  quantity: string | number;
  materialRateRial: number;
  laborRateRial: number;
  equipmentRateRial: number;
  subcontractRateRial: number;
  wastePercent: string | number;
  overheadPercent: string | number;
  markupPercent: string | number;
}

export interface BoqItemTotals {
  /** Rial per unit, rounded to the rial. */
  unitPriceRial: number;
  /** Rial, rounded to the rial. */
  totalRial: number;
}

/** Number.MAX_SAFE_INTEGER — the ceiling migration 0196 puts on a line total. */
export const BOQ_MAX_TOTAL_RIAL = 9_007_199_254_740_991;

/**
 * An exact decimal parse to a scaled BigInt: `"1.25"` at scale 2 → `125n`.
 *
 * Floating point never participates, so `0.1 + 0.2`-class drift cannot make the
 * preview disagree with the database. Values with more decimals than the column
 * accepts are rounded half-up, which is what PostgreSQL's `numeric(…, scale)`
 * assignment does.
 */
function scaledBigInt(value: string | number, decimals: number): bigint {
  const text = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(text) || text === "" || text === "-") {
    throw new Error(`not a decimal: ${text}`);
  }
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace("-", "").split(".");
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  let result = BigInt(`${whole || "0"}${kept}`);
  const dropped = fraction.slice(decimals);
  if (dropped && dropped[0] >= "5") result += 1n; // half-up on the first dropped digit
  return negative ? -result : result;
}

function basisPoints(percent: string | number): bigint {
  // An empty field is how the form spells "no waste / overhead / markup", so it
  // reads as zero here rather than reaching the column as a bad number. The
  // columns are `NOT NULL DEFAULT 0`, so this is the same value a row holds
  // when nobody touches the field at all.
  if (typeof percent === "string" && percent.trim() === "") return 0n;
  return scaledBigInt(percent, 2);
}

/**
 * The mirror of `aec_boq_item_totals()`:
 *
 *   unit_price = round(rateSum × (1 + waste%) × (1 + overhead%) × (1 + markup%))
 *   total      = round(quantity × unit_price)
 *
 * with the percentages as integer basis points and `10^12` as the denominator,
 * so the division is exact and the rounding is the same half-up rounding
 * PostgreSQL performs on the same numbers.
 */
export function computeBoqItemTotals(input: BoqItemRateInput): BoqItemTotals {
  const rateSum =
    BigInt(Math.trunc(input.materialRateRial)) +
    BigInt(Math.trunc(input.laborRateRial)) +
    BigInt(Math.trunc(input.equipmentRateRial)) +
    BigInt(Math.trunc(input.subcontractRateRial));

  const scale = 10_000n; // one whole = 100% = 10 000 basis points
  let numerator = rateSum;
  numerator *= scale + basisPoints(input.wastePercent);
  numerator *= scale + basisPoints(input.overheadPercent);
  numerator *= scale + basisPoints(input.markupPercent);

  const denominator = scale * scale * scale; // 10^12
  const unitPrice = (numerator + denominator / 2n) / denominator;

  const quantity = scaledBigInt(input.quantity, 4); // numeric(16, 4)
  const total = (quantity * unitPrice + 5_000n) / scale; // divide by 10^4, half-up

  return {
    unitPriceRial: Number(unitPrice),
    totalRial: Number(total),
  };
}

/**
 * Whether a line total is inside the range this app can hold exactly. The
 * trigger refuses anything larger; the form asks first so the user gets a
 * sentence rather than a constraint violation.
 */
export function boqTotalFitsInApp(totalRial: number): boolean {
  return Number.isSafeInteger(totalRial) && totalRial >= 0 && totalRial <= BOQ_MAX_TOTAL_RIAL;
}
