// @vitest-environment jsdom

/**
 * «کدام ترکیب؟» — issue #910's outside-card affordance.
 *
 * A product the cart holds in two shapes could only be corrected by finding
 * the right card in the cart list; the tile's stepper cannot say which shape
 * it touches. These tests exercise the chooser the way a cashier does: read
 * each configuration's add-ons and full line total, grow one of them, and open
 * its add-ons — asserting the callback targets *that* line, not its sibling.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductConfigurationsSheet } from "./product-configurations-sheet";
import type { PosCartLine } from "@/lib/pos-cart";

afterEach(cleanup);

function line(overrides: Partial<PosCartLine> & { key: string }): PosCartLine {
  return {
    menuItemId: "coffee",
    name: "لاته",
    unitPrice: 100_000,
    quantity: 1,
    taxRatePercent: 0,
    modifierPicks: [],
    modifiers: [],
    note: "",
    ...overrides,
  };
}

const PLAIN = line({ key: "l-plain" });
const CHOCOLATE = line({
  key: "l-choc",
  quantity: 2,
  modifierPicks: [{ id: "choc", quantity: 1 }],
  modifiers: [{ name: "شکلات", priceDelta: 20_000, quantity: 1 }],
});
const THREE_SHOTS = line({
  key: "l-shot",
  modifierPicks: [{ id: "shot", quantity: 3 }],
  modifiers: [{ name: "شات اضافه", priceDelta: 20_000, quantity: 3 }],
});

function renderSheet(lines: PosCartLine[]) {
  const onEdit = vi.fn();
  const onStep = vi.fn();
  const onNew = vi.fn();
  const onClose = vi.fn();
  render(
    <ProductConfigurationsSheet
      itemName="لاته"
      lines={lines}
      onEdit={onEdit}
      onStep={onStep}
      onNew={onNew}
      onClose={onClose}
    />,
  );
  return { onEdit, onStep, onNew, onClose };
}

describe("ProductConfigurationsSheet — one row per configuration", () => {
  it("lists every configuration with its add-ons and money", () => {
    renderSheet([PLAIN, CHOCOLATE, THREE_SHOTS]);

    expect(screen.getByText(/ترکیب ۱/)).toBeTruthy();
    expect(screen.getByText(/ترکیب ۲/)).toBeTruthy();
    expect(screen.getByText(/ترکیب ۳/)).toBeTruthy();
    // The plain row says so, so an empty chip area is never read as a bug.
    expect(screen.getByText("(بدون افزودنی)")).toBeTruthy();
    // «شکلات» and the extended «شات اضافه ×۳» both appear.
    expect(screen.getByText("شکلات")).toBeTruthy();
    expect(screen.getByText(/شات اضافه/)).toBeTruthy();
    expect(screen.getByText(/×۳/)).toBeTruthy();
  });

  it("prices each configuration on its own (the 320,000 Rial repro)", () => {
    // 2 × (100,000 + 20,000) = 24,000 Toman; 1 × (100,000 + 3×20,000) = 16,000.
    renderSheet([PLAIN, CHOCOLATE, THREE_SHOTS]);

    expect(screen.getByText("۲۴٬۰۰۰ تومان")).toBeTruthy();
    expect(screen.getByText("۱۶٬۰۰۰ تومان")).toBeTruthy();
    // The plain configuration stays at the menu price.
    expect(screen.getByText("۱۰٬۰۰۰ تومان")).toBeTruthy();
  });

  it("grows the configuration whose + was pressed, by key", async () => {
    const user = userEvent.setup();
    const { onStep } = renderSheet([PLAIN, CHOCOLATE]);

    await user.click(
      screen.getByRole("button", { name: /افزایش ترکیب ۲ از لاته/ }),
    );

    expect(onStep).toHaveBeenCalledTimes(1);
    expect(onStep).toHaveBeenCalledWith("l-choc", 1);
  });

  it("decrements the configuration whose − was pressed", async () => {
    const user = userEvent.setup();
    const { onStep } = renderSheet([PLAIN, CHOCOLATE]);

    await user.click(
      screen.getByRole("button", { name: /کاهش ترکیب ۱ از لاته/ }),
    );

    expect(onStep).toHaveBeenCalledWith("l-plain", -1);
  });

  it("opens the add-ons of the chosen configuration, not its sibling", async () => {
    const user = userEvent.setup();
    const { onEdit } = renderSheet([PLAIN, CHOCOLATE]);

    await user.click(
      screen.getByRole("button", { name: /ویرایش افزودنی‌های ترکیب ۲ از لاته/ }),
    );

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith("l-choc");
  });

  it("offers a new configuration and a plain close", async () => {
    const user = userEvent.setup();
    const { onNew, onClose } = renderSheet([PLAIN, CHOCOLATE]);

    await user.click(screen.getByRole("button", { name: /ترکیب جدید/ }));
    await user.click(screen.getByRole("button", { name: "بستن فهرست" }));

    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders one row per line even when the caller passes a single line", () => {
    renderSheet([CHOCOLATE]);
    // Add-on chips are their own list items, so count the rows by their label.
    const rows = screen
      .getAllByRole("listitem")
      .filter((node) => node.getAttribute("aria-label")?.startsWith("ترکیب "));
    expect(rows).toHaveLength(1);
  });
});
