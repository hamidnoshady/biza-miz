// @vitest-environment jsdom

/**
 * The shared status/description fields: the AI button fills the two boxes with
 * a draft, asks before overwriting text the owner wrote, saves nothing by
 * itself, and tells the owner why when it cannot write.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { ProductContentFields, type ProductContentValue } from "./product-content-fields";

const EMPTY: ProductContentValue = { publishStatus: "published", shortDescription: "", longDescription: "" };

function Harness({ initial = EMPTY, name = "دستبند چرم" }: { initial?: ProductContentValue; name?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <MoneyProvider unit="rial">
      <ProductContentFields
        value={value}
        onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
        facts={{ name, sku: "B-1", unit: "عدد" }}
      />
      <div data-testid="state">{JSON.stringify(value)}</div>
    </MoneyProvider>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}") as ProductContentValue;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toBe("/api/products/items/describe");
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, draft: { shortDescription: "کوتاه AI", longDescription: "کامل AI" }, costRial: 0 }),
      };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProductContentFields", () => {
  it("offers the three storefront statuses in Persian", () => {
    render(<Harness />);
    const options = [...screen.getByLabelText("وضعیت انتشار").querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toEqual(["منتشرشده", "پیش‌نویس", "خصوصی"]);
  });

  it("fills both boxes from the AI draft, without saving anything", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "نوشتن با هوش مصنوعی" }));
    await waitFor(() => expect(state().shortDescription).toBe("کوتاه AI"));
    expect(state().longDescription).toBe("کامل AI");
    expect(screen.getByRole("status").textContent).toContain("ذخیره کنید");
  });

  it("keeps the owner's own text when they decline the overwrite", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<Harness initial={{ ...EMPTY, shortDescription: "متن خودم" }} />);
    await user.click(screen.getByRole("button", { name: "نوشتن با هوش مصنوعی" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(state().shortDescription).toBe("متن خودم");
  });

  it("cannot ask without a product name", () => {
    render(<Harness name="  " />);
    expect((screen.getByRole("button", { name: "نوشتن با هوش مصنوعی" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains why when the wallet or platform cannot write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 402,
        json: async () => ({ error: "ai_credit_required", message: "اعتبار هوش مصنوعی کافی نیست." }),
      })),
    );
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "نوشتن با هوش مصنوعی" }));
    expect(await screen.findByText("اعتبار هوش مصنوعی کافی نیست.")).toBeTruthy();
    expect(state().shortDescription).toBe("");
  });

  it("shows a counter that turns on the limit", () => {
    render(<Harness initial={{ ...EMPTY, shortDescription: "abc" }} />);
    expect(screen.getByText("۳ / ۱۰۰۰")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("توضیح کوتاه"), { target: { value: "abcd" } });
    expect(screen.getByText("۴ / ۱۰۰۰")).toBeTruthy();
  });
});
