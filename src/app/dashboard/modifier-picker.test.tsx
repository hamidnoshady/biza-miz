// @vitest-environment jsdom

/**
 * The add-on picker driven by the gesture, end to end.
 *
 * hold-repeat-button.test.tsx proves the *button* fires the right callbacks at
 * the right moments. This file proves the picker does the right thing with
 * them — that a hold really persists a quantity, that the group's ceiling is
 * honoured by the hold and not merely by a disabled attribute, that two taps
 * take one off and zero unselects, and that the quantity the hold built is
 * what comes back out of «افزودن» to be priced and saved.
 *
 * That last part is the reason this is a separate file: the item-level
 * consequences (group min/max, pricing, what the caller receives) live here,
 * not in the button.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModifierGroupWithModifiers } from "./modifier-picker";
import { ModifierPicker } from "./modifier-picker";

/** The dialog primitive animates and portals; neither matters to these assertions. */
beforeEach(() => {
  vi.useFakeTimers();
  // The picker fetches this item's past notes on mount. Nothing here depends
  // on them, and an unhandled rejection would fail the run.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ notes: [] }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function press(element: Element) {
  act(() => {
    element.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }),
    );
  });
}

function release(element: Element) {
  act(() => {
    element.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  });
}

/** Hold an option for `ms`, then let go — the add gesture. */
function hold(element: Element, ms: number) {
  press(element);
  advance(ms);
  release(element);
}

/** Tap an option — which by contract must add nothing. */
function tap(element: Element) {
  press(element);
  advance(40);
  release(element);
}

function option(name: string): HTMLElement {
  const match = screen
    .getAllByRole("button")
    .find((element) => element.getAttribute("aria-label")?.startsWith(`${name}،`));
  if (!match) throw new Error(`no option button for ${name}`);
  return match;
}

function group(
  overrides: Partial<ModifierGroupWithModifiers> = {},
): ModifierGroupWithModifiers {
  return {
    id: "g1",
    name: "افزودنی‌ها",
    minSelect: 0,
    maxSelect: 3,
    modifiers: [
      { id: "m1", groupId: "g1", name: "شات اضافه", priceDelta: 20000, isActive: true, sortOrder: 1 },
      { id: "m2", groupId: "g1", name: "شربت وانیل", priceDelta: 10000, isActive: true, sortOrder: 2 },
    ],
    ...overrides,
  };
}

function setup(groups: ModifierGroupWithModifiers[] = [group()]) {
  const onConfirm = vi.fn();
  render(
    <ModifierPicker
      itemName="لاته"
      itemPrice={100000}
      groups={groups}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm };
}

/** Presses «افزودن» and returns the picks the picker handed back. */
function confirmPicks(onConfirm: ReturnType<typeof vi.fn>) {
  const cta = screen
    .getAllByRole("button")
    .find((element) => element.textContent?.startsWith("افزودن —"));
  if (!cta) throw new Error("confirm button is not enabled");
  act(() => {
    cta.click();
  });
  return onConfirm.mock.calls.at(-1)?.[0] as { id: string; quantity: number }[];
}

describe("ModifierPicker — the hold builds the quantity", () => {
  it("adds nothing on a tap", () => {
    const { onConfirm } = setup();

    tap(option("شات اضافه"));
    advance(1000);

    expect(option("شات اضافه").getAttribute("aria-pressed")).toBe("false");
    expect(confirmPicks(onConfirm)).toEqual([]);
  });

  it("selects one unit after a 2-second hold", () => {
    const { onConfirm } = setup();

    hold(option("شات اضافه"), 2100);

    expect(option("شات اضافه").getAttribute("aria-pressed")).toBe("true");
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);
  });

  it("reaches 2 at 4 seconds and 3 at 6 seconds in one hold", () => {
    const { onConfirm } = setup();

    press(option("شات اضافه"));
    advance(2100);
    expect(option("شات اضافه").getAttribute("aria-label")).toContain("۱ عدد انتخاب شده");
    advance(2000);
    expect(option("شات اضافه").getAttribute("aria-label")).toContain("۲ عدد انتخاب شده");
    advance(2000);
    expect(option("شات اضافه").getAttribute("aria-label")).toContain("۳ عدد انتخاب شده");
    release(option("شات اضافه"));

    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 3 }]);
  });

  it("shows the running quantity on the button face", () => {
    setup();

    press(option("شات اضافه"));
    advance(4100);
    release(option("شات اضافه"));

    expect(option("شات اضافه").textContent).toContain("×۲");
  });

  it("prices the held quantity, not one unit", () => {
    setup();

    press(option("شات اضافه"));
    advance(4100);
    release(option("شات اضافه"));

    // 100,000 base + 2 × 20,000 add-ons = 140,000 Rial → 14,000 Toman.
    const cta = screen
      .getAllByRole("button")
      .find((element) => element.textContent?.startsWith("افزودن —"));
    expect(cta?.textContent).toContain("۱۴٬۰۰۰");
  });
});

describe("ModifierPicker — the group's ceiling", () => {
  it("stops the hold adding past max_select", () => {
    const { onConfirm } = setup([group({ maxSelect: 2 })]);

    press(option("شات اضافه"));
    advance(10_000); // long enough for five increments
    release(option("شات اضافه"));

    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 2 }]);
  });

  it("counts total units across options, not the number of options chosen", () => {
    const { onConfirm } = setup([group({ maxSelect: 3 })]);

    press(option("شات اضافه"));
    advance(4100); // ×۲
    release(option("شات اضافه"));
    press(option("شربت وانیل"));
    advance(6100); // only one unit of budget is left
    release(option("شربت وانیل"));

    expect(confirmPicks(onConfirm)).toEqual([
      { id: "m1", quantity: 2 },
      { id: "m2", quantity: 1 },
    ]);
  });

  it("holds exactly one unit in a single-choice group, and switches rather than stacks", () => {
    const { onConfirm } = setup([group({ minSelect: 1, maxSelect: 1, name: "اندازه" })]);

    press(option("شات اضافه"));
    advance(8000);
    release(option("شات اضافه"));
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);

    hold(option("شربت وانیل"), 2100);
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m2", quantity: 1 }]);
  });

  it("keeps «افزودن» blocked until a required group is answered", () => {
    setup([group({ minSelect: 1, maxSelect: 2 })]);

    const cta = screen
      .getAllByRole("button")
      .find((element) => element.textContent?.includes("ابتدا گروه‌های الزامی"));
    expect((cta as HTMLButtonElement).disabled).toBe(true);

    hold(option("شات اضافه"), 2100);

    expect(
      screen.getAllByRole("button").some((element) => element.textContent?.startsWith("افزودن —")),
    ).toBe(true);
  });
});

describe("ModifierPicker — two quick taps take one off", () => {
  it("decrements a chosen option", () => {
    const { onConfirm } = setup();

    press(option("شات اضافه"));
    advance(6100); // ×۳
    release(option("شات اضافه"));

    tap(option("شات اضافه"));
    advance(100);
    tap(option("شات اضافه"));
    advance(500);

    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 2 }]);
  });

  it("unselects the option entirely at zero", () => {
    const { onConfirm } = setup();

    hold(option("شات اضافه"), 2100);
    expect(option("شات اضافه").getAttribute("aria-pressed")).toBe("true");

    tap(option("شات اضافه"));
    advance(100);
    tap(option("شات اضافه"));
    advance(500);

    expect(option("شات اضافه").getAttribute("aria-pressed")).toBe("false");
    expect(confirmPicks(onConfirm)).toEqual([]);
  });

  it("does nothing when the option holds no units", () => {
    const { onConfirm } = setup();

    tap(option("شربت وانیل"));
    advance(100);
    tap(option("شربت وانیل"));
    advance(500);

    expect(confirmPicks(onConfirm)).toEqual([]);
  });

  it("still decrements at the ceiling — the option stays usable when the group is full", () => {
    const { onConfirm } = setup([group({ maxSelect: 2 })]);

    press(option("شات اضافه"));
    advance(4100); // the group is now full
    release(option("شات اضافه"));
    expect((option("شات اضافه") as HTMLButtonElement).disabled).toBe(false);

    tap(option("شات اضافه"));
    advance(100);
    tap(option("شات اضافه"));
    advance(500);

    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);
  });

  it("disables an empty option once the group is full — neither gesture could do anything", () => {
    setup([group({ maxSelect: 2 })]);

    press(option("شات اضافه"));
    advance(4100);
    release(option("شات اضافه"));

    expect((option("شربت وانیل") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ModifierPicker — the accessible alternative", () => {
  it("offers a real decrement button for every chosen option", () => {
    const { onConfirm } = setup();

    press(option("شات اضافه"));
    advance(4100);
    release(option("شات اضافه"));

    const minus = screen.getByLabelText("کاهش شات اضافه، اکنون ۲ عدد");
    act(() => {
      minus.click();
    });

    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);
  });

  it("names the gesture in every option's accessible label and once per group", () => {
    setup();

    expect(option("شات اضافه").getAttribute("aria-label")).toContain("۲ ثانیه نگه دارید");
    expect(screen.getAllByText(/۲ ثانیه نگه دارید/).length).toBeGreaterThan(0);
  });
});

describe("ModifierPicker — visible − / count / + controls", () => {
  it("adds a unit with a plain click on +, without any hold or tap gesture", () => {
    const { onConfirm } = setup();

    act(() => {
      screen.getByLabelText("افزودن یک شات اضافه").click();
    });

    expect(option("شات اضافه").getAttribute("aria-pressed")).toBe("true");
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);
  });

  it("raises the count to the group's ceiling and then disables +", () => {
    const { onConfirm } = setup([group({ maxSelect: 2 })]);
    const plus = screen.getByLabelText("افزودن یک شات اضافه");

    act(() => {
      plus.click();
      plus.click();
    });

    expect((plus as HTMLButtonElement).disabled).toBe(true);
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 2 }]);
  });

  it("decrements and unselects from the always-visible − button", () => {
    const { onConfirm } = setup();

    act(() => {
      screen.getByLabelText("افزودن یک شات اضافه").click();
      screen.getByLabelText("افزودن یک شات اضافه").click();
    });
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 2 }]);

    act(() => {
      screen.getByLabelText("کاهش شات اضافه، اکنون ۲ عدد").click();
    });
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);

    act(() => {
      screen.getByLabelText("کاهش شات اضافه، اکنون ۱ عدد").click();
    });
    expect(option("شات اضافه").getAttribute("aria-pressed")).toBe("false");
    expect(confirmPicks(onConfirm)).toEqual([]);
  });

  it("shows the count and keeps − disabled while the option holds nothing", () => {
    setup();

    expect(screen.getByLabelText("۰ عدد از شات اضافه")).toBeTruthy();
    expect(
      (screen.getByLabelText("کاهش شات اضافه") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("switches a single-choice group with + instead of stacking", () => {
    const { onConfirm } = setup([
      group({ minSelect: 1, maxSelect: 1, name: "اندازه" }),
    ]);

    act(() => {
      screen.getByLabelText("افزودن یک شات اضافه").click();
    });
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);

    act(() => {
      screen.getByLabelText("افزودن یک شربت وانیل").click();
    });
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m2", quantity: 1 }]);
    // The previous choice is gone, not stacked beside it.
    expect(option("شات اضافه").getAttribute("aria-pressed")).toBe("false");
  });

  it("does not double count when + is pressed while a hold is in flight", () => {
    const { onConfirm } = setup();

    press(option("شات اضافه"));
    advance(2100); // the hold added one
    act(() => {
      screen.getByLabelText("افزودن یک شات اضافه").click();
    });
    release(option("شات اضافه"));

    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 2 }]);
  });
});

/**
 * Issue #910 — the count paths must agree. A double-click is two adds (each a
 * real click), a hold that already added is never re-read as a tap on release,
 * and the item count and the add-on count are independent numbers that only
 * meet in the line total.
 */
function setupWithQuantity(
  groups: ModifierGroupWithModifiers[] = [group()],
  quantity = 1,
) {
  const onConfirm = vi.fn();
  render(
    <ModifierPicker
      itemName="لاته"
      itemPrice={100000}
      selectQuantity
      quantity={quantity}
      groups={groups}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm };
}

describe("ModifierPicker — the two counts are independent", () => {
  it("counts a double-click on + as two units, not one", () => {
    const { onConfirm } = setup();
    const plus = screen.getByLabelText("افزودن یک شات اضافه");

    act(() => {
      plus.click();
      plus.click();
    });

    expect(screen.getByLabelText("۲ عدد از شات اضافه")).toBeTruthy();
    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 2 }]);
  });

  it("never re-reads a hold that added units as a tap or double tap", () => {
    const { onConfirm } = setup([group({ maxSelect: 5 })]);

    hold(option("شات اضافه"), 2100);
    // Past the double-tap window: if the release were also decoded as a tap
    // pair, this is where the decrement would land.
    advance(900);

    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);
    expect(screen.getByLabelText("۱ عدد از شات اضافه")).toBeTruthy();
  });

  it("moves the add-on count and the item count without touching each other", () => {
    const { onConfirm } = setupWithQuantity();

    act(() => {
      screen.getByLabelText("افزایش تعداد").click();
    });
    act(() => {
      screen.getByLabelText("افزودن یک شات اضافه").click();
    });

    // ۲ عدد از آیتم، ۱ عدد از افزودنی — and the money is their product.
    expect(screen.getByLabelText("۱ عدد از شات اضافه")).toBeTruthy();
    expect(screen.getByText("افزودنی‌ها (۱ عدد)")).toBeTruthy();
    // (100,000 + 20,000) × 2
    expect(screen.getByText("۲۴٬۰۰۰ تومان")).toBeTruthy();

    expect(confirmPicks(onConfirm)).toEqual([{ id: "m1", quantity: 1 }]);
    expect(onConfirm.mock.calls.at(-1)?.[2]).toBe(2);
  });

  it("stops the item count at MAX_ORDER_LINE_QUANTITY", () => {
    setupWithQuantity();
    const plus = screen.getByLabelText("افزایش تعداد") as HTMLButtonElement;

    act(() => {
      for (let index = 0; index < 60; index += 1) plus.click();
    });

    expect(plus.disabled).toBe(true);
    // The count sits between − and + inside the footer stepper.
    expect(screen.getByLabelText("کاهش تعداد").parentElement?.textContent).toContain("۵۰");
  });
});

/**
 * Issue #910 — editing an existing line must return what it started with.
 *
 * The open-order editor reopens the picker on a sold line: the add-ons come
 * back as `initialModifiers` with their own quantities, the note as
 * `initialNote`, and the item count is the line's own (`selectQuantity` is
 * off, so the picker cannot change it). Nothing may be lost or reset: a
 * change to one option keeps the others' counts, and confirming an untouched
 * line hands back the same selection.
 */
function setupEdit() {
  const onConfirm = vi.fn();
  render(
    <ModifierPicker
      itemName="لاته"
      itemPrice={100000}
      quantity={2}
      groups={[group({ maxSelect: 5 })]}
      initialModifiers={[
        { id: "m1", quantity: 3 },
        { id: "m2", quantity: 2 },
      ]}
      initialNote="بدون شکر"
      confirmLabel="ذخیرهٔ افزودنی‌ها"
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm };
}

describe("ModifierPicker — reopening an existing line", () => {
  it("shows the saved add-on counts, the note and the item count", () => {
    setupEdit();

    expect(screen.getByLabelText("۳ عدد از شات اضافه")).toBeTruthy();
    expect(screen.getByLabelText("۲ عدد از شربت وانیل")).toBeTruthy();
    expect(screen.getByText("«بدون شکر»")).toBeTruthy();
    // Item count is the line's own and has no stepper here.
    expect(screen.queryByLabelText("افزایش تعداد")).toBeNull();
    // 2 × (100,000 + 3×20,000 + 2×10,000)
    expect(screen.getByText("۳۶٬۰۰۰ تومان")).toBeTruthy();
  });

  it("hands the same selection, note and count back when saved untouched", () => {
    const { onConfirm } = setupEdit();

    act(() => {
      screen
        .getAllByRole("button")
        .find((button) => button.textContent?.startsWith("ذخیرهٔ افزودنی‌ها"))
        ?.click();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [picks, note, quantity] = onConfirm.mock.calls[0];
    expect(picks).toEqual([
      { id: "m1", quantity: 3 },
      { id: "m2", quantity: 2 },
    ]);
    expect(note).toBe("بدون شکر");
    expect(quantity).toBe(2);
  });

  it("changes one option without disturbing the other's count", () => {
    const { onConfirm } = setupEdit();

    act(() => {
      screen.getByLabelText("کاهش شات اضافه، اکنون ۳ عدد").click();
    });
    act(() => {
      screen
        .getAllByRole("button")
        .find((button) => button.textContent?.startsWith("ذخیرهٔ افزودنی‌ها"))
        ?.click();
    });

    const [picks] = onConfirm.mock.calls[0];
    expect(picks).toEqual([
      { id: "m1", quantity: 2 },
      { id: "m2", quantity: 2 },
    ]);
  });
});
