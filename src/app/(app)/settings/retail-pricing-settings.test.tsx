// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_RETAIL_PRICING_POLICY, type RetailPricingPolicy } from "@/lib/retail-pricing-policy";
import { RetailPricingSettings } from "./retail-pricing-settings";

const STORED: RetailPricingPolicy = {
  ...DEFAULT_RETAIL_PRICING_POLICY,
  fixedOverheadRial: 200_000,
  percentOverhead: 5,
  profitPercent: 25,
};

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_input, init) => {
    if (init?.method === "PUT") {
      return json({ ok: true, policy: { ...STORED, ...JSON.parse(String(init.body)) }, defaultTaxPercent: 10 });
    }
    return json({ policy: STORED, defaultTaxPercent: 10 });
  });
  vi.stubGlobal("fetch", fetchMock);
  // The radio groups measure themselves.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RetailPricingSettings", () => {
  it("shows the stored policy in the business's unit and the tax rate it reads", async () => {
    render(<RetailPricingSettings />);

    const fixed = (await screen.findByLabelText(/^سربار ثابت/)) as HTMLInputElement;
    // 200,000 Rial is 20,000 Toman.
    expect(fixed.value).toBe("۲۰٬۰۰۰");
    expect((screen.getByLabelText(/^سربار درصدی/) as HTMLInputElement).value).toBe("۵");
    expect((screen.getByLabelText(/درصد نشانه‌گذاری هدف/) as HTMLInputElement).value).toBe("۲۵");
    expect(screen.getByText(/نرخ فعلی ۱۰٪/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "ذخیرهٔ قیمت‌گذاری" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves integer Rial, not the typed Toman, and only after a change", async () => {
    render(<RetailPricingSettings />);
    const fixed = await screen.findByLabelText(/^سربار ثابت/);

    fireEvent.change(fixed, { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ قیمت‌گذاری" }));

    await waitFor(() => expect(screen.getByText("تنظیمات قیمت‌گذاری با موفقیت ذخیره شد.")).toBeTruthy());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toBe("/api/settings/retail-pricing");
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
      fixedOverheadRial: 300_000,
      percentOverhead: 5,
      profitMode: "markup",
      profitPercent: 25,
      rounding: "nearest",
      taxMode: "exclusive",
    });
  });

  it("refuses an impossible margin without sending anything", async () => {
    render(<RetailPricingSettings />);
    await screen.findByLabelText(/^سربار ثابت/);

    fireEvent.click(screen.getByLabelText(/حاشیهٔ سود از قیمت فروش/));
    fireEvent.change(screen.getByLabelText(/حاشیهٔ سود هدف/), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ قیمت‌گذاری" }));

    expect(await screen.findByText("حاشیهٔ سود باید از ۰ تا کمتر از ۱۰۰ باشد.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("shows a worked example that follows the form before it is saved", async () => {
    render(<RetailPricingSettings />);
    await screen.findByLabelText(/^سربار ثابت/);

    // 100,000 + 5% + 20,000 = 125,000; × 1.25 = 156,250 → nearest 1,000 = 156,000.
    expect(screen.getByText("نمونه").closest("section")?.textContent).toContain("۱۵۶٬۰۰۰ تومان");
    fireEvent.change(screen.getByLabelText(/درصد نشانه‌گذاری هدف/), { target: { value: "0" } });
    expect(screen.getByText("نمونه").closest("section")?.textContent).toContain("۱۲۵٬۰۰۰ تومان");
  });

  it("offers a retry instead of an empty form when the policy cannot be read", async () => {
    fetchMock.mockImplementation(async () => json({ error: "forbidden" }, 403));
    render(<RetailPricingSettings />);

    expect(await screen.findByRole("button", { name: "تلاش دوباره" })).toBeTruthy();
    expect(screen.queryByLabelText(/^سربار ثابت/)).toBeNull();
  });
});
