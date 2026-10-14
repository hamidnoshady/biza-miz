/**
 * Data Transfer ↔ menu-domain parity (issue #844): before the legacy importer
 * retired, the transfer engine had to carry everything it did — item images
 * and target margin, and the item↔modifier-group attachments with their
 * per-item bounds, order and link state.
 *
 * Registry-level only: the adapter contract itself (domain validators, not
 * raw SQL) is asserted by the integration suite, which needs the database
 * module. These checks run on every `npm test`.
 */
import { describe, expect, it } from "vitest";
import { findEntity, requireEntity } from "./registry";

describe("pos.products parity fields", () => {
  const entity = requireEntity("pos.products");

  it("carries the image and margin metadata the menu CRUD owns", () => {
    for (const key of ["imageUrl", "imageMediaId", "targetMarginPercent"]) {
      const field = entity.fields.find((candidate) => candidate.key === key);
      expect(field, `pos.products is missing ${key}`).toBeTruthy();
    }
  });

  it("keeps duplicate identity deterministic — SKU first, then name+category", () => {
    const rules = (entity.duplicateRules ?? []).map((rule) => rule.key);
    expect(rules[0]).toBe("sku");
    expect(rules).toContain("name_category");
  });
});

describe("pos.item_modifier_groups parity entity", () => {
  const entity = requireEntity("pos.item_modifier_groups");

  it("exists, in the menu module, gated by the menu's own capabilities", () => {
    expect(entity.module).toBe("pos");
    expect(entity.importPermission).toBe("menu.edit");
    expect(entity.exportPermission).toBe("menu.view");
    expect(entity.locationScoped).toBe(true);
  });

  it("carries the per-item attachment facts a flat export lost", () => {
    const keys = entity.fields.map((field) => field.key);
    for (const key of [
      "itemName",
      "itemSku",
      "groupName",
      "minSelectOverride",
      "maxSelectOverride",
      "sortOrder",
      "isActive",
    ]) {
      expect(keys, `pos.item_modifier_groups is missing ${key}`).toContain(key);
    }
  });

  it("de-duplicates on the (item, group) pair", () => {
    expect(entity.duplicateRules ?? []).toEqual([
      expect.objectContaining({ key: "item_group", fields: ["itemName", "groupName"] }),
    ]);
  });

  it("is discoverable like every other entity", () => {
    expect(findEntity("pos.item_modifier_groups")).toBe(entity);
    expect(findEntity("pos.item-modifier-groups")).toBeNull();
  });
});
