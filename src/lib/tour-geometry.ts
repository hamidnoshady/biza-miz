/**
 * Where a tour step's popover goes (issue #972). Pure so the placement rules
 * are unit-tested instead of eyeballed: the runtime measures, this decides.
 *
 * All values are viewport (fixed-position) pixels. Placement is physical
 * (`top`/`left`) on purpose — it is computed from `getBoundingClientRect`,
 * which is already physical, so an RTL page needs no mirroring here; only the
 * text inside the popover is RTL.
 */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Gap kept between the popover and the viewport edge, and between popover and target. */
export const TOUR_EDGE = 8;
export const TOUR_GAP = 12;
/** Room around the highlighted element so its focus ring is not clipped. */
export const TOUR_SPOTLIGHT_PADDING = 6;

export type PopoverPlacement = "below" | "above" | "center";

export interface PopoverPosition {
  top: number;
  left: number;
  placement: PopoverPlacement;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Below the target when it fits, otherwise above, otherwise centered in the
 * viewport (a target taller than the screen, or a phone in landscape, still
 * gets a popover the member can read and dismiss). No target = centered.
 */
export function placePopover(target: Box | null, popover: Size, viewport: Size): PopoverPosition {
  const centered: PopoverPosition = {
    top: clamp((viewport.height - popover.height) / 2, TOUR_EDGE, viewport.height - popover.height - TOUR_EDGE),
    left: clamp((viewport.width - popover.width) / 2, TOUR_EDGE, viewport.width - popover.width - TOUR_EDGE),
    placement: "center",
  };
  if (!target) return centered;

  const left = clamp(
    target.left + target.width / 2 - popover.width / 2,
    TOUR_EDGE,
    viewport.width - popover.width - TOUR_EDGE,
  );
  const belowTop = target.top + target.height + TOUR_GAP;
  if (belowTop + popover.height + TOUR_EDGE <= viewport.height) {
    return { top: belowTop, left, placement: "below" };
  }
  const aboveTop = target.top - TOUR_GAP - popover.height;
  if (aboveTop >= TOUR_EDGE) return { top: aboveTop, left, placement: "above" };
  return centered;
}

/** The cut-out around a target: its box grown by the padding, kept on screen. */
export function spotlightBox(target: Box, viewport: Size): Box {
  const top = Math.max(0, target.top - TOUR_SPOTLIGHT_PADDING);
  const left = Math.max(0, target.left - TOUR_SPOTLIGHT_PADDING);
  const right = Math.min(viewport.width, target.left + target.width + TOUR_SPOTLIGHT_PADDING);
  const bottom = Math.min(viewport.height, target.top + target.height + TOUR_SPOTLIGHT_PADDING);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** An anchor with no area (display:none, detached, zero-sized) cannot be pointed at. */
export function isPointable(box: Box | null): box is Box {
  return box !== null && box.width > 0 && box.height > 0;
}
