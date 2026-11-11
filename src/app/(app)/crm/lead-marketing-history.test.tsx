// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { LeadMarketingHistory } from "./lead-marketing-history";
vi.mock("@/app/dashboard/ui", async (original) => ({ ...(await original<typeof import("@/app/dashboard/ui")>()), api: vi.fn() }));
const ok = (data: unknown) => ({ ok: true, status: 200, data, aborted: false }) as never;
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("lead's Growth history", () => {
  it("renders the source reports and pages without claiming verified visits", async () => {
    vi.mocked(api).mockImplementation(async (url) => ok({ touches: [{ id: "t", title: String(url).includes("page=2") ? "Older" : "Recent", target: "Site", agent: "Partner", location_name: "Branch", location_timezone: "Asia/Tehran", channel: "in_person", source: "event", recorded_at: "2026-11-05T10:00:00Z" }], hasMore: String(url).includes("page=1") }));
    const user = userEvent.setup(); render(<LeadMarketingHistory lead={{ id: "lead", name: "Client" }} onClose={() => {}} />);
    await screen.findByText("Recent"); expect(screen.queryByText(/2026-11-05/)).toBeNull();
    expect(screen.getByText(/فقط گزارش‌های شعبه‌های مجاز/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "صفحه بعد تعاملات" }));
    await screen.findByText("Older");
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).includes("leadId=lead&page=2"))).toBe(true);
  });
  it("shows an error rather than an empty report when the Growth API is unavailable", async () => {
    vi.mocked(api).mockResolvedValue({ ok: false, data: { error: "app_unavailable" }, status: 403, aborted: false } as never);
    render(<LeadMarketingHistory lead={{ id: "lead", name: "Client" }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/دسترسی و وضعیت برنامهٔ رشد/)).toBeTruthy());
    expect(screen.queryByText(/گزارشی در شعبه‌های مجاز یافت نشد/)).toBeNull();
  });
});
