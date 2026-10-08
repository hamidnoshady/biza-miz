/**
 * Issue #839 — the automotive trade's pure rules: what a vehicle is, what
 * state it may move to, and the arithmetic the counter, the reports and the
 * dashboard all have to agree on.
 *
 * This is the framework-free counterpart of `automotive-service.ts` (the
 * DB-touching half), the same split `watch.ts`/`watch-sales-service.ts` and
 * `items.ts`/`items-service.ts` use. Everything here is a value, a label, or a
 * small rule over values, so it can be imported by client components, unit
 * tested without a database, and used by the migration's OWNER of truth — the
 * CHECK constraints in `migrations/0212_automotive_vehicle_stock.sql` mirror
 * these lists deliberately, and `automotive.test.ts` asserts the two agree on
 * every enum it can read out of the SQL.
 *
 * The one idea worth stating: a car is **not quantity-only stock**. It is a
 * physical unit with an identity (VIN/chassis/stock number) that survives
 * every operation the trade performs on it, and every rule below exists so
 * that two people cannot end up believing they hold the same car, or that one
 * car was sold twice.
 */
import { isoDateToJalali, jalaliMonthLength, jalaliToIsoDate } from "./jalali";

/* ===========================================================================
 * Condition — new or used, declared, never inferred
 * ===========================================================================
 *
 * §3 of the issue is explicit that condition is a property of the *unit*, not
 * of the business: a dealer sells both off one lot. It is also explicit that
 * `used` must not force every optional field — so mileage, prior owners and
 * the inspection notes are validated *as used data*, and a new vehicle that
 * arrives with 0 km and no inspection is a normal, complete record.
 */

export const VEHICLE_CONDITIONS = ["new", "used"] as const;
export type VehicleCondition = (typeof VEHICLE_CONDITIONS)[number];

export const VEHICLE_CONDITION_LABELS: Record<VehicleCondition, string> = {
  new: "نو",
  used: "کارکرده",
};

export function isVehicleCondition(value: string): value is VehicleCondition {
  return (VEHICLE_CONDITIONS as readonly string[]).includes(value);
}

/* ===========================================================================
 * Lifecycle — one valid state at a time, no contradictory moves
 * ===========================================================================
 *
 * §3's suggested lifecycle, with the two decisions the wording leaves open
 * made explicit here:
 *
 *   * `transferred` means **in transit between branches**, not "was
 *     transferred once". A car being moved is not on either lot, so a hold or
 *     a sale must refuse while it is in that state (hence it is not a state a
 *     sale may start from), and it becomes `in_stock` again when the receiving
 *     branch accepts it. `automotive_vehicle_transfers` keeps the history.
 *   * `sold` is **terminal for the counter**, and only a *reversal* — voiding
 *     the sale through the accounting path, under `orders.amend_closed` — may
 *     move it to `returned`. `validateVehicleStateTransition` therefore
 *     refuses `sold → in_stock` from a plain state update; the reversal
 *     service is the one caller allowed to make that move, and it says so by
 *     name (see `SALE_REVERSAL_ALLOWED_FROM` usage in the sales service).
 */

export const VEHICLE_STATES = [
  "draft",
  "acquired",
  "in_stock",
  "reserved",
  "sold",
  "returned",
  "transferred",
  "archived",
] as const;
export type VehicleState = (typeof VEHICLE_STATES)[number];

export const VEHICLE_STATE_LABELS: Record<VehicleState, string> = {
  draft: "پیش‌نویس",
  acquired: "خریداری‌شده",
  in_stock: "موجود",
  reserved: "رزرو شده",
  sold: "فروخته‌شده",
  returned: "مرجوع‌شده",
  transferred: "در انتقال بین شعبه",
  archived: "بایگانی‌شده",
};

/** States a vehicle is *available to hold or sell* from. `transferred` is not one: it is between lots. */
export const VEHICLE_SELLABLE_STATES: readonly VehicleState[] = ["in_stock", "reserved"];

/** The states that mean "this unit is no longer available stock" — a sale or a permanent archive. */
export const VEHICLE_CLOSED_STATES: readonly VehicleState[] = ["sold", "archived"];

/**
 * Whether the vehicle may be held or sold at all — the question the hold and
 * sale services ask before they look at anything else.
 */
export function isVehicleAvailable(state: VehicleState): boolean {
  return !VEHICLE_CLOSED_STATES.includes(state);
}

/**
 * The one allowed-transition table. `from === to` is always allowed (an
 * idempotent re-assertion, e.g. re-saving an unchanged edit), everything else
 * is a decision:
 *
 *   draft      → acquired | in_stock | archived   (a typed-in car, then
 *             brought in properly, or discarded before it ever became stock)
 *   acquired   → draft | in_stock | archived      (booked, then qualified)
 *   in_stock   → reserved | sold | transferred | returned | archived
 *   reserved   → in_stock | sold | archived       (hold released, or it sold)
 *   sold       → returned                        (reversal only)
 *   returned   → in_stock | archived
 *   transferred→ in_stock | returned | archived  (arrived, came back, written
 *             off)
 *   archived   → (nothing: it is a tombstone, and a mistaken archive is
 *             un-archived by editing the row to `in_stock` through the
 *             explicit `automotive.vehicle_unarchived` event — not by a plain
 *             state transition)
 */
const VEHICLE_TRANSITIONS: Record<VehicleState, readonly VehicleState[]> = {
  draft: ["acquired", "in_stock", "archived"],
  acquired: ["draft", "in_stock", "archived"],
  in_stock: ["reserved", "sold", "transferred", "returned", "archived"],
  reserved: ["in_stock", "sold", "archived"],
  sold: ["returned"],
  returned: ["in_stock", "archived"],
  transferred: ["in_stock", "returned", "archived"],
  archived: [],
};

/**
 * The reversal exception, stated once rather than implied by a hole in the
 * table: voiding a completed sale is the *only* operation that moves a car out
 * of `sold`, it is performed by the accounting reversal path (never by a
 * status edit), and it lands in `returned` — not back in `in_stock`, so the
 * unit visibly carries the fact that it was sold and came back.
 */
export const SALE_REVERSAL_STATE = "returned" as const;

export function validateVehicleStateTransition(from: VehicleState, to: VehicleState): string | null {
  if (from === to) return null;
  if (!VEHICLE_STATES.includes(from) || !VEHICLE_STATES.includes(to)) {
    return "وضعیت خودرو نامعتبر است.";
  }
  if (!VEHICLE_TRANSITIONS[from].includes(to)) {
    return `تغییر وضعیت از «${VEHICLE_STATE_LABELS[from]}» به «${VEHICLE_STATE_LABELS[to]}» مجاز نیست.`;
  }
  return null;
}

/* ===========================================================================
 * Identity — what makes one car that car
 * ===========================================================================
 *
 * §3: VIN, chassis number and the internal stock number must be unique within
 * the correct tenancy/business scope, and duplicate VIN/chassis must not be
 * able to create ambiguous stock. The *uniqueness* half lives where it has to
 * live — partial unique indexes on the vehicle table, per `business_id` — and
 * this half normalises and validates so two spellings of one VIN cannot slip
 * past it: a lower-case `wc…` and an upper-case `WC…` are the same car, and
 * the index sees them as one only if the write path normalises first.
 */

/** Upper-case, strip spaces/dashes — the canonical stored form of a VIN. */
export function normalizeVin(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * ISO 3779 — 17 characters, digits and letters except I, O and Q (which are
 * excluded to avoid confusion with 1 and 0). Older/Iranian-market vehicles
 * often have no ISO VIN at all: absence is normal (`vin` is nullable) and the
 * chassis number carries identity instead, so an *empty* VIN is not an error —
 * only a malformed one is.
 */
export function validateVin(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === "") return null;
  const vin = normalizeVin(raw);
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return "شماره شاسی (VIN) باید ۱۷ کاراکتر و بدون حروف I، O و Q باشد.";
  }
  return null;
}

/** The chassis number's canonical form: upper-case, no spaces or dashes. */
export function normalizeChassis(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * The chassis number is free-form by comparison with the ISO VIN — Iranian
 * chassis plates are 5–20 characters and include letters the VIN excludes —
 * so the rule is only "4 to 32 characters, letters and digits".
 */
export function validateChassisNumber(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === "") return null;
  const chassis = normalizeChassis(raw);
  if (!/^[A-Z0-9]{4,32}$/.test(chassis)) {
    return "شماره شاسی باید بین ۴ تا ۳۲ کاراکتر و شامل حروف و ارقام لاتین باشد.";
  }
  return null;
}

/** The internal stock number's canonical form: trimmed, upper-case, single spaces folded. */
export function normalizeStockNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * The stock number is the dealership's own handle on the car and is *required*
 * (it is what the lot, the key board and the salesman's sheet call it), so
 * unlike VIN and chassis its empty form is an error rather than an absence.
 */
export function validateStockNumber(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === "") return "شماره انبار / پلاک داخلی خودرو الزامی است.";
  const value = normalizeStockNumber(raw);
  if (value.length > 32) return "شماره انبار حداکثر ۳۲ کاراکتر است.";
  if (!/^[A-Z0-9\u0600-\u06FF][A-Z0-9\u0600-\u06FF /._-]*$/.test(value)) {
    return "شماره انبار فقط می‌تواند شامل حروف، ارقام، فاصله، خط تیره، اسلش و نقطه باشد.";
  }
  return null;
}

/** A plate is nullable while the car is unregistered (§3) and free-form when present. */
export function validatePlateNumber(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === "") return null;
  if (raw.trim().length > 32) return "شماره پلاک حداکثر ۳۲ کاراکتر است.";
  return null;
}

/**
 * Which calendar a year is *stated in*.
 *
 * A vehicle's year is a label the market uses, not an instant: this market says
 * «مدل ۱۴۰۲» for a domestically-sold car and «مدل ۲۰۲۳» for an imported one, and
 * both are correct. Storing one of them converted would either invent a
 * precision that does not exist (a bare year is not a date, so 1402 cannot be
 * turned into a Gregorian year the way a date can) or quietly relabel the car.
 * So the year travels with the calendar it was stated in — the same discipline
 * `JalaliDatePicker` applies to dates, and the same reason
 * `fiscal-periods.ts` stores an inherently-Jalali fiscal year as a Jalali
 * number instead of pretending it is Gregorian.
 *
 * One calendar covers both years of a vehicle: a shop that says «مدل ۱۴۰۲، ساخت
 * ۱۴۰۱» states both in the same words, and a shop selling imports states both
 * in the other. That is why migration 0212 carries a single
 * `vehicle_year_calendar` column rather than one per year.
 */
export const VEHICLE_YEAR_CALENDARS = ["jalali", "gregorian"] as const;
export type VehicleYearCalendar = (typeof VEHICLE_YEAR_CALENDARS)[number];

export const VEHICLE_YEAR_CALENDAR_LABELS: Record<VehicleYearCalendar, string> = {
  jalali: "شمسی",
  gregorian: "میلادی",
};

/** Supported year ranges, per calendar. Jalali mirrors `isSupportedFiscalYear`. */
export const VEHICLE_YEAR_RANGES: Record<VehicleYearCalendar, { min: number; max: number }> = {
  jalali: { min: 1300, max: 1500 },
  gregorian: { min: 1900, max: 2100 },
};

export function isVehicleYearCalendar(value: string): value is VehicleYearCalendar {
  return (VEHICLE_YEAR_CALENDARS as readonly string[]).includes(value);
}

/**
 * Model year versus production year. Both are optional (a used car's exact
 * production year is often unknown), but each must fall in the range the stated
 * calendar uses, and when both are present the production year can never be
 * *later* than the model year — a ۱۴۰۲ build sold as a ۱۴۰۱ model is a
 * data-entry error, not a vehicle. The comparison is only meaningful inside one
 * calendar, which is exactly what a single `calendar` input guarantees.
 */
export function validateVehicleYears(input: {
  modelYear?: number | null;
  productionYear?: number | null;
  calendar?: VehicleYearCalendar;
}): string | null {
  const calendar = input.calendar ?? "jalali";
  const range = VEHICLE_YEAR_RANGES[calendar];
  for (const [key, value] of [
    ["سال ساخت (مدل)", input.modelYear],
    ["سال تولید", input.productionYear],
  ] as const) {
    if (value == null) continue;
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      return `${key} باید عددی بین ${range.min} تا ${range.max} (${VEHICLE_YEAR_CALENDAR_LABELS[calendar]}) باشد.`;
    }
  }
  if (input.modelYear != null && input.productionYear != null && input.productionYear > input.modelYear) {
    return "سال تولید نمی‌تواند بعد از سال ساخت (مدل) باشد.";
  }
  return null;
}

/* ===========================================================================
 * Condition-dependent fields
 * ===========================================================================
 */

/**
 * Mileage, in kilometres. Absent is normal for a *new* car (which is shown as
 * «صفر» rather than a null) and for a used car whose odometer nobody has read
 * yet, so it is optional; but a mileage on a new vehicle is a contradiction —
 * a supposedly-new car with 12,000 km is a used car with the wrong condition
 * checkbox, and silently accepting it is how a new-car report lies.
 */
export function validateMileage(
  mileageKm: number | null | undefined,
  condition: VehicleCondition,
): string | null {
  if (mileageKm == null) return null;
  if (!Number.isInteger(mileageKm) || mileageKm < 0) {
    return "کارکرد (کیلومتر) باید عددی صحیح و نامنفی باشد.";
  }
  if (mileageKm > 2_000_000) return "کارکرد (کیلومتر) بیش از حد بزرگ است.";
  if (condition === "new" && mileageKm > 0) {
    return "خودروی نو نمی‌تواند کارکرد داشته باشد؛ در صورت داشتن کارکرد، وضعیت را «کارکرده» بگذارید.";
  }
  return null;
}

/** Prior owners: a used-car fact; meaningless on a new one. */
export function validatePriorOwners(
  priorOwners: number | null | undefined,
  condition: VehicleCondition,
): string | null {
  if (priorOwners == null) return null;
  if (!Number.isInteger(priorOwners) || priorOwners < 0) {
    return "تعداد مالکان قبلی باید عددی صحیح و نامنفی باشد.";
  }
  if (condition === "new" && priorOwners > 0) {
    return "خودروی نو نمی‌تواند مالک قبلی داشته باشد.";
  }
  return null;
}

/* ===========================================================================
 * Cost — acquisition, landed cost, and the frozen effective cost
 * ===========================================================================
 *
 * §4 asks for both the *original* acquisition cost and the *effective/landed*
 * cost, and §5 fixes the equation the UI must show:
 *
 *     acquisition cost + capitalized vehicle costs = effective vehicle cost
 *
 * "Capitalized" is the explicit accounting decision the issue demands: each
 * vehicle cost row carries `posting = 'capitalized' | 'period_expense'`, and
 * only the capitalized ones enter the effective cost — the others are the
 * period's reconditioning overhead (5195), not the car's basis. Both are
 * visible on the vehicle's own cost panel, so nothing is silently mixed.
 */

export interface VehicleCostBreakdown {
  /** What the dealership agreed to pay for the car itself, Rial. */
  acquisitionCostRial: number;
  /** The `capitalized` vehicle cost rows' sum, Rial. */
  capitalizedCostRial: number;
  /** The `period_expense` rows' sum, Rial — reported beside, never added in. */
  periodExpenseRial: number;
}

export interface VehicleEffectiveCost extends VehicleCostBreakdown {
  /** acquisition + capitalized. The number COGS freezes at sale. */
  effectiveCostRial: number;
}

export function computeEffectiveCost(input: VehicleCostBreakdown): VehicleEffectiveCost {
  const acquisitionCostRial = wholeRial(input.acquisitionCostRial, "بهای خرید خودرو");
  const capitalizedCostRial = wholeRial(input.capitalizedCostRial, "هزینه‌های سرمایه‌ای خودرو");
  const periodExpenseRial = wholeRial(input.periodExpenseRial, "هزینه‌های دوره‌ای خودرو");
  return {
    acquisitionCostRial,
    capitalizedCostRial,
    periodExpenseRial,
    effectiveCostRial: acquisitionCostRial + capitalizedCostRial,
  };
}

/** Rial amounts are whole numbers everywhere in this codebase — no decimals in storage. */
export function wholeRial(value: number, label = "مبلغ"): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} باید یک عدد صحیح و نامنفی (ریال) باشد.`);
  }
  return value;
}

/* ===========================================================================
 * Pricing and margin — the two numbers that must stay apart
 * ===========================================================================
 *
 * §6: pricing is independent of accounting cost, and changing a sale price
 * must never mutate the acquisition cost. These helpers therefore take the
 * asking/sale price and the *effective* cost and return a margin; none of them
 * writes anything, and none of them can reach the cost fields.
 */

export interface VehicleMargin {
  /** Price − effective cost. Negative is a loss, and is reported as one. */
  marginRial: number;
  /** margin ÷ price, as a percent — null when the price is 0 (a gift is not a 0% margin). */
  marginPercent: number | null;
}

export function vehicleMargin(input: { priceRial: number; effectiveCostRial: number }): VehicleMargin {
  const price = wholeRial(input.priceRial, "قیمت");
  const cost = wholeRial(input.effectiveCostRial, "بهای تمام‌شده");
  const marginRial = price - cost;
  return {
    marginRial,
    marginPercent: price === 0 ? null : Number(((marginRial / price) * 100).toFixed(2)),
  };
}

/**
 * The minimum acceptable price a sale may draw without an explicit override.
 * `null` means "no floor recorded", which is not the same as zero: a vehicle
 * with no minimum may be sold at any price the seller and buyer agree, while a
 * floor of 0 would be a floor.
 */
export function minimumPriceFloor(minimumPriceRial: number | null | undefined): number | null {
  if (minimumPriceRial == null) return null;
  return wholeRial(minimumPriceRial, "حداقل قیمت");
}

export interface MinimumPriceCheck {
  allowed: boolean;
  /** The shortfall below the floor, Rial — 0 when allowed. */
  shortfallRial: number;
}

export function checkMinimumPrice(input: {
  priceRial: number;
  minimumPriceRial: number | null | undefined;
  /** True when the caller holds `vehicles.override_min_price`. */
  overrideAllowed: boolean;
}): MinimumPriceCheck {
  const floor = minimumPriceFloor(input.minimumPriceRial);
  const price = wholeRial(input.priceRial, "قیمت");
  if (floor == null || price >= floor) return { allowed: true, shortfallRial: 0 };
  if (input.overrideAllowed) return { allowed: true, shortfallRial: floor - price };
  return { allowed: false, shortfallRial: floor - price };
}

/* ===========================================================================
 * Stock ageing — «چند روز در انبار مانده»
 * ===========================================================================
 *
 * §15 asks for stock aging, dead/slow stock and average days-to-sale, and §10
 * for days in stock on the stock table. The thresholds live here once so the
 * table, the report and the dashboard cannot disagree about which car is
 * "slow": up to 60 days is normal, 61–90 is slow, and past 90 it is dead
 * money. They are deliberately a plain constant, not a business setting —
 * if a dealership ever needs its own, this is the one place that changes.
 */

export const VEHICLE_AGING_THRESHOLDS = { slowDays: 60, deadDays: 90 } as const;

export type VehicleAgeBucket = "fresh" | "slow" | "dead";

export const VEHICLE_AGE_BUCKET_LABELS: Record<VehicleAgeBucket, string> = {
  fresh: "عادی",
  slow: "کند‌فروش",
  dead: "راکد",
};

/** Whole days between two ISO dates (Gregorian storage, per the repo's rule). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("تاریخ نامعتبر است.");
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * Days in stock. A *sold* car's age is measured to its sale date — reporting it
 * as "300 days in stock" because the report ran in Farvardin would be wrong,
 * and average-days-to-sale is built on exactly this number.
 */
export function daysInStock(
  input: { acquiredOn: string; soldOn?: string | null },
  onDate: string,
): number {
  return daysBetweenIso(input.acquiredOn, input.soldOn ?? onDate);
}

export function vehicleAgeBucket(days: number): VehicleAgeBucket {
  if (days > VEHICLE_AGING_THRESHOLDS.deadDays) return "dead";
  if (days > VEHICLE_AGING_THRESHOLDS.slowDays) return "slow";
  return "fresh";
}

/* ===========================================================================
 * Holds (reservations) and deposits
 * ===========================================================================
 *
 * §7: a hold names a customer, expires, may carry a deposit, and — the rule
 * that matters — an *active* hold blocks a second hold or a sale to anybody
 * else without an explicit override. The blocking itself is enforced twice:
 * by a partial unique index (one active hold per vehicle) and by the service
 * reading the hold before it sells. Here live only the state rules and the
 * arithmetic of applying a deposit at sale time.
 */

/**
 * Deliberately migration 0202's own vocabulary rather than new words for the
 * same four states. The hold table already exists, its CHECK constraint spells
 * `active | converted | released | expired`, and the trade's reservations reuse
 * it — so the issue's «completed» is this code's `converted` (the hold became
 * the sale), and its «cancelled» is `released` (staff freed the car, with the
 * reason recorded). Inventing a second set of names here would make every
 * report, the API and the deposit posting translate between two vocabularies
 * for one table, which is exactly the duplication §2 forbids.
 */
export const VEHICLE_HOLD_STATUSES = ["active", "converted", "released", "expired"] as const;
export type VehicleHoldStatus = (typeof VEHICLE_HOLD_STATUSES)[number];

export const VEHICLE_HOLD_STATUS_LABELS: Record<VehicleHoldStatus, string> = {
  active: "فعال",
  converted: "تکمیل‌شده (فروخته شد)",
  released: "لغو‌شده",
  expired: "منقضی‌شده",
};

/** Only an active hold blocks anything; the other three are history. */
export function holdIsBlocking(status: VehicleHoldStatus): boolean {
  return status === "active";
}

export function validateHoldStatusTransition(
  from: VehicleHoldStatus,
  to: VehicleHoldStatus,
): string | null {
  if (from === to) return null;
  if (from !== "active") return "رزرو بسته‌شده را نمی‌توان تغییر داد.";
  if (to === "active") return "رزرو فعال را نمی‌توان دوباره فعال کرد.";
  return null;
}

/**
 * Whether a hold is past its expiry on the given day. An *expired* hold does
 * not block a sale (the next sale to anyone heals it — the same rule
 * `serial_reservations` uses), but it is never silently deleted: it becomes
 * `expired` with the date it lapsed.
 *
 * A hold with no expiry date (`null`) is "until released" and never lapses.
 */
export function holdHasExpired(
  hold: { status: VehicleHoldStatus; expiresAt: string | null },
  onDate: string,
): boolean {
  if (hold.status !== "active") return false;
  if (!hold.expiresAt) return false;
  return hold.expiresAt < onDate;
}

/**
 * What a deposit contributes to a sale: min(deposit, invoice total). A deposit
 * larger than the car's price is a refund question, not a discount, so the
 * applied part is capped and the excess stays on the customer's advance
 * account (2430) where it can be refunded deliberately — never quietly turned
 * into revenue.
 */
export function depositAppliedToSale(depositRial: number, invoiceTotalRial: number): number {
  const deposit = wholeRial(depositRial, "مبلغ بیعانه");
  const total = wholeRial(invoiceTotalRial, "مبلغ فاکتور");
  return Math.min(deposit, total);
}

/** Reservation states the counter may set on a *new* hold — `expired` is the passage of time, never a button. */
export const CREATABLE_HOLD_STATUSES: readonly VehicleHoldStatus[] = ["active"];

/* ===========================================================================
 * The lot's vocabulary — the enums the columns carry
 * ===========================================================================
 *
 * Deliberately small and closed: each list mirrors a CHECK constraint in
 * migration 0212, and a value outside it is a bug in the caller rather than a
 * business choice. Free text stays where free text belongs (notes, engine
 * specification).
 */

export const VEHICLE_BODY_TYPES = [
  "sedan",
  "hatchback",
  "suv",
  "crossover",
  "coupe",
  "convertible",
  "pickup",
  "van",
  "minibus",
  "truck",
  "other",
] as const;
export type VehicleBodyType = (typeof VEHICLE_BODY_TYPES)[number];
export const VEHICLE_BODY_TYPE_LABELS: Record<VehicleBodyType, string> = {
  sedan: "سدان",
  hatchback: "هاچبک",
  suv: "شاسیبلند",
  crossover: "کراساوور",
  coupe: "کوپه",
  convertible: "کروک",
  pickup: "وانت",
  van: "ون",
  minibus: "مینیبوس",
  truck: "کامیون",
  other: "سایر",
};

export const VEHICLE_TRANSMISSIONS = [
  "manual",
  "automatic",
  "cvt",
  "dual_clutch",
  "single_speed",
  "other",
] as const;
export type VehicleTransmission = (typeof VEHICLE_TRANSMISSIONS)[number];
export const VEHICLE_TRANSMISSION_LABELS: Record<VehicleTransmission, string> = {
  manual: "دنده‌ای",
  automatic: "اتوماتیک",
  cvt: "CVT",
  dual_clutch: "دو کلاچه",
  single_speed: "تک‌سرعته (برقی)",
  other: "سایر",
};

export const VEHICLE_FUEL_TYPES = [
  "petrol",
  "diesel",
  "hybrid",
  "plug_in_hybrid",
  "electric",
  "cng",
  "lpg",
  "other",
] as const;
export type VehicleFuelType = (typeof VEHICLE_FUEL_TYPES)[number];
export const VEHICLE_FUEL_TYPE_LABELS: Record<VehicleFuelType, string> = {
  petrol: "بنزینی",
  diesel: "دیزلی",
  hybrid: "هیبرید",
  plug_in_hybrid: "هیبرید پلاگین",
  electric: "برقی",
  cng: "CNG",
  lpg: "LPG",
  other: "سایر",
};

export const VEHICLE_DRIVETRAINS = ["fwd", "rwd", "awd", "4wd", "other"] as const;
export type VehicleDrivetrain = (typeof VEHICLE_DRIVETRAINS)[number];
export const VEHICLE_DRIVETRAIN_LABELS: Record<VehicleDrivetrain, string> = {
  fwd: "دیفرانسیل جلو",
  rwd: "دیفرانسیل عقب",
  awd: "چهارچرخ محرک (AWD)",
  "4wd": "چهارچرخ محرک (4WD)",
  other: "سایر",
};

/**
 * Where the car came from. §4's five intake paths plus the two that always
 * exist in practice; `trade_in` is recorded even though the trade-in *flow*
 * ships in a later wave, because the acquisition row is where its valuation
 * will live and a schema that could not name it would have to be migrated
 * again to allow it.
 */
export const VEHICLE_ACQUISITION_SOURCES = [
  "direct_purchase",
  "supplier_purchase",
  "dealer_purchase",
  "customer_purchase",
  "trade_in",
  "import",
  "opening_stock",
  "other",
] as const;
export type VehicleAcquisitionSource = (typeof VEHICLE_ACQUISITION_SOURCES)[number];
export const VEHICLE_ACQUISITION_SOURCE_LABELS: Record<VehicleAcquisitionSource, string> = {
  direct_purchase: "خرید مستقیم",
  supplier_purchase: "خرید از تأمین‌کننده",
  dealer_purchase: "خرید از نمایشگاه/نمایندگی",
  customer_purchase: "خرید از مشتری",
  trade_in: "معاوضه (تحویل خودروی مشتری)",
  import: "واردات",
  opening_stock: "موجودی اول دوره",
  other: "سایر",
};

/** §5's cost categories. `posting` is the separate, explicit decision. */
export const VEHICLE_EXPENSE_CATEGORIES = [
  "repair",
  "paint_body",
  "detailing",
  "tires",
  "parts",
  "inspection",
  "registration",
  "transport",
  "customs",
  "advertising",
  "preparation",
  "other",
] as const;
export type VehicleExpenseCategory = (typeof VEHICLE_EXPENSE_CATEGORIES)[number];
export const VEHICLE_EXPENSE_CATEGORY_LABELS: Record<VehicleExpenseCategory, string> = {
  repair: "تعمیرات",
  paint_body: "صافکاری و نقاشی",
  detailing: "صفرشویی و پولیش",
  tires: "لاستیک",
  parts: "قطعات",
  inspection: "معاینه فنی / کارشناسی",
  registration: "هزینه شماره‌گذاری و نقل‌وانتقال",
  transport: "حمل و باربری",
  customs: "حقوق گمرکی و ترخیص",
  advertising: "آگهی و تبلیغات",
  preparation: "آماده‌سازی متفرقه",
  other: "سایر",
};

/**
 * The accounting decision §5 requires, per cost row, made visible rather than
 * implied:
 *
 *   * `capitalized` — the cost is part of what the car cost; it debits
 *     «موجودی خودرو» (1370) and therefore raises the unit's effective cost,
 *     which is what COGS will freeze at sale.
 *   * `period_expense` — the cost is this period's reconditioning overhead; it
 *     debits 5195 and never touches the unit's basis.
 *
 * There is deliberately no third "decide later": a row is one or the other the
 * moment it is recorded, and changing the decision is a void-and-re-record
 * (which is why costs are voided, never edited).
 */
export const VEHICLE_EXPENSE_POSTINGS = ["capitalized", "period_expense"] as const;
export type VehicleExpensePosting = (typeof VEHICLE_EXPENSE_POSTINGS)[number];
export const VEHICLE_EXPENSE_POSTING_LABELS: Record<VehicleExpensePosting, string> = {
  capitalized: "سرمایه‌ای (به بهای خودرو اضافه می‌شود)",
  period_expense: "هزینه دوره",
};

/** The classification dimensions §3 asks for and both the price history and the stock report read. */
export const VEHICLE_CLASSIFICATIONS = ["new", "used"] as const;

/* ===========================================================================
 * Display and search helpers
 * ===========================================================================
 */

export interface VehicleNameParts {
  make: string;
  model: string;
  trim?: string | null;
  modelYear?: number | null;
}

/** «پژو ۲۰۷ پانوراما ۱۴۰۳» — the one place a vehicle's display name is assembled. */
export function vehicleDisplayName(parts: VehicleNameParts): string {
  return [parts.make, parts.model, parts.trim, parts.modelYear]
    .map((part) => (part == null ? "" : String(part).trim()))
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * The search term, normalised the way the stock list's SQL normalises it:
 * trimmed, upper-cased for the Latin identity fields, and with Persian/Arabic
 * digits folded to Latin so a plate typed on a Persian keyboard still finds
 * the row it names. The caller keeps the raw term for name/free-text matches.
 */
export function normalizeVehicleSearch(raw: string): string {
  return raw
    .trim()
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toUpperCase();
}

/**
 * The next stock number from the last one issued, e.g.
 * `«۱۴۰۳-۰۰۷» → «۱۴۰۳-۰۰۸»`. Pure, and deliberately a *helper* rather than a
 * rule: the service falls back to a plain counter when the dealership's own
 * numbering does not parse, because refusing to register a car whose stock
 * number a human typed by hand would be the system being clever at the
 * counter's expense.
 */
export function nextStockNumber(lastStockNumber: string | null | undefined): string | null {
  if (!lastStockNumber) return null;
  const match = /^(.*?)(\d+)$/.exec(lastStockNumber.trim());
  if (!match) return null;
  const [, prefix, digits] = match;
  const next = String(Number(digits) + 1).padStart(digits.length, "0");
  return `${prefix}${next}`;
}

/* ===========================================================================
 * The margin/aging numbers the dashboard and reports share
 * ===========================================================================
 */

export interface VehicleStockSummaryInput {
  state: VehicleState;
  condition: VehicleCondition;
  effectiveCostRial: number;
  askingPriceRial: number;
  acquiredOn: string;
  soldOn?: string | null;
  /** Sale price when sold — the report's realised figure, not the asking price. */
  salePriceRial?: number | null;
  /**
   * Net revenue (invoice total less the VAT the sale posted) and the frozen
   * effective cost, both as the sale recorded them. Used for the month's
   * realised figures only: VAT is the tax office's money and never margin.
   */
  saleNetRial?: number | null;
  soldCostRial?: number | null;
}

export interface VehicleStockSummary {
  inStock: number;
  reserved: number;
  sold: number;
  stockValueRial: number;
  askingValueRial: number;
  potentialMarginRial: number;
  averageAgeDays: number | null;
  slowCount: number;
  deadCount: number;
  /** §16 — cars whose sale date falls in `onDate`'s Jalali month. */
  soldThisMonth: number;
  revenueThisMonthRial: number;
  grossProfitThisMonthRial: number;
  averageMarginThisMonth: number | null;
}

/**
 * The dashboard's KPI arithmetic (§16), pure so it is tested against a list of
 * vehicles rather than against a database. One deliberate choice: an average
 * margin is expressed as a *sum*, not a mean of percentages — a mean of ratios
 * over a lot of four cars reduces to the same thing only by accident, and
 * «میانگین حاشیهٔ سود» should be the aggregate the owner can reconcile.
 */
/**
 * The first and last day of the Jalali month `onDate` falls in, as ISO dates.
 * A "month" in this product is a Jalali month — «فروش مهر» is what an owner
 * asks for, and comparing ISO strings outside that range would silently answer
 * the Gregorian question instead.
 */
export function jalaliMonthRange(onDate: string): [string, string] {
  const parts = isoDateToJalali(onDate);
  if (!parts) return [onDate, onDate];
  const startJd = 1;
  const endJd = jalaliMonthLength(parts.jy, parts.jm);
  return [jalaliToIsoDate(parts.jy, parts.jm, startJd), jalaliToIsoDate(parts.jy, parts.jm, endJd)];
}

export function summarizeVehicleStock(
  vehicles: readonly VehicleStockSummaryInput[],
  onDate: string,
): VehicleStockSummary {
  let inStock = 0;
  let reserved = 0;
  let sold = 0;
  let stockValueRial = 0;
  let askingValueRial = 0;
  let ageSum = 0;
  let ageCount = 0;
  let slowCount = 0;
  let deadCount = 0;

  // The Jalali month `onDate` falls in — «فروش این ماه» is the owner's month,
  // not the Gregorian one.
  const [monthStart, monthEnd] = jalaliMonthRange(onDate);
  let soldThisMonth = 0;
  let revenueThisMonth = 0;
  let costThisMonth = 0;

  for (const vehicle of vehicles) {
    if (vehicle.state === "sold") {
      sold += 1;
      if (vehicle.soldOn && vehicle.soldOn >= monthStart && vehicle.soldOn <= monthEnd) {
        soldThisMonth += 1;
        // The invoice's *net* revenue is what the ledgers credited; the row's
        // sale price is the VAT-inclusive total, and VAT is never margin.
        revenueThisMonth += vehicle.saleNetRial ?? 0;
        costThisMonth += vehicle.soldCostRial ?? 0;
      }
      continue;
    }
    if (vehicle.state === "archived") continue;
    if (vehicle.state === "reserved") reserved += 1;
    if (vehicle.state === "in_stock" || vehicle.state === "acquired" || vehicle.state === "draft") inStock += 1;

    stockValueRial += vehicle.effectiveCostRial;
    askingValueRial += vehicle.askingPriceRial;
    const age = daysInStock({ acquiredOn: vehicle.acquiredOn, soldOn: vehicle.soldOn }, onDate);
    ageSum += age;
    ageCount += 1;
    const bucket = vehicleAgeBucket(age);
    if (bucket === "slow") slowCount += 1;
    if (bucket === "dead") deadCount += 1;
  }

  return {
    inStock,
    reserved,
    sold,
    stockValueRial,
    askingValueRial,
    potentialMarginRial: askingValueRial - stockValueRial,
    averageAgeDays: ageCount === 0 ? null : Math.round(ageSum / ageCount),
    slowCount,
    deadCount,
    soldThisMonth,
    revenueThisMonthRial: revenueThisMonth,
    grossProfitThisMonthRial: revenueThisMonth - costThisMonth,
    averageMarginThisMonth:
      revenueThisMonth > 0 ? Math.round(((revenueThisMonth - costThisMonth) / revenueThisMonth) * 1000) / 10 : null,
  };
}
