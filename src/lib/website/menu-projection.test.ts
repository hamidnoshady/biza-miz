import { describe, expect, it } from "vitest";
import type { RestaurantMenuCategory, RestaurantMenuItem } from "../restaurant-menu";
import { menuProjectionKey, projectMenuItem, type MenuProjectionInput } from "./menu-projection";

const category: RestaurantMenuCategory = {
  id: "category-1", name: "قهوه", description: "نوشیدنی گرم", taxRate: 0, isActive: true, sortOrder: 3,
};
const item: RestaurantMenuItem = {
  id: "item-1", categoryId: category.id, name: "لاته", description: "با شیر تازه", sku: "LAT-1",
  price: 1_200_000, imageUrl: "https://images.example.test/old.jpg", imageMediaId: "media-1",
  isActive: true, sortOrder: 7, targetMarginPercent: null,
};
const input: MenuProjectionInput = {
  item,
  category,
  groups: [
    { id: "group-2", name: "شیر", minSelect: 0, maxSelect: 3, isActive: true, sortOrder: 0 },
    { id: "group-1", name: "افزودنی", minSelect: 1, maxSelect: 2, isActive: true, sortOrder: 9 },
  ],
  links: [
    { menuItemId: item.id, modifierGroupId: "group-1", minSelectOverride: 0, maxSelectOverride: 1, sortOrder: 0, isActive: true },
    { menuItemId: item.id, modifierGroupId: "group-2", minSelectOverride: null, maxSelectOverride: null, sortOrder: 1, isActive: false },
    { menuItemId: "another-item", modifierGroupId: "group-1", minSelectOverride: null, maxSelectOverride: null, sortOrder: 0, isActive: true },
  ],
  modifiers: [
    { id: "option-2", groupId: "group-1", name: "شات اضافه", priceDelta: 300_000, isActive: true, sortOrder: 1 },
    { id: "option-1", groupId: "group-1", name: "بدون شکر", priceDelta: -10_000, isActive: false, sortOrder: 0 },
    { id: "option-3", groupId: "group-2", name: "شیر بادام", priceDelta: 250_000, isActive: true, sortOrder: 0 },
  ],
};

describe("ESH-145 — Accounting menu projection", () => {
  it("projects category identity/description/order and the canonical media precedence", () => {
    const projected = projectMenuItem(input)!;
    expect(projected.product).toMatchObject({
      name: "لاته", description: "با شیر تازه", sku: "LAT-1", sortOrder: 7,
      imageMediaId: "media-1",
      category: { sourceId: "category-1", name: "قهوه", description: "نوشیدنی گرم", sortOrder: 3 },
    });
    expect(projected.desired).toMatchObject({ priceRial: 1_200_000, stock: null, available: true });
    expect(menuProjectionKey(projected.product, projected.desired)).not.toContain("old.jpg");
  });

  it("uses attachment order and effective bounds, retaining inactive groups/options with their source ids", () => {
    const groups = projectMenuItem(input)!.product.modifierGroups!;
    expect(groups.map((group) => group.sourceId)).toEqual(["group-1", "group-2"]);
    expect(groups[0]).toMatchObject({ minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    expect(groups[0].options.map((option) => [option.sourceId, option.priceDeltaRial, option.isActive]))
      .toEqual([["option-1", -10_000, false], ["option-2", 300_000, true]]);
    expect(groups[1]).toMatchObject({ minSelect: 0, maxSelect: 3, sortOrder: 1, isActive: false });
    expect(groups[1].options[0].sourceId).toBe("option-3");
  });

  it("makes an inactive item or category unavailable without deleting its projection", () => {
    expect(projectMenuItem({ ...input, item: { ...item, isActive: false } })!.desired.available).toBe(false);
    expect(projectMenuItem({ ...input, category: { ...category, isActive: false } })!.desired.available).toBe(false);
    expect(projectMenuItem({ ...input, category: null })!.desired.available).toBe(false);
  });

  it("diffs content independently of price/stock and notices every menu content field", () => {
    const base = projectMenuItem(input)!;
    const key = menuProjectionKey(base.product, base.desired);
    expect(menuProjectionKey(base.product, { ...base.desired, priceRial: 9, stock: 0 })).toBe(key);
    const changed = structuredClone(input);
    changed.modifiers[0].priceDelta += 1;
    const next = projectMenuItem(changed)!;
    expect(menuProjectionKey(next.product, next.desired)).not.toBe(key);
    expect(menuProjectionKey({ ...base.product, imageUrl: "https://images.example.test/new.jpg" }, base.desired)).toBe(key);
    expect(menuProjectionKey({ ...base.product, imageMediaId: null }, base.desired)).not.toBe(key);
  });
});
