/**
 * Server-side cart resolution shared by "create order" and "add item to an
 * open order": looks up menu items + modifiers by id, prices from the DB
 * (never the client), and validates modifier group min/max select.
 *
 * This module is the one conceptual
 * `resolveRestaurantLineConfiguration(menuItemId, modifierIds)` for order
 * intake: for every menu item in the cart it always loads the item's
 * *attached modifier groups* — whether or not the request contained any
 * modifier ids — because a required group must be enforced on a line that
 * submitted zero add-ons too. (Only loading groups when some modifier id
 * exists was the bug: an item with a required «اندازه» 1..1 group could be
 * submitted with `modifierIds: []` and the group was never so much as read.)
 *
 * All mutation paths — POST /api/orders, add-items, line re-picking
 * (`resolveLineModifiers`), the offline queue's replay — run through this same
 * resolution, so no transport can bypass the rule.
 */
import { query } from "./db";
import type { PoolClient } from "pg";
import {
  effectiveSelectionBounds,
  resolveModifierSelection,
  type AttachedModifierGroup,
  type ModifierPick,
  type SelectableModifier,
  type SelectedModifier,
} from "./order-line-modifiers";
import { MAX_ORDER_LINE_QUANTITY } from "./order-quantity";
import type { CartLine } from "./orders";

export interface CartItemInput {
  menuItemId?: string;
  quantity?: number;
  /**
   * The line's add-ons, each with its own repeat count («شات اضافه ×۳» is one
   * entry at quantity 3). A bare id means quantity 1.
   */
  modifiers?: (ModifierPick | string)[];
  /**
   * The pre-quantity shape every client sent until now — still accepted (the
   * waiter screen, queued offline payloads, old installs) and equivalent to
   * `modifiers` with every quantity at 1. When both are present, the two are
   * concatenated and validated as one selection, so no path can bypass the
   * duplicate check by splitting its choice across the two fields.
   */
  modifierIds?: string[];
  note?: string;
}

export interface PreparedItem {
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  note: string | null;
  modifiers: { id: string; name: string; priceDelta: number; quantity: number }[];
}

export type ResolveCartResult =
  | { ok: true; cartLines: CartLine[]; preparedItems: PreparedItem[] }
  | { ok: false; error: string; status: number };

export function validateItemShape(items: CartItemInput[]): string | null {
  if (items.length === 0) return "no_items";
  for (const it of items) {
    const qty = Number(it.quantity);
    if (
      !it.menuItemId ||
      !Number.isInteger(qty) ||
      qty <= 0 ||
      qty > MAX_ORDER_LINE_QUANTITY
    ) {
      return "invalid_item";
    }
    // A modifier id list that is not a list of strings is malformed input,
    // not a missing choice — reject it before it reaches a uuid[] cast.
    if (
      it.modifierIds !== undefined &&
      it.modifierIds !== null &&
      (!Array.isArray(it.modifierIds) ||
        it.modifierIds.some((id) => typeof id !== "string"))
    ) {
      return "invalid_modifier";
    }
    if (
      it.modifiers !== undefined &&
      it.modifiers !== null &&
      (!Array.isArray(it.modifiers) ||
        it.modifiers.some(
          (pick) =>
            typeof pick !== "string" &&
            (typeof pick !== "object" ||
              pick === null ||
              typeof pick.id !== "string"),
        ))
    ) {
      return "invalid_modifier";
    }
  }
  return null;
}

/**
 * The rows one menu-item resolution needs, read in one batch so a whole cart
 * costs a fixed number of queries rather than one round-trip per line.
 *
 * `links` and `groups` are loaded unconditionally — that is the fix for the
 * required-modifier bypass: the attachment map for *every* cart item is known
 * even when the request carries no modifier ids at all. Only the `modifiers`
 * read is skipped when no ids exist anywhere in the cart, because a modifier
 * row is only ever needed to price a submitted selection.
 */
interface MenuRuleRows {
  menuItemMap: Map<string, { name: string; price: string; isActive: boolean; categoryIsActive: boolean; taxRate: string; categoryId: string | null }>;
  groupsById: Map<string, { isActive: boolean; minSelect: number; maxSelect: number }>;
  linksByItem: Map<string, { groupId: string; minSelectOverride: number | null; maxSelectOverride: number | null; isActive: boolean }[]>;
  modifiersById: Map<string, SelectableModifier>;
}

async function loadMenuRuleRows(
  execute: <T extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>,
  locationId: string,
  menuItemIds: string[],
  modifierIds: string[],
): Promise<MenuRuleRows> {
  const { rows: menuItems } = await execute<{
    id: string;
    name: string;
    price: string;
    is_active: boolean;
    category_is_active: boolean | null;
    category_id: string | null;
    tax_rate: string;
  }>(
    `SELECT mi.id, mi.name, mi.price, mi.is_active, mi.category_id,
            mc.is_active AS category_is_active,
            COALESCE(mc.tax_rate, 0) AS tax_rate
       FROM menu_items mi LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE mi.location_id = $1 AND mi.id = ANY($2::uuid[])`,
    [locationId, menuItemIds],
  );
  const menuItemMap = new Map(
    menuItems.map((m) => [
      m.id,
      {
        name: m.name,
        price: m.price,
        isActive: m.is_active,
        categoryIsActive: m.category_is_active !== false,
        taxRate: m.tax_rate,
        categoryId: m.category_id,
      },
    ]),
  );

  // Always read the group defaults and the per-item attachments. Inactive
  // groups (migration 0165 lifecycle) are filtered out when the attachment
  // map is built — a disabled group must not appear in new-order selection,
  // while order history keeps its own snapshots untouched.
  const { rows: groups } = await execute<{
    id: string;
    is_active: boolean;
    min_select: number;
    max_select: number;
  }>(
    "SELECT id, is_active, min_select, max_select FROM modifier_groups WHERE location_id = $1",
    [locationId],
  );
  const groupsById = new Map(
    groups.map((g) => [
      g.id,
      { isActive: g.is_active, minSelect: g.min_select, maxSelect: g.max_select },
    ]),
  );

  const { rows: links } = await execute<{
    menu_item_id: string;
    modifier_group_id: string;
    min_select_override: number | null;
    max_select_override: number | null;
    is_active: boolean;
  }>(
    `SELECT menu_item_id, modifier_group_id, min_select_override, max_select_override, is_active
       FROM menu_item_modifier_groups WHERE menu_item_id = ANY($1::uuid[])`,
    [menuItemIds],
  );
  const linksByItem = new Map<
    string,
    { groupId: string; minSelectOverride: number | null; maxSelectOverride: number | null; isActive: boolean }[]
  >();
  for (const link of links) {
    if (!linksByItem.has(link.menu_item_id)) linksByItem.set(link.menu_item_id, []);
    linksByItem.get(link.menu_item_id)!.push({
      groupId: link.modifier_group_id,
      minSelectOverride: link.min_select_override,
      maxSelectOverride: link.max_select_override,
      isActive: link.is_active,
    });
  }

  const modifiersById = new Map<string, SelectableModifier>();
  if (modifierIds.length > 0) {
    const { rows: modifiers } = await execute<{
      id: string;
      group_id: string;
      name: string;
      price_delta: string;
      is_active: boolean;
    }>(
      "SELECT id, group_id, name, price_delta, is_active FROM modifiers WHERE location_id = $1 AND id = ANY($2::uuid[])",
      [locationId, modifierIds],
    );
    for (const m of modifiers) modifiersById.set(m.id, m);
  }

  return { menuItemMap, groupsById, linksByItem, modifiersById };
}

/**
 * Builds the per-item attachment map: every group actively attached to the
 * item (active link + active group), with bounds resolved item-override →
 * group default. Groups absent from this map are not offered to this item,
 * and a modifier from one of them is `invalid_modifier`.
 */
function attachedGroupsForItem(
  rows: Pick<MenuRuleRows, "groupsById" | "linksByItem">,
  menuItemId: string,
): Map<string, AttachedModifierGroup> {
  const attached = new Map<string, AttachedModifierGroup>();
  for (const link of rows.linksByItem.get(menuItemId) ?? []) {
    if (!link.isActive) continue;
    const group = rows.groupsById.get(link.groupId);
    if (!group || !group.isActive) continue;
    const bounds = effectiveSelectionBounds(
      { min: group.minSelect, max: group.maxSelect },
      link,
    );
    attached.set(link.groupId, {
      groupId: link.groupId,
      minSelect: bounds.min,
      maxSelect: bounds.max,
    });
  }
  return attached;
}

export async function resolveCartItems(
  locationId: string,
  items: CartItemInput[],
  client?: PoolClient,
): Promise<ResolveCartResult> {
  const execute = async <T extends Record<string, unknown>>(text: string, params?: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const menuItemIds = [...new Set(items.map((i) => i.menuItemId!))];
  const modifierIds = [
    ...new Set(
      items.flatMap((i) => [
        ...(i.modifierIds ?? []),
        ...(i.modifiers ?? []).map((pick) => (typeof pick === "string" ? pick : pick.id)),
      ]),
    ),
  ];

  const rows = await loadMenuRuleRows(execute, locationId, menuItemIds, modifierIds);

  // Availability is checked for every cart item up front, before any line is
  // priced: unknown or inactive items are `item_not_found`; an item whose
  // category is inactive is `item_not_available` — the POS hides inactive
  // categories, and the server must not sell what the menu does not show.
  // Historical orders are untouched: this runs only at intake.
  for (const id of menuItemIds) {
    const mi = rows.menuItemMap.get(id);
    if (!mi || !mi.isActive) return { ok: false, error: "item_not_found", status: 404 };
    if (!mi.categoryIsActive) return { ok: false, error: "item_not_available", status: 409 };
  }

  const cartLines: CartLine[] = [];
  const preparedItems: PreparedItem[] = [];

  for (const it of items) {
    const mi = rows.menuItemMap.get(it.menuItemId!)!;
    const quantity = Number(it.quantity);
    // One rule, shared with every other path (order-line-modifiers.ts): the
    // attachment map is always built for this item — modifiers or not — so
    // a required group cannot be skipped by submitting an empty selection.
    const selection = resolveModifierSelection({
      selection: [...(it.modifierIds ?? []), ...(it.modifiers ?? [])],
      modifiersById: rows.modifiersById,
      attachedGroups: attachedGroupsForItem(rows, it.menuItemId!),
    });
    if (!selection.ok) return selection;
    const { modifiers } = selection;

    cartLines.push({
      unitPrice: Number(mi.price),
      quantity,
      // A repeated add-on prices once per its own quantity: the deltas list
      // carries the add-on's delta N times, which is exactly what the pure
      // totals math already sums per unit of the line.
      modifierDeltas: modifiers.flatMap((m) => Array.from({ length: m.quantity }, () => m.priceDelta)),
      taxRatePercent: Number(mi.taxRate),
      // The promotion engine's scope axes (item/category targeting). Creation
      // must carry them or a scoped campaign can fire on an amendment but not
      // on the sale itself — the exact creation-vs-recompute divergence issue
      // #913 item 4 closes.
      id: it.menuItemId!,
      categoryId: mi.categoryId,
    });
    preparedItems.push({
      menuItemId: it.menuItemId!,
      name: mi.name,
      unitPrice: Number(mi.price),
      quantity,
      note: it.note?.trim() || null,
      modifiers,
    });
  }

  return { ok: true, cartLines, preparedItems };
}

export type ResolveLineModifiersResult =
  | { ok: true; modifiers: SelectedModifier[] }
  | { ok: false; error: string; status: number };

/**
 * Re-prices the add-ons of a single line that is already on an open order —
 * the counterpart of `resolveCartItems` for
 * PATCH /api/orders/[id]/items/[itemId], where the menu item is fixed and
 * only the selection changes.
 *
 * Runs the *same* rule against the *same* tables through the same loader, so
 * an add-on that could not have been chosen at intake cannot be bolted on
 * afterwards either, a required group cannot be un-answered by an edit, and
 * duplicate ids are rejected exactly as at intake.
 */
export async function resolveLineModifiers(
  locationId: string,
  menuItemId: string,
  modifiers: (ModifierPick | string)[],
  client?: PoolClient,
): Promise<ResolveLineModifiersResult> {
  const execute = async <T extends Record<string, unknown>>(text: string, params?: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  // When `client` is present this function is running inside a transaction on
  // one physical Postgres connection. Concurrent client.query() calls used to
  // be queued implicitly, but node-postgres 8.19 deprecates that behaviour and
  // pg 9 will throw. Await in order; callers without a client still use the
  // pool through execute(), but these small reads do not justify two
  // different code paths merely to parallelise them.
  const ids = modifiers.map((pick) => (typeof pick === "string" ? pick : pick.id));
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length) {
    return { ok: false, error: "duplicate_modifier", status: 400 };
  }

  const rows = await loadMenuRuleRows(execute, locationId, [menuItemId], uniqueIds);

  const item = rows.menuItemMap.get(menuItemId);
  if (!item || !item.isActive) {
    return { ok: false, error: "item_not_found", status: 404 };
  }

  return resolveModifierSelection({
    selection: modifiers,
    modifiersById: rows.modifiersById,
    attachedGroups: attachedGroupsForItem(rows, menuItemId),
  });
}
