// @vitest-environment jsdom

/**
 * The cart card is where the cashier checks the line's money before taking
 * payment. Its total must be (base + Σ delta × add-on count) × product count —
 * the same number the picker promised and the server persists.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CartLineCard, type CartLineCardData } from "./cart-line-card";

afterEach(cleanup);

function line(overrides: Partial<CartLineCardData> = {}): CartLineCardData {
  return {
    key: "l1",
    name: "لاته",
    unitPrice: 100_000,
    quantity: 1,
    modifiers: [],
    note: "",
    ...overrides,
  };
}

const noop = vi.fn();

describe("CartLineCard — quantity-aware line total", () => {
  it("prices base 100,000 + shot 20,000 ×3, two units, at 320,000", () => {
    render(
      <CartLineCard
        line={line({
          quantity: 2,
          modifiers: [
            { name: "شات اضافه", priceDelta: 20_000, quantity: 3 },
          ],
        })}
        onStep={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    );

    // 32,000 Toman, the issue's repro number.
    expect(screen.getByText(/۳۲٬۰۰۰/)).toBeTruthy();
    expect(screen.getByText(/شات اضافه/)).toBeTruthy();
    expect(screen.getByText("×۳")).toBeTruthy();
  });

  it("leaves a plain line at its menu price × quantity", () => {
    render(
      <CartLineCard
        line={line({ quantity: 3 })}
        onStep={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    );

    expect(screen.getByText((_, el) => el?.textContent === "۳۰٬۰۰۰ تومان")).toBeTruthy();
    expect(screen.getByText(/برای هر واحد/).textContent).toContain("۱۰٬۰۰۰");
  });

  it("shows a negative add-on lowering the unit and line price", () => {
    render(
      <CartLineCard
        line={line({
          quantity: 1,
          modifiers: [{ name: "تخفیف شیر", priceDelta: -50_000, quantity: 1 }],
        })}
        onStep={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    );

    // 100,000 − 50,000 = 50,000 Rial → 5,000 Toman.
    // Both the per-unit price and the line total are 5,000 Toman here.
    expect(
      screen.getAllByText((_, el) => el?.textContent === "۵٬۰۰۰ تومان"),
    ).toHaveLength(2);
  });
});
