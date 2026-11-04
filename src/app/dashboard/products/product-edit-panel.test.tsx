// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VariantSummary } from "@/lib/accessories-service";
import { ProductEditPanel, changedFields } from "./product-edit-panel";

function product(overrides: Partial<VariantSummary> = {}): VariantSummary {
  return {
    id: "item-1",
    parentItemId: null,
    parentName: null,
    name: "پیراهن آبی",
    sku: "zza05023",
    kind: "simple",
    isActive: true,
    quantity: "3",
    unitCost: 1000,
    unitPrice: 2000,
    attributes: [],
    barcode: null,
    unit: "عدد",
    subUnit: null,
    conversionFactor: null,
    isSellable: true,
    publishStatus: "draft",
    shortDescription: null,
    longDescription: null,
    source: null,
    ...overrides,
  };
}

interface Snapshot {
  url: string;
  method?: string;
  body: Record<string, unknown>;
}

function renderPanel(item = product(), snapshot: Snapshot[] = []) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    snapshot.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const onSaved = vi.fn();
  const setBusy = vi.fn();
  const user = userEvent.setup();
  render(<ProductEditPanel item={item} busy={false} setBusy={setBusy} onSaved={onSaved} />);
  return { user, onSaved, setBusy, snapshot, fetchMock };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the product edit panel (#1207 §B «ویرایش»)", () => {
  it("opens with the row's own values and saves nothing until something changes", () => {
    const { user } = renderPanel();
    expect((screen.getByLabelText("نام محصول") as HTMLInputElement).value).toBe("پیراهن آبی");
    expect((screen.getByLabelText("کد کالا") as HTMLInputElement).value).toBe("zza05023");
    expect((screen.getByLabelText("بارکد") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("واحد اصلی") as HTMLInputElement).value).toBe("عدد");
    expect((screen.getByRole("button", { name: "ذخیرهٔ ویرایش" }) as HTMLButtonElement).disabled).toBe(true);
    expect(user).toBeTruthy();
  });

  it("PATCHes only the changed fields, as a patch", async () => {
    const { user, onSaved, snapshot } = renderPanel();
    await user.clear(screen.getByLabelText("بارکد"));
    await user.type(screen.getByLabelText("بارکد"), "6260001234567");
    await user.click(screen.getByRole("button", { name: "ذخیرهٔ ویرایش" }));
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].url).toBe("/api/products/items/item-1/meta");
    expect(snapshot[0].method).toBe("PATCH");
    // Name, SKU and unit were untouched, so they are not in the body at all.
    expect(snapshot[0].body).toEqual({ barcode: "6260001234567" });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("clears an emptied code to null rather than to an empty string", async () => {
    const { user, snapshot } = renderPanel();
    await user.clear(screen.getByLabelText("کد کالا"));
    await user.click(screen.getByRole("button", { name: "ذخیرهٔ ویرایش" }));
    expect(snapshot[0].body).toEqual({ sku: null });
  });

  it("refuses an empty name without calling the server", async () => {
    const { user, fetchMock } = renderPanel();
    await user.clear(screen.getByLabelText("نام محصول"));
    await user.click(screen.getByRole("button", { name: "ذخیرهٔ ویرایش" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("نام محصول");
  });

  it("puts back the row's values from «بازگرداندن»", async () => {
    const { user } = renderPanel();
    await user.clear(screen.getByLabelText("نام محصول"));
    await user.type(screen.getByLabelText("نام محصول"), "پیراهن سبز");
    await user.click(screen.getByRole("button", { name: "بازگرداندن" }));
    expect((screen.getByLabelText("نام محصول") as HTMLInputElement).value).toBe("پیراهن آبی");
    expect((screen.getByRole("button", { name: "ذخیرهٔ ویرایش" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the SKU is local — an edit is not a store update", () => {
    renderPanel();
    // The hint beside the SKU field is the sentence that keeps the two apart.
    expect(screen.getByText(/تغییر آن محصول فروشگاه را تغییر نمی‌دهد/)).toBeTruthy();
    expect(screen.getByText(/ارسال فروشگاه فقط با «به‌روزرسانی دستی»/)).toBeTruthy();
  });

  it("shows a sentence, not a code, when the save fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "item_not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const user = userEvent.setup();
    render(<ProductEditPanel item={product()} busy={false} setBusy={() => {}} onSaved={() => {}} />);
    await user.clear(screen.getByLabelText("بارکد"));
    await user.type(screen.getByLabelText("بارکد"), "123");
    await user.click(screen.getByRole("button", { name: "ذخیرهٔ ویرایش" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("این محصول دیگر در این شعبه نیست");
    expect(alert.textContent).not.toContain("item_not_found");
  });
});

describe("changedFields", () => {
  it("trims and compares field by field", () => {
    const before = { name: " الف ", sku: "A", barcode: "", unit: "عدد" };
    expect(changedFields(before, { name: "الف", sku: "A", barcode: "", unit: "عدد" })).toEqual({});
    expect(changedFields(before, { name: "الف ب", sku: "B", barcode: "C", unit: "عدد" })).toEqual({
      name: "الف ب",
      sku: "B",
      barcode: "C",
    });
    expect(changedFields(before, { name: "الف", sku: "  ", barcode: "", unit: "عدد" })).toEqual({ sku: null });
  });
});
