/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.mock("../context", () => ({ useBusiness: () => ({ id: "selected-business" }) }));
import { ReportingWorkspace } from "./workspace";

const catalog = { currencyDisplay: "toman", today: "2026-10-05", apps: [], reports: [], views: [], locations: [{ id: "branch-a", name: "شعبهٔ الف" }] };
function fixture(url: string) {
  if (url.endsWith("/catalog")) return catalog;
  if (url.includes("/day")) return { today: catalog.today };
  if (url.includes("/health")) return { sync: { data: null }, backup: { data: null }, devices: { data: [] } };
  return { sales: null, accounting: null, activity: null };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("report workspace recovery", () => {
  it("actually refetches the catalog after a failed bootstrap", async () => {
    let attempts = 0;
    const fetch = vi.fn(async (url: string) => {
      const failed = url.endsWith("/catalog") && attempts++ === 0;
      return { ok: !failed, status: failed ? 503 : 200, json: async () => failed ? { error: "report_unavailable" } : fixture(url) };
    });
    vi.stubGlobal("fetch", fetch);
    render(<ReportingWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "تلاش مجدد" }));
    expect(await screen.findByRole("tab", { name: "نمای کلی" })).toBeTruthy();
    expect(attempts).toBe(2);
  });
  it("refreshes the active report without resetting the selected branch or tab", async () => {
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => fixture(url) }));
    vi.stubGlobal("fetch", fetch);
    render(<ReportingWorkspace />);
    const branch = await screen.findByRole("combobox", { name: "شعبه" });
    fireEvent.change(branch, { target: { value: "branch-a" } });
    const health = screen.getByRole("tab", { name: "سلامت سیستم" });
    fireEvent.click(health);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes("/health?"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "تازه‌سازی" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.includes("/health?")).length).toBe(2));
    expect((branch as HTMLSelectElement).value).toBe("branch-a");
    expect(health.getAttribute("aria-selected")).toBe("true");
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/catalog"))).toHaveLength(1);
  });
});
