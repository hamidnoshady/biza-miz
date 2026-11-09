// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { MyMarketingAssignmentsSection } from "./my-marketing-assignments-section";
vi.mock("@/app/dashboard/ui", async (original) => ({ ...(await original<typeof import("@/app/dashboard/ui")>()), api: vi.fn() }));
const success = (data: unknown) => ({ ok: true, status: 200, data, aborted: false }) as never;
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("my assignments", () => {
  it("shows only self-service actions and refreshes after a status change", async () => {
    vi.mocked(api).mockImplementation(async (_url, init) => init?.method === "PATCH" ? success({ ok: true }) : success({ assignments: [{ id: "work", title: "Own work", target: "Site", location_name: "Main", status: "planned", due_date: null }], hasMore: false }));
    const user = userEvent.setup(); render(<MyMarketingAssignmentsSection />);
    expect(await screen.findByText("Own work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "لغو" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "شروع" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([url, init]) => url === "/api/growth/my-marketing-assignments/work" && init?.method === "PATCH")).toBe(true));
    const write = vi.mocked(api).mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(write[1]!.body as string)).toEqual({ expected: "planned", next: "in_progress" });
  });
});

it("only offers self reporting with the explicit CRM intersection and retains the retry key", async () => {
  const task = { id: "work", title: "Own work", target: "Site", location_name: "Main", status: "planned", due_date: null };
  const fail = { ok: false, status: 0, data: {}, aborted: false } as never;
  vi.mocked(api).mockImplementation(async (url, init) => {
    if (init?.method === "POST") return fail;
    if (url.startsWith("/api/crm/leads")) return success({ leads: [{ id: "lead", name: "Lead", organization: "" }], total: 1 });
    return success({ assignments: [task], hasMore: false });
  });
  const user = userEvent.setup();
  const view = render(<MyMarketingAssignmentsSection />);
  await screen.findByText("Own work");
  expect(screen.queryByRole("button", { name: "گزارش تعامل" })).toBeNull();
  view.rerender(<MyMarketingAssignmentsSection canRecordTouch />);
  await user.click(screen.getByRole("button", { name: "گزارش تعامل" }));
  expect(screen.getByText(/مدرک ملاقات، رضایت، فروش یا پاداش نیست/)).toBeTruthy();
  await user.type(screen.getByLabelText("جست‌وجوی سرنخ موجود در CRM"), "Lead");
  await user.click(screen.getByRole("button", { name: "جست‌وجوی سرنخ" }));
  await user.selectOptions(await screen.findByLabelText("سرنخ موجود"), "lead");
  await user.click(screen.getByRole("button", { name: "ثبت گزارش" }));
  await screen.findByText(/ثبت تأیید نشد/);
  await user.click(screen.getByRole("button", { name: "ثبت گزارش" }));
  const posts = vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts[0][0]).toBe("/api/growth/my-marketing-touchpoints");
  expect(JSON.parse(posts[0][1]!.body as string)).toEqual(JSON.parse(posts[1][1]!.body as string));
  expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ assignmentId: "work", leadId: "lead" });
});

it("loads only the explicitly opened self history and supports search and pagination", async () => {
  vi.mocked(api).mockImplementation(async (url) => {
    if (url.startsWith("/api/growth/my-marketing-touchpoints")) return success({ touches: [{ id: "touch", title: "Call", target: "Site", lead_name: "Lead", location_name: "Main", location_timezone: "Asia/Tehran", channel: "phone", source: "phone", recorded_at: "2026-01-01T12:00:00Z" }], hasMore: true });
    return success({ assignments: [], hasMore: false });
  });
  const user = userEvent.setup(); const view = render(<MyMarketingAssignmentsSection />);
  await screen.findByText("ماموریتی برای شما یافت نشد.");
  expect(screen.queryByRole("button", { name: "نمایش گزارش‌های تعامل من" })).toBeNull();
  view.rerender(<MyMarketingAssignmentsSection canRecordTouch />);
  expect(vi.mocked(api).mock.calls.some(([url]) => url.startsWith("/api/growth/my-marketing-touchpoints"))).toBe(false);
  await user.click(screen.getByRole("button", { name: "نمایش گزارش‌های تعامل من" }));
  expect(await screen.findByText("Lead")).toBeTruthy();
  expect(screen.getByText(/همسانی اطلاعات به‌تنهایی/)).toBeTruthy();
  await user.type(screen.getByLabelText("جست‌وجوی گزارش تعامل من"), "Lead");
  await user.click(screen.getByRole("button", { name: "جست‌وجوی گزارش‌ها" }));
  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([url]) => url.includes("q=Lead&page=1"))).toBe(true));
  await user.click(await screen.findByRole("button", { name: "صفحه بعد گزارش‌ها" }));
  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([url]) => url.includes("q=Lead&page=2"))).toBe(true));
  await user.click(screen.getByRole("button", { name: "بستن گزارش‌ها" }));
  expect(screen.queryByText("Lead")).toBeNull();
});
