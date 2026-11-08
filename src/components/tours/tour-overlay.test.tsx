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

  it("ignores a second Next, Back or Skip while a step's save is pending", async () => {
    let release: (ok: boolean) => void = () => {};
    const events: TourProgressEvent[] = [];
    const onEvent = vi.fn(
      (event: TourProgressEvent) =>
        new Promise<boolean>((resolve) => {
          events.push(event);
          release = resolve;
        }),
    );
    render(<TourOverlay tour={playback} startIndex={0} onEvent={onEvent} onExit={vi.fn()} />);
    const next = screen.getByRole("button", { name: "بعدی" });
    await act(async () => {
      fireEvent.click(next);
      fireEvent.click(next);
      fireEvent.keyDown(document, { key: "ArrowLeft" });
      fireEvent.click(screen.getByRole("button", { name: "رد شدن" }));
    });
    expect(events).toEqual([{ type: "step_seen", stepId: "welcome" }]);
    expect((screen.getByRole("button", { name: "بعدی" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release(true);
    });
    // Exactly one step forward, and the next one is recorded on its own.
    expect(screen.getByRole("dialog").textContent).toContain("مرحلهٔ ۲ از ۳");
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

  it("targets the visible copy when an anchor is drawn twice (phone bar and desktop panel)", () => {
    // The first copy in the document is hidden (no box), as a `md:hidden` bar is on desktop.
    const hidden = mountAnchor("products.toolbar", { width: 0, height: 0 });
    const visible = mountAnchor("products.toolbar");
    const { container } = setup({ startIndex: 1 });
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect((HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts).toContain(visible);
    expect((HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts).not.toContain(hidden);
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

describe("verified action steps", () => {
  const taskTour: TourPlayback = {
    id: "test.task",
    version: 1,
    route: "/crm/directory",
    title: "اولین مشتری را ثبت کنید",
    steps: [
      { id: "how-it-works", kind: "explain", title: "خودتان انجام می‌دهید", body: "شروع" },
      {
        id: "register",
        kind: "action",
        verifier: "party.created",
        anchor: "parties.add",
        title: "مشتری را ثبت کنید",
        body: "دکمهٔ افزودن",
      },
    ],
  };

  function setupAction(onVerify: (stepId: string) => Promise<"verified" | "pending" | "error">) {
    const events: TourProgressEvent[] = [];
    const onEvent = vi.fn(async (event: TourProgressEvent) => {
      events.push(event);
      return true;
    });
    const onExit = vi.fn();
    const verify = vi.fn(async (stepId: string) => {
      const status = await onVerify(stepId);
      return status === "verified"
        ? ({ status, evidenceAt: "2026-11-01T00:04:00.000Z", beforeTour: false } as const)
        : ({ status } as const);
    });
    mountAnchor("parties.add");
    const utils = render(
      <TourOverlay
        tour={taskTour}
        startIndex={1}
        onEvent={onEvent}
        onVerify={verify}
        onExit={onExit}
      />,
    );
    return { events, onEvent, onExit, verify, ...utils };
  }

  it("leaves the page usable and never posts `step_seen` for an action step", async () => {
    const { events, verify } = setupAction(async () => "pending");
    // No full-screen click blocker while the member has work to do.
    expect(document.querySelector('[data-tour-overlay] > div[aria-hidden="true"].fixed.inset-0')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "انجام دادم" }));
    });
    expect(verify).toHaveBeenCalledWith("register");
    expect(events.filter((event) => event.type === "step_seen")).toEqual([]);
  });

  it("says it is waiting, then confirms when the server finds the evidence", async () => {
    let answer: "pending" | "verified" = "pending";
    const { verify } = setupAction(async () => answer);
    expect(await screen.findByText(/هنوز تأیید نشده/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "انجام دادم" })).toHaveProperty("disabled", true);

    answer = "verified";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "بررسی" }));
    });
    expect(await screen.findByText("تأیید شد ✓")).toBeTruthy();
    expect((screen.getByRole("button", { name: "پایان" }) as HTMLButtonElement).disabled).toBe(false);
    expect(verify.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("confirms the last step and then finishes the tour with `complete`", async () => {
    const { events, onExit } = setupAction(async () => "verified");
    expect(await screen.findByText("تأیید شد ✓")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "پایان" }));
    });
    // The server already recorded the verified step; only the completion is sent.
    expect(events).toEqual([{ type: "complete" }]);
    expect(onExit).toHaveBeenCalledWith("completed");
  });

  it("tells the member when they had already done this before the tour", async () => {
    mountAnchor("parties.add");
    const onEvent = vi.fn(async () => true);
    render(
      <TourOverlay
        tour={taskTour}
        startIndex={1}
        onEvent={onEvent}
        onVerify={async () => ({ status: "verified", evidenceAt: "2025-01-01T00:00:00.000Z", beforeTour: true })}
        onExit={() => {}}
      />,
    );
    expect(await screen.findByText(/پیش‌تر هم انجام داده بودید/)).toBeTruthy();
  });

  it("never lets a tour that cannot verify pretend the step is done", async () => {
    const events: TourProgressEvent[] = [];
    mountAnchor("parties.add");
    render(
      <TourOverlay
        tour={taskTour}
        startIndex={1}
        onEvent={async (event) => {
          events.push(event);
          return true;
        }}
        onExit={() => {}}
      />,
    );
    // Without a verifier the step degrades to an explanation: Next records it
    // as seen rather than offering a confirmation that cannot be checked.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "پایان" }));
    });
    expect(events).toEqual([{ type: "step_seen", stepId: "register" }, { type: "complete" }]);
  });
});
