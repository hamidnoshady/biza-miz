/** Pure Accounting-menu → website projection. No DB, HTTP or CMS-shaped data. */
import {
  effectiveBounds,
  type RestaurantMenuCategory,
  type RestaurantMenuItem,
  type RestaurantItemModifierGroup,
  type RestaurantModifier,
  type RestaurantModifierGroup,
} from "../restaurant-menu";
import type { DesiredProductState, WebsiteLocalProduct } from "./sync";

export interface MenuProjectionInput {
  item: RestaurantMenuItem;
  category: RestaurantMenuCategory | null;
  groups: RestaurantModifierGroup[];
  links: RestaurantItemModifierGroup[];
  modifiers: RestaurantModifier[];
}

/**
 * Keep inactive groups/options in the projection with their lifecycle flag:
 * the storefront can hide them while historical order snapshots keep their
 * identities. The item's attachment order wins over a group's global order.
 */
export function projectMenuItem(input: MenuProjectionInput): {
  product: WebsiteLocalProduct;
  desired: DesiredProductState;
} | null {
  const { item, category } = input;
  const groupsById = new Map(input.groups.map((group) => [group.id, group]));
  const links = input.links
    .filter((link) => link.menuItemId === item.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.modifierGroupId.localeCompare(b.modifierGroupId));
  const modifierGroups = links.flatMap((link) => {
    const group = groupsById.get(link.modifierGroupId);
    if (!group) return [];
    const bounds = effectiveBounds(group, link);
    const options = input.modifiers
      .filter((option) => option.groupId === group.id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fa"))
      .map((option) => ({
        sourceId: option.id,
        label: option.name,
        priceDeltaRial: option.priceDelta,
        isActive: option.isActive,
        sortOrder: option.sortOrder,
      }));
    return [{
      sourceId: group.id,
      label: group.name,
      ...bounds,
      isActive: group.isActive && link.isActive,
      sortOrder: link.sortOrder,
      options,
    }];
  });
  return {
    product: {
      name: item.name,
      sku: item.sku,
      description: item.description,
      imageMediaId: item.imageMediaId,
      imageUrl: item.imageUrl,
      sortOrder: item.sortOrder,
      category: category ? {
        sourceId: category.id,
        name: category.name,
        description: category.description ?? null,
        sortOrder: category.sortOrder,
      } : null,
      modifierGroups,
    },
    desired: {
      priceRial: item.price,
      stock: null,
      published: true,
      available: item.isActive && category?.isActive === true,
    },
  };
}

/** Stable diff key. Price and stock have their own switches and map columns. */
export function menuProjectionKey(product: WebsiteLocalProduct, desired: DesiredProductState): string {
  return JSON.stringify({
    name: product.name,
    sku: product.sku ?? null,
    description: product.description ?? null,
    imageMediaId: product.imageMediaId ?? null,
    imageUrl: product.imageMediaId ? null : product.imageUrl ?? null,
    sortOrder: product.sortOrder ?? 0,
    category: product.category ?? null,
    modifierGroups: (product.modifierGroups ?? []).map((group) => ({
      sourceId: group.sourceId,
      label: group.label,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      isActive: group.isActive,
      sortOrder: group.sortOrder,
      options: group.options.map((option) => ({
        sourceId: option.sourceId,
        label: option.label,
        priceDeltaRial: option.priceDeltaRial,
        isActive: option.isActive,
        sortOrder: option.sortOrder,
      })),
    })),
    published: desired.published ?? true,
    available: desired.available ?? true,
  });
}
