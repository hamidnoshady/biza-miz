/**
 * Runtime validation for the restaurant menu HTTP surface.
 *
 * Route handlers receive untrusted JSON; TypeScript's types are compile-time
 * only and every `Boolean(body.isActive)` / `Number(body.sortOrder) || 0`
 * coercion is a hole — `"false"` is truthy, `"12abc"` becomes 12, `null`
 * becomes 0. These schemas reject instead of coercing, and are the *same*
 * schemas for create and patch so the two paths can never disagree about
 * what a valid name/price/SKU is (a patch accepting what a create rejects,
 * or vice versa, was exactly the drift this file exists to end).
 *
 * Hand-rolled on purpose: the repo has no validation dependency, and these
 * are small, closed shapes — adding one for ~10 schemas would be a new
 * supply-chain surface for no gain. Pure and framework-free, so the routes,
 * the services and the unit tests share it.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MENU_NAME_MAX_LENGTH = 200;
export const MENU_SKU_MAX_LENGTH = 100;
/** An optional client-supplied create key is bounded: it is indexed. */
export const MENU_CREATE_KEY_MAX_LENGTH = 100;
export const MENU_DESCRIPTION_MAX_LENGTH = 2000;

/** A real boolean — never `Boolean(value)`, which turns `"false"` into true. */
export function parseBoolean(value: unknown): ParseResult<boolean> {
  if (typeof value !== "boolean") return { ok: false, error: "bad_request" };
  return { ok: true, value };
}

/** `null` and `undefined` both mean "field absent" for optional booleans. */
export function parseOptionalBoolean(value: unknown): ParseResult<boolean | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  return parseBoolean(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function parseUuid(value: unknown): ParseResult<string> {
  if (!isUuid(value)) return { ok: false, error: "bad_request" };
  return { ok: true, value };
}

/** A required, non-empty name within the column's length. */
export function parseName(value: unknown, maxLength = MENU_NAME_MAX_LENGTH): ParseResult<string> {
  if (typeof value !== "string") return { ok: false, error: "missing_fields" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: "missing_fields" };
  if (trimmed.length > maxLength) return { ok: false, error: "name_too_long" };
  return { ok: true, value: trimmed };
}

/**
 * An optional name: absent stays absent (patch semantics), null is rejected —
 * these entities always have a name.
 */
export function parseOptionalName(value: unknown, maxLength = MENU_NAME_MAX_LENGTH): ParseResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return parseName(value, maxLength);
}

/** Integer Rial ≥ 0 — the stored type of every menu price. */
export function parsePrice(value: unknown): ParseResult<number> {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return { ok: false, error: "invalid_price" };
  }
  return { ok: true, value };
}

/** A percentage in [0, 100] — tax rates, margins-with-ceiling included. */
export function parsePercent(value: unknown, max = 100): ParseResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    return { ok: false, error: "invalid_rate" };
  }
  return { ok: true, value };
}

/** Sort order: a plain integer; not silently defaulted from garbage. */
export function parseSortOrder(value: unknown): ParseResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 2_000_000_000) {
    return { ok: false, error: "bad_request" };
  }
  return { ok: true, value };
}

export function parseOptionalSortOrder(value: unknown): ParseResult<number | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  return parseSortOrder(value);
}

/** An optional text field: null clears it, a string is trimmed, garbage is rejected. */
export function parseOptionalText(
  value: unknown,
  maxLength: number,
): ParseResult<string | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "bad_request" };
  const trimmed = value.trim();
  if (trimmed.length > maxLength) return { ok: false, error: "too_long" };
  return { ok: true, value: trimmed || null };
}

/** An item code / SKU: optional, trimmed, no interior control characters. */
export function parseOptionalSku(value: unknown): ParseResult<string | null | undefined> {
  const parsed = parseOptionalText(value, MENU_SKU_MAX_LENGTH);
  if (!parsed.ok) return parsed;
  if (parsed.value && /[\u0000-\u001f\u007f]/.test(parsed.value)) {
    return { ok: false, error: "bad_request" };
  }
  return parsed;
}

/** Target gross margin: null clears, otherwise [0, 100). */
export function parseOptionalMargin(value: unknown): ParseResult<number | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 100) {
    return { ok: false, error: "invalid_margin" };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export interface CategoryCreateInput {
  name: string;
  /** Absent → the business's default tax rate (resolved by the service). */
  taxRate?: number;
  sortOrder?: number;
  isActive?: boolean;
}

export interface CategoryPatchInput {
  name?: string;
  taxRate?: number;
  sortOrder?: number;
  isActive?: boolean;
}

export function validateCategoryCreate(body: unknown): ParseResult<CategoryCreateInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const name = parseName(raw.name, 120);
  if (!name.ok) return name;
  const value: CategoryCreateInput = { name: name.value };
  if (raw.taxRate !== undefined && raw.taxRate !== null) {
    const taxRate = parsePercent(raw.taxRate);
    if (!taxRate.ok) return taxRate;
    value.taxRate = taxRate.value;
  }
  if (raw.sortOrder !== undefined && raw.sortOrder !== null) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
  }
  if (raw.isActive !== undefined && raw.isActive !== null) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
  }
  return { ok: true, value };
}

export function validateCategoryPatch(body: unknown): ParseResult<CategoryPatchInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const value: CategoryPatchInput = {};
  let fields = 0;
  if (raw.name !== undefined) {
    const name = parseName(raw.name, 120);
    if (!name.ok) return name;
    value.name = name.value;
    fields++;
  }
  if (raw.taxRate !== undefined) {
    if (raw.taxRate === null) return { ok: false, error: "invalid_rate" };
    const taxRate = parsePercent(raw.taxRate);
    if (!taxRate.ok) return taxRate;
    value.taxRate = taxRate.value;
    fields++;
  }
  if (raw.sortOrder !== undefined) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
    fields++;
  }
  if (raw.isActive !== undefined) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
    fields++;
  }
  if (fields === 0) return { ok: false, error: "bad_request" };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Menu item
// ---------------------------------------------------------------------------

export interface MenuItemCreateInput {
  categoryId: string;
  name: string;
  price: number;
  description?: string | null;
  sku?: string | null;
  imageUrl?: string | null;
  imageMediaId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  /**
   * Optional client-supplied create key (issue #911).
   *
   * A save whose answer the client never received is retried with the SAME
   * key, and the server then answers with the item the first attempt created
   * instead of making a second one. Absent means «do not deduplicate» —
   * importers, syncs and data transfer all leave it out.
   */
  idempotencyKey?: string;
}

export interface MenuItemPatchInput {
  categoryId?: string;
  name?: string;
  price?: number;
  description?: string | null;
  sku?: string | null;
  imageUrl?: string | null;
  imageMediaId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  targetMarginPercent?: number | null;
}

/**
 * The create key: a plain opaque string, trimmed and length-bounded, and
 * nothing more. It is never displayed, never parsed and never used as an
 * identifier for anything but this one dedupe, so there is no format to
 * validate — only a size, because the column is indexed.
 */
export function parseCreateKey(value: unknown): ParseResult<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: "bad_request" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: "bad_request" };
  if (trimmed.length > MENU_CREATE_KEY_MAX_LENGTH) return { ok: false, error: "too_long" };
  return { ok: true, value: trimmed };
}

export function validateMenuItemCreate(body: unknown): ParseResult<MenuItemCreateInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const categoryId = parseUuid(raw.categoryId);
  if (!categoryId.ok) return { ok: false, error: "missing_fields" };
  const name = parseName(raw.name);
  if (!name.ok) return name;
  const price = parsePrice(raw.price);
  if (!price.ok) return price;

  const value: MenuItemCreateInput = {
    categoryId: categoryId.value,
    name: name.value,
    price: price.value,
  };
  const description = parseOptionalText(raw.description, MENU_DESCRIPTION_MAX_LENGTH);
  if (!description.ok) return description;
  if (description.value !== undefined) value.description = description.value;
  const sku = parseOptionalSku(raw.sku);
  if (!sku.ok) return sku;
  if (sku.value !== undefined) value.sku = sku.value;
  const imageUrl = parseOptionalText(raw.imageUrl, 2000);
  if (!imageUrl.ok) return imageUrl;
  if (imageUrl.value !== undefined) value.imageUrl = imageUrl.value;
  const imageMediaId = parseOptionalText(raw.imageMediaId, 64);
  if (!imageMediaId.ok) return imageMediaId;
  if (imageMediaId.value !== undefined) {
    if (imageMediaId.value !== null && !isUuid(imageMediaId.value)) {
      return { ok: false, error: "bad_request" };
    }
    value.imageMediaId = imageMediaId.value;
  }
  if (raw.sortOrder !== undefined && raw.sortOrder !== null) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
  }
  if (raw.isActive !== undefined && raw.isActive !== null) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
  }
  const createKey = parseCreateKey(raw.idempotencyKey);
  if (!createKey.ok) return createKey;
  if (createKey.value !== undefined) value.idempotencyKey = createKey.value;
  return { ok: true, value };
}

export function validateMenuItemPatch(body: unknown): ParseResult<MenuItemPatchInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const value: MenuItemPatchInput = {};
  let fields = 0;
  if (raw.categoryId !== undefined) {
    if (raw.categoryId === null) return { ok: false, error: "bad_request" };
    const categoryId = parseUuid(raw.categoryId);
    if (!categoryId.ok) return { ok: false, error: "bad_request" };
    value.categoryId = categoryId.value;
    fields++;
  }
  if (raw.name !== undefined) {
    const name = parseName(raw.name);
    if (!name.ok) return name;
    value.name = name.value;
    fields++;
  }
  if (raw.price !== undefined) {
    const price = parsePrice(raw.price);
    if (!price.ok) return price;
    value.price = price.value;
    fields++;
  }
  if (raw.description !== undefined) {
    const description = parseOptionalText(raw.description, MENU_DESCRIPTION_MAX_LENGTH);
    if (!description.ok) return description;
    value.description = description.value;
    fields++;
  }
  if (raw.sku !== undefined) {
    const sku = parseOptionalSku(raw.sku);
    if (!sku.ok) return sku;
    value.sku = sku.value;
    fields++;
  }
  if (raw.imageUrl !== undefined) {
    const imageUrl = parseOptionalText(raw.imageUrl, 2000);
    if (!imageUrl.ok) return imageUrl;
    value.imageUrl = imageUrl.value;
    fields++;
  }
  if (raw.imageMediaId !== undefined) {
    const imageMediaId = parseOptionalText(raw.imageMediaId, 64);
    if (!imageMediaId.ok) return imageMediaId;
    if (imageMediaId.value !== null && !isUuid(imageMediaId.value)) {
      return { ok: false, error: "bad_request" };
    }
    value.imageMediaId = imageMediaId.value;
    fields++;
  }
  if (raw.sortOrder !== undefined) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
    fields++;
  }
  if (raw.isActive !== undefined) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
    fields++;
  }
  if (raw.targetMarginPercent !== undefined) {
    const margin = parseOptionalMargin(raw.targetMarginPercent);
    if (!margin.ok) return margin;
    value.targetMarginPercent = margin.value;
    fields++;
  }
  if (fields === 0) return { ok: false, error: "bad_request" };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Modifier group
// ---------------------------------------------------------------------------

export interface ModifierGroupCreateInput {
  name: string;
  minSelect?: number;
  maxSelect?: number;
  sortOrder?: number;
  isActive?: boolean;
}

export interface ModifierGroupPatchInput {
  name?: string;
  minSelect?: number;
  maxSelect?: number;
  sortOrder?: number;
  isActive?: boolean;
}

function parseSelectionBound(value: unknown): ParseResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_000_000_000) {
    return { ok: false, error: "bad_request" };
  }
  return { ok: true, value };
}

export function validateModifierGroupCreate(body: unknown): ParseResult<ModifierGroupCreateInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const name = parseName(raw.name, 120);
  if (!name.ok) return name;
  const value: ModifierGroupCreateInput = { name: name.value };
  if (raw.minSelect !== undefined) {
    const min = parseSelectionBound(raw.minSelect);
    if (!min.ok) return min;
    value.minSelect = min.value;
  }
  if (raw.maxSelect !== undefined) {
    const max = parseSelectionBound(raw.maxSelect);
    if (!max.ok) return max;
    value.maxSelect = max.value;
  }
  if (raw.sortOrder !== undefined && raw.sortOrder !== null) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
  }
  if (raw.isActive !== undefined && raw.isActive !== null) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
  }
  return { ok: true, value };
}

export function validateModifierGroupPatch(body: unknown): ParseResult<ModifierGroupPatchInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const value: ModifierGroupPatchInput = {};
  let fields = 0;
  if (raw.name !== undefined) {
    const name = parseName(raw.name, 120);
    if (!name.ok) return name;
    value.name = name.value;
    fields++;
  }
  if (raw.minSelect !== undefined) {
    const min = parseSelectionBound(raw.minSelect);
    if (!min.ok) return min;
    value.minSelect = min.value;
    fields++;
  }
  if (raw.maxSelect !== undefined) {
    const max = parseSelectionBound(raw.maxSelect);
    if (!max.ok) return max;
    value.maxSelect = max.value;
    fields++;
  }
  if (raw.sortOrder !== undefined) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
    fields++;
  }
  if (raw.isActive !== undefined) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
    fields++;
  }
  if (fields === 0) return { ok: false, error: "bad_request" };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Modifier (an add-on option)
// ---------------------------------------------------------------------------

export interface ModifierCreateInput {
  groupId: string;
  name: string;
  priceDelta?: number;
  sortOrder?: number;
  isActive?: boolean;
}

export interface ModifierPatchInput {
  groupId?: string;
  name?: string;
  priceDelta?: number;
  sortOrder?: number;
  isActive?: boolean;
}

/** Price delta: integer Rial, negative allowed (a discount-shaped add-on). */
function parsePriceDelta(value: unknown): ParseResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > 9_000_000_000_000) {
    return { ok: false, error: "missing_fields" };
  }
  return { ok: true, value };
}

export function validateModifierCreate(body: unknown): ParseResult<ModifierCreateInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const groupId = parseUuid(raw.groupId);
  if (!groupId.ok) return { ok: false, error: "missing_fields" };
  const name = parseName(raw.name, 120);
  if (!name.ok) return name;
  const value: ModifierCreateInput = { groupId: groupId.value, name: name.value };
  if (raw.priceDelta !== undefined && raw.priceDelta !== null) {
    const priceDelta = parsePriceDelta(raw.priceDelta);
    if (!priceDelta.ok) return priceDelta;
    value.priceDelta = priceDelta.value;
  }
  if (raw.sortOrder !== undefined && raw.sortOrder !== null) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
  }
  if (raw.isActive !== undefined && raw.isActive !== null) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
  }
  return { ok: true, value };
}

export function validateModifierPatch(body: unknown): ParseResult<ModifierPatchInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const value: ModifierPatchInput = {};
  let fields = 0;
  if (raw.groupId !== undefined) {
    if (raw.groupId === null) return { ok: false, error: "bad_request" };
    const groupId = parseUuid(raw.groupId);
    if (!groupId.ok) return { ok: false, error: "bad_request" };
    value.groupId = groupId.value;
    fields++;
  }
  if (raw.name !== undefined) {
    const name = parseName(raw.name, 120);
    if (!name.ok) return name;
    value.name = name.value;
    fields++;
  }
  if (raw.priceDelta !== undefined) {
    const priceDelta = parsePriceDelta(raw.priceDelta);
    if (!priceDelta.ok) return priceDelta;
    value.priceDelta = priceDelta.value;
    fields++;
  }
  if (raw.sortOrder !== undefined) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
    fields++;
  }
  if (raw.isActive !== undefined) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
    fields++;
  }
  if (fields === 0) return { ok: false, error: "bad_request" };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Item ↔ modifier-group attachment
// ---------------------------------------------------------------------------

export interface ItemModifierGroupAttachInput {
  menuItemId: string;
  modifierGroupId: string;
  minSelectOverride?: number | null;
  maxSelectOverride?: number | null;
  sortOrder?: number;
}

export function validateItemModifierGroupAttach(
  body: unknown,
): ParseResult<ItemModifierGroupAttachInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const menuItemId = parseUuid(raw.menuItemId);
  if (!menuItemId.ok) return { ok: false, error: "missing_fields" };
  const modifierGroupId = parseUuid(raw.modifierGroupId);
  if (!modifierGroupId.ok) return { ok: false, error: "missing_fields" };
  const value: ItemModifierGroupAttachInput = {
    menuItemId: menuItemId.value,
    modifierGroupId: modifierGroupId.value,
  };
  for (const key of ["minSelectOverride", "maxSelectOverride"] as const) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null) {
      value[key] = null;
      continue;
    }
    const bound = parseSelectionBound(raw[key]);
    if (!bound.ok) return bound;
    value[key] = bound.value;
  }
  if (raw.sortOrder !== undefined && raw.sortOrder !== null) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
  }
  return { ok: true, value };
}

/** A patch of just the per-item attachment configuration. */
export interface ItemModifierGroupPatchInput {
  minSelectOverride?: number | null;
  maxSelectOverride?: number | null;
  sortOrder?: number;
  isActive?: boolean;
}

export function validateItemModifierGroupPatch(
  body: unknown,
): ParseResult<ItemModifierGroupPatchInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "bad_request" };
  const raw = body as Record<string, unknown>;
  const value: ItemModifierGroupPatchInput = {};
  let fields = 0;
  for (const key of ["minSelectOverride", "maxSelectOverride"] as const) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null) {
      value[key] = null;
      fields++;
      continue;
    }
    const bound = parseSelectionBound(raw[key]);
    if (!bound.ok) return bound;
    value[key] = bound.value;
    fields++;
  }
  if (raw.sortOrder !== undefined) {
    const sortOrder = parseSortOrder(raw.sortOrder);
    if (!sortOrder.ok) return sortOrder;
    value.sortOrder = sortOrder.value;
    fields++;
  }
  if (raw.isActive !== undefined) {
    const isActive = parseBoolean(raw.isActive);
    if (!isActive.ok) return isActive;
    value.isActive = isActive.value;
    fields++;
  }
  if (fields === 0) return { ok: false, error: "bad_request" };
  return { ok: true, value };
}
