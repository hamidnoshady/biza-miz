// @vitest-environment jsdom

/**
 * The New Product «پیشنهاد قیمت فروش» panel (issue #924, code-review item 3,
 * and the follow-up that moved the global policy into settings).
 *
 * The business-wide figures — overhead, profit target, rounding, tax basis — are
 * read from `/api/settings/retail-pricing`; the panel itself offers only the
 * per-product overhead/profit overrides and one action: apply the suggestion.
 * Applying changes the form's draft and nothing else. No price row, no audit
 * row, no write request: the suggestion only becomes data when the product is
 * saved, and the metadata handed to the form is what the server later uses to
 * decide whether the saved price really was the suggestion.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETAIL_PRICING_POLICY, type RetailPricingPolicy } from "@/lib/retail-pricing-policy";
import { RetailPriceAdvisor } from "./retail-price-advisor";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const POLICY: RetailPricingPolicy = {
  ...DEFAULT_RETAIL_PRICING_POLICY,
  profitMode: "markup",
  profitPercent: 20,
  rounding: "nearest",
  roundStepRial: 10_000,
};

async function renderAdvisor({
  policy = POLICY,
  purchasePrice = "100000",
  taxSalePercent = "",
  defaultTaxPercent = null,
  onApply = vi.fn(),
}: {
  policy?: RetailPricingPolicy;
  purchasePrice?: string;
  taxSalePercent?: string;
  defaultTaxPercent?: number | null;
  onApply?: ReturnType<typeof vi.fn>;
} = {}) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ policy, defaultTaxPercent }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <RetailPriceAdvisor
      purchasePrice={purchasePrice}
      sellPrice=""
      taxSalePercent={taxSalePercent}
      onApply={onApply}
    />,
  );
  // The policy arrives asynchronously; the summary list is the first thing that needs it.
  await screen.findByLabelText("تنظیمات قیمت‌گذاری کسب‌وکار");
  return { onApply, fetchMock };
}

function openOverrides() {
  fireEvent.click(screen.getByRole("button", { name: /سربار یا سود اختصاصی برای این محصول/ }));
}

describe("RetailPriceAdvisor", () => {
  it("suggests from the business policy and applying it never writes", async () => {
    const { onApply, fetchMock } = await renderAdvisor();

    // 100,000 Toman + 20% markup = 120,000, a multiple of the 1,000-Toman step.
    const suggestion = screen.getByText("قیمت فروش پیشنهادی").parentElement?.textContent ?? "";
    expect(suggestion).toContain("۱۲۰٬۰۰۰ تومان");
    // The unit is said once.
    expect(suggestion).not.toMatch(/تومان\s*تومان/);

    fireEvent.click(screen.getByRole("button", { name: "اعمال قیمت پیشنهادی" }));

    // The only request is the read of the policy.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/settings/retail-pricing");
    expect(onApply).toHaveBeenCalledTimes(1);
    const [value, recommendation] = onApply.mock.calls[0] as [
      string,
      { suggestedPriceRial: number; mode: string; inputs: Record<string, unknown> },
    ];
    expect(value).toBe("120000");
    expect(recommendation.mode).toBe("markup");
    expect(recommendation.suggestedPriceRial).toBe(1_200_000);
    // The inputs travel with the suggestion so the audit row can reproduce it,
    // and say that nothing was overridden for this product.
    expect(recommendation.inputs).toMatchObject({
      referenceCostRial: 1_000_000,
      markupPercent: 20,
      rounding: "nearest",
      profitSource: "policy",
      overheadSource: "policy",
    });
  });

  it("offers no global setting on the product form — only overrides and the suggestion", async () => {
    await renderAdvisor();
    openOverrides();

    expect(screen.getByLabelText(/سربار ثابت اختصاصی/)).toBeTruthy();
    expect(screen.getByLabelText(/سربار درصدی اختصاصی/)).toBeTruthy();
    expect(screen.getByLabelText(/روش سود اختصاصی/)).toBeTruthy();
    expect(screen.getByLabelText(/نشانه‌گذاری اختصاصی/)).toBeTruthy();

    // Rounding, tax basis and the overhead base belong to the settings page.
    expect(screen.queryByLabelText(/گرد/)).toBeNull();
    expect(screen.queryByLabelText(/مالیات/)).toBeNull();
    expect(screen.queryByText("پیش‌نمایش محاسبه")).toBeNull();
    expect(screen.getAllByRole("link", { name: /تنظیمات قیمت‌گذاری/ })[0].getAttribute("href")).toBe("/settings/pricing");
  });

  it("asks for a purchase price before suggesting anything", async () => {
    await renderAdvisor({ purchasePrice: "" });

    expect(screen.getByText(/قیمت خرید را وارد کنید/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /اعمال قیمت پیشنهادی/ })).toBeNull();
  });

  it("does not invent a price when no profit target exists, and a product profit override supplies one", async () => {
    const { onApply } = await renderAdvisor({ policy: { ...POLICY, profitPercent: null } });

    expect(screen.getByText(/سود هدف هنوز تعیین نشده است/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /اعمال قیمت پیشنهادی/ })).toBeNull();

    openOverrides();
    fireEvent.change(screen.getByLabelText(/روش سود اختصاصی/), { target: { value: "margin" } });
    fireEvent.change(screen.getByLabelText(/حاشیهٔ سود اختصاصی/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "اعمال قیمت پیشنهادی" }));

    const [, recommendation] = onApply.mock.calls[0] as [string, { mode: string; inputs: Record<string, unknown> }];
    expect(recommendation.mode).toBe("margin");
    expect(recommendation.inputs).toMatchObject({ marginPercent: 20, markupPercent: null, profitSource: "product" });
  });

  it("lets one product carry its own overhead while the rest keeps the business setting", async () => {
    const { onApply } = await renderAdvisor({
      policy: { ...POLICY, percentOverhead: 10, rounding: "none" },
    });

    openOverrides();
    fireEvent.change(screen.getByLabelText(/سربار ثابت اختصاصی/), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "اعمال قیمت پیشنهادی" }));

    // 100,000 + 10% (business) + 5,000 (this product) = 115,000; × 1.2 = 138,000.
    const [value, recommendation] = onApply.mock.calls[0] as [string, { inputs: Record<string, unknown> }];
    expect(value).toBe("138000");
    expect(recommendation.inputs).toMatchObject({
      fixedOverheadRial: 50_000,
      percentOverhead: 10,
      overheadSource: "product",
      profitSource: "policy",
    });
  });

  it("keeps no-extra-rounding suggestions representable in whole Toman inputs", async () => {
    const { onApply } = await renderAdvisor({
      policy: { ...POLICY, profitPercent: 5, rounding: "none" },
      purchasePrice: "101",
    });

    fireEvent.click(screen.getByRole("button", { name: "اعمال قیمت پیشنهادی" }));

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

  it("applies an exclusive-tax suggestion as the pre-tax price, using the product's own tax rate", async () => {
    const { onApply } = await renderAdvisor({
      policy: { ...POLICY, profitPercent: 10, rounding: "none", taxMode: "exclusive" },
      taxSalePercent: "10",
      defaultTaxPercent: 9,
    });

    expect(screen.getByText("قیمت فروش پیشنهادی").parentElement?.textContent).toContain("۱۱۰٬۰۰۰ تومان");
    expect(screen.getByText(/مالیات جدا: ۱۱٬۰۰۰ تومان/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "اعمال قیمت پیشنهادی" }));
    const [appliedValue, recommendation] = onApply.mock.calls[0] as [
      string,
      { suggestedPriceRial: number; inputs: Record<string, unknown> },
    ];
    expect(appliedValue).toBe("110000");
    expect(recommendation.suggestedPriceRial).toBe(1_100_000);
    expect(recommendation.inputs).toMatchObject({ taxPercent: 10, taxMode: "exclusive" });
  });

  it("falls back to the business tax rate when the product has none of its own", async () => {
    const { onApply } = await renderAdvisor({
      policy: { ...POLICY, profitPercent: 10, rounding: "none", taxMode: "inclusive" },
      defaultTaxPercent: 9,
    });

    fireEvent.click(screen.getByRole("button", { name: "اعمال قیمت پیشنهادی" }));
    const [, recommendation] = onApply.mock.calls[0] as [string, { inputs: Record<string, unknown> }];
    expect(recommendation.inputs).toMatchObject({ taxPercent: 9, taxMode: "inclusive" });
  });
});
