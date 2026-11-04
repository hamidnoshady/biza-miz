// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { MarketingTargetsSection } from "./marketing-targets-section";
import { MarketingAssignmentsSection } from "./marketing-assignments-section";

vi.mock("@/app/dashboard/ui", async (original) => ({
  ...(await original<typeof import("@/app/dashboard/ui")>()),
  api: vi.fn(),
}));
const ok = (data: unknown) => ({ ok: true, status: 200, data, aborted: false }) as never;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("marketing operations screens", () => {
  it("shows a read-only target list without a directory picker or create form", async () => {
    vi.mocked(api).mockResolvedValue(ok({ targets: [{ id: "t", site_label: "Shop", city: "Tehran", neighborhood: "", location_name: "Main", party_linked: true }], hasMore: false }));
    render(<MarketingTargetsSection canManage={false} />);
    expect(await screen.findByText("Shop")).toBeTruthy();
    expect(screen.queryByText("افزودن مقصد")).toBeNull();
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).startsWith("/api/parties"))).toBe(false);
  });
  it("renders task dates in Jalali and offers no mutation actions to a reader", async () => {
    vi.mocked(api).mockResolvedValue(ok({ assignments: [{ id: "a", title: "Call", target: "Shop", agent: "Marketer", location_name: "Main", status: "planned", due_date: "2026-11-05" }], hasMore: false }));
    render(<MarketingAssignmentsSection canManage={false} />);
    expect(await screen.findByText("Call")).toBeTruthy();
    expect(screen.queryByText("2026-11-05")).toBeNull();
    expect(screen.queryByRole("button", { name: "تکمیل" })).toBeNull();
    expect(screen.queryByText("ثبت ماموریت")).toBeNull();
  });
  it("searches the shared directory only after a manager asks for it", async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === "/api/growth/marketing-targets/locations") return ok({ locations: [{ id: "b", name: "Main" }] });
      if (String(url).startsWith("/api/parties?")) return ok({ parties: [{ id: "p", displayName: "Customer" }] });
      return ok({ targets: [], hasMore: false });
    });
    const user = userEvent.setup(); render(<MarketingTargetsSection canManage />);
    const field = await screen.findByLabelText("جست‌وجوی شخص موجود (اختیاری)");
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).startsWith("/api/parties?"))).toBe(false);
    await user.type(field, "Customer"); await user.click(screen.getByRole("button", { name: "جست‌وجوی شخص" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Customer" })).toBeTruthy());
  });
});
