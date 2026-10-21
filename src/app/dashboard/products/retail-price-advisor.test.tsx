// @vitest-environment jsdom

/**
 * Issue #924, code-review item 3 — «اعمال قیمت پیشنهادی» changes the form's
 * draft and nothing else.
 *
 * The advisor must not write anything: no price row, no audit row, no request.
 * The suggestion only becomes data when the user saves the product, and the
 * metadata it hands to the form is what the server later uses to decide whether
 * the saved price really was the suggestion (see the integration test for the
 * server side).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetailPriceAdvisor } from "./product-add-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAdvisor(onApply = vi.fn(), purchasePrice = "100000") {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(
    <RetailPriceAdvisor purchasePrice={purchasePrice} sellPrice="" onApply={onApply} unitLabel="تومان" />,
  );
  return { onApply, fetchMock };
}

describe("RetailPriceAdvisor", () => {
  it("preview and apply never write: no request, only the draft callback", () => {
    const { onApply, fetchMock } = renderAdvisor();

    fireEvent.change(screen.getByLabelText(/نشانه‌گذاری markup/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش محاسبه" }));
    expect(screen.getByText(/^قیمت پیشنهادی:/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /اعمال قیمت پیشنهادی/ }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledTimes(1);
    const [value, recommendation] = onApply.mock.calls[0] as [
      string,
      { suggestedPriceRial: number; mode: string; inputs: Record<string, unknown> },
    ];
    expect(Number(value.replace(/[^\d]/g, ""))).toBeGreaterThan(0);
    expect(recommendation.mode).toBe("markup");
    expect(recommendation.suggestedPriceRial).toBeGreaterThan(0);
    // The inputs travel with the suggestion so the audit row can reproduce it.
    expect(recommendation.inputs).toMatchObject({
      referenceCostRial: 1_000_000,
      markupPercent: 20,
      rounding: "nearest",
    });
  });

  it("keeps no-extra-rounding recommendations representable in whole Toman inputs", () => {
    const { onApply } = renderAdvisor(vi.fn(), "101");

    fireEvent.change(screen.getByLabelText(/نشانه‌گذاری markup/), { target: { value: "5" } });
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش محاسبه" }));
    fireEvent.click(screen.getByRole("button", { name: /اعمال قیمت پیشنهادی/ }));

    const [appliedValue, recommendation] = onApply.mock.calls[0] as [
      string,
      { suggestedPriceRial: number; inputs: Record<string, unknown> },
    ];
    expect(Number(appliedValue) * 10).toBe(recommendation.suggestedPriceRial);
    expect(recommendation.suggestedPriceRial).toBe(1_060);
    expect(recommendation.inputs).toMatchObject({
      rounding: "nearest",
      roundingSelection: "none",
      roundStepRial: 10,
    });
  });

  it("applies an exclusive-tax recommendation as the pre-tax product price", () => {
    const { onApply } = renderAdvisor(vi.fn(), "100000");

    fireEvent.change(screen.getByLabelText(/نشانه‌گذاری markup/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("مالیات فروش (%)"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش محاسبه" }));
    expect(screen.getByText(/^قیمت پیشنهادی:/).textContent).toContain("۱۱۰۰۰۰ تومان");
    expect(screen.getByText(/قابل پرداخت:/).textContent).toContain("۱۲۱۰۰۰ تومان");

    fireEvent.click(screen.getByRole("button", { name: /اعمال قیمت پیشنهادی/ }));
    const [appliedValue, recommendation] = onApply.mock.calls[0] as [
      string,
      { suggestedPriceRial: number },
    ];
    expect(appliedValue).toBe("110000");
    expect(recommendation.suggestedPriceRial).toBe(1_100_000);
  });

  it("records margin mode when the margin field drives the calculation", () => {
    const { onApply } = renderAdvisor();

    fireEvent.change(screen.getByLabelText(/حاشیه سود margin/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش محاسبه" }));
    fireEvent.click(screen.getByRole("button", { name: /اعمال قیمت پیشنهادی/ }));

    const [, recommendation] = onApply.mock.calls[0] as [string, { mode: string; inputs: Record<string, unknown> }];
    expect(recommendation.mode).toBe("margin");
    expect(recommendation.inputs).toMatchObject({ marginPercent: 20, markupPercent: null });
  });
});
