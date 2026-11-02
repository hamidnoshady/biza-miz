import { describe, expect, it } from "vitest";
import { TOUR_EDGE, isPointable, placePopover, spotlightBox } from "./tour-geometry";

const viewport = { width: 1000, height: 700 };
const popover = { width: 350, height: 180 };

describe("placePopover", () => {
  it("centers a step with no target", () => {
    expect(placePopover(null, popover, viewport)).toEqual({ top: 260, left: 325, placement: "center" });
  });

  it("goes below a target when there is room", () => {
    const pos = placePopover({ top: 100, left: 400, width: 200, height: 40 }, popover, viewport);
    expect(pos.placement).toBe("below");
    expect(pos.top).toBe(152);
    expect(pos.left).toBe(325);
  });

  it("goes above when below does not fit", () => {
    const pos = placePopover({ top: 600, left: 400, width: 200, height: 40 }, popover, viewport);
    expect(pos.placement).toBe("above");
    expect(pos.top).toBe(600 - 12 - 180);
  });

  it("falls back to the center for a target that fills the screen", () => {
    const pos = placePopover({ top: 0, left: 0, width: 1000, height: 700 }, popover, viewport);
    expect(pos.placement).toBe("center");
  });

  it("never leaves the viewport horizontally, at either edge", () => {
    const left = placePopover({ top: 100, left: 0, width: 20, height: 20 }, popover, viewport);
    const right = placePopover({ top: 100, left: 980, width: 20, height: 20 }, popover, viewport);
    expect(left.left).toBe(TOUR_EDGE);
    expect(right.left).toBe(viewport.width - popover.width - TOUR_EDGE);
  });

  it("survives a popover wider than a narrow phone", () => {
    const pos = placePopover({ top: 10, left: 10, width: 50, height: 20 }, { width: 400, height: 150 }, { width: 360, height: 640 });
    expect(pos.left).toBe(TOUR_EDGE);
  });
});

describe("spotlight", () => {
  it("grows the target and stays on screen", () => {
    expect(spotlightBox({ top: 100, left: 100, width: 50, height: 30 }, viewport)).toEqual({ top: 94, left: 94, width: 62, height: 42 });
    expect(spotlightBox({ top: 0, left: 0, width: 50, height: 30 }, viewport)).toEqual({ top: 0, left: 0, width: 56, height: 36 });
  });

  it("refuses to point at an anchor with no area", () => {
    expect(isPointable(null)).toBe(false);
    expect(isPointable({ top: 0, left: 0, width: 0, height: 10 })).toBe(false);
    expect(isPointable({ top: 0, left: 0, width: 10, height: 10 })).toBe(true);
  });
});
