// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { MarketersSection } from "./marketers-section";
vi.mock("@/app/dashboard/ui", async (original) => ({ ...(await original<typeof import("@/app/dashboard/ui")>()), api: vi.fn() }));
const ok = (data: unknown) => ({ ok: true, status: 200, data, aborted: false }) as never;
const employee = { id: "staff", name: "Employee", kind: "employee", status: "active", location_name: "Main", user_active: true, revision: 2 };
const partner = { id: "ext", name: "Partner", kind: "affiliate", status: "active", location_name: "Main", user_active: null, revision: 3 };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("marketer lifecycle UI", () => {
  it("does not expose actions to a read-only user", async () => {
    vi.mocked(api).mockResolvedValue(ok({ marketers: [employee], hasMore: false }));
    render(<MarketersSection canManage={false} />); await screen.findByText("Employee");
    expect(screen.queryByRole("button", { name: "غیرفعال‌سازی" })).toBeNull();
    expect(screen.queryByText("افزودن بازاریاب")).toBeNull();
  });
  it("edits only external names and confirms status changes with revisions", async () => {
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") return ok({ ok: true });
      if (String(url).includes("/candidates")) return ok({ locations: [], users: [] });
      return ok({ marketers: [employee, partner], hasMore: false });
    });
    const user = userEvent.setup(); render(<MarketersSection canManage />);
    await screen.findByText("Employee");
    expect(screen.getAllByRole("button", { name: "ویرایش نام" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "ویرایش نام" }));
    await user.clear(screen.getByLabelText("نام همکار برای ویرایش")); await user.type(screen.getByLabelText("نام همکار برای ویرایش"), "New partner");
    await user.click(screen.getByRole("button", { name: "ذخیره تغییرات" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([url, opts]) => url === "/api/growth/marketers/ext" && opts?.method === "PATCH" && JSON.parse(String(opts.body)).expectedRevision === 3)).toBe(true));
    await user.click((await screen.findAllByRole("button", { name: "غیرفعال‌سازی" }))[0]);
    expect(screen.getByText("تأیید غیرفعال‌سازی")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "تأیید" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([url, opts]) => url === "/api/growth/marketers/staff" && opts?.method === "PATCH" && JSON.parse(String(opts.body)).action === "deactivate")).toBe(true));
  });
  it("explains open assignments and member eligibility", async () => {
    let error = "open_assignments";
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") return { ok: false, status: 409, data: { error }, aborted: false } as never;
      if (String(url).includes("/candidates")) return ok({ locations: [], users: [] });
      return ok({ marketers: [{ ...employee, status: "inactive" }, partner], hasMore: false });
    });
    const user = userEvent.setup(); render(<MarketersSection canManage />); await screen.findByText("Employee");
    await user.click(screen.getByRole("button", { name: "غیرفعال‌سازی" })); await user.click(screen.getByRole("button", { name: "تأیید" }));
    expect(await screen.findByText(/ماموریت باز دارد/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "فعال‌سازی" })); error = "ineligible_user";
    await user.click(screen.getByRole("button", { name: "تأیید" }));
    expect(await screen.findByText(/عضو مرتبط فعال نیست/)).toBeTruthy();
  });
});
