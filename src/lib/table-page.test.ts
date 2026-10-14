import { describe, expect, it } from "vitest";
import { tablePageOfIndex, tablePageWindow } from "./table-page";

describe("tablePageWindow", () => {
  it("bounds 1,685 rows to pages of 50", () => {
    expect(tablePageWindow(1685, 1, 50)).toEqual({ page: 1, pageCount: 34, start: 0, end: 50 });
    expect(tablePageWindow(1685, 34, 50)).toEqual({ page: 34, pageCount: 34, start: 1650, end: 1685 });
  });

  it("clamps a page that no longer exists after filtering", () => {
    expect(tablePageWindow(12, 9, 50)).toEqual({ page: 1, pageCount: 1, start: 0, end: 12 });
    expect(tablePageWindow(0, 3, 50)).toEqual({ page: 1, pageCount: 1, start: 0, end: 0 });
    expect(tablePageWindow(120, 0, 50).page).toBe(1);
  });

  it("finds the page a row is on", () => {
    expect(tablePageOfIndex(0, 50)).toBe(1);
    expect(tablePageOfIndex(49, 50)).toBe(1);
    expect(tablePageOfIndex(50, 50)).toBe(2);
  });
});
