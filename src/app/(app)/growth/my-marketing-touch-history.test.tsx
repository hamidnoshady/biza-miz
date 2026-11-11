// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { MyMarketingTouchHistory } from "./my-marketing-touch-history";
vi.mock("@/app/dashboard/ui", async (original) => ({ ...(await original<typeof import("@/app/dashboard/ui")>()), api: vi.fn() }));
const success = (data: unknown) => ({ ok: true, status: 200, data, aborted: false }) as never;
const failure = { ok: false, status: 403, data: {}, aborted: false } as never;
const item = (name: string) => ({ id: name, title: name, target: "Site", lead_name: "Lead", location_name: "Main", location_timezone: "Asia/Tehran", channel: "phone", source: "phone", recorded_at: "2026-01-01T12:00:00Z" });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("my reported interaction history", () => {
  it("distinguishes failure from an empty history and retries", async () => {
    vi.mocked(api).mockResolvedValueOnce(failure).mockResolvedValueOnce(success({ touches: [], hasMore: false }));
    const user = userEvent.setup(); render(<MyMarketingTouchHistory version={0} onClose={() => {}} />);
    expect(await screen.findByText(/دریافت گزارش‌ها ممکن نشد/)).toBeTruthy();
    expect(screen.queryByText(/گزارشی در دسترسی فعلی شما یافت نشد/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByText(/گزارشی در دسترسی فعلی شما یافت نشد/)).toBeTruthy();
  });
  it("ignores stale responses and refreshes after a successful new report", async () => {
    let resolveFirst!: (value: never) => void;
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValueOnce(success({ touches: [item("Latest")], hasMore: false })).mockResolvedValueOnce(success({ touches: [item("After write")], hasMore: false }));
    const user = userEvent.setup(); const view = render(<MyMarketingTouchHistory version={0} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "به‌روزرسانی گزارش‌ها" }));
    expect(await screen.findByText("Latest")).toBeTruthy();
    resolveFirst(success({ touches: [item("Stale")], hasMore: false }));
    await waitFor(() => expect(screen.queryByText("Stale")).toBeNull());
    view.rerender(<MyMarketingTouchHistory version={1} onClose={() => {}} />);
    expect(await screen.findByText("After write")).toBeTruthy();
    expect(screen.queryByText("Latest")).toBeNull();
  });
});
