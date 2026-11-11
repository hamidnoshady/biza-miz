// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MoneyProvider } from "@/components/money/money-context";
import { JewelryPriceBoard } from "./jewelry-price-board";
const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
beforeEach(() => apiMock.mockReset());
afterEach(cleanup);
it("shows native per-gram rates in Shamsi without write controls to a reader", async () => {
  apiMock.mockResolvedValue({ ok: true, data: { prices: [{ id: "g", purity: "18", priceDate: "2026-01-01", pricePerGram: 5000000, source: "manual" }] } });
  render(<MoneyProvider unit="rial"><JewelryPriceBoard canEdit={false} /></MoneyProvider>);
  expect(await screen.findByText("۱۸ عیار")).toBeTruthy();
  expect(document.body.textContent).not.toContain("2026-01-01");
  expect(screen.queryByRole("link")).toBeNull();
  expect(apiMock.mock.calls[0][0]).toBe("/api/jewelry/prices");
});
it("reports load failures and retries", async () => {
  apiMock.mockResolvedValueOnce({ ok: false, data: {} }).mockResolvedValueOnce({ ok: true, data: { prices: [] } });
  render(<JewelryPriceBoard canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "تلاش دوباره" }));
  expect(await screen.findByText("نرخی ثبت نشده است.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "بخش تخصصی طلا و جواهر" }).getAttribute("href")).toBe("/accounting/jewelry");
});
