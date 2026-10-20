/**
 * The canonical restaurant menu model — one definition of the menu the POS,
 * the waiter screen, the menu manager and the tests all consume.
 *
 * Until now each screen redeclared its own slice of `/api/menu`'s payload
 * (the cashier's `Item` had no sku, the waiter's had no image, the manager's
 * had no bounds overrides), which is how they drifted: the POS could not
 * search a SKU it never loaded, and the waiter could not show an image it
 * never asked for. The wire format stays exactly what `/api/menu` has always
 * returned (snake_case, plus the new columns 0165 added) so old clients and
 * offline installs keep working; `toRestaurantMenu` is the one place that
 * converts it.
 *
 * Framework-free (no db, no next) so client components, Edge code and unit
 * tests import it directly.
 */

export interface RestaurantMenuCategory {
  id: string;
  name: string;
  taxRate: number;
  isActive: boolean;
  sortOrder: number;
}

export interface RestaurantMenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  /** The item code the till can search by. Not required — many cafés never set one. */
  sku: string | null;
  /** Integer Rial. */
  price: number;
  /** Legacy pre-media-library image URL — kept as a fallback for old installations. */
  imageUrl: string | null;
  /** Canonical catalogue photo: a media_assets id (migration 0149). */
  imageMediaId: string | null;
  isActive: boolean;
  sortOrder: number;
  targetMarginPercent: number | null;
}

export interface RestaurantModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  /** 0165 lifecycle: a disabled group is kept but never offered on new orders. */
  isActive: boolean;
  sortOrder: number;
}

export interface RestaurantModifier {
  id: string;
  groupId: string;
  name: string;
  /** Integer Rial, may be negative. */
  priceDelta: number;
  isActive: boolean;
  sortOrder: number;
}

export interface RestaurantItemModifierGroup {
  menuItemId: string;
  modifierGroupId: string;
  minSelectOverride: number | null;
  maxSelectOverride: number | null;
  sortOrder: number;
  /** 0165: an attachment can be turned off per item without detaching it. */
  isActive: boolean;
}

export interface RestaurantMenuData {
  categories: RestaurantMenuCategory[];
  items: RestaurantMenuItem[];
  modifierGroups: RestaurantModifierGroup[];
  modifiers: RestaurantModifier[];
  itemModifierGroups: RestaurantItemModifierGroup[];
}

/** The snake_case rows `/api/menu` (getMenuTree) returns. */
export interface MenuTreePayload {
  categories: Array<{
    id: string;
    name: string;
    tax_rate: string | number;
    sort_order: number;
    is_active: boolean;
  }>;
  items: Array<{
    id: string;
    category_id: string | null;
    name: string;
    description: string | null;
    sku: string | null;
    price: string | number;
    image_url: string | null;
    image_media_id: string | null;
    sort_order: number;
    is_active: boolean;
    target_margin_percent: string | number | null;
  }>;
  modifierGroups: Array<{
    id: string;
    name: string;
    min_select: number;
    max_select: number;
    is_active: boolean;
    sort_order: number;
  }>;
  modifiers: Array<{
    id: string;
    group_id: string;
    name: string;
    price_delta: string | number;
    sort_order: number;
    is_active: boolean;
  }>;
  itemModifierGroups: Array<{
    menu_item_id: string;
    modifier_group_id: string;
    min_select_override: number | null;
    max_select_override: number | null;
    sort_order: number;
    is_active: boolean;
  }>;
}

const toNumber = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/** Converts the API wire payload into the canonical model. Pure. */
export function toRestaurantMenu(payload: MenuTreePayload): RestaurantMenuData {
  return {
    categories: payload.categories.map((c) => ({
      id: c.id,
      name: c.name,
      taxRate: toNumber(c.tax_rate),
      isActive: c.is_active,
      sortOrder: c.sort_order,
    })),
    items: payload.items.map((i) => ({
      id: i.id,
      categoryId: i.category_id,
      name: i.name,
      description: i.description,
      sku: i.sku,
      price: toNumber(i.price),
      imageUrl: i.image_url,
      imageMediaId: i.image_media_id,
      isActive: i.is_active,
      sortOrder: i.sort_order,
      targetMarginPercent:
        i.target_margin_percent === null || i.target_margin_percent === undefined
          ? null
          : Number(i.target_margin_percent),
    })),
    modifierGroups: payload.modifierGroups.map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.min_select,
      maxSelect: g.max_select,
      isActive: g.is_active,
      sortOrder: g.sort_order,
    })),
    modifiers: payload.modifiers.map((m) => ({
      id: m.id,
      groupId: m.group_id,
      name: m.name,
      priceDelta: toNumber(m.price_delta),
      isActive: m.is_active,
      sortOrder: m.sort_order,
    })),
    itemModifierGroups: payload.itemModifierGroups.map((l) => ({
      menuItemId: l.menu_item_id,
      modifierGroupId: l.modifier_group_id,
      minSelectOverride: l.min_select_override,
      maxSelectOverride: l.max_select_override,
      sortOrder: l.sort_order,
      isActive: l.is_active,
    })),
  };
}

/**
 * A modifier group as one menu item offers it: the group's defaults resolved
 * through the item's own overrides, plus the group's active options in the
 * order the kitchen expects them listed.
 */
export interface RestaurantGroupView {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: RestaurantModifier[];
}

/** item-override → group default, the one resolution rule (mirrors the server's). */
export function effectiveBounds(
  group: Pick<RestaurantModifierGroup, "minSelect" | "maxSelect">,
  link: Pick<RestaurantItemModifierGroup, "minSelectOverride" | "maxSelectOverride"> | undefined,
): { minSelect: number; maxSelect: number } {
  return {
    minSelect: link?.minSelectOverride ?? group.minSelect,
    maxSelect: link?.maxSelectOverride ?? group.maxSelect,
  };
}

/**
 * The lookup maps a selling surface needs, built once per menu load instead
 * of O(items × groups × modifiers) inside every render/keystroke:
 *
 *   itemsById / categoriesById / groupsById  — id → row
 *   activeCategories                          — active, in sort order
 *   itemsByCategory                           — active items grouped by category
 *   groupsByItem                              — active groups actively attached
 *                                               to an item, with effective bounds,
 *                                               in the item's own link order
 *   modifiersByGroup                          — active options per group, sorted
 *   requiresConfigurationByItem               — any attached group with minSelect > 0
 */
export interface RestaurantMenuIndex {
  categoriesById: Map<string, RestaurantMenuCategory>;
  itemsById: Map<string, RestaurantMenuItem>;
  groupsById: Map<string, RestaurantModifierGroup>;
  activeCategories: RestaurantMenuCategory[];
  itemsByCategory: Map<string, RestaurantMenuItem[]>;
  groupsByItem: Map<string, RestaurantGroupView[]>;
  modifiersByGroup: Map<string, RestaurantModifier[]>;
  requiresConfigurationByItem: Map<string, boolean>;
}

export function buildRestaurantMenuIndex(
  menu: RestaurantMenuData,
): RestaurantMenuIndex {
  const categoriesById = new Map(menu.categories.map((c) => [c.id, c]));
  const itemsById = new Map(menu.items.map((i) => [i.id, i]));
  const groupsById = new Map(menu.modifierGroups.map((g) => [g.id, g]));
  const activeCategories = menu.categories
    .filter((c) => c.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fa"));

  // Items keep their stored order (sort_order, then name as the stable
  // secondary key) — the same order the manager and the offline snapshot use.
  const sortedItems = [...menu.items].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fa"),
  );
  const itemsByCategory = new Map<string, RestaurantMenuItem[]>();
  for (const item of sortedItems) {
    if (!item.categoryId || !item.isActive) continue;
    const list = itemsByCategory.get(item.categoryId);
    if (list) list.push(item);
    else itemsByCategory.set(item.categoryId, [item]);
  }

  const modifiersByGroup = new Map<string, RestaurantModifier[]>();
  for (const modifier of [...menu.modifiers].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fa"),
  )) {
    if (!modifier.isActive) continue;
    const list = modifiersByGroup.get(modifier.groupId);
    if (list) list.push(modifier);
    else modifiersByGroup.set(modifier.groupId, [modifier]);
  }

  // Links grouped per item — several links may exist per item, so collect
  // first, then resolve each against its group once.
  const linksByItem = new Map<string, RestaurantItemModifierGroup[]>();
  for (const link of menu.itemModifierGroups) {
    const list = linksByItem.get(link.menuItemId);
    if (list) list.push(link);
    else linksByItem.set(link.menuItemId, [link]);
  }

  const groupsByItem = new Map<string, RestaurantGroupView[]>();
  const requiresConfigurationByItem = new Map<string, boolean>();
  for (const [itemId, links] of linksByItem) {
    const attached: RestaurantGroupView[] = [];
    for (const link of [...links].sort((a, b) => a.sortOrder - b.sortOrder)) {
      if (!link.isActive) continue;
      const group = groupsById.get(link.modifierGroupId);
      if (!group || !group.isActive) continue;
      const bounds = effectiveBounds(group, link);
      attached.push({
        id: group.id,
        name: group.name,
        minSelect: bounds.minSelect,
        maxSelect: bounds.maxSelect,
        modifiers: modifiersByGroup.get(group.id) ?? [],
      });
    }
    // The item's OWN attachment order wins. The editor shows (and the
    // reorder route stores) `menu_item_modifier_groups.sort_order`, and the
    // cashier must see the groups in that order. Re-sorting `attached` by the
    // group's global sort_order — as this used to — silently discarded the
    // per-item sequence and made the editor's arrows a lie.
    groupsByItem.set(itemId, attached);
    requiresConfigurationByItem.set(
      itemId,
      attached.some((group) => group.minSelect > 0),
    );
  }

  return {
    categoriesById,
    itemsById,
    groupsById,
    activeCategories,
    itemsByCategory,
    groupsByItem,
    modifiersByGroup,
    requiresConfigurationByItem,
  };
}

/**
 * A menu item's catalogue image: the canonical media asset when one is set,
 * the legacy URL as a compatibility fallback for installations whose photos
 * predate the library, and null when there is nothing to show. One function
 * so the POS tile, the waiter card and the manager row can never disagree
 * about which of the two systems a given item renders from.
 */
export function catalogueImage(
  item: Pick<RestaurantMenuItem, "imageMediaId" | "imageUrl">,
): { mediaId: string | null; url: string | null } {
  return {
    mediaId: item.imageMediaId ?? null,
    url: item.imageMediaId ? null : item.imageUrl ?? null,
  };
}
