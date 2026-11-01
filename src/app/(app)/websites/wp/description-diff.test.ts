import { describe, expect, it } from "vitest";
import { diffHasChanges, diffLines } from "./description-diff";

describe("diffLines — what an Apply will change", () => {
  it("reports nothing for identical text", () => {
    const lines = diffLines("یک\nدو", "یک\nدو");
    expect(lines).toEqual([
      { kind: "same", text: "یک" },
      { kind: "same", text: "دو" },
    ]);
    expect(diffHasChanges(lines)).toBe(false);
  });

  it("marks a rewritten line as one removal and one addition", () => {
    const lines = diffLines("قیمت قدیم\nمتن ثابت", "قیمت جدید\nمتن ثابت");
    expect(lines).not.toBeNull();
    expect(diffHasChanges(lines)).toBe(true);
    const changed = (lines ?? []).filter((line) => line.kind !== "same");
    expect(changed.map((line) => line.kind).sort()).toEqual(["added", "removed"]);
    // The untouched line is not reported as a change.
    expect(lines?.find((line) => line.text === "متن ثابت")?.kind).toBe("same");
  });

  it("handles growing and shrinking text", () => {
    expect(diffLines("", "الف\nبا").map((line) => line.kind)).toEqual(["added", "added"]);
    expect(diffLines("الف\nبا", "").map((line) => line.kind)).toEqual(["removed", "removed"]);
  });

  it("treats a trailing newline as formatting, not as an empty line change", () => {
    const lines = diffLines("متن", "متن\n");
    expect(diffHasChanges(lines)).toBe(false);
  });

  it("normalises CRLF so a Windows-written description is not a whole-file change", () => {
    const lines = diffLines("خط یک\r\nخط دو", "خط یک\nخط دو");
    expect(diffHasChanges(lines)).toBe(false);
  });

  it("refuses to compare text past the line budget instead of truncating it", () => {
    const long = Array.from({ length: 11 }, (_, index) => `خط ${index}`).join("\n");
    expect(diffLines(long, "کوتاه", { maxLines: 10 })).toBeNull();
    expect(diffHasChanges(null)).toBe(false);
  });

  it("keeps HTML blocks comparable, so a Gutenberg edit is visible line by line", () => {
    const before = '<!-- wp:paragraph -->\n<p>متن اول</p>\n<!-- /wp:paragraph -->';
    const after = '<!-- wp:paragraph -->\n<p>متن دوم</p>\n<!-- /wp:paragraph -->';
    const lines = diffLines(before, after) ?? [];
    expect(lines.filter((line) => line.kind !== "same").map((line) => line.text)).toEqual([
      "<p>متن اول</p>",
      "<p>متن دوم</p>",
    ]);
  });
});
