// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutomotiveReports } from "./automotive-reports";

const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
const data = { onDate: "2026-10-10", summary: { inStock: 3, reserved: 1, sold: 2, soldThisMonth: 1, averageAgeDays: 12, slowCount: 0, deadCount: 0, stockValueRial: 1000 } };
beforeEach(() => { apiMock.mockReset(); apiMock.mockResolvedValue({ ok: true, data }); });
afterEach(cleanup);
describe("automotive reports", () => {
  it("uses the native overview without showing financial fields to a viewer", async () => {
    render(<AutomotiveReports canSeeCost={false} />);
    expect(await screen.findByText("موجودی شعبهٔ فعال")).toBeTruthy();
    expect(screen.queryByText("ارزش و سود")).toBeNull();
    expect(apiMock).toHaveBeenCalledWith("/api/automotive/overview", expect.anything());
  });
  it("offers retry instead of treating a failure as an empty report", async () => {
    apiMock.mockResolvedValueOnce({ ok: false, data: {} });
    render(<AutomotiveReports canSeeCost />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByText("ارزش و سود")).toBeTruthy();
  });
});
