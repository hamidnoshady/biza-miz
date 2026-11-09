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
    render(<MarketingTargetsSection canManage={false} canCreate={false} />);
    expect(await screen.findByText("Shop")).toBeTruthy();
    expect(screen.queryByText("افزودن مقصد")).toBeNull();
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).startsWith("/api/parties"))).toBe(false);
  });
  it("lets a manager without directory access edit and archive, with revision and confirmation", async () => {
    const row = { id: "t", site_label: "Shop", city: "City", neighborhood: "", location_name: "Main", party_linked: true, status: "active", revision: 4 };
    vi.mocked(api).mockImplementation(async (url, options) => options?.method === "PATCH" ? ok({ ok: true }) : ok({ targets: [row], hasMore: false }));
    const user = userEvent.setup(); render(<MarketingTargetsSection canManage canCreate={false} />);
    await screen.findByText("Shop");
    expect(screen.queryByText("افزودن مقصد")).toBeNull();
    await user.click(screen.getByRole("button", { name: "ویرایش" }));
    await user.clear(screen.getByLabelText("عنوان محل برای ویرایش")); await user.type(screen.getByLabelText("عنوان محل برای ویرایش"), "New");
    await user.click(screen.getByRole("button", { name: "ذخیره تغییرات" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([url, options]) => url === "/api/growth/marketing-targets/t" && JSON.parse(String(options?.body)).expectedRevision === 4)).toBe(true));
    await user.click(screen.getByRole("button", { name: "بایگانی" }));
    expect(screen.getByText("تأیید بایگانی مقصد")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "تأیید" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === "PATCH" && JSON.parse(String(options.body)).action === "archive")).toBe(true));
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).startsWith("/api/parties"))).toBe(false);
  });
  it("shows archived targets and supports restoring them", async () => {
    vi.mocked(api).mockImplementation(async (url, options) => options?.method === "PATCH" ? ok({ ok: true }) : ok({ targets: String(url).includes("status=archived") ? [{ id: "t", site_label: "Old shop", city: "", neighborhood: "", location_name: "Main", party_linked: false, status: "archived", revision: 1 }] : [], hasMore: false }));
    const user = userEvent.setup(); render(<MarketingTargetsSection canManage canCreate={false} />);
    await user.selectOptions(screen.getByLabelText("وضعیت مقصد"), "archived");
    await screen.findByText("Old shop"); await user.click(screen.getByRole("button", { name: "بازگرداندن" }));
    await user.click(screen.getByRole("button", { name: "تأیید" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === "PATCH" && JSON.parse(String(options.body)).action === "restore")).toBe(true));
  });
  it("renders task dates in Jalali and offers no mutation actions to a reader", async () => {
    vi.mocked(api).mockResolvedValue(ok({ assignments: [{ id: "a", title: "Call", target: "Shop", agent: "Marketer", location_name: "Main", status: "planned", due_date: "2026-11-05" }], hasMore: false }));
    render(<MarketingAssignmentsSection canManage={false} />);
    expect(await screen.findByText("Call")).toBeTruthy();
    expect(screen.queryByText("2026-11-05")).toBeNull();
    expect(screen.queryByRole("button", { name: "تکمیل" })).toBeNull();
    expect(screen.queryByText("ثبت ماموریت")).toBeNull();
  });
  it("searches and pages assignment options independently in the chosen branch", async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (!String(url).includes("/options?")) return ok({ assignments: [], hasMore: false });
      const params = new URL(String(url), "http://localhost").searchParams;
      const branch = params.get("location");
      const target = params.get("targetQ") ? "Searched site" : params.get("targetPage") === "2" ? "Second site" : "First site";
      return ok({ locations: [{ id: "b", name: "Main" }], targets: branch ? [{ id: target, location_id: "b", site_label: target }] : [], agents: branch ? [{ id: "a", location_id: "b", name: "Agent" }] : [], targetHasMore: params.get("targetPage") === "1", agentHasMore: false });
    });
    const user = userEvent.setup(); render(<MarketingAssignmentsSection canManage />);
    await user.selectOptions(await screen.findByLabelText("شعبه"), "b");
    await screen.findByRole("option", { name: "First site" });
    await user.selectOptions(screen.getByLabelText("بازاریاب"), "a");
    await user.click(screen.getByRole("button", { name: "مقصدهای بعد" }));
    await screen.findByRole("option", { name: "Second site" });
    expect((screen.getByLabelText("بازاریاب") as HTMLSelectElement).value).toBe("a");
    await user.type(screen.getByLabelText("جست‌وجوی مقصد"), "Needle");
    await user.click(screen.getByRole("button", { name: "جست‌وجوی مقصد" }));
    await screen.findByRole("option", { name: "Searched site" });
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).includes("targetQ=Needle&targetPage=1"))).toBe(true);
  });
  it("searches the shared directory only after a manager asks for it", async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === "/api/growth/marketing-targets/locations") return ok({ locations: [{ id: "b", name: "Main" }] });
      if (String(url).startsWith("/api/parties?")) return ok({ parties: [{ id: "p", displayName: "Customer" }] });
      return ok({ targets: [], hasMore: false });
    });
    const user = userEvent.setup(); render(<MarketingTargetsSection canManage canCreate />);
    const field = await screen.findByLabelText("جست‌وجوی شخص موجود (اختیاری)");
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).startsWith("/api/parties?"))).toBe(false);
    await user.type(field, "Customer"); await user.click(screen.getByRole("button", { name: "جست‌وجوی شخص" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Customer" })).toBeTruthy());
  });
});
