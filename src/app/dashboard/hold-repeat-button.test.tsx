// @vitest-environment jsdom

/**
 * The ۲-second add-on hold, driven the way a finger drives it.
 *
 * The contract this file exists to protect is the one a cashier discovers by
 * accident otherwise: a tap must add **nothing**, a hold must add one unit
 * every ۲ ثانیه for as long as it lasts, and two quick taps must take one off.
 * Those are three outcomes of the same physical press, separated only by
 * timing, so they can only be tested by actually pressing — hence rendered
 * pointer events and assertions against the rendered fill, not against state.
 *
 * Fake timers drive `requestAnimationFrame` and `performance.now()` from one
 * clock, matching the single-source discipline the component follows.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldRepeatButton } from "./hold-repeat-button";

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * One extra animation frame. Under fake timers rAF fires on a 16ms grid
 * counted from the start of the test, so a hold that began off that grid gets
 * its last frame a few ms early; a real browser always delivers one just
 * after. Used only where a fire is expected — never to prove one has not
 * happened yet.
 */
function settle() {
  advance(20);
}

const DOM_EVENT: Record<string, string> = { pointerleave: "pointerout" };

function press(element: Element, init: PointerEventInit = {}) {
  act(() => {
    element.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, ...init }),
    );
  });
}

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

/** A tap: press and release with no meaningful time in between. */
function tap(element: Element, holdMs = 40) {
  press(element);
  advance(holdMs);
  release(element);
}

function button(): HTMLButtonElement {
  return screen.getByRole("button");
}

function fill(): HTMLElement {
  return screen.getByTestId("hold-repeat-fill");
}

/** The fill's own reported progress, 0–100, read off the rendered element. */
function fillProgress(): number {
  return Number(fill().dataset.progress ?? "0");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HoldRepeatButton — a tap adds nothing", () => {
  it("does not increment on a single tap", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} onDoubleTap={vi.fn()} />);

    tap(button());
    advance(5000);

    expect(onRepeat).not.toHaveBeenCalled();
  });

  it("does not increment on a click event either — there is no onClick path", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    act(() => {
      button().click();
    });

    expect(onRepeat).not.toHaveBeenCalled();
  });

  it("does not increment on a press released one frame short of the interval", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button());
    advance(1900);
    release(button());
    advance(4000);

    expect(onRepeat).not.toHaveBeenCalled();
  });
});

describe("HoldRepeatButton — one hold, many units", () => {
  it("adds at 2s, 4s, 6s and 8s within a single uninterrupted hold", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button());
    advance(1999);
    expect(onRepeat).toHaveBeenCalledTimes(0);

    advance(21); // 2s
    expect(onRepeat).toHaveBeenCalledTimes(1);
    advance(2000); // 4s
    expect(onRepeat).toHaveBeenCalledTimes(2);
    advance(2000); // 6s
    expect(onRepeat).toHaveBeenCalledTimes(3);
    advance(2000); // 8s
    expect(onRepeat).toHaveBeenCalledTimes(4);

    release(button());
    advance(6000);
    expect(onRepeat).toHaveBeenCalledTimes(4);
  });

  it("stops adding the instant the finger lifts", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button());
    advance(2100);
    expect(onRepeat).toHaveBeenCalledTimes(1);
    release(button());
    advance(20_000);

    expect(onRepeat).toHaveBeenCalledTimes(1);
  });

  it("does not fire the single-tap callback for a hold that added something", () => {
    const onPress = vi.fn();
    render(<HoldRepeatButton onRepeat={vi.fn()} onPress={onPress} onDoubleTap={vi.fn()} />);

    press(button());
    advance(2100);
    release(button());
    advance(2000); // past the double-tap window

    expect(onPress).not.toHaveBeenCalled();
  });

  it("ramps the real fill toward the next unit and resets it after each one", () => {
    render(<HoldRepeatButton onRepeat={vi.fn()} />);

    expect(fillProgress()).toBe(0);
    press(button());

    advance(1000);
    const half = fillProgress();
    expect(half).toBeGreaterThan(45);
    expect(half).toBeLessThan(55);

    // Crossing the 2s boundary banks a unit and restarts the ramp from empty,
    // so the button is always showing the climb toward the *next* unit.
    advance(1020);
    expect(fillProgress()).toBeLessThan(10);

    advance(1000);
    expect(fillProgress()).toBeGreaterThan(45);
  });

  it("empties the fill on release", () => {
    render(<HoldRepeatButton onRepeat={vi.fn()} />);

    press(button());
    advance(1000);
    expect(fillProgress()).toBeGreaterThan(0);

    release(button());
    expect(fillProgress()).toBe(0);
    expect(fill().style.width).toBe("0%");
  });
});

describe("HoldRepeatButton — two quick taps decrement", () => {
  it("runs the decrement, and never the single tap, for a pair inside the window", () => {
    const onDoubleTap = vi.fn();
    const onPress = vi.fn();
    const onRepeat = vi.fn();
    render(
      <HoldRepeatButton onRepeat={onRepeat} onPress={onPress} onDoubleTap={onDoubleTap} />,
    );

    tap(button());
    advance(100); // second tap well inside the 320ms window
    tap(button());
    advance(2000);

    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    expect(onRepeat).not.toHaveBeenCalled();
  });

  it("does not start two adds — a double tap is not two holds", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} onDoubleTap={vi.fn()} />);

    tap(button());
    advance(100);
    tap(button());
    advance(10_000);

    expect(onRepeat).not.toHaveBeenCalled();
  });

  it("treats two taps further apart than the window as two separate taps", () => {
    const onDoubleTap = vi.fn();
    const onPress = vi.fn();
    render(<HoldRepeatButton onRepeat={vi.fn()} onPress={onPress} onDoubleTap={onDoubleTap} />);

    tap(button());
    advance(500); // past doubleTapMs — the first tap has already resolved
    tap(button());
    advance(500);

    expect(onDoubleTap).not.toHaveBeenCalled();
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("does not pair a tap with a preceding hold", () => {
    const onDoubleTap = vi.fn();
    render(<HoldRepeatButton onRepeat={vi.fn()} onDoubleTap={onDoubleTap} />);

    press(button());
    advance(2100); // a hold, which added a unit
    release(button());
    advance(50);
    tap(button()); // a tap right after it
    advance(1000);

    expect(onDoubleTap).not.toHaveBeenCalled();
  });
});

describe("HoldRepeatButton — interruptions", () => {
  it("a cancelled pointer is neither an add nor a tap", () => {
    const onRepeat = vi.fn();
    const onPress = vi.fn();
    const onDoubleTap = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} onPress={onPress} onDoubleTap={onDoubleTap} />);

    press(button());
    advance(1000); // the browser decides this is a scroll
    release(button(), "pointercancel");
    advance(5000);

    expect(onRepeat).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();
    expect(fillProgress()).toBe(0);
  });

  it("the finger sliding off the button ends the hold", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button());
    advance(1000);
    release(button(), "pointerleave");
    advance(10_000);

    expect(onRepeat).not.toHaveBeenCalled();
  });

  it("ignores a second finger landing mid-hold", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button(), { pointerId: 1 });
    advance(500);
    press(button(), { pointerId: 2 });
    release(button(), "pointerup", { pointerId: 2 });
    advance(1600);

    // The owning hold ran its own 2s and added exactly one unit.
    expect(onRepeat).toHaveBeenCalledTimes(1);
  });

  it("ignores a right-click press", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button(), { pointerType: "mouse", button: 2 });
    advance(6000);

    expect(onRepeat).not.toHaveBeenCalled();
  });

  it("stops when the group's ceiling disables it mid-hold", () => {
    const onRepeat = vi.fn();
    const { rerender } = render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button());
    advance(2100);
    expect(onRepeat).toHaveBeenCalledTimes(1);

    // The parent hit max_select and disabled the option.
    act(() => {
      rerender(<HoldRepeatButton onRepeat={onRepeat} disabled />);
    });
    advance(10_000);

    expect(onRepeat).toHaveBeenCalledTimes(1);
    expect(fillProgress()).toBe(0);
  });

  it("does nothing at all while disabled", () => {
    const onRepeat = vi.fn();
    const onDoubleTap = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} onDoubleTap={onDoubleTap} disabled />);

    press(button());
    advance(6000);
    release(button());
    tap(button());
    advance(100);
    tap(button());
    advance(1000);

    expect(onRepeat).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("fires nothing after unmount, including a pending tap", () => {
    const onRepeat = vi.fn();
    const onPress = vi.fn();
    const { unmount } = render(
      <HoldRepeatButton onRepeat={onRepeat} onPress={onPress} onDoubleTap={vi.fn()} />,
    );

    press(button());
    advance(1000);
    release(button()); // a tap, now waiting out its double-tap window
    unmount();
    advance(20_000);

    expect(onRepeat).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it("survives repeated up events for one press without double-counting", () => {
    const onPress = vi.fn();
    render(<HoldRepeatButton onRepeat={vi.fn()} onPress={onPress} onDoubleTap={vi.fn()} />);

    press(button());
    advance(50);
    release(button());
    release(button()); // a duplicate the platform sometimes emits
    release(button());
    advance(1000);

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("HoldRepeatButton — keyboard", () => {
  it("increments on a held Space at the same cadence", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);
    const element = button();

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    advance(2000);
    settle();
    expect(onRepeat).toHaveBeenCalledTimes(1);
    advance(2000);
    expect(onRepeat).toHaveBeenCalledTimes(2);

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
    });
    advance(6000);
    expect(onRepeat).toHaveBeenCalledTimes(2);
  });

  it("adds nothing for a quick Space press", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);
    const element = button();

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    advance(100);
    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
    });
    advance(5000);

    expect(onRepeat).not.toHaveBeenCalled();
  });

  it("ignores the OS auto-repeat, so one physical key press is one hold", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);
    const element = button();

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    for (let elapsed = 0; elapsed < 2000; elapsed += 400) {
      advance(400);
      act(() => {
        element.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }),
        );
      });
    }
    settle();

    // Restarting the hold on each repeat would have added nothing at all.
    expect(onRepeat).toHaveBeenCalledTimes(1);
  });

  it("treats focus lost mid-hold as a release", () => {
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);
    const element = button();

    act(() => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    advance(1000);
    act(() => {
      element.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    });
    advance(8000);

    expect(onRepeat).not.toHaveBeenCalled();
  });
});

describe("HoldRepeatButton — haptics are a bonus, never a dependency", () => {
  it("buzzes once per increment and never per frame", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { vibrate }));
    render(<HoldRepeatButton onRepeat={vi.fn()} />);

    press(button());
    advance(1000);
    expect(vibrate).not.toHaveBeenCalled(); // mid-ramp: nothing was added

    advance(1020);
    expect(vibrate).toHaveBeenCalledTimes(1);
    advance(2000);
    expect(vibrate).toHaveBeenCalledTimes(2);
    advance(2000);
    expect(vibrate).toHaveBeenCalledTimes(3);
  });

  it("does not buzz for a tap", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { vibrate }));
    render(<HoldRepeatButton onRepeat={vi.fn()} onDoubleTap={vi.fn()} />);

    tap(button());
    advance(1000);

    expect(vibrate).not.toHaveBeenCalled();
  });

  it("increments identically on a device with no Vibration API", () => {
    expect("vibrate" in navigator).toBe(false);
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button());
    advance(2100);

    expect(onRepeat).toHaveBeenCalledTimes(1);
  });

  it("survives a vibrate() that throws", () => {
    const vibrate = vi.fn(() => {
      throw new Error("NotAllowedError");
    });
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { vibrate }));
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button());
    advance(2100);
    advance(2000);

    expect(onRepeat).toHaveBeenCalledTimes(2);
  });
});

describe("HoldRepeatButton — timing preference changes", () => {
  it("cancels a live gesture and uses the new repeat interval after a rerender", () => {
    const onRepeat = vi.fn();
    const { rerender } = render(<HoldRepeatButton intervalMs={2000} onRepeat={onRepeat} />);
    press(button());
    advance(1000);
    rerender(<HoldRepeatButton intervalMs={1000} onRepeat={onRepeat} />);
    release(button());
    advance(1100);
    expect(onRepeat).not.toHaveBeenCalled();

    press(button());
    advance(1020);
    expect(onRepeat).toHaveBeenCalledTimes(1);
  });
});

describe("HoldRepeatButton — reduced motion", () => {
  it("still ramps and still increments, with the smoothing dropped", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    window.matchMedia = globalThis.matchMedia;
    const onRepeat = vi.fn();
    render(<HoldRepeatButton onRepeat={onRepeat} />);

    press(button());
    advance(1000);
    expect(fillProgress()).toBeGreaterThan(45);
    expect(fill().style.transition).toBe("none");

    advance(1020);
    expect(onRepeat).toHaveBeenCalledTimes(1);
  });
});
