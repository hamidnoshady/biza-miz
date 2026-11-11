// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReportsSection } from "./reports-section";
const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
afterEach(cleanup);
it("does not present a failed watch report as an empty report and can retry", async () => {
  apiMock.mockResolvedValueOnce({ ok: false, data: {} }).mockResolvedValueOnce({ ok: true, data: { warranty: { rows: [], counts: {} }, repairs: { rows: [], byStatus: {}, totals: { revenue: 0, partsCost: 0, margin: 0 } } } });
  render(<ReportsSection />);
  fireEvent.click(await screen.findByRole("button", { name: "تلاش دوباره" }));
  expect(await screen.findByText("گارانتی‌ها")).toBeTruthy();
  expect(apiMock).toHaveBeenCalledTimes(2);
});
