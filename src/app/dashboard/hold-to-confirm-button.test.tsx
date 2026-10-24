// @vitest-environment jsdom

/**
 * The ۴-second payment hold, driven the way a finger drives it.
 *
 * hold-timer.test.ts already proves the *arithmetic* with an injected clock.
 * What cannot be proven there is the thing the till actually depends on: that
 * a tap on this button never takes money, that one uninterrupted hold submits
 * exactly once, and that the fill a cashier reads the gesture from is really
 * growing. So these render the component and send real
 * pointerdown/pointerup/pointercancel, and assert against the rendered
 * progress element rather than against internal state.
 *
 * Time is faked for the whole file: vitest's fake timers replace
 * `requestAnimationFrame` *and* `performance.now()` from one clock, which is
 * the same single-source discipline the component itself follows — so
 * `advanceTimersByTime(4000)` runs ~250 real frames and the component sees
 * exactly 4000ms pass, with no wall-clock flake.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldToConfirmButton, HOLD_TOAST_MESSAGE } from "./hold-to-confirm-button";

const toastInfo = vi.fn();
vi.mock("sonner", () => ({ toast: { info: (...args: unknown[]) => toastInfo(...args) } }));

/** Runs the frame loop forward by `ms` of the component's own clock. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * One extra animation frame.
 *
 * Under fake timers `requestAnimationFrame` fires on a 16ms grid counted from
 * the start of the test, so a hold that began off that grid (after a tap, say)
 * gets its last frame a few milliseconds before the deadline and would look
 * like a hold one frame short. A real browser always delivers a frame just
 * after. Used only where the *completion* is what is being asserted — never
 * where the point is that something must NOT have happened yet.
 */
function settle() {
  advance(20);
}

function press(element: Element, init: PointerEventInit = {}) {
  act(() => {
    element.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, ...init }),
    );
  });
}

/**
 * React has no native `pointerleave`/`blur` listener: it synthesises both from
 * the bubbling `pointerout`/`focusout` pair, so those are what a real release
 * off the edge of the button actually dispatches. Sending `pointerleave`
 * directly would test an event React never sees.
 */
const DOM_EVENT: Record<string, string> = { pointerleave: "pointerout" };

function release(element: Element, type = "pointerup", init: PointerEventInit = {}) {
  act(() => {
    element.dispatchEvent(
      new window.PointerEvent(DOM_EVENT[type] ?? type, {
        bubbles: true,
        pointerId: 1,
        relatedTarget: document.body,
        ...init,
      }),
    );
  });
}

/** The rendered fill — the element the cashier actually reads progress from. */
function fill(): HTMLElement {
  return screen.getByTestId("hold-progress-fill");
}

/** Its width as a 0–100 number, parsed off the real inline style. */
function fillPercent(): number {
  return Number.parseFloat(fill().style.width) || 0;
}

function button(): HTMLButtonElement {
  return screen.getByRole("button");
}

beforeEach(() => {
  vi.useFakeTimers();
  toastInfo.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HoldToConfirmButton — a tap is not a payment", () => {
  it("does not submit on a plain tap, and says how to do it instead", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(80); // the length of a real tap
    release(button());

    expect(onComplete).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(HOLD_TOAST_MESSAGE);
    expect(fillPercent()).toBe(0);
  });

  it("does not submit on a click event alone — there is no onClick path at all", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    act(() => {
      button().click();
    });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not submit when released one frame short of the full duration", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(3900);
    expect(onComplete).not.toHaveBeenCalled();
    release(button());
    advance(2000);

    expect(onComplete).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(HOLD_TOAST_MESSAGE);
  });
});

describe("HoldToConfirmButton — changing configured duration", () => {
  it("cancels an in-flight hold and uses the new duration", () => {
    const onComplete = vi.fn();
    const { rerender } = render(<HoldToConfirmButton durationMs={4000} label="ثبت پرداخت" onComplete={onComplete} />);
    press(button());
    advance(1000);
    rerender(<HoldToConfirmButton durationMs={1000} label="ثبت پرداخت" onComplete={onComplete} />);
    release(button());
    advance(1500);
    expect(onComplete).not.toHaveBeenCalled();

    press(button());
    advance(1020);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("HoldToConfirmButton — one full hold", () => {
  it("submits exactly once after 4s, and never again", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(4000);
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Keep holding, then release, then hold again: still one payment.
    advance(5000);
    release(button());
    press(button());
    advance(9000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("disables itself the moment it fires, so a second press cannot land", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(4000);

    expect(button().disabled).toBe(true);
    press(button());
    advance(4000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("grows the real progress fill from empty to full across the hold", () => {
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={vi.fn()} />);

    expect(fillPercent()).toBe(0);
    press(button());

    advance(1000);
    const quarter = fillPercent();
    expect(quarter).toBeGreaterThan(20);
    expect(quarter).toBeLessThan(30);

    advance(1000);
    const half = fillPercent();
    expect(half).toBeGreaterThan(quarter);
    expect(half).toBeGreaterThan(45);
    expect(half).toBeLessThan(55);

    advance(2000);
    expect(fillPercent()).toBe(100);
  });

  it("mirrors the fill on the progressbar role, so it is spoken as well as seen", () => {
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={vi.fn()} />);
    const bar = fill();
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");

    press(button());
    advance(2000);
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(45);

    advance(2000);
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });

  it("resets the fill to empty when the hold is abandoned", () => {
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={vi.fn()} />);

    press(button());
    advance(2000);
    expect(fillPercent()).toBeGreaterThan(0);

    release(button());
    expect(fillPercent()).toBe(0);
  });
});

describe("HoldToConfirmButton — interruptions", () => {
  it("treats a cancelled pointer (the browser stole the gesture) as a release", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(3000);
    release(button(), "pointercancel");
    advance(5000);

    expect(onComplete).not.toHaveBeenCalled();
    expect(fillPercent()).toBe(0);
  });

  it("treats the finger sliding off the button as a release", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(2000);
    release(button(), "pointerleave");
    advance(5000);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("ignores a pointer leaving that was never preceded by a press — no ghost toast", () => {
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={vi.fn()} />);

    release(button(), "pointerleave");

    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("ignores a second finger: it can neither start nor release the owner's hold", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button(), { pointerId: 1 });
    advance(1000);
    press(button(), { pointerId: 2 }); // a second finger lands
    release(button(), "pointerup", { pointerId: 2 }); // and lifts again
    advance(3000);

    // The original hold was neither restarted nor cancelled: it completes on
    // its own 4s, exactly once.
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("ignores a right-click press", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button(), { pointerType: "mouse", button: 2 });
    advance(5000);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("drops a hold that is disabled mid-press rather than leaving a live timer", () => {
    const onComplete = vi.fn();
    const { rerender } = render(
      <HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />,
    );

    press(button());
    advance(2000);
    act(() => {
      rerender(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} busy />);
    });
    advance(5000);

    expect(onComplete).not.toHaveBeenCalled();
    expect(fillPercent()).toBe(0);
  });

  it("never fires after unmount", () => {
    const onComplete = vi.fn();
    const { unmount } = render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(2000);
    unmount();
    advance(10_000);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("refuses to start at all when disabled", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} disabled />);

    press(button());
    advance(5000);

    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("HoldToConfirmButton — keyboard", () => {
  it("completes on a held Space and not on a quick one", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);
    const element = button();

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    advance(120);
    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
    });
    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    advance(4000);
    settle();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("ignores the OS key auto-repeat, so one physical press is one hold", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);
    const element = button();

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    // The OS starts repeating the key half a second in; each repeat must not
    // restart the hold, or it would never complete.
    for (let elapsed = 500; elapsed < 4000; elapsed += 500) {
      advance(500);
      act(() => {
        element.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }),
        );
      });
    }
    advance(500);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("treats focus lost mid-hold as a release", () => {
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);
    const element = button();

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    advance(2000);
    act(() => {
      element.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    });
    advance(5000);

    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("HoldToConfirmButton — haptics are a bonus, never a dependency", () => {
  it("buzzes at the start, at the quarter milestones and at completion", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { vibrate }));
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={vi.fn()} />);

    press(button());
    expect(vibrate).toHaveBeenCalledTimes(1); // start
    advance(1050);
    expect(vibrate).toHaveBeenCalledTimes(2); // 25%
    advance(1000);
    expect(vibrate).toHaveBeenCalledTimes(3); // 50%
    advance(1000);
    expect(vibrate).toHaveBeenCalledTimes(4); // 75%
    advance(1000);
    expect(vibrate).toHaveBeenCalledTimes(5); // completion

    // Never once per frame: ~250 frames passed and there were five buzzes.
    expect(vibrate.mock.calls.length).toBeLessThan(10);
  });

  it("works identically on a device with no Vibration API", () => {
    // jsdom's navigator has no `vibrate` — this is the desktop/iOS Safari case.
    expect("vibrate" in navigator).toBe(false);
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(4000);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(fillPercent()).toBe(100);
  });

  it("survives a vibrate() that throws, as some embedded WebViews do", () => {
    const vibrate = vi.fn(() => {
      throw new Error("NotAllowedError");
    });
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { vibrate }));
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(4000);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("HoldToConfirmButton — reduced motion", () => {
  it("still fills and still completes, with the smoothing dropped", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    window.matchMedia = globalThis.matchMedia;
    const onComplete = vi.fn();
    render(<HoldToConfirmButton label="ثبت پرداخت" onComplete={onComplete} />);

    press(button());
    advance(2000);
    expect(fillPercent()).toBeGreaterThan(45);
    expect(fill().style.transition).toBe("none");

    advance(2000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
