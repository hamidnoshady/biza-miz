import { describe, expect, it } from "vitest";
import { selectVisualScreens } from "../../scripts/visual-selection.mjs";

describe("local visual capture selection", () => {
  const ids = ["receivables", "expenses", "other"];
  it("always keeps the complete default suite", () => {
    expect(selectVisualScreens(ids, [], true)).toEqual(ids);
    expect(selectVisualScreens(ids, [], false)).toEqual(ids);
  });
  it("records only explicitly selected local screens, without changing their order", () => {
    expect(selectVisualScreens(ids, ["--update", "--screens=expenses,receivables"], false)).toEqual(ids.slice(0, 2));
  });
  it("cannot weaken CI or silently accept an empty/misspelled selection", () => {
    expect(() => selectVisualScreens(ids, ["--screens=receivables"], true)).toThrow("complete visual suite");
    for (const args of [["--screens="], ["--screens=typo"], ["--screns=receivables"], ["--screens=expenses", "--screens=receivables"]]) {
      expect(() => selectVisualScreens(ids, args, false)).toThrow();
    }
  });
});
