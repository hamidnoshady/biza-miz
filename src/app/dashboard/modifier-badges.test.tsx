// @vitest-environment jsdom

/**
 * The add-on chips are the smallest surface that still makes a money claim:
 * «شات اضافه ×۳» on a 20,000-Toman extra shot is 60,000 Toman, and the caption
 * describes one unit of the line. These tests pin both — a chip that showed
 * the unit delta beside «×۳» (or a caption that summed one delta per option)
 * is exactly the undercount issue #910 reported.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModifierBadges } from "./modifier-badges";

afterEach(cleanup);

describe("ModifierBadges — quantity and money agree", () => {
  it("shows ×N on a repeated add-on and its extended price", () => {
    render(
      <ModifierBadges
        modifiers={[{ name: "شات اضافه", priceDelta: 200_000, quantity: 3 }]}
      />,
    );

    const chip = screen.getByText("شات اضافه").closest("li");
    expect(chip?.textContent).toContain("×۳");
    // 3 × 20,000 Toman, not one.
    expect(chip?.textContent).toContain("۶۰٬۰۰۰");
    // The unit price is still named, so the extended number is not mistaken
    // for what each shot costs.
    expect(chip?.textContent).toContain("هر عدد");
    expect(chip?.textContent).toContain("۲۰٬۰۰۰");
  });

  it("sums the caption with every add-on's quantity", () => {
    render(
      <ModifierBadges
        modifiers={[
          { name: "شات اضافه", priceDelta: 200_000, quantity: 3 },
          { name: "شربت وانیل", priceDelta: 100_000, quantity: 1 },
        ]}
      />,
    );

    // 3 × 20,000 + 10,000 = 70,000 Toman on each unit.
    const caption = screen.getByText(/افزودنی‌ها/);
    expect(caption.textContent).toContain("۷۰٬۰۰۰");
    expect(caption.textContent).toContain("روی هر واحد");
  });

  it("keeps a quantity-one add-on to one delta", () => {
    render(
      <ModifierBadges
        modifiers={[{ name: "شربت وانیل", priceDelta: 100_000 }]}
      />,
    );

    const chip = screen.getByText("شربت وانیل").closest("li");
    expect(chip?.textContent).not.toContain("×");
    expect(chip?.textContent).toContain("۱۰٬۰۰۰");
  });

  it("calls a free add-on free even at quantity > 1", () => {
    render(
      <ModifierBadges
        modifiers={[{ name: "بدون شکر", priceDelta: 0, quantity: 2 }]}
      />,
    );

    const chip = screen.getByText("بدون شکر").closest("li");
    expect(chip?.textContent).toContain("×۲");
    expect(chip?.textContent).toContain("رایگان");
    expect(chip?.textContent).not.toContain("۰ تومان");
  });

  it("prices a negative add-on with its sign, extended", () => {
    render(
      <ModifierBadges
        modifiers={[{ name: "تخفیف شیر", priceDelta: -50_000, quantity: 2 }]}
      />,
    );

    const chip = screen.getByText("تخفیف شیر").closest("li");
    // 2 × −5,000 Toman.
    expect(chip?.textContent).toContain("−۱۰٬۰۰۰");
  });
});
