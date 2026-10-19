import { describe, expect, it } from "vitest";
import {
  buildRestaurantMenuIndex,
  effectiveBounds,
  toRestaurantMenu,
  type RestaurantMenuData,
} from "./restaurant-menu";

function menu(overrides: Partial<RestaurantMenuData> = {}): RestaurantMenuData {
  return {
    categories: [],
    items: [],
    modifierGroups: [],
    modifiers: [],
    itemModifierGroups: [],
    ...overrides,
  };
}

describe("effectiveBounds", () => {
  it("prefers the item's override over the group default", () => {
    expect(
      effectiveBounds(
        { minSelect: 0, maxSelect: 3 },
        { minSelectOverride: 1, maxSelectOverride: 2 },
      ),
    ).toEqual({ minSelect: 1, maxSelect: 2 });
  });

  it("falls back to the group default for a blank override", () => {
    expect(
      effectiveBounds(
        { minSelect: 1, maxSelect: 1 },
        { minSelectOverride: null, maxSelectOverride: null },
      ),
    ).toEqual({ minSelect: 1, maxSelect: 1 });
  });
});

describe("buildRestaurantMenuIndex — group order", () => {
  it("keeps the item's OWN attachment order over the group's global order", () => {
    const data = menu({
      modifierGroups: [
        { id: "g-size", name: "اندازه", minSelect: 0, maxSelect: 1, isActive: true, sortOrder: 0 },
        { id: "g-milk", name: "شیر", minSelect: 0, maxSelect: 1, isActive: true, sortOrder: 1 },
        { id: "g-extra", name: "افزودنی", minSelect: 0, maxSelect: 3, isActive: true, sortOrder: 2 },
      ],
      modifiers: [
        { id: "m1", groupId: "g-size", name: "بزرگ", priceDelta: 0, isActive: true, sortOrder: 0 },
        { id: "m2", groupId: "g-milk", name: "بادام", priceDelta: 0, isActive: true, sortOrder: 0 },
        { id: "m3", groupId: "g-extra", name: "شات", priceDelta: 0, isActive: true, sortOrder: 0 },
      ],
      items: [
        {
          id: "i1",
          categoryId: null,
          name: "لاته",
          description: null,
          sku: null,
          price: 100_000,
          imageUrl: null,
          imageMediaId: null,
          isActive: true,
          sortOrder: 0,
          targetMarginPercent: null,
        },
      ],
      // The editor stored this item's links as: extras, size, milk.
      itemModifierGroups: [
        { menuItemId: "i1", modifierGroupId: "g-extra", minSelectOverride: null, maxSelectOverride: null, sortOrder: 0, isActive: true },
        { menuItemId: "i1", modifierGroupId: "g-size", minSelectOverride: null, maxSelectOverride: null, sortOrder: 1, isActive: true },
        { menuItemId: "i1", modifierGroupId: "g-milk", minSelectOverride: null, maxSelectOverride: null, sortOrder: 2, isActive: true },
      ],
    });

    const index = buildRestaurantMenuIndex(data);
    expect(index.groupsByItem.get("i1")?.map((group) => group.id)).toEqual([
      "g-extra",
      "g-size",
      "g-milk",
    ]);
  });

  it("skips an inactive attachment, an inactive group and an inactive option", () => {
    const data = menu({
      modifierGroups: [
        { id: "on", name: "فعال", minSelect: 0, maxSelect: 2, isActive: true, sortOrder: 0 },
        { id: "off", name: "غیرفعال", minSelect: 0, maxSelect: 2, isActive: false, sortOrder: 1 },
      ],
      modifiers: [
        { id: "a", groupId: "on", name: "الف", priceDelta: 0, isActive: true, sortOrder: 0 },
        { id: "b", groupId: "on", name: "ب", priceDelta: 0, isActive: false, sortOrder: 1 },
        { id: "c", groupId: "off", name: "ج", priceDelta: 0, isActive: true, sortOrder: 0 },
      ],
      itemModifierGroups: [
        { menuItemId: "i1", modifierGroupId: "on", minSelectOverride: null, maxSelectOverride: null, sortOrder: 0, isActive: true },
        { menuItemId: "i1", modifierGroupId: "off", minSelectOverride: null, maxSelectOverride: null, sortOrder: 1, isActive: true },
      ],
    });

    const index = buildRestaurantMenuIndex(data);
    expect(index.groupsByItem.get("i1")?.map((group) => group.id)).toEqual(["on"]);
    expect(index.groupsByItem.get("i1")?.[0].modifiers.map((modifier) => modifier.id)).toEqual(["a"]);
  });

  it("resolves a per-item override before requiring a choice", () => {
    const data = menu({
      modifierGroups: [
        { id: "g", name: "شیر", minSelect: 0, maxSelect: 1, isActive: true, sortOrder: 0 },
      ],
      itemModifierGroups: [
        { menuItemId: "i1", modifierGroupId: "g", minSelectOverride: 1, maxSelectOverride: 1, sortOrder: 0, isActive: true },
      ],
    });

    const index = buildRestaurantMenuIndex(data);
    expect(index.requiresConfigurationByItem.get("i1")).toBe(true);
    expect(index.groupsByItem.get("i1")?.[0]).toMatchObject({ minSelect: 1, maxSelect: 1 });
  });
});

describe("toRestaurantMenu", () => {
  it("converts snake_case rows once, numbers included", () => {
    const converted = toRestaurantMenu({
      categories: [{ id: "c", name: "نوشیدنی", tax_rate: "9", sort_order: 1, is_active: true }],
      items: [
        {
          id: "i",
          category_id: "c",
          name: "لاته",
          description: null,
          sku: "LAT",
          price: "120000",
          image_url: null,
          image_media_id: null,
          sort_order: 2,
          is_active: true,
          target_margin_percent: "35",
        },
      ],
      modifierGroups: [{ id: "g", name: "شیر", min_select: 0, max_select: 1, is_active: true, sort_order: 0 }],
      modifiers: [{ id: "m", group_id: "g", name: "بادام", price_delta: "-5000", sort_order: 0, is_active: true }],
      itemModifierGroups: [
        {
          menu_item_id: "i",
          modifier_group_id: "g",
          min_select_override: null,
          max_select_override: null,
          sort_order: 0,
          is_active: true,
        },
      ],
    });

    expect(converted.categories[0].taxRate).toBe(9);
    expect(converted.items[0].price).toBe(120_000);
    expect(converted.items[0].targetMarginPercent).toBe(35);
    expect(converted.modifiers[0].priceDelta).toBe(-5_000);
  });
});
