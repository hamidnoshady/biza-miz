import { describe, expect, it } from "vitest";
import {
  toggleTermId,
  wpEditorIsDirty,
  wpEditorPatch,
  wpTaxonomiesDirty,
  wpTaxonomyPatch,
  type WpEditorValues,
} from "./content-editor-state";

const ORIGINAL: WpEditorValues = {
  editorTitle: "عنوان اصلی",
  content: "<!-- wp:paragraph --><p>متن اصلی</p><!-- /wp:paragraph -->",
  excerpt: "خلاصه",
  slug: "original",
  status: "publish",
  scheduledFor: "",
};

describe("WordPress editor patch", () => {
  it("omits an unchanged body from a title-only edit", () => {
    expect(wpEditorPatch(ORIGINAL, { ...ORIGINAL, editorTitle: "عنوان تازه" })).toEqual({
      title: "عنوان تازه",
    });
  });

  it("includes an intentionally cleared body", () => {
    expect(wpEditorPatch(ORIGINAL, { ...ORIGINAL, content: "" })).toEqual({ content: "" });
  });

  it("maps every editor field to the wp/v2 field name", () => {
    expect(
      wpEditorPatch(ORIGINAL, {
        editorTitle: "تازه",
        content: "متن تازه",
        excerpt: "خلاصهٔ تازه",
        slug: "new-slug",
        status: "draft",
        scheduledFor: "",
      }),
    ).toEqual({
      title: "تازه",
      content: "متن تازه",
      excerpt: "خلاصهٔ تازه",
      slug: "new-slug",
      status: "draft",
    });
  });

  it("reports clean, dirty and not-yet-loaded states", () => {
    expect(wpEditorIsDirty(ORIGINAL, { ...ORIGINAL })).toBe(false);
    expect(wpEditorIsDirty(ORIGINAL, { ...ORIGINAL, slug: "changed" })).toBe(true);
    expect(wpEditorIsDirty(null, ORIGINAL)).toBe(false);
  });
});

describe("WordPress editor schedule", () => {
  const SCHEDULED: WpEditorValues = { ...ORIGINAL, status: "future", scheduledFor: "2026-11-10T05:30:00.000Z" };

  it("carries a chosen schedule as its own field, not as a wp/v2 date", () => {
    expect(wpEditorPatch(ORIGINAL, SCHEDULED)).toEqual({
      status: "future",
      scheduledFor: "2026-11-10T05:30:00.000Z",
    });
  });

  it("counts a date-only change as a real edit", () => {
    const later: WpEditorValues = { ...SCHEDULED, scheduledFor: "2026-12-01T06:00:00.000Z" };

    expect(wpEditorIsDirty(SCHEDULED, later)).toBe(true);
    expect(wpEditorPatch(SCHEDULED, later)).toEqual({ scheduledFor: "2026-12-01T06:00:00.000Z" });
  });
});
describe("WordPress editor taxonomy patch", () => {
  const EMPTY = { categories: [], tags: [] };

  it("sends only the list the owner changed", () => {
    expect(wpTaxonomyPatch(EMPTY, { categories: [3, 4], tags: [] })).toEqual({ categories: [3, 4] });
    expect(wpTaxonomyPatch({ categories: [3], tags: [9] }, { categories: [3], tags: [] })).toEqual({ tags: [] });
  });

  it("counts a term change as a real edit, and nothing else as an edit", () => {
    expect(wpTaxonomiesDirty(EMPTY, EMPTY)).toBe(false);
    expect(wpTaxonomiesDirty(EMPTY, { categories: [], tags: [5] })).toBe(true);
    expect(wpTaxonomiesDirty(null, { categories: [1], tags: [] })).toBe(false);
  });

  it("treats order as part of the selection, because WordPress shows it", () => {
    expect(wpTaxonomyPatch({ categories: [1, 2], tags: [] }, { categories: [2, 1], tags: [] })).toEqual({
      categories: [2, 1],
    });
  });

  it("toggles a term without disturbing the rest", () => {
    expect(toggleTermId([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleTermId([1, 2, 3], 2)).toEqual([1, 3]);
    expect(toggleTermId([], 7)).toEqual([7]);
  });
});
