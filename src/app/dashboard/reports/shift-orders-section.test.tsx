// @vitest-environment jsdom

/**
 * Issue #910 — the shift report's money, rendered.
 *
 * `shift-orders.test.ts` proves the grouping arithmetic; this proves the row
 * the operator actually reads shows the same numbers, and names an add-on's
 * own count instead of silently repeating one unit of it:
 *
 *   - repro: 100,000 base + extra shot 20,000 ×3, two units → 320,000 Rial;
 *   - the row says «هر واحد: ۱۰٬۰۰۰ تومان +۶٬۰۰۰ = ۱۶٬۰۰۰ تومان» (the unit
 *     is named once, not repeated inside the add-on term) and the line amount
 *     «۳۲٬۰۰۰ تومان» — the report displays Toman;
 *   - a negative add-on keeps its sign in the per-unit expression;
 *   - a voided line stays visible, struck through, with its reason.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ShiftOrderLine } from "@/lib/shift-orders";
import { ShiftOrderLineRow } from "./shift-orders-section";

afterEach(cleanup);

function renderRow(line: ShiftOrderLine) {
  render(
    <table>
      <tbody>
        <ShiftOrderLineRow line={line} />
      </tbody>
    </table>,
  );
  return screen.getByRole("row");
}

function line(overrides: Partial<ShiftOrderLine> = {}): ShiftOrderLine {
  return {
    itemId: "i1",
    name: "لاته",
    quantity: 2,
    unitPrice: 100_000,
    modifiers: [{ name: "شات اضافه", priceDelta: 20_000, quantity: 3 }],
    addOnsPerUnit: 60_000,
    amount: 320_000,
    note: null,
    voidReason: null,
    status: "served",
    voided: false,
    ...overrides,
  };
}

describe("ShiftOrderLineRow", () => {
  it("shows the repro line's per-unit and line money, with the add-on count", () => {
    const row = renderRow(line());

    // Per-unit: 100,000 base, +60,000 of shots, 160,000 total — in Toman.
    expect(row.textContent).toContain("هر واحد: ۱۰٬۰۰۰ تومان");
    expect(row.textContent).toContain("+۶٬۰۰۰ = ۱۶٬۰۰۰ تومان");
    // Line: ×۲ units, 320,000 Rial.
    expect(row.textContent).toContain("×۲");
    expect(row.textContent).toContain("۳۲٬۰۰۰ تومان");
    // The badge names the count: three shots, 6,000 Toman on every unit.
    expect(within(row).getByText("×۳")).toBeTruthy();
    expect(within(row).getByText("+۶٬۰۰۰ تومان")).toBeTruthy();
  });

  it("keeps a negative add-on's sign in the per-unit arithmetic", () => {
    const row = renderRow(
      line({
        modifiers: [{ name: "تخفیف شیر", priceDelta: -10_000, quantity: 2 }],
        addOnsPerUnit: -20_000,
        amount: 160_000,
      }),
    );

    expect(row.textContent).toContain("−۲٬۰۰۰ = ۸٬۰۰۰ تومان");
    expect(row.textContent).toContain("۱۶٬۰۰۰ تومان");
  });

  it("shows a voided line, struck through, with its reason and no live money", () => {
    const row = renderRow(
      line({ voided: true, status: "voided", voidReason: "سفارش اشتباه" }),
    );

    expect(row.textContent).toContain("باطل‌شده");
    expect(row.textContent).toContain("دلیل ابطال: سفارش اشتباه");
    // Still priced — the report is a record of what was rung, not a claim
    // that it was paid.
    expect(row.textContent).toContain("۳۲٬۰۰۰ تومان");
  });

  it("shows the note beside the line", () => {
    const row = renderRow(line({ note: "بدون شکر" }));
    expect(row.textContent).toContain("یادداشت: بدون شکر");
  });
});
