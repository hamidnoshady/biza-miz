import { describe, expect, it } from "vitest";
import { normalizeTableShape, TABLE_SHAPES } from "./table-shape";

describe("normalizeTableShape", () => {
  it("accepts every stored shape unchanged", () => {
    for (const shape of TABLE_SHAPES) expect(normalizeTableShape(shape)).toBe(shape);
  });

  it("maps the retired circle spelling to round", () => {
    expect(normalizeTableShape("circle")).toBe("round");
  });

  it("rejects anything else", () => {
    for (const bad of ["Circle", "ROUND", "oval", "", null, undefined, 3]) {
      expect(normalizeTableShape(bad)).toBeNull();
    }
  });
});
