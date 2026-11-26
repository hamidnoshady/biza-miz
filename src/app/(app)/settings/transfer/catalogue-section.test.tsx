// @vitest-environment jsdom
//
// GH #1567 F6: the reviewed catalogue import's mapping editor for a size ×
// colour file. Each mapped option column gets its own axis name, and the
// preview carries every axis in order; a CSV file is accepted like an XLSX.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogueSection } from "./catalogue-section";

const columns = ["شناسه کالا", "نام کالا", "شناسه والد", "نام والد", "گزینه تنوع", "گزینه تنوع ۲"];
const posted: Record<string, unknown>[] = [];

beforeEach(() => {
  posted.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      const options = JSON.parse(String(init.body.get("options")));
      posted.push(options);
      if (options.action === "analyse") {
        return new Response(JSON.stringify({ columns, sheet: "CSV", mapping: { sku: 0, title: 1, parent_sku: 2, parent_title: 3, option: 4, option_2: 5 } }));
      }
      return new Response(JSON.stringify({
        rows: [], valueTotals: {}, totals: { rows: 0, distinctSkus: 0, repeated: 0, repeatedBarcodes: 0, blankBrandRows: 0, excelBrandRows: 0, fallbackBrandRows: 0, unbrandedRows: 0 },
      }));
    }
    return new Response(JSON.stringify({ runs: [], stores: [], target: "retail", localOnly: false }));
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("catalogue mapping editor — multi-axis (GH #1567 F6)", () => {
  it("accepts a CSV, names one axis per mapped option column and previews with both axes in order", async () => {
    render(<CatalogueSection />);
    const input = await screen.findByLabelText("فایل اکسل یا CSV") as HTMLInputElement;
    expect(input.accept).toBe(".xlsx,.csv");
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { files: [new File(["x"], "grid.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "خواندن ستون‌ها" }));

    const first = await screen.findByLabelText(/نام محور تنوع ۱/);
    const second = screen.getByLabelText(/نام محور تنوع ۲/);
    expect(screen.queryByLabelText(/نام محور تنوع ۳/)).toBeNull();
    fireEvent.change(first, { target: { value: "سایز" } });
    fireEvent.change(second, { target: { value: "رنگ" } });
    fireEvent.change(screen.getByLabelText(/نام برند پیش‌فرض/), { target: { value: "برند" } });
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش ردیف‌ها" }));

    await waitFor(() => expect(posted.some(options => options.action === "preview")).toBe(true));
    expect(posted.find(options => options.action === "preview")).toMatchObject({ axis: "سایز", axes: ["سایز", "رنگ"] });
  });
});
