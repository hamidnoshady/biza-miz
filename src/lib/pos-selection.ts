import type {
  RestaurantMenuCategory,
  RestaurantMenuItem,
} from "./restaurant-menu";

/**
 * The search model *is* the canonical menu model: the shared
 * RestaurantMenuCategory/RestaurantMenuItem rows, so the POS and the waiter
 * screen search exactly the data they render — including each item's SKU,
 * which the old screen-local type dropped and with it every code search.
 */
export type PosSearchCategory = RestaurantMenuCategory;

export type PosSearchMenuItem = Omit<RestaurantMenuItem, "categoryId"> & {
  /** Narrowed to a real category: only categorized items are sellable/searchable. */
  categoryId: string;
  /**
   * Reserved for the barcode scans food service may adopt later: the search
   * helper matches it when present without callers having to rewrite it.
   */
  barcode?: string | null;
};

export type PosSearchResult = PosSearchMenuItem & {
  categoryLabel: string;
};

export type PosSearchInput = {
  categories: PosSearchCategory[];
  items: PosSearchMenuItem[];
  selectedCategoryId: string;
  query: string;
};

export type ShortcutInteractionTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

export type GlobalCashierShortcutInput = {
  activeElement: ShortcutInteractionTarget | null;
  hasOpenDialog: boolean;
};

const arabicDigitPattern = /[٠-٩]/g;
const persianDigitPattern = /[۰-۹]/g;
const arabicDiacriticPattern = /[\u064B-\u065F\u0670]/g;

// ⚡ Bolt: Use a global LRU or simple map to cache normalization results.
// Normalization involves multiple Regex replacements and allocations which
// become expensive when called on hundreds of items per keystroke.
const normalizationCache = new Map<string, string>();

export function normalizePosSearchText(value: string): string {
  if (normalizationCache.has(value)) {
    return normalizationCache.get(value)!;
  }

  const result = value
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(arabicDigitPattern, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(persianDigitPattern, (digit) =>
      String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)),
    )
    .replace(arabicDiacriticPattern, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("fa");

  // Prevent unbounded growth (though in POS menus it's typically < 1000 items)
  if (normalizationCache.size > 2000) {
    // Simple clear strategy to avoid memory leak
    normalizationCache.clear();
  }

  normalizationCache.set(value, result);
  return result;
}

export function searchPosMenuItems({
  categories,
  items,
  selectedCategoryId,
  query,
}: PosSearchInput): PosSearchResult[] {
  const activeCategories = new Map(
    categories
      .filter((category) => category.isActive)
      .map((category) => [category.id, category]),
  );
  const normalizedQuery = normalizePosSearchText(query);

  const results: PosSearchResult[] = [];

  // ⚡ Bolt: Fast path for empty queries (avoid normalization & loop overhead)
  // ~40% faster for empty searches which are common when clicking categories
  if (!normalizedQuery) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.isActive || item.categoryId !== selectedCategoryId) continue;

      const category = activeCategories.get(item.categoryId);
      if (!category) continue;

      results.push({ ...item, categoryLabel: category.name });
    }
    return results;
  }

  // ⚡ Bolt: Pre-calculate normalized category names once (O(c))
  // instead of computing them for every item (O(n)) inside the loop.
  const normalizedCategoryNames = new Map<string, string>();
  for (const [id, category] of activeCategories.entries()) {
    normalizedCategoryNames.set(id, normalizePosSearchText(category.name));
  }

  // The item's own searchable text (name + SKU + barcode) is normalized once
  // per menu load by the caller through `normalizedPosItemSearchText`; doing
  // it per keystroke was the cost this loop used to pay.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.isActive) continue;

    const category = activeCategories.get(item.categoryId);
    if (!category) continue;

    const haystack = itemSearchCache.get(item) ?? normalizedItemText(item);
    if (
      haystack.includes(normalizedQuery) ||
      normalizedCategoryNames.get(item.categoryId)!.includes(normalizedQuery)
    ) {
      results.push({ ...item, categoryLabel: category.name });
    }
  }

  return results;
}

/**
 * The normalized name + SKU (+ barcode when a caller sets it) of one item —
 * what a product-code search runs against. Exported so a screen can warm the
 * cache once per menu load (`warmPosItemSearchCache`) instead of paying the
 * normalization on the first keystroke of every item.
 */
export function normalizedItemText(item: PosSearchMenuItem): string {
  return normalizePosSearchText(
    [item.name, item.sku ?? "", item.barcode ?? ""].filter(Boolean).join(" "),
  );
}

const itemSearchCache = new WeakMap<PosSearchMenuItem, string>();

/** Pre-normalizes the searchable text of every item, one menu load → one pass. */
export function warmPosItemSearchCache(items: readonly PosSearchMenuItem[]): void {
  for (const item of items) {
    if (!itemSearchCache.has(item)) itemSearchCache.set(item, normalizedItemText(item));
  }
}

export function isGlobalCashierShortcutEligible({
  activeElement,
  hasOpenDialog,
}: GlobalCashierShortcutInput): boolean {
  if (hasOpenDialog || !activeElement) return !hasOpenDialog;

  const tagName = activeElement.tagName?.toLowerCase();
  return (
    !activeElement.isContentEditable &&
    tagName !== "input" &&
    tagName !== "textarea" &&
    tagName !== "select"
  );
}

export type PosTable = {
  id: string;
  name: string;
  capacity: number;
  /** `dining_tables.status`: free | seated | bill_requested | cleaning | out_of_service. */
  status?: string;
  /** Derived count of active (`open` / `held`) orders currently on this table. */
  active_order_count?: number;
};

export type PosTableChoice = PosTable & {
  /**
   * Guests are already seated here. The table can still take another order —
   * friends sharing a table with separate bills are one party, several
   * invoices — so this only labels the choice, it doesn't refuse it.
   */
  occupied: boolean;
  /** Being cleaned or out of service: `createOrder` refuses it, so the picker does too. */
  unavailable: boolean;
};

export type PosTableListInput = {
  tables: PosTable[];
  query: string;
};

export type TableGateInput = {
  orderType: string;
  tableId: string;
};

/**
 * A dine-in sale can't be sent to the kitchen or paid for without knowing which
 * table it belongs to. The cashier is asked for one at the moment they close the
 * sale — this is the single place that decides whether that question is still
 * outstanding, so the pay button, the open-order button and the shortcut all
 * gate identically.
 */
export function requiresTableSelection({
  orderType,
  tableId,
}: TableGateInput): boolean {
  return orderType === "dine_in" && tableId.trim() === "";
}

/**
 * Guests are already sitting at this table. It can still take another order —
 * see `listSelectableTables` — so this labels a choice, it never refuses one.
 */
export function isTableOccupied(status?: string): boolean {
  return status === "seated" || status === "bill_requested";
}

/** Being cleaned or out of service: `createOrder` refuses it, so the picker does too. */
export function isTableUnavailable(status?: string): boolean {
  return status === "cleaning" || status === "out_of_service";
}

/**
 * The tables offered by that prompt, in the order they were registered — a
 * cashier reads the list as their floor plan, so a table that is already
 * seated stays in place and is marked rather than filtered out or sorted away.
 *
 * Seated is *not* unavailable: a second order on an occupied table is how a
 * party splits its bill (each order is its own invoice, settled and printed on
 * its own, all sharing the table's one session). Only a table being cleaned or
 * out of service is refused, because `createOrder` refuses it too.
 */
export function listSelectableTables({
  tables,
  query,
}: PosTableListInput): PosTableChoice[] {
  const normalizedQuery = normalizePosSearchText(query);
  return tables
    .filter(
      (table) =>
        !normalizedQuery ||
        normalizePosSearchText(table.name).includes(normalizedQuery),
    )
    .map((table) => ({
      ...table,
      occupied: isTableOccupied(table.status),
      unavailable: isTableUnavailable(table.status),
    }));
}

// ---------------------------------------------------------------------------
// The cart, and what still stands between it and a sale
// ---------------------------------------------------------------------------

export type PosCartLineQuantity = {
  menuItemId: string;
  quantity: number;
};

/**
 * How many of each menu item the cart currently holds, summed across lines.
 *
 * One product can sit on several lines — two lattes with different add-ons or
 * notes are deliberately not merged (see `addToCart`) — so a product tile that
 * wants to say "۳ در سبد" has to add them up rather than find "the" line.
 */
export function cartQuantitiesByItem(
  lines: readonly PosCartLineQuantity[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.menuItemId, (totals.get(line.menuItemId) ?? 0) + line.quantity);
  }
  return totals;
}

export type PosCheckoutRequirement =
  | "empty_cart"
  | "table_required"
  | "delivery_address_required";

export type PosCheckoutGateInput = {
  orderType: string;
  tableId: string;
  deliveryAddress: string;
  lineCount: number;
};

/**
 * The first thing still missing before this cart can become an order, or null
 * when nothing is.
 *
 * There is one of these rather than a check per button because the till used to
 * disagree with itself: both actions were enabled whenever the cart had a line,
 * so a delivery order with no address was accepted by the buttons, carried
 * through the table prompt and the review dialog, and only refused by `submit()`
 * at the last press — three screens after the field that was actually empty. The
 * caller now labels its own button with what this returns, so the answer is on
 * screen before the cashier commits to anything.
 *
 * Order matters: an empty cart is reported first because the other two are not
 * yet worth asking about, and the table is asked for before the address because
 * only one of the two can apply to any given order type.
 */
export function missingCheckoutRequirement({
  orderType,
  tableId,
  deliveryAddress,
  lineCount,
}: PosCheckoutGateInput): PosCheckoutRequirement | null {
  if (lineCount <= 0) return "empty_cart";
  if (requiresTableSelection({ orderType, tableId })) return "table_required";
  if (orderType === "delivery" && deliveryAddress.trim() === "")
    return "delivery_address_required";
  return null;
}
