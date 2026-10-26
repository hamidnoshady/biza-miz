// @vitest-environment jsdom

/**
 * Issue #972 — the overlay's contract with the member: it explains and never
 * operates, every exit pauses where the member stood, a skipped step is not a
 * seen one, and a missing anchor degrades to a plain explanation instead of
 * a dead end.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TourPlayback, TourProgressEvent } from "@/lib/tours";
import { TourOverlay } from "./tour-overlay";

const playback: TourPlayback = {
  id: "test.tour",
  version: 1,
  route: "/accounting/products",
  title: "تور آزمایشی",
  steps: [
    { id: "welcome", kind: "explain", title: "خوش آمدید", body: "شروع" },
    { id: "toolbar", kind: "spotlight", anchor: "products.toolbar", title: "نوار ابزار", body: "جست‌وجو" },
    { id: "done", kind: "explain", title: "تمام", body: "پایان" },
  ],
};

function setup(options: { startIndex?: number; accept?: boolean } = {}) {
  const events: TourProgressEvent[] = [];
  const onEvent = vi.fn(async (event: TourProgressEvent) => {
    events.push(event);
    return options.accept ?? true;
  });
  const onExit = vi.fn();
  const utils = render(
    <TourOverlay tour={playback} startIndex={options.startIndex ?? 0} onEvent={onEvent} onExit={onExit} />,
  );
  return { events, onEvent, onExit, ...utils };
}

function mountAnchor(id: string, box = { width: 200, height: 40 }) {
  const el = document.createElement("div");
  el.setAttribute("data-tour-id", id);
  el.getBoundingClientRect = () =>
    ({ top: 100, left: 100, width: box.width, height: box.height, right: 300, bottom: 140, x: 100, y: 100, toJSON() {} }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TourOverlay", () => {
  it("shows the step as an accessible dialog with its position in the tour", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("خوش آمدید");
    expect(dialog.textContent).toContain("مرحلهٔ ۱ از ۳");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(screen.queryByRole("button", { name: "قبلی" })).toBeNull();
  });

  it("records a step as seen only when Next is pressed, in order, and completes on the last", async () => {
    const { events, onExit } = setup({ startIndex: 2 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "پایان" }));
    });
    expect(events).toEqual([{ type: "step_seen", stepId: "done" }, { type: "complete" }]);
    expect(onExit).toHaveBeenCalledWith("completed");
  });

  it("does not call a tour finished when the server refused the completion", async () => {
    const { onExit } = setup({ startIndex: 2, accept: false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "پایان" }));
    });
    expect(onExit).toHaveBeenCalledWith("incomplete");
  });

  it("does not count a skipped step as seen", async () => {
    const { events } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "رد شدن" }));
    });
    expect(events).toEqual([]);
    expect(screen.getByRole("dialog").textContent).toContain("مرحلهٔ ۲ از ۳");
  });

  it("pauses at the current step on Escape and on the close button", async () => {
    const first = setup();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(first.events).toEqual([{ type: "pause", stepId: "welcome" }]);
    expect(first.onExit).toHaveBeenCalledWith("paused");
    cleanup();

    const second = setup({ startIndex: 1 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "بستن تور" }));
    });
    expect(second.events).toEqual([{ type: "pause", stepId: "toolbar" }]);
  });

  it("follows the arrow keys in the page's reading direction", async () => {
    document.documentElement.dir = "rtl";
    setup();
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowLeft" });
    });
    expect(screen.getByRole("dialog").textContent).toContain("مرحلهٔ ۲ از ۳");
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowRight" });
    });
    expect(screen.getByRole("dialog").textContent).toContain("مرحلهٔ ۱ از ۳");
    document.documentElement.dir = "";
  });

  it("scrolls the anchor into view and lights it up", () => {
    const anchor = mountAnchor("products.toolbar");
    const { container } = setup({ startIndex: 1 });
    expect(anchor.isConnected).toBe(true);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(container.querySelector("[style*='box-shadow']")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("waits for an anchor that mounts late", async () => {
    setup({ startIndex: 1 });
    await act(async () => {
      mountAnchor("products.toolbar");
      await Promise.resolve();
    });
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("degrades a step whose anchor never appears, and still lets the member move on", async () => {
    vi.useFakeTimers();
    const { events } = setup({ startIndex: 1 });
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.getByRole("status").textContent).toContain("اکنون روی صفحه نیست");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "بعدی" }));
    });
    expect(events).toEqual([{ type: "step_seen", stepId: "toolbar" }]);
    expect(screen.getByRole("dialog").textContent).toContain("مرحلهٔ ۳ از ۳");
  });

  it("hands focus back to the button that started the tour", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const events: TourProgressEvent[] = [];
    const { unmount } = render(
      <TourOverlay
        tour={playback}
        startIndex={0}
        returnFocus={trigger}
        onEvent={async (e) => {
          events.push(e);
          return true;
        }}
        onExit={() => {}}
      />,
    );
    unmount();
    expect(document.activeElement).toBe(trigger);
  });
});
