// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { MarketingTouchpointsSection } from "./marketing-touchpoints-section";
vi.mock("@/app/dashboard/ui", async (original) => ({ ...(await original<typeof import("@/app/dashboard/ui")>()), api: vi.fn() }));
const result = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, data, aborted: false }) as never;
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("marketing touch screen", () => {
  it("keeps CRM identities and recording controls hidden from read-only users", async () => {
    vi.mocked(api).mockResolvedValue(result({ touches: [{ id: "a", title: "Call", target: "Site", agent: "Marketer", location_name: "Main", location_timezone: "Asia/Tehran", channel: "phone", source: "phone", recorded_at: "2026-11-05T12:00:00Z", lead_id: null, lead_name: null }], hasMore: false }));
    render(<MarketingTouchpointsSection canManage={false} />);
    expect(await screen.findByText("Call")).toBeTruthy();
    expect(screen.getByText("محدود")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ثبت تعامل" })).toBeNull();
    expect(vi.mocked(api).mock.calls.some(([url]) => String(url).startsWith("/api/crm/leads"))).toBe(false);
  });
  it("reuses the idempotency key when a request with the same details is retried", async () => {
    let attempts = 0;
    vi.mocked(api).mockImplementation(async (url, init) => {
      if (String(url).startsWith("/api/growth/marketing-touchpoints/options")) return result({ assignments: [{ id: "assignment", title: "Call", target: "Site", location_name: "Main" }], hasMore: false });
      if (String(url).startsWith("/api/crm/leads")) return result({ leads: [{ id: "lead", name: "Person", organization: "" }], total: 1 });
      if (init?.method === "POST") { attempts++; return attempts === 1 ? result({ error: "network_error" }, false) : result({ id: "t", replayed: true }); }
      return result({ touches: [], hasMore: false });
    });
    const user = userEvent.setup(); render(<MarketingTouchpointsSection canManage />);
    await user.selectOptions(await screen.findByLabelText("ماموریت"), "assignment");
    await user.type(screen.getByLabelText("جست‌وجوی سرنخ در CRM"), "Person");
    await user.click(screen.getByRole("button", { name: "جست‌وجوی سرنخ" }));
    await user.selectOptions(await screen.findByLabelText("سرنخ"), "lead");
    await user.click(screen.getByRole("button", { name: "ثبت تعامل" }));
    await screen.findByText(/ثبت تعامل تایید نشد/);
    await user.click(screen.getByRole("button", { name: "ثبت تعامل" }));
    await waitFor(() => expect(attempts).toBe(2));
    const writes = vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(JSON.parse(writes[0][1]!.body as string).idempotencyKey).toBe(JSON.parse(writes[1][1]!.body as string).idempotencyKey);
  });
});
