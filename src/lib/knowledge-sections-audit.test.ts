/**
 * Section-identity audit (issue #874 F26 / #938): legacy keys are classified
 * and mapped where confident, but never silently dropped.
 */
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_PAGES, KNOWLEDGE_SECTIONS } from "./knowledge-base";
import {
  auditKnowledgeSections,
  knowledgeSectionKeyKind,
  LEGACY_SECTION_ALIASES,
  suggestedPageKeyForLegacyKey,
} from "./knowledge-sections-audit";

describe("knowledgeSectionKeyKind", () => {
  it("recognises current page and section keys", () => {
    expect(knowledgeSectionKeyKind("page:/accounting/pos")).toBe("page");
    expect(knowledgeSectionKeyKind("pos")).toBe("section");
  });

  it("classifies the seeded legacy keys as stale", () => {
    expect(knowledgeSectionKeyKind("overview")).toBe("stale");
    expect(knowledgeSectionKeyKind("stock")).toBe("stale");
    expect(knowledgeSectionKeyKind("ai")).toBe("stale");
  });
});

describe("suggestedPageKeyForLegacyKey", () => {
  it("keeps current page keys unchanged", () => {
    for (const page of KNOWLEDGE_PAGES) {
      expect(suggestedPageKeyForLegacyKey(page.key)).toBe(page.key);
    }
  });

  it("maps overview and stock to canonical destinations", () => {
    expect(suggestedPageKeyForLegacyKey("overview")).toBe("page:/accounting/overview");
    expect(suggestedPageKeyForLegacyKey("stock")).toBe("inventory");
    expect(knowledgeSectionKeyKind("inventory")).toBe("section");
  });

  it("leaves ai unmapped because the workspace home has no learning page", () => {
    expect(suggestedPageKeyForLegacyKey("ai")).toBeNull();
  });

  it("maps section keys to the page with the same route when one exists", () => {
    // «تنظیمات» exists both as a section and as a page.
    expect(suggestedPageKeyForLegacyKey("settings")).toBe("page:/settings");
  });

  it("never points an alias at a key that does not exist", () => {
    for (const target of Object.values(LEGACY_SECTION_ALIASES)) {
      const known =
        KNOWLEDGE_PAGES.some((page) => page.key === target) ||
        KNOWLEDGE_SECTIONS.some((section) => section.key === target);
      expect(known, target).toBe(true);
    }
  });
});

describe("auditKnowledgeSections", () => {
  it("groups articles by key and reports unmapped stale keys", () => {
    const report = auditKnowledgeSections([
      { slug: "pos-basics", sectionKeys: ["pos", "page:/accounting/pos"] },
      { slug: "overview-dashboard", sectionKeys: ["overview"] },
      { slug: "ai-guide", sectionKeys: ["ai", "projects"] },
      { slug: "uncategorised", sectionKeys: [] },
    ]);

    expect(report.mappedLegacyKeys).toEqual(["overview"]);
    expect(report.unmappedKeys).toEqual(["ai"]);
    expect(report.articlesWithoutAssignments).toEqual(["uncategorised"]);

    const overview = report.entries.find((entry) => entry.key === "overview");
    expect(overview).toMatchObject({
      kind: "stale",
      suggestedPageKey: "page:/accounting/overview",
      articles: ["overview-dashboard"],
    });
    const pos = report.entries.find((entry) => entry.key === "pos");
    expect(pos?.articles).toEqual(["pos-basics"]);
  });

  it("returns an empty report for no articles", () => {
    expect(auditKnowledgeSections([])).toEqual({
      entries: [],
      mappedLegacyKeys: [],
      unmappedKeys: [],
      articlesWithoutAssignments: [],
    });
  });
});
