/**
 * Pure cart-line operations for the till.
 *
 * Every quantity change honours the one ceiling the server enforces
 * (order-quantity.ts): the steppers cannot build a line the submit would
 * reject, and a merge that would overflow the ceiling stays two lines
 * instead — each one legal on its own.
 *
 * The till.*
 * A cart line is *one configuration* of a menu item — a given menu item can sit
 * on several lines, one per distinct add-on/note combination. «دو قهوه، یکی با
 * شکلات و یکی بدون آن» is therefore two lines, each with its own quantity and
 * its own number selector. These helpers are the only place lines are merged,
 * grown or replaced, so the POS screen can't grow a customised line by mistake
 * (the bug where tapping + on a tile silently added another unit *with* an
 * add-on the new unit was not supposed to carry).
 *
 * Tile `+` never copies add-ons. It adds (or grows) a *plain* unit — no
 * add-ons, no note — and leaves any customised sibling alone. Growing a
 * customised configuration is the cart-line stepper's job, where the number
 * sits on that line. The previous "smart +" still copied toppings whenever the
 * cart held only one line of the product; `decideTilePlus` is what closed that
 * hole.
 *
 * Everything here is a plain function over the cart array and is unit-tested;
 * the component only wires these into state.
 */

import { MAX_ORDER_LINE_QUANTITY } from "./order-quantity";

/** One chosen add-on on a till line: which one, and how many of it. */
export interface PosCartModifierPick {
  id: string;
  quantity: number;
}

/** The fields two lines must share to count as the same sellable configuration. */
export interface PosCartLineConfig {
  menuItemId: string;
  /** Add-on picks with quantities, sorted by id — «شات ×۳» is one pick. */
  modifierPicks: PosCartModifierPick[];
  note: string;
}

export interface PosCartLine extends PosCartLineConfig {
  key: string;
  name: string;
  unitPrice: number;
  quantity: number;
  taxRatePercent: number;
  /** Display data per pick — name, delta, and how many of it (default one). */
  modifiers: { name: string; priceDelta: number; quantity?: number }[];
  /**
   * A monotonic stamp of the cart action that last touched this line.
   *
   * The tile's − must undo the cashier's *last* action, and array position is
   * not that: adding a second coffee with the same configuration merges into
   * the earlier card, so the most recently touched line can sit above a
   * plain sibling added after it. Every helper below stamps the line it
   * changes; `stepLastLineForItem` reads the stamp and only falls back to
   * array order for carts built before stamps existed (offline snapshots,
   * callers that construct lines by hand).
   */
  lastTouched?: number;
}

/** The next stamp: one greater than every stamp already in the cart. */
function nextTouch(lines: readonly PosCartLine[]): number {
  return lines.reduce((max, line) => Math.max(max, line.lastTouched ?? 0), 0) + 1;
}

/**
 * An ordered, value-wise comparison of the fields that make a line a distinct
 * configuration. Two lines merge only when they are the same item, carry the
 * same add-ons in the same shape, and share a note — otherwise they stay apart
 * by design (coffee with chocolate vs. coffee without is two lines).
 */
export function sameLineConfig(
  a: PosCartLineConfig,
  b: PosCartLineConfig,
): boolean {
  return (
    a.menuItemId === b.menuItemId &&
    a.note === b.note &&
    // Quantities are part of the configuration: «شات ×۲» and «شات ×۳» are
    // different drinks and must never merge into one line.
    a.modifierPicks.length === b.modifierPicks.length &&
    a.modifierPicks.every(
      (pick, index) =>
        pick.id === b.modifierPicks[index].id &&
        pick.quantity === b.modifierPicks[index].quantity,
    )
  );
}

/**
 * Puts a freshly configured line into the cart: merges into an identical line
 * (same item + add-ons + note) by adding the quantity, otherwise appends it as
 * a new, separate line. Used when the add-on picker confirms — including when
 * it confirms a configuration the cart already holds, so two «coffee without
 * anything» adds become one line of two rather than two one-unit cards.
 */
export function addOrMergeLine(
  lines: readonly PosCartLine[],
  incoming: PosCartLine,
): PosCartLine[] {
  // Every branch stamps the line the cashier just acted on, so the tile's −
  // can find it even when the merge happens into an earlier card.
  const stamp = nextTouch(lines);
  const existingIndex = lines.findIndex((line) =>
    sameLineConfig(line, incoming),
  );
  if (existingIndex === -1) return [...lines, { ...incoming, lastTouched: stamp }];
  const target = lines[existingIndex];
  // A merge that would push the line past the server's ceiling stays two
  // lines — each individually valid — rather than one the submit would
  // reject. The cashier still sees every unit they scanned.
  if (target.quantity + incoming.quantity > MAX_ORDER_LINE_QUANTITY) {
    return [...lines, { ...incoming, lastTouched: stamp }];
  }
  return lines.map((line, index) =>
    index === existingIndex
      ? {
          ...line,
          quantity: line.quantity + incoming.quantity,
          lastTouched: stamp,
        }
      : line,
  );
}

/**
 * Replaces a line being edited (`targetKey`), then re-merges: if the edited
 * configuration now matches another line, the two collapse into one with the
 * quantities added; otherwise the edited line keeps its position in the cart.
 * This is what makes «edit this line's add-ons» safe — removing the chocolate
 * from one of two coffees merges it with the plain coffee already in the cart
 * instead of leaving a duplicated card.
 */
export function upsertLine(
  lines: readonly PosCartLine[],
  targetKey: string,
  updated: PosCartLine,
): PosCartLine[] {
  const stamp = nextTouch(lines);
  const stamped = { ...updated, lastTouched: stamp };
  const currentIndex = lines.findIndex((line) => line.key === targetKey);
  if (currentIndex === -1) return addOrMergeLine(lines, stamped);

  const remaining = lines.filter((line) => line.key !== targetKey);
  const mergeIndex = remaining.findIndex((line) =>
    sameLineConfig(line, updated),
  );
  if (mergeIndex !== -1 && remaining[mergeIndex].quantity + updated.quantity > MAX_ORDER_LINE_QUANTITY) {
    // Same overflow rule as addOrMergeLine: keep the lines apart.
    const next = [...remaining];
    next.splice(Math.min(currentIndex, next.length), 0, stamped);
    return next;
  }
  if (mergeIndex === -1) {
    // Keep the edited line where it stood; rebuild without reordering.
    const next = [...remaining];
    next.splice(Math.min(currentIndex, next.length), 0, stamped);
    return next;
  }
  return remaining.map((line, index) =>
    index === mergeIndex
      ? {
          ...line,
          quantity: line.quantity + updated.quantity,
          lastTouched: stamp,
        }
      : line,
  );
}

/**
 * Steps one line's quantity, removing the line when it reaches zero. Returns
 * the cart untouched when the key is unknown, so a double-tap on a line that
 * just disappeared can't crash the till.
 */
export function stepLineQuantity(
  lines: readonly PosCartLine[],
  key: string,
  delta: number,
): PosCartLine[] {
  // A stepper press is a touch too: after growing the plain coffee, the
  // tile's − should undo THAT, not fall back to array order.
  const stamp = nextTouch(lines);
  return lines.flatMap((line) => {
    if (line.key !== key) return [line];
    const nextQuantity = line.quantity + delta;
    if (nextQuantity <= 0) return [];
    // The server refuses a line above its ceiling whatever the client sends;
    // the stepper simply refuses to build one. The caller surfaces the
    // «حداکثر تعداد» message when it tries anyway.
    if (nextQuantity > MAX_ORDER_LINE_QUANTITY) return [line];
    return [{ ...line, quantity: nextQuantity, lastTouched: stamp }];
  });
}

/**
 * The − on a product tile undoes the cashier's *last* touch of that product: it
 * steps the most recent line carrying the item, which is the one they just
 * added. Earlier lines — e.g. a differently-customised coffee — are left alone,
 * because the tile cannot show which of them a tap is meant for.
 */
export function stepLastLineForItem(
  lines: readonly PosCartLine[],
  menuItemId: string,
  delta: number,
): PosCartLine[] {
  // The last *touch*, not the last array entry. A configuration added again
  // merges into its earlier card, so the newest action can sit above a
  // sibling that was added later; array order alone would remove the wrong
  // coffee. Lines without a stamp (old carts) fall back to array order.
  let chosen: PosCartLine | null = null;
  for (const line of lines) {
    if (line.menuItemId !== menuItemId) continue;
    if (!chosen || (line.lastTouched ?? 0) >= (chosen.lastTouched ?? 0)) {
      chosen = line;
    }
  }
  if (!chosen) return [...lines];
  return stepLineQuantity(lines, chosen.key, delta);
}

/**
 * How many *distinct configurations* of a product the cart currently holds.
 * A tile badge that wants a count of units should use `cartQuantitiesByItem`
 * instead — this one is "how many cards", not "how many coffees".
 */
export function countLinesForItem(
  lines: readonly PosCartLine[],
  menuItemId: string,
): number {
  return lines.reduce(
    (count, line) =>
      line.menuItemId === menuItemId ? count + 1 : count,
    0,
  );
}

/** No add-ons and no note: the default unit the product tile's + rings up. */
export function isPlainConfiguration(line: PosCartLineConfig): boolean {
  return line.modifierPicks.length === 0 && line.note === "";
}

/**
 * What the product tile's + should do.
 *
 * The tile + means "another unit of this product, without extra add-ons".
 * It must never grow a customised line — that was the bug: one coffee with
 * chocolate, tap +, both coffees had chocolate. A line that already carries
 * add-ons (or a note) stays put; the new unit is a separate, plain line, or
 * merges with the plain line already in the cart.
 *
 * When the item *requires* a modifier choice (size, etc.) a plain unit isn't
 * valid, so the caller opens the picker instead of guessing.
 *
 * `pick` is first-add: the tile isn't in the cart yet, so the caller behaves
 * like a tap (plain add, or the picker when the item has groups).
 */
export type TilePlusDecision =
  | { type: "pick" }
  | { type: "configure" }
  | { type: "add_plain" };

export function decideTilePlus(
  lines: readonly PosCartLine[],
  menuItemId: string,
  requiresConfiguration: boolean,
): TilePlusDecision {
  const inCart = lines.some((line) => line.menuItemId === menuItemId);
  if (!inCart) return { type: "pick" };
  if (requiresConfiguration) return { type: "configure" };
  return { type: "add_plain" };
}

/**
 * Applies the tile's + to the cart: a new plain unit, merged with an existing
 * plain line of the same product if there is one. Customised lines are never
 * touched. The caller only invokes this when `decideTilePlus` returned
 * `add_plain` — `pick` / `configure` open UI, they don't mutate the cart.
 */
export function addPlainUnit(
  lines: readonly PosCartLine[],
  incoming: PosCartLine,
): PosCartLine[] {
  return addOrMergeLine(lines, {
    ...incoming,
    modifierPicks: [],
    modifiers: [],
    note: "",
  });
}
