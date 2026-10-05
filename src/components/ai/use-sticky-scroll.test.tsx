// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { STICKY_THRESHOLD_PX, useStickyScroll } from "./use-sticky-scroll";

/**
 * A stand-in for the scroll container. `scrollHeight`/`clientHeight` are what
 * the hook reads to decide how far from the bottom the reader is; jsdom leaves
 * both at 0, so they are set explicitly per scenario.
 */
function makeContainer(overrides: Partial<HTMLElement> = {}) {
  const node = document.createElement("div");
  Object.defineProperties(node, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 400, configurable: true },
    scrollTop: { value: 0, writable: true, configurable: true },
  });
  const scrollTo = vi.fn((options?: ScrollToOptions) => {
    if (options?.top !== undefined) node.scrollTop = Number(options.top);
  });
  node.scrollTo = scrollTo as typeof node.scrollTo;
  Object.assign(node, overrides);
  return { node, scrollTo };
}

describe("issue #812 §18 — sticky scrolling", () => {
  it("starts pinned to the bottom and follows new content", () => {
    const { node } = makeContainer();
    const { result } = renderHook(() => useStickyScroll());
    act(() => {
      result.current.containerRef.current = node;
    });
    expect(result.current.atBottom).toBe(true);

    act(() => result.current.scrollToBottom({ smooth: true }));
    expect(node.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  it("stops following once the reader scrolls up past the threshold", () => {
    const { node, scrollTo } = makeContainer();
    const { result } = renderHook(() => useStickyScroll());
    act(() => {
      result.current.containerRef.current = node;
    });

    // Reader scrolls up: 300px from the bottom, well past the threshold.
    act(() => {
      node.scrollTop = 300;
      result.current.onScroll();
    });
    expect(result.current.atBottom).toBe(false);

    scrollTo.mockClear();
    act(() => result.current.scrollToBottom());
    // A streamed delta must not yank them back down.
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("still treats the reader as at the bottom inside the threshold", () => {
    const { node, scrollTo } = makeContainer();
    const { result } = renderHook(() => useStickyScroll());
    act(() => {
      result.current.containerRef.current = node;
    });
    // 1000 - 600 - 400 = 0 → exactly at the bottom.
    act(() => {
      node.scrollTop = 600;
      result.current.onScroll();
    });
    expect(result.current.atBottom).toBe(true);

    scrollTo.mockClear();
    act(() => result.current.scrollToBottom());
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("resumes sticky scrolling when the reader returns to the bottom", () => {
    const { node, scrollTo } = makeContainer();
    const { result } = renderHook(() => useStickyScroll());
    act(() => {
      result.current.containerRef.current = node;
    });
    act(() => {
      node.scrollTop = 100;
      result.current.onScroll();
    });
    expect(result.current.atBottom).toBe(false);

    act(() => {
      node.scrollTop = 1000 - STICKY_THRESHOLD_PX;
      result.current.onScroll();
    });
    expect(result.current.atBottom).toBe(true);

    scrollTo.mockClear();
    act(() => result.current.scrollToBottom());
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("the jump-to-latest affordance forces the scroll even when scrolled up", () => {
    const { node, scrollTo } = makeContainer();
    const { result } = renderHook(() => useStickyScroll());
    act(() => {
      result.current.containerRef.current = node;
    });
    act(() => {
      node.scrollTop = 50;
      result.current.onScroll();
    });
    expect(result.current.atBottom).toBe(false);

    scrollTo.mockClear();
    act(() => result.current.jumpToLatest());
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    expect(result.current.atBottom).toBe(true);
  });

  it("a forced scroll wins over the reader's position (conversation switch)", () => {
    const { node, scrollTo } = makeContainer();
    const { result } = renderHook(() => useStickyScroll());
    act(() => {
      result.current.containerRef.current = node;
    });
    act(() => {
      node.scrollTop = 10;
      result.current.onScroll();
    });
    scrollTo.mockClear();
    act(() => result.current.scrollToBottom({ force: true }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is no container yet", () => {
    const { result } = renderHook(() => useStickyScroll());
    expect(() => act(() => result.current.scrollToBottom())).not.toThrow();
    expect(() => act(() => result.current.jumpToLatest())).not.toThrow();
    expect(() => act(() => result.current.onScroll())).not.toThrow();
  });
});
