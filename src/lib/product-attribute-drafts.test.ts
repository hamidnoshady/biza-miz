import { describe, expect, it } from "vitest";
import {
  draftAttributeReconciliationIssues,
  migrateDraftAttributeValues,
  snapshotAttributeDefinitions,
  type AttributeDefinitionView,
} from "./product-attribute-drafts";

const colour: AttributeDefinitionView = {
  id: "2f95f2dc-e945-4dcc-97a2-a2f8b8a59f38",
  name: "رنگ",
  options: ["قرمز", "آبی"],
  isActive: true,
};

const size: AttributeDefinitionView = {
  id: "e30f2059-7f8a-4f15-b8c2-c988d3e55930",
  name: "سایز",
  options: ["کوچک", "بزرگ"],
  isActive: true,
};

describe("product-attribute-drafts", () => {
  it("migrates legacy name-keyed values by Persian-aware unique name without losing unmatched values", () => {
    const migrated = migrateDraftAttributeValues([
      { id: "variant-1", values: { "رنگ": "قرمز", "نام قدیمی": "مقدار تاریخی" } },
    ], [colour]);

    expect(migrated[0].values).toEqual({ [colour.id]: "قرمز" });
    expect(migrated[0].unresolvedValues).toEqual({ "نام قدیمی": "مقدار تاریخی" });
  });

  it("does not guess when normalized definition names are ambiguous", () => {
    const duplicateName = { ...colour, id: "b9ed0e20-6a95-40dd-a176-d770c05f0e84", name: "رنگ" };
    const migrated = migrateDraftAttributeValues([
      { id: "variant-1", values: { "رنگ": "قرمز" } },
    ], [colour, duplicateName]);

    expect(migrated[0].values).toEqual({});
    expect(migrated[0].unresolvedValues).toEqual({ "رنگ": "قرمز" });
  });

  it("preserves ID-keyed drafts and reports renamed/changed schemas and removed options", () => {
    const oldSnapshot = snapshotAttributeDefinitions([colour]);
    const current = { ...colour, name: "طیف رنگ", options: ["سبز", "آبی"] };
    const issues = draftAttributeReconciliationIssues([
      { id: "variant-1", values: { [colour.id]: "قرمز", [size.id]: "بزرگ" } },
    ], oldSnapshot, [current, size]);

    expect(issues.map((issue) => [issue.reason, issue.previousName, issue.currentName])).toEqual([
      ["schema_changed", "رنگ", "طیف رنگ"],
      ["option_removed", "رنگ", "طیف رنگ"],
    ]);
  });

  it("flags deleted, inactive, and legacy-unmapped values rather than silently filtering them", () => {
    const deletedId = "43a5b29a-8456-438d-9bb4-56aab27bd42e";
    const issues = draftAttributeReconciliationIssues([
      {
        id: "variant-1",
        values: { [deletedId]: "تاریخی", [colour.id]: "قرمز" },
        unresolvedValues: { "رنگ پیشین": "آبی" },
      },
    ], { [deletedId]: { name: "فصل", options: ["زمستان"], isActive: true }, ...snapshotAttributeDefinitions([colour]) }, [
      { ...colour, isActive: false },
    ]);

    expect(issues.map((issue) => issue.reason)).toEqual([
      "definition_removed",
      "definition_inactive",
      "unmapped_legacy_value",
    ]);
  });

  it("treats option reordering as presentation-only, not schema invalidation", () => {
    const issues = draftAttributeReconciliationIssues([
      { id: "variant-1", values: { [colour.id]: "قرمز" } },
    ], snapshotAttributeDefinitions([colour]), [{ ...colour, options: [...colour.options].reverse() }]);

    expect(issues).toEqual([]);
  });
});
