/**
 * GH #1567 Phase 6C — virtual size packs: the pure rules.
 *
 * A pack is a composition of sellable variants, each with an integer
 * multiplier and a wholesale unit price. It owns no stock: its availability is
 * derived from the components, and selling N packs sells N × multiplier of
 * each component through the ordinary per-variant sale path. Everything here
 * is deterministic and free of I/O so the service, the route and the builder
 * UI agree on the same numbers.
 */
export const MAX_PACK_COMPONENTS = 60;
export const MAX_PACK_QUANTITY = 10_000;

export interface PackComponentInput {
  itemId: string;
  quantity: number;
  unitPriceRial: number;
}

export interface PackDefinitionInput {
  name: string;
  barcode?: string | null;
  components: PackComponentInput[];
}

export class SizePackRuleError extends Error {
  constructor(public readonly code: string, public readonly detail?: Record<string, unknown>) {
    super(code);
    this.name = "SizePackRuleError";
  }
}

/** Validates a definition; throws SizePackRuleError with a stable code. */
export function validatePackDefinition(input: PackDefinitionInput): void {
  if (!input.name || input.name.trim().length === 0) throw new SizePackRuleError("pack_name_required");
  if (input.components.length === 0) throw new SizePackRuleError("pack_has_no_components");
  if (input.components.length > MAX_PACK_COMPONENTS) throw new SizePackRuleError("pack_too_many_components");
  const seen = new Set<string>();
  for (const c of input.components) {
    if (seen.has(c.itemId)) throw new SizePackRuleError("pack_duplicate_component", { itemId: c.itemId });
    seen.add(c.itemId);
    if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > MAX_PACK_QUANTITY) {
      throw new SizePackRuleError("pack_invalid_quantity", { itemId: c.itemId });
    }
    if (!Number.isSafeInteger(c.unitPriceRial) || c.unitPriceRial < 0) {
      throw new SizePackRuleError("pack_invalid_price", { itemId: c.itemId });
    }
  }
}

/** The pack's price and piece count — exact sums, no allocation rounding. */
export function packTotals(components: readonly Pick<PackComponentInput, "quantity" | "unitPriceRial">[]): { priceRial: number; pieces: number } {
  let price = 0n;
  let pieces = 0;
  for (const c of components) {
    price += BigInt(c.unitPriceRial) * BigInt(c.quantity);
    pieces += c.quantity;
  }
  if (price > BigInt(Number.MAX_SAFE_INTEGER)) throw new SizePackRuleError("pack_price_too_large");
  return { priceRial: Number(price), pieces };
}

export interface ComponentStock {
  itemId: string;
  name: string;
  quantity: number;
  onHand: string;
}

export interface PackShortage {
  itemId: string;
  name: string;
  need: number;
  onHand: string;
  missing: string;
}

/**
 * Whole packs the components can make right now (`min ⌊onHand ÷ multiplier⌋`)
 * and, for `wanted` packs, which components fall short and by how much.
 */
export function packAvailability(components: readonly ComponentStock[], wanted = 1): { available: number; shortages: PackShortage[] } {
  let available = Number.POSITIVE_INFINITY;
  const shortages: PackShortage[] = [];
  for (const c of components) {
    const onHand = Number(c.onHand);
    const whole = onHand > 0 ? Math.floor(onHand / c.quantity) : 0;
    available = Math.min(available, whole);
    const need = c.quantity * wanted;
    if (onHand < need) {
      shortages.push({ itemId: c.itemId, name: c.name, need, onHand: c.onHand, missing: trimNumber(need - onHand) });
    }
  }
  return { available: Number.isFinite(available) ? available : 0, shortages };
}

function trimNumber(value: number): string {
  return String(Math.round(value * 1_000_000) / 1_000_000);
}

export interface PackSnapshotComponent {
  itemId: string;
  name: string;
  quantityPerPack: number;
  unitPriceRial: number;
}

export interface ExpandedPackLine {
  kind: "stocked";
  itemId: string;
  quantity: string;
  unitPrice: number;
  discount: number;
  vatPercent: number;
  sizePackId: string;
}

/**
 * The ordinary per-variant invoice lines `packQuantity` packs become. Order is
 * the pack's component order, so the snapshot can pair each with its order line.
 */
export function expandPack(
  packId: string,
  components: readonly PackSnapshotComponent[],
  packQuantity: number,
  vatPercent: number,
): ExpandedPackLine[] {
  if (!Number.isInteger(packQuantity) || packQuantity < 1 || packQuantity > MAX_PACK_QUANTITY) {
    throw new SizePackRuleError("pack_invalid_quantity");
  }
  return components.map((c) => ({
    kind: "stocked",
    itemId: c.itemId,
    quantity: String(c.quantityPerPack * packQuantity),
    unitPrice: c.unitPriceRial,
    discount: 0,
    vatPercent,
    sizePackId: packId,
  }));
}

export interface PackLineRequest {
  packId: string;
  quantity: number;
  vatPercent: number;
}

/** The canonical form of the pack lines a request asked for (hashed by the service). */
export function canonicalPackRequest(lines: readonly PackLineRequest[]): string {
  return JSON.stringify(lines.map((l) => [l.packId, l.quantity, l.vatPercent]));
}

export interface PackChildReturnState {
  quantity: string;
  returnedQuantity: string;
}

/** «فروخته‌شده» / «برگشت جزئی» / «برگشت کامل» for a sold pack's child lines. */
export function packReturnStatus(children: readonly PackChildReturnState[]): "sold" | "partially_returned" | "returned" {
  let any = false;
  let all = children.length > 0;
  for (const c of children) {
    const returned = Number(c.returnedQuantity);
    if (returned > 0) any = true;
    if (returned < Number(c.quantity)) all = false;
  }
  return all ? "returned" : any ? "partially_returned" : "sold";
}
