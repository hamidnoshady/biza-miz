import { describe, expect, it } from "vitest";
import { foldForSearch, searchPattern, SEARCH_FOLD } from "./sql-search";

describe("foldForSearch", () => {
  it("folds the column into the alphabet the typed needle is normalized into", () => {
    // Arabic ي/ك → Persian ی/ک, and both digit sets → ASCII: the exact map
    // `normalizePosSearchText` applies to what the person typed, so a search
    // for «علي» finds a column holding «علی» and «۱۲» finds «12».
    expect(foldForSearch("p.name")).toBe(
      "translate(p.name, 'يك٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', 'یک01234567890123456789')",
    );
  });

  it("always substitutes the expression into the template", () => {
    // No `%s` may survive into the SQL — an un-substituted placeholder is a
    // syntax error at query time, not at build time.
    expect(SEARCH_FOLD).toContain("%s");
    expect(foldForSearch("coalesce(p.name, 'x')")).not.toContain("%s");
  });
});

describe("searchPattern", () => {
  it("is null for nothing to search for", () => {
    expect(searchPattern("")).toBeNull();
    expect(searchPattern("   ")).toBeNull();
    expect(searchPattern(undefined)).toBeNull();
    expect(searchPattern(null)).toBeNull();
    // Normalizing to nothing (diacritics only) is also "nothing to search for".
    expect(searchPattern("ً")).toBeNull();
  });

  it("folds the needle the way the pickers do", () => {
    expect(searchPattern("علي")).toBe("%علی%");
    expect(searchPattern("۱۲۳")).toBe("%123%");
    expect(searchPattern("  مينا  ")).toBe("%مینا%");
  });

  it("escapes the LIKE wildcards it may contain", () => {
    // «%» must find a literal «%», not swallow the table — and the backslash
    // it is escaped with must itself be escaped, or `\%` reads as «an escaped
    // backslash followed by anything».
    expect(searchPattern("50%")).toBe("%50\\%%");
    expect(searchPattern("a_b")).toBe("%a\\_b%");
    expect(searchPattern("c:\\x")).toBe("%c:\\\\x%");
  });
});
