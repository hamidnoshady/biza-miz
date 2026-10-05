"use client";

/**
 * Issue #812 §18 — sticky scrolling for the assistant thread.
 *
 * The old effect scrolled to the bottom whenever `messages` or `busy` changed,
 * which meant a member reading an earlier answer was yanked back down on every
 * streamed token. That is the opposite of what a chat should do.
 *
 * The rule now:
 *   - auto-scroll only while the reader is already near the bottom;
 *   - once they scroll up past the threshold, stop forcing the bottom and show
 *     a «برو به آخرین پیام» affordance instead;
 *   - resume sticky scrolling as soon as they return to the bottom.
 *
 * Deliberately framework-free apart from React so it can be unit-tested in
 * jsdom with a plain element, and reused by any scrollable thread.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Distance from the bottom (px) still counted as "at the bottom". */
export const STICKY_THRESHOLD_PX = 96;

export interface StickyScroll {
  /** Attach to the scrollable element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** True while the reader is pinned to the bottom. */
  atBottom: boolean;
  /**
   * Call after new content lands (a streamed delta, a loaded conversation).
   * Scrolls only when the reader is already at the bottom, or when `force` is
   * set (switching conversation, starting a fresh one).
   */
  scrollToBottom: (options?: { force?: boolean; smooth?: boolean }) => void;
  /** The «jump to latest» action the affordance calls. */
  jumpToLatest: () => void;
  /** Handler for the container's `onScroll`. */
  onScroll: () => void;
}

export function useStickyScroll(): StickyScroll {
  const containerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Read inside the scroll handler without re-binding it on every render.
  const atBottomRef = useRef(true);

  const measure = useCallback(() => {
    const node = containerRef.current;
    if (!node) return true;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const next = distance <= STICKY_THRESHOLD_PX;
    atBottomRef.current = next;
    setAtBottom((current) => (current === next ? current : next));
    return next;
  }, []);

  const scrollToBottom = useCallback(
    (options: { force?: boolean; smooth?: boolean } = {}) => {
      const node = containerRef.current;
      if (!node) return;
      // A forced scroll (new conversation, greeting) always wins; otherwise the
      // reader's position is respected — that is the whole point.
      if (!options.force && !atBottomRef.current) return;
      atBottomRef.current = true;
      setAtBottom(true);
      node.scrollTo({ top: node.scrollHeight, behavior: options.smooth ? "smooth" : "auto" });
    },
    [],
  );

  const jumpToLatest = useCallback(() => {
    scrollToBottom({ force: true, smooth: true });
  }, [scrollToBottom]);

  // `onScroll` must be a stable function: an inline arrow would detach and
  // reattach the listener on every render, which is exactly the churn that made
  // the old effect unreliable.
  const onScroll = useCallback(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    measure();
  }, [measure]);

  return { containerRef, atBottom, scrollToBottom, jumpToLatest, onScroll };
}
