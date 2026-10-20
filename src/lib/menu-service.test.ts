import { describe, expect, it } from "vitest";

/**
 * Issue #911 — how one item patch is recorded.
 *
 * Price changes already had their own event and their own append-only
 * history; everything else an operator does to an item did not. The risk of
 * adding the missing lifecycle rows is the opposite one — recording the same
 * write twice, or filing a price change under two events. So the rule is:
 * one event per write, named by the most consequential thing it does, with
 * price never among the recorded fields (it has its own row).
 *
 * Pure, and asserted here rather than only against a database.
 */
import { auditActionForPatch, changedFields } from "./menu-service";

const ACTIVE = { category_id: "cat-a", is_active: true };

describe("menu item lifecycle audit", () => {
  it("names the most consequential change in a patch, once", () => {
    // Selling on/off decides whether the till can sell the item at all.
    expect(auditActionForPatch({ isActive: false }, ACTIVE)).toBe("menu.item.deactivated");
    expect(auditActionForPatch({ isActive: true }, { ...ACTIVE, is_active: false })).toBe(
      "menu.item.activated",
    );
    // Then a move to a *different* category …
    expect(auditActionForPatch({ categoryId: "cat-b" }, ACTIVE)).toBe("menu.item.moved");
    // … and anything else is an edit.
    expect(auditActionForPatch({ name: "لاتهٔ کارامل" }, ACTIVE)).toBe("menu.item.updated");
    expect(auditActionForPatch({ sku: "LAT-01" }, ACTIVE)).toBe("menu.item.updated");
  });

  it("does not call a re-statement of the current state a change", () => {
    expect(auditActionForPatch({ isActive: true }, ACTIVE)).toBe("menu.item.updated");
    expect(auditActionForPatch({ categoryId: "cat-a" }, ACTIVE)).toBe("menu.item.updated");
  });

  it("leaves price out of the recorded fields — it has its own history row", () => {
    expect(changedFields({ price: 500_000 })).toEqual([]);
    expect(changedFields({ price: 500_000, name: "لاته" })).toEqual(["name"]);
  });

  it("lists exactly the fields a patch changes", () => {
    expect(
      changedFields({
        name: "لاته",
        categoryId: "cat-b",
        description: null,
        sku: null,
        imageMediaId: null,
        isActive: false,
        targetMarginPercent: 65,
      }).sort(),
    ).toEqual(
      [
        "categoryId",
        "description",
        "imageMediaId",
        "isActive",
        "name",
        "sku",
        "targetMarginPercent",
      ].sort(),
    );
    expect(changedFields({})).toEqual([]);
  });
});
