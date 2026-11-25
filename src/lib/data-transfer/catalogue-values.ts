/**
 * Re-importing prices and stock for products that already exist (issue #1376).
 *
 * The catalogue import used to be metadata-only: a Watch tenant uploaded a file
 * with valid prices and quantities, and the reviewed import deliberately wrote
 * neither, so existing SKUs showed zero stock and no price. Uploading the same
 * file again created nothing to fix that.
 *
 * This module is the pure decision layer between the file and the domain
 * writers. It never writes: given the workbook values and the canonical stock
 * state it says, per field, whether the value would be set, is already the same,
 * or must be held with a reason. `catalogue-service.ts` stores that plan on the
 * staged item and applies it through `saveStockPrices` (price history, cost
 * guard) and `createItemStockCount` (reviewed delta, journal, serial/batch guard).
 *
 * Client-safe: no database, no node builtins.
 */

export const CATALOGUE_VALUE_MODES = ["catalogue_only", "fill_missing", "update_existing"] as const;
export type CatalogueValueMode = (typeof CATALOGUE_VALUE_MODES)[number];

export const CATALOGUE_VALUE_MODE_LABELS: Record<CatalogueValueMode, string> = {
  catalogue_only: "فقط کاتالوگ (بدون قیمت و موجودی)",
  fill_missing: "تکمیل مقادیر خالی",
  update_existing: "به‌روزرسانی مقادیر موجود",
};

export const CATALOGUE_CURRENCIES = ["rial", "toman"] as const;
export type CatalogueCurrency = (typeof CATALOGUE_CURRENCIES)[number];

export type CatalogueAmountState = "blank" | "valid" | "zero" | "invalid" | "formula" | "error";

export interface CatalogueMoneyCell {
  raw: string | null;
  /** Integer Rial, or null when blank/invalid. */
  rial: number | null;
  state: CatalogueAmountState;
}

export interface CatalogueQuantityCell {
  raw: string | null;
  /** Decimal text, or null when blank/invalid. Zero is a real, explicit value. */
  quantity: string | null;
  state: CatalogueAmountState;
}

const PERSIAN_DIGITS = /[\u06F0-\u06F9]/gu;
const ARABIC_DIGITS = /[\u0660-\u0669]/gu;
const SEPARATORS = /[\s,\u066C\u060C_\u00A0]/gu;
const CURRENCY_WORDS = /(?:ریال|ريال|تومان|تومن)/gu;

function toWesternDigits(value: string): string {
  return value
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * Parse one spreadsheet money cell into integer Rial. Blank is blank — never
 * zero. A malformed value, a negative, a fraction of a Rial and a formula/error
 * cell are all `invalid`-family states, so nothing quietly becomes 0.
 */
export function parseCatalogueMoney(
  raw: string | null | undefined,
  currency: CatalogueCurrency,
  cellIssue?: "formula" | "error" | "unsafe_number" | null,
): CatalogueMoneyCell {
  const text = (raw ?? "").trim();
  if (cellIssue === "formula") return { raw: text || null, rial: null, state: "formula" };
  if (cellIssue === "error") return { raw: text || null, rial: null, state: "error" };
  if (cellIssue) return { raw: text || null, rial: null, state: "invalid" };
  const cleaned = toWesternDigits(text).replace(CURRENCY_WORDS, "").replace(SEPARATORS, "");
  if (!cleaned) return { raw: text || null, rial: null, state: "blank" };
  if (!/^\d+(?:\.\d+)?$/u.test(cleaned)) return { raw: text || null, rial: null, state: "invalid" };
  const amount = Number(cleaned);
  const rial = currency === "toman" ? amount * 10 : amount;
  if (!Number.isSafeInteger(rial) || rial < 0 || rial > 1_000_000_000_000_000) {
    return { raw: text || null, rial: null, state: "invalid" };
  }
  return { raw: text || null, rial, state: rial === 0 ? "zero" : "valid" };
}

/** Stock quantity: a non-negative decimal kept as text so precision survives. */
export function parseCatalogueQuantity(
  raw: string | null | undefined,
  cellIssue?: "formula" | "error" | "unsafe_number" | null,
): CatalogueQuantityCell {
  const text = (raw ?? "").trim();
  if (cellIssue === "formula") return { raw: text || null, quantity: null, state: "formula" };
  if (cellIssue === "error") return { raw: text || null, quantity: null, state: "error" };
  if (cellIssue) return { raw: text || null, quantity: null, state: "invalid" };
  const cleaned = toWesternDigits(text).replace(SEPARATORS, "");
  if (!cleaned) return { raw: text || null, quantity: null, state: "blank" };
  if (!/^\d+(?:\.\d+)?$/u.test(cleaned)) return { raw: text || null, quantity: null, state: "invalid" };
  const quantity = cleaned.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "");
  if (Number(quantity) > 1_000_000_000) return { raw: text || null, quantity: null, state: "invalid" };
  return { raw: text || null, quantity: quantity === "0" ? "0" : quantity, state: quantity === "0" ? "zero" : "valid" };
}

/** What the catalogue row says about the fields this feature can apply. */
export interface CatalogueIncomingValues {
  priceRial: number | null;
  costRial: number | null;
  quantity: string | null;
}

/** The canonical side: what the product already has. */
export interface CatalogueStockState {
  kind: string;
  tracking: string;
  hasStockRow: boolean;
  quantity: string;
  unitPriceRial: number | null;
  unitCostRial: number | null;
}

export type CatalogueValueAction = "set" | "unchanged" | "held";

export interface CatalogueFieldValuePlan {
  action: CatalogueValueAction;
  /** Integer Rial for money, decimal text for quantity. */
  current: number | string | null;
  proposed: number | string;
  /** Machine reason, shown as a localized message by the wizard. */
  reason?: string;
}

export interface CatalogueQuantityValuePlan extends CatalogueFieldValuePlan {
  delta: number;
}

export interface CatalogueValuePlan {
  price?: CatalogueFieldValuePlan;
  cost?: CatalogueFieldValuePlan;
  quantity?: CatalogueQuantityValuePlan;
}

export const CATALOGUE_VALUE_REASONS: Record<string, string> = {
  catalogue_price_must_be_positive: "قیمت فروش باید بزرگ‌تر از صفر باشد؛ مقدار صفر اعمال نمی‌شود.",
  catalogue_cost_locked_with_stock: "بهای خرید وقتی موجودی دارد توسط رسیدها تعیین می‌شود؛ تغییر آن اعمال نمی‌شود.",
  catalogue_existing_stock_preserved: "موجودی موجود حفظ می‌شود؛ فقط ردیف‌های بدون موجودی تکمیل می‌شوند.",
  catalogue_variant_parent_has_no_stock: "والد تنوع موجودی و قیمت مستقل ندارد؛ تنوع‌ها جداگانه بررسی می‌شوند.",
  catalogue_tracking_serial_unsupported: "کالای سریال‌دار موجودی عددی نمی‌پذیرد؛ از فرایند سریال استفاده کنید.",
  catalogue_tracking_batch_unsupported: "کالای دارای بچ باید از مسیر بچ و تاریخ انقضا ثبت شود.",
  catalogue_tracking_weight_unsupported: "کالای وزنی موجودی عددی نمی‌پذیرد؛ از مسیر وزن استفاده کنید.",
  catalogue_explicit_zero_requires_overwrite: "موجودی صفر فقط در حالت به‌روزرسانی صریح اعمال می‌شود.",
};

function moneyPlan(
  proposed: number | null,
  current: number | null,
  mode: CatalogueValueMode,
  field: "price" | "cost",
): CatalogueFieldValuePlan | undefined {
  if (proposed == null) return undefined;
  if (field === "price" && proposed === 0) {
    return { action: "held", current, proposed, reason: "catalogue_price_must_be_positive" };
  }
  if (mode === "fill_missing" && current != null) {
    return { action: "unchanged", current, proposed };
  }
  if (current === proposed) return { action: "unchanged", current, proposed };
  return { action: "set", current, proposed };
}

/**
 * Decide what a row means for one existing product. Nothing here writes, and a
 * value the file does not carry never becomes a change.
 */
export function planCatalogueValues(
  incoming: CatalogueIncomingValues | null | undefined,
  state: CatalogueStockState,
  mode: CatalogueValueMode,
): CatalogueValuePlan {
  if (!incoming || mode === "catalogue_only") return {};
  const plan: CatalogueValuePlan = {};

  const price = moneyPlan(incoming.priceRial, state.unitPriceRial, mode, "price");
  if (price) plan.price = price;

  const cost = moneyPlan(incoming.costRial, state.unitCostRial, mode, "cost");
  if (cost) {
    // The stock cost of a product that holds stock belongs to its receipts and
    // lots; rewriting it here would silently revalue inventory. A value the mode
    // already preserves is not a refused change, so it stays `unchanged`.
    plan.cost = state.quantity !== "0" && cost.action === "set"
      ? { ...cost, action: "held", reason: "catalogue_cost_locked_with_stock" }
      : cost;
  }

  const proposed = incoming.quantity;
  if (proposed != null) {
    const current = state.quantity;
    const numericProposed = Number(proposed);
    const numericCurrent = Number(current);
    const base = {
      current,
      proposed,
      delta: Number((numericProposed - numericCurrent).toFixed(9)),
    };
    if (state.kind === "variant_parent") {
      plan.quantity = { ...base, action: "held", reason: "catalogue_variant_parent_has_no_stock" };
    } else if (state.tracking !== "none") {
      plan.quantity = { ...base, action: "held", reason: `catalogue_tracking_${state.tracking}_unsupported` };
    } else if (mode === "fill_missing" && state.hasStockRow) {
      plan.quantity = { ...base, action: "unchanged", reason: "catalogue_existing_stock_preserved" };
    } else if (numericProposed === numericCurrent) {
      plan.quantity = { ...base, action: "unchanged" };
    } else {
      plan.quantity = { ...base, action: "set" };
    }
  }
  return plan;
}

export interface CatalogueValuePlanCounts {
  price: { set: number; unchanged: number; held: number };
  cost: { set: number; unchanged: number; held: number };
  quantity: { set: number; unchanged: number; held: number };
}

export function emptyValuePlanCounts(): CatalogueValuePlanCounts {
  return {
    price: { set: 0, unchanged: 0, held: 0 },
    cost: { set: 0, unchanged: 0, held: 0 },
    quantity: { set: 0, unchanged: 0, held: 0 },
  };
}

export function countValuePlans(plans: ReadonlyArray<CatalogueValuePlan | null | undefined>): CatalogueValuePlanCounts {
  const counts = emptyValuePlanCounts();
  for (const plan of plans) {
    if (!plan) continue;
    for (const field of ["price", "cost", "quantity"] as const) {
      const entry = plan[field];
      if (entry) counts[field][entry.action] += 1;
    }
  }
  return counts;
}
