import { describe, expect, it } from "vitest";
import {
  MAX_PICKER_TERMS,
  MAX_POST_CATEGORIES,
  normaliseTermIds,
  normaliseWpTerms,
  pluginSupportsPostTaxonomies,
  postTermsFromCapabilities,
  sameTermIds,
} from "./wp-content-taxonomies";

describe("normaliseWpTerms", () => {
  it("reads wp/v2 terms, in the order the site sent them", () => {
    expect(
      normaliseWpTerms([
        { id: 5, name: "  فرش  ", parent: 0, count: 12 },
        { id: "7", name: "پرده", count: "3" },
      ]),
    ).toEqual([
      { id: 5, name: "فرش", parent: 0, count: 12 },
      { id: 7, name: "پرده", parent: 0, count: 3 },
    ]);
  });

  it("drops junk instead of rendering a broken checkbox", () => {
    const terms = normaliseWpTerms([
      { id: 0, name: "صفر" },
      { id: -3, name: "منفی" },
      { id: 4, name: "   " },
      { id: 4.5, name: "اعشاری" },
      { name: "بدون شناسه" },
      null,
      "رشته",
      { id: 9, name: "درست" },
    ]);

    expect(terms).toEqual([{ id: 9, name: "درست", parent: 0, count: 0 }]);
  });

  it("keeps the first of two entries with the same id", () => {
    const terms = normaliseWpTerms([
      { id: 3, name: "اول", count: 5 },
      { id: 3, name: "دوم", count: 9 },
    ]);

    expect(terms).toHaveLength(1);
    expect(terms[0].name).toBe("اول");
  });

  it("bounds the list, because a site may have thousands of tags", () => {
    const many = Array.from({ length: MAX_PICKER_TERMS + 50 }, (_, index) => ({
      id: index + 1,
      name: `برچسب ${index + 1}`,
    }));

    expect(normaliseWpTerms(many)).toHaveLength(MAX_PICKER_TERMS);
    expect(normaliseWpTerms(many, 10)).toHaveLength(10);
    expect(normaliseWpTerms("not-a-list")).toEqual([]);
    expect(normaliseWpTerms(null)).toEqual([]);
  });
});

describe("plugin capabilities", () => {
  it("needs an explicit advertisement before offering the picker", () => {
    expect(pluginSupportsPostTaxonomies({ contentTaxonomies: true })).toBe(true);
    expect(pluginSupportsPostTaxonomies({ contentTaxonomies: "yes" })).toBe(false);
    expect(pluginSupportsPostTaxonomies({ jobTypes: ["post_upsert"] })).toBe(false);
    expect(pluginSupportsPostTaxonomies(null)).toBe(false);
  });

  it("reads the two reported lists separately", () => {
    const caps = {
      postCategories: [{ id: 2, name: "دستهٔ اصلی" }],
      postTags: [{ id: 8, name: "برچسب" }],
    };

    expect(postTermsFromCapabilities(caps, "category")).toEqual([
      { id: 2, name: "دستهٔ اصلی", parent: 0, count: 0 },
    ]);
    expect(postTermsFromCapabilities(caps, "post_tag")).toEqual([
      { id: 8, name: "برچسب", parent: 0, count: 0 },
    ]);
    expect(postTermsFromCapabilities(caps, "post_tag").length).toBe(1);
    expect(postTermsFromCapabilities(null, "category")).toEqual([]);
  });
});

describe("normaliseTermIds", () => {
  it("accepts a bounded list of positive integers", () => {
    expect(normaliseTermIds([3, 1, 3], MAX_POST_CATEGORIES)).toEqual({ ok: true, ids: [3, 1] });
    expect(normaliseTermIds([], MAX_POST_CATEGORIES)).toEqual({ ok: true, ids: [] });
    expect(normaliseTermIds(undefined, MAX_POST_CATEGORIES)).toEqual({ ok: true, ids: [] });
  });

  it("refuses a name, a fraction, a zero and an over-long list", () => {
    expect(normaliseTermIds(["فرش"], MAX_POST_CATEGORIES).ok).toBe(false);
    expect(normaliseTermIds([1.5], MAX_POST_CATEGORIES).ok).toBe(false);
    expect(normaliseTermIds([0], MAX_POST_CATEGORIES).ok).toBe(false);
    expect(normaliseTermIds("5", MAX_POST_CATEGORIES).ok).toBe(false);
    expect(normaliseTermIds(Array.from({ length: MAX_POST_CATEGORIES + 1 }, (_, index) => index + 1), MAX_POST_CATEGORIES).ok).toBe(false);
  });
});

describe("sameTermIds", () => {
  it("compares membership and order", () => {
    expect(sameTermIds([1, 2], [1, 2])).toBe(true);
    expect(sameTermIds([1, 2], [2, 1])).toBe(false);
    expect(sameTermIds([1], [1, 2])).toBe(false);
    expect(sameTermIds([], [])).toBe(true);
  });
});
