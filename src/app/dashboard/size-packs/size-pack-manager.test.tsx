// @vitest-environment jsdom
//
// GH #1567 Phase 6C — the size-pack screens.
//   - the pack list shows price, pieces and derived availability with shortages;
//   - the builder fills a size × colour matrix, previews price/pieces/"can make N"
//     from live stock, and saves exactly the components entered;
//   - a server shortage / barcode clash is shown as a Persian message;
//   - a read-only member sees no mutating controls;
//   - the till cart line prices a pack like its per-variant lines.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeAccessorySalePrice } from "@/lib/accessories";
import { sizePackErrorMessage } from "@/lib/fashion-size-pack-messages";
import { sizePackCartLine } from "../pos/size-pack-cart";
import { matrixLayout, PackBuilder, parseCount, SizePackManager, type SizePack } from "./size-pack-manager";

const STYLE_ID = "11111111-1111-4111-8111-111111111111";

const PACK: SizePack = {
  id: "22222222-2222-4222-8222-222222222222", name: "بستهٔ عمده مشکی", barcode: "PACK-1", isActive: true, version: 1,
  priceRial: 410_000, pieces: 5, available: 1, shortages: [],
  components: [
    { itemId: "s", name: "پیراهن", sku: null, attributes: "مشکی / S", quantity: 1, unitPriceRial: 80_000, onHand: "5" },
    { itemId: "m", name: "پیراهن", sku: null, attributes: "مشکی / M", quantity: 2, unitPriceRial: 80_000, onHand: "5" },
    { itemId: "l", name: "پیراهن", sku: null, attributes: "مشکی / L", quantity: 2, unitPriceRial: 85_000, onHand: "3" },
  ],
};

const CELLS = ["S", "M", "L"].map((size, i) => ({
  itemId: size.toLowerCase(), name: "پیراهن", sku: null, attributes: { رنگ: "مشکی", سایز: size },
  onHand: ["5", "5", "3"][i], unitPriceRial: 120_000,
}));

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let saveResponse: { status: number; body: unknown } | null = null;

beforeEach(() => {
  calls.length = 0;
  saveResponse = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/size-packs" && method === "POST") {
      if (saveResponse) return new Response(JSON.stringify(saveResponse.body), { status: saveResponse.status });
      return new Response(JSON.stringify({ pack: PACK }), { status: 201 });
    }
    if (url === "/api/size-packs") return new Response(JSON.stringify({ packs: [PACK, { ...PACK, id: "x", name: "بستهٔ تمام‌شده", available: 0, clearedBarcode: "2000000000015", shortages: [{ itemId: "l", name: "پیراهن (L)", need: 2, onHand: "1", missing: "1" }] }] }));
    if (url === "/api/size-packs/matrix") return new Response(JSON.stringify({ styles: [{ id: STYLE_ID, name: "پیراهن", sku: "DR", variants: 3 }] }));
    if (url === `/api/size-packs/matrix?styleId=${STYLE_ID}`) return new Response(JSON.stringify({ axes: ["رنگ", "سایز"], cells: CELLS }));
    if (url === "/api/size-packs/sales") return new Response(JSON.stringify({ sales: [] }));
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("size pack helpers", () => {
  it("accepts only whole positive counts, Persian digits included", () => {
    expect(parseCount("۲")).toBe(2);
    expect(parseCount("0")).toBeNull();
    expect(parseCount("1.5")).toBeNull();
    expect(parseCount("-1")).toBeNull();
  });

  it("lays sizes across and colours down", () => {
    const layout = matrixLayout(["رنگ", "سایز"], CELLS);
    expect(layout.sizeAxis).toBe("سایز");
    expect(layout.rowAxis).toBe("رنگ");
    expect(layout.columns).toEqual(["S", "M", "L"]);
    expect(layout.rows).toEqual(["مشکی"]);
  });

  it("explains a shortage per variant", () => {
    const text = sizePackErrorMessage("pack_shortage", { packName: "عمده", shortages: [{ name: "L", need: 4, onHand: "3", missing: "1" }] });
    expect(text).toContain("عمده");
    expect(text).toContain("کمبود ۱");
    expect(sizePackErrorMessage("pack_barcode_taken")).toContain("بارکد");
    expect(sizePackErrorMessage("something_new")).toBe("انجام نشد. دوباره تلاش کنید.");
  });

  it("prices a till pack line like the per-variant lines the server will create", () => {
    const line = sizePackCartLine(PACK, 2, 9, "k");
    expect(line.payload).toEqual({ kind: "size_pack", packId: PACK.id, quantity: 2, vatPercent: 9 });
    const expected = PACK.components.reduce((sum, c) => sum + Number(computeAccessorySalePrice({
      unitPrice: c.unitPriceRial, quantity: String(c.quantity * 2), discount: 0, vatPercent: 9,
    }).total), 0);
    expect(line.total).toBe(expected);
    expect(line.net).toBe(820_000);
  });
});

describe("SizePackManager", () => {
  it("lists packs with price, pieces and derived availability with shortages", async () => {
    render(<SizePackManager canEdit />);
    const table = await screen.findByRole("table", { name: "بسته‌های سایزی" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("بستهٔ عمده مشکی")).toBeTruthy();
    expect(within(rows[1]).getByText("۵")).toBeTruthy();
    expect(within(rows[2]).getByText(/کمبود: پیراهن \(L\)/)).toBeTruthy();
    // GH #1567 C3: a barcode migration 0334 cleared is explained on the row.
    expect(within(rows[2]).getByText(/بارکد ۲۰۰۰۰۰۰۰۰۰۰۱۵ برداشته شد/)).toBeTruthy();
    expect(within(rows[1]).queryByText(/برداشته شد/)).toBeNull();
    expect(screen.getByRole("button", { name: /بستهٔ تازه/ })).toBeTruthy();
  });

  it("a read-only member sees no mutating controls", async () => {
    render(<SizePackManager canEdit={false} />);
    await screen.findByRole("table", { name: "بسته‌های سایزی" });
    expect(screen.queryByRole("button", { name: /بستهٔ تازه/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "ویرایش" })).toBeNull();
  });
});

describe("PackBuilder", () => {
  async function pickStyle() {
    await waitFor(() => expect(calls.some((c) => c.url === "/api/size-packs/matrix")).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "مدل" }).getAttribute("aria-busy")).not.toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "مدل" }));
    fireEvent.click(await screen.findByRole("option", { name: "پیراهن (DR)" }));
  }

  async function fillMatrix(onSaved: () => void = () => undefined) {
    render(<PackBuilder pack={null} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("نام بسته"), { target: { value: "عمده" } });
    await pickStyle();
    await screen.findByRole("table", { name: "جدول تعداد هر سایز و رنگ در یک بسته" });
    fireEvent.change(screen.getByLabelText("تعداد مشکی S در بسته"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("تعداد مشکی M در بسته"), { target: { value: "۲" } });
    fireEvent.change(screen.getByLabelText("تعداد مشکی L در بسته"), { target: { value: "2" } });
  }

  it("previews pieces, price and how many packs stock can make, then saves the exact components", async () => {
    const onSaved = vi.fn();
    await fillMatrix(onSaved);
    const preview = screen.getByLabelText("پیش‌نمایش بسته");
    expect(within(preview).getByText("۵")).toBeTruthy();
    // L: 3 on hand ÷ 2 per pack → 1 pack.
    expect(within(preview).getByText("۱ بسته")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ بسته" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      name: "عمده",
      barcode: null,
      components: [
        { itemId: "s", quantity: 1, unitPriceRial: 120_000 },
        { itemId: "m", quantity: 2, unitPriceRial: 120_000 },
        { itemId: "l", quantity: 2, unitPriceRial: 120_000 },
      ],
    });
  });

  it("a shortage for one more pack is listed per variant", async () => {
    await fillMatrix();
    fireEvent.change(screen.getByLabelText("تعداد مشکی L در بسته"), { target: { value: "4" } });
    const list = screen.getByRole("list", { name: "کمبود برای یک بسته" });
    expect(within(list).getByText(/کمبود ۱/)).toBeTruthy();
  });

  it("shows the server's barcode clash in Persian and does not close", async () => {
    saveResponse = { status: 409, body: { error: "pack_barcode_taken" } };
    const onSaved = vi.fn();
    render(<PackBuilder pack={null} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("نام بسته"), { target: { value: "عمده" } });
    await pickStyle();
    await screen.findByRole("table", { name: "جدول تعداد هر سایز و رنگ در یک بسته" });
    fireEvent.change(screen.getByLabelText("تعداد مشکی S در بسته"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ بسته" }));
    expect(await screen.findByText(/این بارکد در این شعبه/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("refuses to save an empty pack without calling the server", async () => {
    render(<PackBuilder pack={null} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ بسته" }));
    expect(await screen.findByText("نام بسته و دست‌کم یک تنوع لازم است.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
