import { describe, expect, it } from "vitest";
import {
  PUBLICATION_RULE_COPY,
  TOROB_PRODUCT_PAGE_SIZE,
  TOROB_SELECTION_BATCH_LIMIT,
  clampPage,
  isPublishedByRule,
  nextDecision,
  publicationSummary,
} from "./publication";

/**
 * Issue #894 Wave 4 — the two publication rules, and the click that edits them.
 *
 * This is the one place where "everything except these" and "only these" have to
 * mean exactly the same thing about a product nobody touched, because that
 * product is the majority of every catalogue. If the two rules disagree there, a
 * merchant switches rule and silently loses — or gains — their whole catalogue.
 */

describe("the rules", () => {
  it("publishes an untouched product under «همه» and not under «فقط انتخابی»", () => {
    expect(isPublishedByRule({ rule: "all", decision: null })).toBe(true);
    expect(isPublishedByRule({ rule: "all", decision: undefined })).toBe(true);
    expect(isPublishedByRule({ rule: "selected", decision: null })).toBe(false);
    expect(isPublishedByRule({ rule: "selected", decision: undefined })).toBe(false);
  });

  it("honours the merchant's own decision under both rules", () => {
    // An exclusion survives a switch to «selected», and an inclusion survives a
    // switch back: the decision is stored once and read by whichever rule owns it.
    expect(isPublishedByRule({ rule: "all", decision: "exclude" })).toBe(false);
    expect(isPublishedByRule({ rule: "all", decision: "include" })).toBe(true);
    expect(isPublishedByRule({ rule: "selected", decision: "include" })).toBe(true);
    expect(isPublishedByRule({ rule: "selected", decision: "exclude" })).toBe(false);
  });
});

describe("the click", () => {
  it("cycles untouched → included → excluded → untouched", () => {
    // The third state is what makes the button reversible: clearing a decision must
    // return the product to the rule, not leave it switched off out of sight.
    expect(nextDecision(null)).toBe("include");
    expect(nextDecision("include")).toBe("exclude");
    expect(nextDecision("exclude")).toBeNull();
    expect(nextDecision(undefined)).toBe("include");
  });
});

describe("what the screen says", () => {
  it("describes each rule and what it does to an untouched product", () => {
    for (const rule of ["all", "selected"] as const) {
      expect(PUBLICATION_RULE_COPY[rule].label.length).toBeGreaterThan(3);
      expect(PUBLICATION_RULE_COPY[rule].summary.length).toBeGreaterThan(10);
      expect(PUBLICATION_RULE_COPY[rule].untouched.length).toBeGreaterThan(5);
    }
    // The two rules must not read alike — that is the whole point of the screen.
    expect(PUBLICATION_RULE_COPY.all.untouched).not.toBe(PUBLICATION_RULE_COPY.selected.untouched);
  });

  it("counts rather than describes, in Persian digits", () => {
    expect(publicationSummary({ rule: "all", published: 12, excluded: 3, unselected: 0 })).toBe(
      "۱۲ محصول در فید · ۳ کنار گذاشته‌شده",
    );
    // «انتخاب‌نشده» is only meaningful under the selection rule: under «همه» an
    // untouched product is published, so reporting it would invent a problem.
    expect(publicationSummary({ rule: "all", published: 12, excluded: 0, unselected: 8 })).toBe("۱۲ محصول در فید");
    expect(publicationSummary({ rule: "selected", published: 2, excluded: 0, unselected: 10 })).toBe(
      "۲ محصول در فید · ۱۰ انتخاب‌نشده",
    );
  });
});

describe("paging", () => {
  it("clamps to a page the caller can render", () => {
    expect(TOROB_PRODUCT_PAGE_SIZE).toBe(25);
    expect(clampPage(1, 4)).toBe(1);
    expect(clampPage(3, 4)).toBe(3);
    expect(clampPage(9, 4)).toBe(4);
    expect(clampPage(0, 4)).toBe(1);
    expect(clampPage(-2, 4)).toBe(1);
    expect(clampPage("2", 4)).toBe(2);
    expect(clampPage(undefined, 4)).toBe(1);
    // An empty list still has a page 1 — an empty page would look like a failure.
    expect(clampPage(3, 0)).toBe(1);
  });

  it("bounds how many products one request may carry", () => {
    expect(TOROB_SELECTION_BATCH_LIMIT).toBe(100);
  });
});
